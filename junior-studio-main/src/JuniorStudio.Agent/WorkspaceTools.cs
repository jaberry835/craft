using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.AI;

namespace JuniorStudio.Agent;

/// <summary>Approval policy for a tool category.</summary>
internal enum ApprovalMode
{
    /// <summary>Run without prompting.</summary>
    Auto,
    /// <summary>Prompt the user via the UI before each invocation.</summary>
    Confirm,
    /// <summary>Refuse the tool call and return an error string to the agent.</summary>
    Deny
}

/// <summary>
/// Workspace-scoped tools the agent can invoke. All paths are resolved relative to
/// <see cref="WorkspaceRoot"/> and rejected if they escape it.
/// </summary>
internal sealed class WorkspaceTools
{
    private static readonly string[] RepoInstructionCandidates =
    {
        Path.Combine(".junior", "instructions.md"),
        Path.Combine(".github", "copilot-instructions.md"),
        "AGENTS.md"
    };

    private string workspaceRoot = Directory.GetCurrentDirectory();
    private readonly object mutationLock = new();
    private readonly HashSet<string> mutatedFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly object diagnosticsLock = new();
    private List<DiagnosticSnapshotItem> diagnostics = new();

    public string WorkspaceRoot
    {
        get => workspaceRoot;
        set
        {
            workspaceRoot = value ?? string.Empty;
            Index.SetRoot(string.IsNullOrEmpty(workspaceRoot) ? null : workspaceRoot);
        }
    }

    public string ScratchRoot { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "source", "repos");

    /// <summary>Workspace file index. Populated lazily after <see cref="WorkspaceRoot"/> is set.</summary>
    public WorkspaceIndex Index { get; } = new();

    /// <summary>Roslyn-based symbol index over the workspace's C# files.</summary>
    public SymbolIndex Symbols { get; }

    /// <summary>Monotonically increases whenever a workspace mutation tool succeeds.</summary>
    public int MutationVersion { get; private set; }

    /// <summary>Mutation version covered by the latest successful workspace validation.</summary>
    public int LastSuccessfulValidationMutationVersion { get; private set; }

    public WorkspaceTools()
    {
        Symbols = new SymbolIndex(Index);
    }

    /// <summary>Approval policy for write/create file tools.</summary>
    public ApprovalMode ApprovalWrite { get; set; } = ApprovalMode.Confirm;
    /// <summary>Approval policy for the delete file tool.</summary>
    public ApprovalMode ApprovalDelete { get; set; } = ApprovalMode.Confirm;
    /// <summary>Approval policy for the shell tool.</summary>
    public ApprovalMode ApprovalShell { get; set; } = ApprovalMode.Confirm;

    /// <summary>
    /// When set, called before any tool subject to a "confirm" policy executes.
    /// Arguments: (category, human-readable description, cancellation token). Returns
    /// <c>true</c> to allow the action, <c>false</c> to deny.
    /// </summary>
    public Func<string, string, CancellationToken, Task<bool>>? ApprovalCallback { get; set; }

    /// <summary>Raised when the agent creates a new workspace folder via <see cref="CreateWorkspaceFolder"/>.</summary>
    public event Action<string>? WorkspaceFolderCreated;

