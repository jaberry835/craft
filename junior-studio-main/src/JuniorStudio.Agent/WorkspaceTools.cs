using System.ComponentModel;
using System.Diagnostics;
using System.Text;
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
    private string workspaceRoot = Directory.GetCurrentDirectory();

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
            AIFunctionFactory.Create(DeleteFile),
            AIFunctionFactory.Create(RunShell),
            AIFunctionFactory.Create(CreateWorkspaceFolder)
        };
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
        var refusal = await RequireApprovalAsync("write", $"Write {content?.Length ?? 0} chars to {path}", ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        var full = ResolveInsideWorkspace(path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content ?? string.Empty);
        return $"Wrote {content?.Length ?? 0} chars to {path}";
    }

    [Description("Creates a new UTF-8 text file. Fails if the file already exists.")]
    public async Task<string> CreateFile(
        [Description("Workspace-relative file path.")] string path,
        [Description("Full contents of the new file.")] string content,
        CancellationToken ct = default)
    {
        var refusal = await RequireApprovalAsync("write", $"Create {path} ({content?.Length ?? 0} chars)", ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        var full = ResolveInsideWorkspace(path);
        if (File.Exists(full)) return $"ERROR: file already exists: {path}. Use write_file to overwrite.";
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content ?? string.Empty);
        return $"Created {path} ({content?.Length ?? 0} chars)";
    }

    [Description("Deletes a file from the workspace.")]
    public async Task<string> DeleteFile(
        [Description("Workspace-relative file path.")] string path,
        CancellationToken ct = default)
    {
        var refusal = await RequireApprovalAsync("delete", $"Delete {path}", ct).ConfigureAwait(false);
        if (refusal is not null) return refusal;
        var full = ResolveInsideWorkspace(path);
        if (!File.Exists(full)) return $"ERROR: file not found: {path}";
        File.Delete(full);
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