    /// <summary>
    /// Returns null if the action should proceed; otherwise returns a refusal string
    /// to be returned to the agent in place of the tool result.
    /// </summary>
    private async Task<string?> RequireApprovalAsync(string category, string description, CancellationToken ct)
    {
        var mode = category switch
        {
            "write" => ApprovalWrite,
            "delete" => ApprovalDelete,
            "shell" => ApprovalShell,
            _ => ApprovalMode.Auto
        };
        if (mode == ApprovalMode.Auto) return null;
        if (mode == ApprovalMode.Deny)
            return $"User has set '{category}' tool calls to DENY. Action blocked. Try a different approach or ask the user to enable it.";
        var cb = ApprovalCallback;
        if (cb is null) return null; // no UI wired \u2014 fail open so headless tests still work
        bool ok;
        try { ok = await cb(category, description, ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return $"Approval request failed: {ex.Message}"; }
        return ok ? null : $"User denied this {category} action. Skip and continue, or try a different approach.";
    }

    /// <summary>Returns the list of tools as <see cref="AITool"/> wrappers.</summary>
    public IList<AITool> AsAITools() => AsAITools("agent");

    /// <summary>
    /// Returns the tool list appropriate for the given chat mode.
    /// <list type="bullet">
    ///   <item><description><c>agent</c>: full tool set (read, write, run, search, scaffold).</description></item>
    ///   <item><description><c>plan</c>: read-only tools only (no writes, deletes, or shell).</description></item>
    ///   <item><description><c>ask</c>: no tools \u2014 pure chat.</description></item>
    /// </list>
    /// </summary>
    public IList<AITool> AsAITools(string mode)
    {
        var m = (mode ?? "agent").Trim().ToLowerInvariant();
        if (m == "ask") return Array.Empty<AITool>();

        var readOnly = new List<AITool>
        {
            AIFunctionFactory.Create(GetWorkspaceRoot),
            AIFunctionFactory.Create(ListDir),
            AIFunctionFactory.Create(ReadFile),
            AIFunctionFactory.Create(SearchText),
            AIFunctionFactory.Create(SearchRelevantFiles),
            AIFunctionFactory.Create(GetDiagnostics),
            AIFunctionFactory.Create(GetRepoInstructions),
            AIFunctionFactory.Create(ListWorkspaceFiles),
            AIFunctionFactory.Create(FindFiles),
            AIFunctionFactory.Create(GetWorkspaceTree),
            AIFunctionFactory.Create(FindSymbol),
            AIFunctionFactory.Create(GetFileOutline),
            AIFunctionFactory.Create(FindSymbolReferences)
        };
        if (m == "plan") return readOnly;

        // agent (default): read-only + mutation + shell + scaffold.
        return new List<AITool>(readOnly)
        {
            AIFunctionFactory.Create(WriteFile),
            AIFunctionFactory.Create(CreateFile),
            AIFunctionFactory.Create(ApplyPatch),
            AIFunctionFactory.Create(ReplaceText),
            AIFunctionFactory.Create(ReplaceLines),
            AIFunctionFactory.Create(DeleteFile),
            AIFunctionFactory.Create(ValidateWorkspace),
            AIFunctionFactory.Create(RunShell),
            AIFunctionFactory.Create(CreateWorkspaceFolder)
        };
    }

    public IReadOnlyList<string> GetMutatedFiles()
    {
        lock (mutationLock) return mutatedFiles.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public bool HasUnvalidatedMutations => MutationVersion > LastSuccessfulValidationMutationVersion;

    public string DetectDefaultValidationCommand() => DetectValidationCommand();

    public void SetDiagnostics(IEnumerable<DiagnosticSnapshotItem>? items)
    {
        lock (diagnosticsLock)
        {
            diagnostics = (items ?? Array.Empty<DiagnosticSnapshotItem>())
                .Where(d => d is not null)
                .Take(200)
                .ToList();
        }
    }

    public string GetDiagnosticsSummary(int maxResults = 20) => FormatDiagnostics(null, maxResults, includeHeader: true);

    [Description("Returns the active repository instruction file Junior is using, plus other detected instruction files. Use this when behavior depends on project guidance or coding conventions.")]
    public string GetRepoInstructions()
    {
        var info = GetRepoInstructionInfo();
        if (string.IsNullOrWhiteSpace(info.Source)) return "(no repository instruction files found)";
        var sb = new StringBuilder();
        sb.Append("# Active repository instructions: ").AppendLine(info.Source);
        if (info.Candidates.Count > 1)
            sb.Append("# Detected instruction files, in precedence order: ").AppendLine(string.Join(", ", info.Candidates));
        if (info.Truncated) sb.AppendLine("# Content was truncated for context budget.");
        sb.AppendLine("```markdown");
        sb.AppendLine(info.Text);
        sb.AppendLine("```");
        return sb.ToString();
    }

    public RepoInstructionInfo GetRepoInstructionInfo(int maxChars = 4000)
    {
        var candidates = new List<string>();
        if (string.IsNullOrWhiteSpace(WorkspaceRoot) || !Directory.Exists(WorkspaceRoot))
            return new RepoInstructionInfo(string.Empty, string.Empty, false, candidates);

        string activeSource = string.Empty;
        string activeText = string.Empty;
        var truncated = false;
        foreach (var rel in RepoInstructionCandidates)
        {
            try
            {
                var path = Path.Combine(WorkspaceRoot, rel);
                if (!File.Exists(path)) continue;
                var text = File.ReadAllText(path).Trim();
                if (text.Length == 0) continue;
                var normalized = rel.Replace('\\', '/');
                candidates.Add(normalized);
                if (activeSource.Length > 0) continue;
                activeSource = normalized;
                if (maxChars > 0 && text.Length > maxChars)
                {
                    activeText = text.Substring(0, maxChars) + "\n(truncated)";
                    truncated = true;
                }
                else
                {
                    activeText = text;
                }
            }
            catch { }
        }
        return new RepoInstructionInfo(activeSource, activeText, truncated, candidates);
    }

    public string BuildRepairTargetSummary(string validationResult, int maxResults = 12)
    {
        if (maxResults <= 0) maxResults = 12;
        if (maxResults > 50) maxResults = 50;
        var targets = new List<RepairTarget>();
        lock (diagnosticsLock)
        {
            foreach (var item in diagnostics)
            {
                var file = NormalizeTargetPath(item.File);
                if (string.IsNullOrWhiteSpace(file)) continue;
                targets.Add(new RepairTarget(
                    Source: "Visual Studio",
                    Severity: string.IsNullOrWhiteSpace(item.Severity) ? "Diagnostic" : item.Severity!.Trim(),
                    File: file,
                    Line: item.Line.GetValueOrDefault(),
                    Column: item.Column.GetValueOrDefault(),
                    Code: item.Code ?? string.Empty,
                    Message: item.Message ?? string.Empty));
            }
        }

        ExtractValidationTargets(validationResult, targets);
        var ordered = targets
            .Where(t => !string.IsNullOrWhiteSpace(t.File))
            .GroupBy(t => t.Key, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .OrderBy(t => SeverityRank(t.Severity))
            .ThenBy(t => t.File, StringComparer.OrdinalIgnoreCase)
            .ThenBy(t => t.Line)
            .ThenBy(t => t.Column)
            .Take(maxResults)
            .ToList();

        if (ordered.Count == 0) return "(no file/line repair targets were detected)";
        var sb = new StringBuilder();
        sb.Append("# Repair targets: ").Append(ordered.Count).AppendLine();
        foreach (var target in ordered)
        {
            sb.Append("- ").Append(target.Source).Append(' ')
              .Append(string.IsNullOrWhiteSpace(target.Severity) ? "Diagnostic" : target.Severity.Trim());
            if (!string.IsNullOrWhiteSpace(target.Code)) sb.Append(' ').Append(target.Code.Trim());
            sb.Append("  ").Append(target.File);
            if (target.Line > 0) sb.Append(':').Append(target.Line);
            if (target.Column > 0) sb.Append(':').Append(target.Column);
            if (!string.IsNullOrWhiteSpace(target.Message)) sb.Append("  ").Append(target.Message.Trim());
            sb.AppendLine();
        }
        if (targets.Count > ordered.Count) sb.AppendLine($"(truncated; {targets.Count} candidate target(s) detected)");
        return sb.ToString();
    }

    private void NoteMutation(string path)
    {
        var normalized = (path ?? string.Empty).Replace('\\', '/').TrimStart('/');
        lock (mutationLock)
        {
            MutationVersion++;
            if (normalized.Length > 0) mutatedFiles.Add(normalized);
        }
    }

    [Description("Returns the absolute path of the current workspace root that the agent is allowed to read and write.")]
    public string GetWorkspaceRoot() => string.IsNullOrEmpty(WorkspaceRoot) ? "(none)" : WorkspaceRoot;

    [Description("Creates a new empty workspace folder when no workspace is open in Visual Studio. The folder is created under the user's source\\repos directory and becomes the active workspace root for subsequent tool calls. Visual Studio will be asked to open it as a folder.")]
    public string CreateWorkspaceFolder(
        [Description("Folder name (no path separators). Example: 'AcmeApi'.")] string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "ERROR: name is empty";
        if (name.IndexOfAny(new[] { '/', '\\', ':', '*', '?', '"', '<', '>', '|' }) >= 0)
            return "ERROR: name must be a simple folder name without separators";
        Directory.CreateDirectory(ScratchRoot);
        var full = Path.GetFullPath(Path.Combine(ScratchRoot, name));
        if (!full.StartsWith(Path.GetFullPath(ScratchRoot), StringComparison.OrdinalIgnoreCase))
            return "ERROR: invalid name";
        Directory.CreateDirectory(full);
        WorkspaceRoot = full;
        WorkspaceFolderCreated?.Invoke(full);
        return $"Created and activated workspace at {full}. Visual Studio will open this folder.";
    }

    [Description("Lists files known to the workspace index. Returns workspace-relative paths plus size in bytes. Much faster than ListDir for getting an overview.")]
    public string ListWorkspaceFiles(
        [Description("Optional path prefix to filter by, e.g. 'src/' or 'src/JuniorStudio.Agent'. Empty = all files.")] string? prefix = null,
        [Description("Maximum entries to return. Default 200, max 1000.")] int maxResults = 200)
    {
        if (string.IsNullOrWhiteSpace(WorkspaceRoot)) return "ERROR: no workspace open";
        if (maxResults <= 0) maxResults = 200;
        if (maxResults > 1000) maxResults = 1000;
        var all = Index.GetAll();
        if (all.Count == 0) return "(workspace index is empty or still loading)";
        IEnumerable<WorkspaceIndex.FileEntry> q = all;
        if (!string.IsNullOrEmpty(prefix))
        {
            var p = prefix!.Replace('\\', '/').TrimStart('/');
            q = q.Where(f => f.RelativePath.StartsWith(p, StringComparison.OrdinalIgnoreCase));
        }
        var list = q.Take(maxResults + 1).ToList();
        var truncated = list.Count > maxResults;
        if (truncated) list.RemoveAt(list.Count - 1);
        var sb = new StringBuilder();
        sb.Append("# files: ").Append(list.Count);
        if (truncated) sb.Append(" (truncated; total indexed = ").Append(all.Count).Append(")");
        sb.AppendLine();
        foreach (var f in list)
            sb.Append(f.RelativePath).Append('\t').Append(f.Size).AppendLine("B");
        return sb.ToString();
    }

    [Description("Finds files by substring match against workspace-relative paths. Useful for locating files when you don't know the exact path.")]
    public string FindFiles(
        [Description("Substring to match against file paths (case-insensitive). Examples: 'AgentHost', '.csproj', 'src/api/'.")] string query,
        [Description("Maximum results. Default 50, max 200.")] int maxResults = 50)
    {
        if (string.IsNullOrWhiteSpace(query)) return "ERROR: query is empty";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot)) return "ERROR: no workspace open";
        if (maxResults <= 0) maxResults = 50;
        if (maxResults > 200) maxResults = 200;
        var hits = Index.Search(query, maxResults);
        if (hits.Count == 0) return $"(no files matched '{query}')";
        var sb = new StringBuilder();
        sb.Append("# matches: ").Append(hits.Count).AppendLine();
        foreach (var f in hits) sb.AppendLine(f.RelativePath);
        return sb.ToString();
    }

    [Description("Returns a compact tree view of the workspace (directories + files, capped at 150 lines). Call this once at the start of a task to understand the project layout.")]
    public string GetWorkspaceTree()
    {
        if (string.IsNullOrWhiteSpace(WorkspaceRoot)) return "ERROR: no workspace open";
        return Index.BuildTreeSnapshot(150);
    }

    [Description("Lists files and subdirectories under a workspace-relative path. Returns up to 200 entries.")]
    public string ListDir(
        [Description("Path relative to the workspace root. Use '.' or '' for the root itself.")] string path)
    {
        var full = ResolveInsideWorkspace(path);
        if (!Directory.Exists(full)) return $"ERROR: not a directory: {path}";
        var sb = new StringBuilder();
        int n = 0;
        foreach (var d in Directory.EnumerateDirectories(full).Take(100))
        {
            sb.Append(Path.GetFileName(d)).AppendLine("/");
            if (++n >= 200) break;
        }
        foreach (var f in Directory.EnumerateFiles(full).Take(200))
        {
            sb.AppendLine(Path.GetFileName(f));
            if (++n >= 200) break;
        }
        return sb.Length == 0 ? "(empty)" : sb.ToString();
    }

    [Description("Reads the contents of a UTF-8 text file in the workspace. Returns the full text (up to 100 KB).")]
    public string ReadFile(
        [Description("Workspace-relative file path.")] string path)
    {
        var full = ResolveInsideWorkspace(path);
        if (!File.Exists(full)) return $"ERROR: file not found: {path}";
        var info = new FileInfo(full);
        if (info.Length > 100 * 1024) return $"ERROR: file is too large ({info.Length} bytes); read smaller files or summarize.";
        return File.ReadAllText(full);
    }

    [Description("Overwrites a UTF-8 text file in the workspace, creating parent directories as needed. Use this when modifying an existing file.")]
    public async Task<string> WriteFile(
        [Description("Workspace-relative file path.")] string path,
        [Description("Full new contents of the file.")] string content,
        CancellationToken ct = default)
    {
        var full = ResolveInsideWorkspace(path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var original = File.Exists(full) ? File.ReadAllText(full) : string.Empty;
        var updated = content ?? string.Empty;
        var refusal = await RequireApprovalAsync("write", BuildChangeApprovalDescription(File.Exists(full) ? "Overwrite file" : "Write new file", path, original, updated), ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        File.WriteAllText(full, content ?? string.Empty);
        NoteMutation(path);
        return $"Wrote {content?.Length ?? 0} chars to {path}";
    }

    [Description("Creates a new UTF-8 text file. Fails if the file already exists.")]
    public async Task<string> CreateFile(
        [Description("Workspace-relative file path.")] string path,
        [Description("Full contents of the new file.")] string content,
        CancellationToken ct = default)
    {
        var full = ResolveInsideWorkspace(path);
        if (File.Exists(full)) return $"ERROR: file already exists: {path}. Use write_file to overwrite.";
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var refusal = await RequireApprovalAsync("write", BuildChangeApprovalDescription("Create file", path, string.Empty, content ?? string.Empty), ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        File.WriteAllText(full, content ?? string.Empty);
        NoteMutation(path);
        return $"Created {path} ({content?.Length ?? 0} chars)";
    }

    [Description("Applies multiple exact-text replacements to one file atomically. Every hunk is checked before the file is written; if any hunk is missing or ambiguous, no changes are made. Prefer this for multi-location edits in the same file.")]
    public async Task<string> ApplyPatch(
        [Description("Workspace-relative file path.")] string path,
        [Description("Patch hunks. Each hunk has oldText and newText. oldText must match exactly and uniquely at the point it is applied.")] List<PatchHunk> hunks,
        CancellationToken ct = default)
    {
        if (hunks == null || hunks.Count == 0) return "ERROR: no patch hunks supplied";
        if (hunks.Count > 50) return "ERROR: too many patch hunks (max 50)";
        for (var i = 0; i < hunks.Count; i++)
        {
            if (hunks[i] == null) return $"ERROR: hunk {i + 1} is null";
            if (string.IsNullOrEmpty(hunks[i].OldText)) return $"ERROR: hunk {i + 1} oldText is empty";
        }

        var full = ResolveInsideWorkspace(path);
        if (!File.Exists(full)) return $"ERROR: file not found: {path}";
        var info = new FileInfo(full);
        if (info.Length > 1024 * 1024) return $"ERROR: file is too large for patching ({info.Length} bytes)";

        var original = File.ReadAllText(full);
        var patched = original;
        var totalRemoved = 0;
        var totalAdded = 0;

        for (var i = 0; i < hunks.Count; i++)
        {
            var hunk = hunks[i];
            var oldText = hunk.OldText ?? string.Empty;
            var newText = hunk.NewText ?? string.Empty;
            var count = CountOccurrences(patched, oldText);
            if (count == 0)
                return $"ERROR: hunk {i + 1} oldText was not found. No changes were made. Read the current file and retry with exact context.";
            if (count != 1)
                return $"ERROR: hunk {i + 1} oldText appeared {count} times. No changes were made. Provide more surrounding context.";

            patched = ReplaceFirst(patched, oldText, newText);
            totalRemoved += CountLogicalLines(oldText);
            totalAdded += CountLogicalLines(newText);
        }

        if (string.Equals(original, patched, StringComparison.Ordinal))
            return $"Patch made no changes to {path}";

        var refusal = await RequireApprovalAsync("write", BuildChangeApprovalDescription($"Apply {hunks.Count} patch hunk(s)", path, original, patched), ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;

        File.WriteAllText(full, patched);
        NoteMutation(path);
        return $"Applied {hunks.Count} patch hunk(s) to {path}; removed {totalRemoved} line(s), added {totalAdded} line(s).";
    }

    [Description("Replaces an exact text span inside a workspace file. Safer than WriteFile for focused edits because it fails when the old text is missing or appears an unexpected number of times.")]
    public async Task<string> ReplaceText(
        [Description("Workspace-relative file path.")] string path,
        [Description("Exact existing text to replace. Include enough surrounding context to make it unique.")] string oldText,
        [Description("Replacement text.")] string newText,
        [Description("Expected number of replacements. Default 1. Use a higher value only when intentionally replacing repeated identical text.")] int expectedReplacements = 1,
        CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(oldText)) return "ERROR: oldText is empty";
        if (expectedReplacements <= 0) expectedReplacements = 1;

        var full = ResolveInsideWorkspace(path);
        if (!File.Exists(full)) return $"ERROR: file not found: {path}";
        var info = new FileInfo(full);
        if (info.Length > 1024 * 1024) return $"ERROR: file is too large for exact replacement ({info.Length} bytes)";

        var text = File.ReadAllText(full);
        var count = CountOccurrences(text, oldText);
        if (count == 0) return "ERROR: oldText was not found. Read the current file and try again with exact context.";
        if (count != expectedReplacements) return $"ERROR: oldText appeared {count} times, expected {expectedReplacements}. Provide more context or adjust expectedReplacements.";

        var updated = text.Replace(oldText, newText ?? string.Empty);
        var refusal = await RequireApprovalAsync("write", BuildChangeApprovalDescription($"Replace {count} exact text span(s)", path, text, updated), ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        File.WriteAllText(full, updated);
        NoteMutation(path);
        return $"Replaced {count} exact text span(s) in {path}";
    }

    [Description("Replaces a 1-based inclusive line range in a workspace file. Use this for surgical patches after reading the surrounding lines.")]
    public async Task<string> ReplaceLines(
        [Description("Workspace-relative file path.")] string path,
        [Description("1-based start line to replace.")] int startLine,
        [Description("1-based inclusive end line to replace.")] int endLine,
        [Description("Replacement text for the line range. May contain multiple lines.")] string newText,
        CancellationToken ct = default)
    {
        if (startLine <= 0 || endLine < startLine) return "ERROR: invalid line range";

        var full = ResolveInsideWorkspace(path);
        if (!File.Exists(full)) return $"ERROR: file not found: {path}";
        var text = File.ReadAllText(full);
        var newline = text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var hadTrailingNewline = text.EndsWith("\n", StringComparison.Ordinal);
        var normalized = text.Replace("\r\n", "\n");
        var lines = normalized.Split('\n').ToList();
        if (hadTrailingNewline && lines.Count > 0 && lines[^1].Length == 0) lines.RemoveAt(lines.Count - 1);
        if (startLine > lines.Count || endLine > lines.Count) return $"ERROR: line range {startLine}-{endLine} exceeds file length {lines.Count}";

        var replacement = (newText ?? string.Empty).Replace("\r\n", "\n").Split('\n').ToList();
        if (replacement.Count == 1 && replacement[0].Length == 0) replacement.Clear();
        lines.RemoveRange(startLine - 1, endLine - startLine + 1);
        lines.InsertRange(startLine - 1, replacement);
        var updated = string.Join(newline, lines);
        if (hadTrailingNewline) updated += newline;
        var refusal = await RequireApprovalAsync("write", BuildChangeApprovalDescription($"Replace lines {startLine}-{endLine}", path, text, updated), ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        File.WriteAllText(full, updated);
        NoteMutation(path);
        return $"Replaced lines {startLine}-{endLine} in {path}";
    }

    [Description("Deletes a file from the workspace.")]
    public async Task<string> DeleteFile(
        [Description("Workspace-relative file path.")] string path,
        CancellationToken ct = default)
    {
        var full = ResolveInsideWorkspace(path);
        if (!File.Exists(full)) return $"ERROR: file not found: {path}";
        var info = new FileInfo(full);
        var original = info.Length <= 1024 * 1024 && LooksTextual(path) ? File.ReadAllText(full) : string.Empty;
        var refusal = await RequireApprovalAsync("delete", BuildChangeApprovalDescription("Delete file", path, original, string.Empty), ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        File.Delete(full);
        NoteMutation(path);
        return $"Deleted {path}";
    }

    [Description("Searches for a literal substring across indexed workspace files and returns matching file:line lines. Honors workspace excludes (bin/obj/node_modules/.git/etc).")]
    public string SearchText(
        [Description("Substring to search for (case-insensitive).")] string query,
        [Description("Optional file extension filter (e.g. '.cs' or '.ts'). Defaults to all text files.")] string? extension = null)
    {
        if (string.IsNullOrEmpty(query)) return "ERROR: query is empty";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot) || !Directory.Exists(WorkspaceRoot))
            return "ERROR: no workspace open";

        var ext = string.IsNullOrWhiteSpace(extension) ? null : extension!.Trim();
        if (ext is not null && !ext.StartsWith('.')) ext = "." + ext;

        var sb = new StringBuilder();
        int hits = 0;
        var entries = Index.GetAll();
        if (entries.Count == 0)
        {
            // Index hasn't populated yet — wait briefly so first searches don't return empty.
            Index.WaitForInitialScan(2000);
            entries = Index.GetAll();
        }

        foreach (var entry in entries)
        {
            if (ext is not null && !entry.RelativePath.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) continue;
            var full = Path.Combine(WorkspaceRoot, entry.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full)) continue;
            try
            {
                var lines = File.ReadAllLines(full);
                for (int i = 0; i < lines.Length; i++)
                {
                    if (lines[i].IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        sb.Append(entry.RelativePath).Append(':').Append(i + 1).Append(": ").AppendLine(lines[i].Trim());
                        if (++hits >= 100) return sb.AppendLine("(truncated at 100 matches)").ToString();
                    }
                }
            }
            catch { }
        }
        return hits == 0 ? "(no matches)" : sb.ToString();
    }

    [Description("Returns the latest Visual Studio Error List diagnostics snapshot for this workspace. Use this before fixing compile errors or red squiggles.")]
    public string GetDiagnostics(
        [Description("Optional workspace-relative file path filter. Empty = all diagnostics.")] string? path = null,
        [Description("Maximum diagnostics to return. Default 50, max 200.")] int maxResults = 50)
    {
        return FormatDiagnostics(path, maxResults, includeHeader: true);
    }

    [Description("Finds files likely relevant to a natural-language task using filename/content scoring plus boosts for active diagnostics, files changed this session, and C# symbol matches. Returns reasons for each match. Use this before broad reading when the user asks for a feature, bug fix, or architectural question.")]
    public string SearchRelevantFiles(
        [Description("Natural language query describing the task or concept to locate.")] string query,
        [Description("Maximum files to return. Default 8, max 20.")] int maxResults = 8)
    {
        if (string.IsNullOrWhiteSpace(query)) return "ERROR: query is empty";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot) || !Directory.Exists(WorkspaceRoot))
            return "ERROR: no workspace open";
        if (maxResults <= 0) maxResults = 8;
        if (maxResults > 20) maxResults = 20;
        if (Index.Count == 0) Index.WaitForInitialScan(2000);

        var terms = ExtractTerms(query).ToArray();
        if (terms.Length == 0) return "ERROR: query has no searchable terms";
        var diagnosticFiles = GetDiagnosticFiles();
        var changedFiles = GetMutatedFiles().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var symbolHits = GetSymbolHitSummary(terms);
        var scored = new List<RelevantFileScore>();
        foreach (var entry in Index.GetAll())
        {
            var path = entry.RelativePath;
            if (!LooksTextual(path)) continue;
            var score = 0;
            var reasons = new List<string>();
            foreach (var term in terms)
            {
                if (path.IndexOf(term, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    score += 8;
                    AddReason(reasons, "path matches '" + term + "'");
                }
            }
            if (diagnosticFiles.Contains(path))
            {
                score += 30;
                AddReason(reasons, "has active diagnostics");
            }
            if (changedFiles.Contains(path))
            {
                score += 18;
                AddReason(reasons, "changed this session");
            }
            if (symbolHits.TryGetValue(path, out var symbols))
            {
                score += Math.Min(24, symbols.Count * 6);
                AddReason(reasons, "symbol match: " + string.Join(", ", symbols.Take(3)));
            }

            var sampleLines = new List<string>();
            var full = Path.Combine(WorkspaceRoot, path.Replace('/', Path.DirectorySeparatorChar));
            try
            {
                var lines = File.ReadLines(full).Take(400).ToList();
                for (var i = 0; i < lines.Count; i++)
                {
                    var lineScore = 0;
                    foreach (var term in terms)
                    {
                        if (lines[i].IndexOf(term, StringComparison.OrdinalIgnoreCase) >= 0) lineScore++;
                    }
                    if (lineScore <= 0) continue;
                    score += lineScore;
                    AddReason(reasons, "content mentions query terms");
                    if (sampleLines.Count < 3)
                        sampleLines.Add($"{i + 1}: {lines[i].Trim()}");
                }
            }
            catch { }

            if (score > 0) scored.Add(new RelevantFileScore(entry, score, reasons, sampleLines));
        }

        var top = scored
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Entry.RelativePath, StringComparer.OrdinalIgnoreCase)
            .Take(maxResults)
            .ToList();
        if (top.Count == 0) return "(no relevant files found)";

        var sb = new StringBuilder();
        sb.Append("# relevant files for: ").AppendLine(query.Trim());
        foreach (var item in top)
        {
            sb.Append(item.Score.ToString().PadLeft(3)).Append("  ").AppendLine(item.Entry.RelativePath);
            if (item.Reasons.Count > 0)
                sb.Append("     why: ").AppendLine(string.Join("; ", item.Reasons.Take(4)));
            foreach (var line in item.Lines) sb.Append("     ").AppendLine(line);
        }
        return sb.ToString();
    }

    [Description("Runs a build/test/validation command in the workspace and returns diagnostics. If command is empty, chooses a reasonable default such as dotnet build for .NET workspaces.")]
    public async Task<string> ValidateWorkspace(
        [Description("Optional validation command. Examples: 'dotnet build', 'dotnet test', 'npm test'. Empty = auto-detect.")] string? command = null,
        CancellationToken ct = default)
    {
        var actual = string.IsNullOrWhiteSpace(command) ? DetectValidationCommand() : command!.Trim();
        if (string.IsNullOrWhiteSpace(actual)) return "ERROR: could not detect a validation command. Provide one explicitly.";
        var result = await RunShell(actual, ct).ConfigureAwait(false);
        if (ValidationSucceeded(result))
        {
            LastSuccessfulValidationMutationVersion = MutationVersion;
        }
        return result;
    }

    [Description("Runs a short shell command via cmd.exe in the workspace root and returns combined stdout/stderr. 5-minute timeout.")]
    public async Task<string> RunShell(
        [Description("Command line to run, e.g. 'dotnet build', 'git status'.")] string command,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(command)) return "ERROR: empty command";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot) || !Directory.Exists(WorkspaceRoot))
            return "ERROR: no workspace is open in Visual Studio. Open a folder or solution first.";
        var refusal = await RequireApprovalAsync("shell", $"Run: {command}", ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        var psi = new ProcessStartInfo("cmd.exe", "/d /c " + command)
        {
            WorkingDirectory = WorkspaceRoot,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        // Disable MSBuild node reuse so child workers exit promptly and don't keep
        // stdout/stderr pipes open after the parent dies (which would hang our reads).
        psi.EnvironmentVariables["MSBUILDDISABLENODEREUSE"] = "1";
        psi.EnvironmentVariables["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        psi.EnvironmentVariables["DOTNET_NOLOGO"] = "1";
        try
        {
            using var p = Process.Start(psi)!;
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            p.OutputDataReceived += (_, e) => { if (e.Data != null) { lock (stdout) { stdout.AppendLine(e.Data); } } };
            p.ErrorDataReceived += (_, e) => { if (e.Data != null) { lock (stderr) { stderr.AppendLine(e.Data); } } };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            const int timeoutMs = 300_000; // 5 minutes
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                try { p.WaitForExit(5_000); } catch { }
                string so, se;
                lock (stdout) { so = stdout.ToString(); }
                lock (stderr) { se = stderr.ToString(); }
                return $"ERROR: command timed out after {timeoutMs / 1000}s\n--- stdout ---\n{so}\n--- stderr ---\n{se}";
            }
            // Drain any remaining async output.
            try { p.WaitForExit(); } catch { }
            string finalOut, finalErr;
            lock (stdout) { finalOut = stdout.ToString(); }
            lock (stderr) { finalErr = stderr.ToString(); }
            var combined = new StringBuilder();
            combined.AppendLine($"exit {p.ExitCode}");
            if (finalOut.Length > 0) combined.AppendLine("--- stdout ---").Append(finalOut);
            if (finalErr.Length > 0) combined.AppendLine("--- stderr ---").Append(finalErr);
            var s = combined.ToString();
            return s.Length > 8000 ? s.Substring(0, 8000) + "\n(truncated)" : s;
        }
        catch (Exception ex)
        {
            return $"ERROR: {ex.Message}";
        }
    }

    [Description("Finds C# symbols (classes, methods, properties, fields, etc.) by name across the workspace. Use this BEFORE grepping or reading files to jump straight to a declaration. Powered by a Roslyn syntax index that is kept in sync with edits.")]
    public string FindSymbol(
        [Description("Symbol name to search for, case-insensitive substring match. Examples: 'WorkspaceTools', 'SendMessage', 'Configure'.")] string name,
        [Description("Optional kind filter: class, struct, interface, record, enum, delegate, method, constructor, property, field, event, indexer.")] string? kind = null,
        [Description("Maximum results. Default 30, max 100.")] int maxResults = 30)
    {
        if (string.IsNullOrWhiteSpace(name)) return "ERROR: name is empty";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot)) return "ERROR: no workspace open";
        if (maxResults <= 0) maxResults = 30;
        if (maxResults > 100) maxResults = 100;
        if (Symbols.Count == 0) Symbols.WaitForInitialScan(3000);
        var hits = Symbols.Find(name, kind, maxResults);
        if (hits.Count == 0)
            return $"(no symbols matched '{name}'" + (string.IsNullOrWhiteSpace(kind) ? "" : $" of kind '{kind}'") + ")";
        var sb = new StringBuilder();
        sb.Append("# matches: ").Append(hits.Count).AppendLine();
        foreach (var s in hits)
        {
            sb.Append(s.Kind).Append(' ').Append(s.FullName)
              .Append("  @ ").Append(s.FilePath).Append(':').Append(s.Line)
              .AppendLine();
        }
        return sb.ToString();
    }

    [Description("Returns an outline of all C# symbols declared in a single file (types, methods, properties, fields), ordered by line. Use this to understand a file's shape before deciding whether to read its full contents.")]
    public string GetFileOutline(
        [Description("Workspace-relative path to a .cs file.")] string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "ERROR: path is empty";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot)) return "ERROR: no workspace open";
        if (!path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            return "ERROR: outline is only supported for .cs files";
        if (Symbols.Count == 0) Symbols.WaitForInitialScan(3000);
        var symbols = Symbols.GetFileSymbols(path);
        if (symbols.Count == 0) return $"(no symbols indexed for {path}; the file may be missing, empty, or excluded)";
        var sb = new StringBuilder();
        sb.Append("# ").Append(path).Append(" (").Append(symbols.Count).AppendLine(" symbols)");
        foreach (var s in symbols)
        {
            int depth = string.IsNullOrEmpty(s.Container) ? 0 : Math.Min(8, s.Container.Count(c => c == '.') + 1);
            var indent = new string(' ', depth * 2);
            sb.Append(s.Line.ToString().PadLeft(5)).Append("  ")
              .Append(indent).Append(s.Kind).Append(' ').Append(s.Name)
              .AppendLine();
        }
        return sb.ToString();
    }

    [Description("Finds candidate references to a C# symbol by scanning .cs files for the identifier as a whole word. This is a syntax-level approximation (no semantic resolution), so results may include unrelated identifiers with the same name. Returns file:line: snippet for each hit.")]
    public string FindSymbolReferences(
        [Description("Symbol identifier to search for. Use the simple name, e.g. 'Configure' or 'AgentHost'.")] string name,
        [Description("Maximum results. Default 50, max 200.")] int maxResults = 50)
    {
        if (string.IsNullOrWhiteSpace(name)) return "ERROR: name is empty";
        if (string.IsNullOrWhiteSpace(WorkspaceRoot)) return "ERROR: no workspace open";
        if (maxResults <= 0) maxResults = 50;
        if (maxResults > 200) maxResults = 200;

        bool ok = name.Length > 0 && (char.IsLetter(name[0]) || name[0] == '_');
        for (int i = 1; ok && i < name.Length; i++)
            if (!char.IsLetterOrDigit(name[i]) && name[i] != '_') ok = false;
        if (!ok) return "ERROR: name must be a C# identifier";

        if (Index.Count == 0) Index.WaitForInitialScan(2000);
        var entries = Index.GetAll();
        var sb = new StringBuilder();
        int hits = 0;
        foreach (var entry in entries)
        {
            if (!entry.RelativePath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) continue;
            var full = Path.Combine(WorkspaceRoot, entry.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full)) continue;
            string[] lines;
            try { lines = File.ReadAllLines(full); }
            catch { continue; }
            for (int i = 0; i < lines.Length; i++)
            {
                if (ContainsWord(lines[i], name))
                {
                    sb.Append(entry.RelativePath).Append(':').Append(i + 1).Append(": ").AppendLine(lines[i].Trim());
                    if (++hits >= maxResults)
                    {
                        sb.AppendLine($"(truncated at {maxResults} matches)");
                        return sb.ToString();
                    }
                }
            }
        }
        return hits == 0 ? $"(no references to '{name}' found in .cs files)" : sb.ToString();
    }

    private static bool ContainsWord(string line, string word)
    {
        int from = 0;
        while (true)
        {
            int idx = line.IndexOf(word, from, StringComparison.Ordinal);
            if (idx < 0) return false;
            bool leftOk = idx == 0 || !IsIdentChar(line[idx - 1]);
            int end = idx + word.Length;
            bool rightOk = end >= line.Length || !IsIdentChar(line[end]);
            if (leftOk && rightOk) return true;
            from = end;
        }
    }

    private static bool IsIdentChar(char c) => char.IsLetterOrDigit(c) || c == '_';

    private string FormatDiagnostics(string? path, int maxResults, bool includeHeader)
    {
        if (maxResults <= 0) maxResults = 50;
        if (maxResults > 200) maxResults = 200;
        var filter = string.IsNullOrWhiteSpace(path) ? null : path!.Replace('\\', '/').TrimStart('/');
        List<DiagnosticSnapshotItem> snapshot;
        lock (diagnosticsLock) snapshot = diagnostics.ToList();
        if (filter is not null)
        {
            snapshot = snapshot
                .Where(d => (d.File ?? string.Empty).Replace('\\', '/').TrimStart('/').Equals(filter, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        if (snapshot.Count == 0)
            return filter is null ? "(no Visual Studio diagnostics reported)" : $"(no Visual Studio diagnostics reported for {filter})";

        var ordered = snapshot
            .OrderBy(d => SeverityRank(d.Severity))
            .ThenBy(d => d.File ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            .ThenBy(d => d.Line ?? 0)
            .ThenBy(d => d.Column ?? 0)
            .Take(maxResults)
            .ToList();

        var sb = new StringBuilder();
        if (includeHeader)
        {
            sb.Append("# Visual Studio diagnostics: ").Append(ordered.Count);
            if (snapshot.Count > ordered.Count) sb.Append(" of ").Append(snapshot.Count);
            sb.AppendLine();
        }
        foreach (var d in ordered)
        {
            var file = string.IsNullOrWhiteSpace(d.File) ? "(no file)" : d.File!.Replace('\\', '/');
            var line = d.Line.GetValueOrDefault() > 0 ? d.Line.GetValueOrDefault().ToString() : "?";
            var col = d.Column.GetValueOrDefault() > 0 ? d.Column.GetValueOrDefault().ToString() : "?";
            var code = string.IsNullOrWhiteSpace(d.Code) ? string.Empty : " " + d.Code!.Trim();
            sb.Append((d.Severity ?? "Message").Trim()).Append(code).Append("  ")
              .Append(file).Append(':').Append(line).Append(':').Append(col).Append("  ")
              .AppendLine((d.Message ?? string.Empty).Trim());
        }
        return sb.ToString();
    }

    private HashSet<string> GetDiagnosticFiles()
    {
        List<DiagnosticSnapshotItem> snapshot;
        lock (diagnosticsLock) snapshot = diagnostics.ToList();
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in snapshot)
        {
            var file = NormalizeTargetPath(item.File);
            if (!string.IsNullOrWhiteSpace(file)) files.Add(file);
        }
        return files;
    }

    private Dictionary<string, List<string>> GetSymbolHitSummary(IEnumerable<string> terms)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        if (Symbols.Count == 0) Symbols.WaitForInitialScan(1500);
        foreach (var term in terms)
        {
            if (term.Length < 3) continue;
            foreach (var symbol in Symbols.Find(term, max: 40))
            {
                if (!result.TryGetValue(symbol.FilePath, out var list))
                {
                    list = new List<string>();
                    result[symbol.FilePath] = list;
                }
                var label = symbol.Kind + " " + symbol.Name;
                if (!list.Contains(label, StringComparer.OrdinalIgnoreCase)) list.Add(label);
            }
        }
        return result;
    }

    private static void AddReason(List<string> reasons, string reason)
    {
        if (string.IsNullOrWhiteSpace(reason)) return;
        if (!reasons.Contains(reason, StringComparer.OrdinalIgnoreCase)) reasons.Add(reason);
    }

    private static int SeverityRank(string? severity)
    {
        if (string.Equals(severity, "Error", StringComparison.OrdinalIgnoreCase)) return 0;
        if (string.Equals(severity, "Warning", StringComparison.OrdinalIgnoreCase)) return 1;
        return 2;
    }

    private void ExtractValidationTargets(string? validationResult, List<RepairTarget> targets)
    {
        if (string.IsNullOrWhiteSpace(validationResult)) return;
        var patterns = new[]
        {
            @"(?<file>(?:[A-Za-z]:)?[^\r\n:]+?\.(?:cs|xaml|csproj|props|targets|json|xml|js|ts|css|md))\((?<line>\d+)(?:,(?<col>\d+))?\):\s*(?<severity>error|warning)\s*(?<code>[A-Z]+\d+)?\s*:\s*(?<message>.*)",
            @"(?<file>(?:[A-Za-z]:)?[^\r\n:]+?\.(?:cs|xaml|csproj|props|targets|json|xml|js|ts|css|md)):(?<line>\d+):(?<col>\d+):\s*(?<severity>error|warning)\s*(?<code>[A-Z]+\d+)?\s*:?\s*(?<message>.*)"
        };
        foreach (var pattern in patterns)
        {
            foreach (Match match in Regex.Matches(validationResult, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                var file = NormalizeTargetPath(match.Groups["file"].Value);
                if (string.IsNullOrWhiteSpace(file)) continue;
                targets.Add(new RepairTarget(
                    Source: "Validation",
                    Severity: match.Groups["severity"].Value,
                    File: file,
                    Line: ParsePositiveInt(match.Groups["line"].Value),
                    Column: ParsePositiveInt(match.Groups["col"].Value),
                    Code: match.Groups["code"].Value,
                    Message: StripProjectSuffix(match.Groups["message"].Value)));
            }
        }
    }

    private static int ParsePositiveInt(string value)
    {
        return int.TryParse(value, out var parsed) && parsed > 0 ? parsed : 0;
    }

    private string NormalizeTargetPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return string.Empty;
        var cleaned = path.Trim().Trim('"').Replace('\\', '/');
        if (Path.IsPathRooted(cleaned) && !string.IsNullOrWhiteSpace(WorkspaceRoot))
        {
            try
            {
                var root = Path.GetFullPath(WorkspaceRoot);
                var full = Path.GetFullPath(cleaned);
                if (full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    cleaned = Path.GetRelativePath(root, full).Replace('\\', '/');
            }
            catch { }
        }
        return cleaned.TrimStart('/');
    }

    private static string StripProjectSuffix(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var trimmed = value.Trim();
        var projectStart = trimmed.LastIndexOf(" [", StringComparison.Ordinal);
        return projectStart > 0 ? trimmed.Substring(0, projectStart).Trim() : trimmed;
    }

    public static bool ValidationSucceeded(string result)
    {
        if (string.IsNullOrWhiteSpace(result)) return false;
        return result.StartsWith("exit 0", StringComparison.OrdinalIgnoreCase);
    }

    private static int CountOccurrences(string text, string needle)
    {
        var count = 0;
        var index = 0;
        while (true)
        {
            index = text.IndexOf(needle, index, StringComparison.Ordinal);
            if (index < 0) return count;
            count++;
            index += needle.Length;
        }
    }

    private static string ReplaceFirst(string text, string oldText, string newText)
    {
        var index = text.IndexOf(oldText, StringComparison.Ordinal);
        if (index < 0) return text;
        return text.Substring(0, index) + newText + text.Substring(index + oldText.Length);
    }

    private static int CountLogicalLines(string text)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        var normalized = text.Replace("\r\n", "\n");
        var count = normalized.Count(c => c == '\n') + 1;
        if (normalized.EndsWith("\n", StringComparison.Ordinal)) count--;
        return Math.Max(0, count);
    }

    private static string BuildChangeApprovalDescription(string action, string path, string oldText, string newText)
    {
        oldText ??= string.Empty;
        newText ??= string.Empty;
        var removed = CountLogicalLines(oldText);
        var added = CountLogicalLines(newText);
        var sb = new StringBuilder();
        sb.AppendLine(action + ": " + path);
        sb.Append("Changed lines: -").Append(removed).Append(" +").Append(added).AppendLine();
        sb.AppendLine();
        sb.Append(BuildUnifiedDiffPreview(path, oldText, newText, 160));
        return sb.ToString();
    }

    private static string BuildUnifiedDiffPreview(string path, string oldText, string newText, int maxLines)
    {
        if (string.Equals(oldText, newText, StringComparison.Ordinal)) return "(no textual changes)";

        var oldLines = SplitDiffLines(oldText);
        var newLines = SplitDiffLines(newText);
        var prefix = 0;
        while (prefix < oldLines.Count && prefix < newLines.Count && string.Equals(oldLines[prefix], newLines[prefix], StringComparison.Ordinal)) prefix++;

        var suffix = 0;
        while (suffix < oldLines.Count - prefix
               && suffix < newLines.Count - prefix
               && string.Equals(oldLines[oldLines.Count - 1 - suffix], newLines[newLines.Count - 1 - suffix], StringComparison.Ordinal))
        {
            suffix++;
        }

        const int context = 3;
        var oldStart = Math.Max(0, prefix - context);
        var newStart = Math.Max(0, prefix - context);
        var oldChangeEnd = oldLines.Count - suffix;
        var newChangeEnd = newLines.Count - suffix;
        var oldEnd = Math.Min(oldLines.Count, oldChangeEnd + context);
        var newEnd = Math.Min(newLines.Count, newChangeEnd + context);

        var sb = new StringBuilder();
        sb.Append("--- ").AppendLine(path);
        sb.Append("+++ ").AppendLine(path);
        sb.Append("@@ -").Append(oldStart + 1).Append(',').Append(Math.Max(0, oldEnd - oldStart))
          .Append(" +").Append(newStart + 1).Append(',').Append(Math.Max(0, newEnd - newStart)).AppendLine(" @@");

        var emitted = 0;
        void AddLine(char prefixChar, string line)
        {
            if (emitted >= maxLines) return;
            sb.Append(prefixChar).AppendLine(line);
            emitted++;
        }

        for (var i = oldStart; i < prefix && i < oldEnd; i++) AddLine(' ', oldLines[i]);
        for (var i = prefix; i < oldChangeEnd && i < oldEnd; i++) AddLine('-', oldLines[i]);
        for (var i = prefix; i < newChangeEnd && i < newEnd; i++) AddLine('+', newLines[i]);
        for (var i = oldChangeEnd; i < oldEnd; i++) AddLine(' ', oldLines[i]);

        var totalPreviewLines = (prefix - oldStart) + (oldChangeEnd - prefix) + (newChangeEnd - prefix) + (oldEnd - oldChangeEnd);
        if (totalPreviewLines > maxLines) sb.AppendLine("... (diff preview truncated)");
        return sb.ToString();
    }

    private static List<string> SplitDiffLines(string text)
    {
        if (string.IsNullOrEmpty(text)) return new List<string>();
        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
        var parts = normalized.Split('\n').ToList();
        if (parts.Count > 0 && parts[^1].Length == 0) parts.RemoveAt(parts.Count - 1);
        return parts;
    }

    private static IEnumerable<string> ExtractTerms(string query)
    {
        var terms = new List<string>();
        var current = new StringBuilder();
        foreach (var ch in query.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch) || ch == '_') current.Append(ch);
            else FlushTerm(current, terms);
        }
        FlushTerm(current, terms);
        return terms.Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private static void FlushTerm(StringBuilder current, List<string> terms)
    {
        if (current.Length < 3) { current.Clear(); return; }
        var term = current.ToString();
        current.Clear();
        if (term is "the" or "and" or "for" or "with" or "that" or "this" or "from" or "into" or "have" or "will") return;
        terms.Add(term);
    }

    private static bool LooksTextual(string path)
    {
        var ext = Path.GetExtension(path);
        if (string.IsNullOrEmpty(ext)) return true;
        return ext.Equals(".cs", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".csproj", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".sln", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".xaml", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".json", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".xml", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".md", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".js", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".ts", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".css", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".ps1", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase);
    }

    private string DetectValidationCommand()
    {
        if (string.IsNullOrWhiteSpace(WorkspaceRoot) || !Directory.Exists(WorkspaceRoot)) return string.Empty;
        var sln = Directory.EnumerateFiles(WorkspaceRoot, "*.sln", SearchOption.TopDirectoryOnly).FirstOrDefault();
        if (!string.IsNullOrEmpty(sln)) return "dotnet build \"" + Path.GetFileName(sln) + "\"";
        var csproj = Directory.EnumerateFiles(WorkspaceRoot, "*.csproj", SearchOption.AllDirectories)
            .Where(p => !p.Split(Path.DirectorySeparatorChar).Any(part => part.Equals("bin", StringComparison.OrdinalIgnoreCase) || part.Equals("obj", StringComparison.OrdinalIgnoreCase)))
            .OrderBy(p => p.Length)
            .FirstOrDefault();
        if (!string.IsNullOrEmpty(csproj)) return "dotnet build \"" + Path.GetRelativePath(WorkspaceRoot, csproj) + "\"";
        if (File.Exists(Path.Combine(WorkspaceRoot, "package.json"))) return "npm test";
        return string.Empty;
    }

    private string ResolveInsideWorkspace(string? rel)
    {
        rel ??= string.Empty;
        if (string.IsNullOrWhiteSpace(WorkspaceRoot))
            throw new InvalidOperationException("No workspace is open in Visual Studio. Open a folder or solution first.");
        if (Path.IsPathRooted(rel)) throw new InvalidOperationException("Absolute paths are not allowed. Use workspace-relative paths.");
        var rootFull = Path.GetFullPath(WorkspaceRoot);
        var combined = Path.GetFullPath(Path.Combine(rootFull, rel));
        if (!combined.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Path escapes the workspace root.");
        return combined;
    }
}

internal sealed class PatchHunk
{
    [Description("Exact current text to replace. Include enough surrounding context to make this hunk unique.")]
    public string? OldText { get; set; }

    [Description("Replacement text for this hunk.")]
    public string? NewText { get; set; }
}

internal sealed record RepairTarget(
    string Source,
    string Severity,
    string File,
    int Line,
    int Column,
    string Code,
    string Message)
{
    public string Key => string.Join("\u001f", File, Line.ToString(), Column.ToString(), Code ?? string.Empty, Message ?? string.Empty);
}

internal sealed record RepoInstructionInfo(string Source, string Text, bool Truncated, IReadOnlyList<string> Candidates);

internal sealed record RelevantFileScore(
    WorkspaceIndex.FileEntry Entry,
    int Score,
    IReadOnlyList<string> Reasons,
    IReadOnlyList<string> Lines);
