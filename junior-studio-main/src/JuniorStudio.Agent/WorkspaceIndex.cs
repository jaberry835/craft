using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace JuniorStudio.Agent;

/// <summary>
/// Workspace file index. On <see cref="SetRoot"/> it scans the workspace once
/// (in the background), persists a cache to %LOCALAPPDATA%\JuniorStudio\index,
/// and watches for file changes so subsequent agent turns see fresh state.
///
/// Ported from SecureChatExtension's workspaceIndexer.ts.
/// </summary>
internal sealed class WorkspaceIndex : IDisposable
{
    public sealed class FileEntry
    {
        [JsonPropertyName("path")] public string RelativePath { get; set; } = "";
        [JsonPropertyName("size")] public long Size { get; set; }
        [JsonPropertyName("mtime")] public long MTimeMs { get; set; }
        [JsonPropertyName("lang")] public string Language { get; set; } = "plaintext";
    }

    private static readonly HashSet<string> ExcludeDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "bin", "obj", "node_modules", ".git", ".vs", ".vscode", ".idea",
        "dist", "out", "build", "target", "__pycache__", ".pytest_cache",
        ".venv", "venv", "env", "packages", "TestResults", ".next", ".nuxt",
        ".cache", ".gradle", ".mvn", "coverage", ".turbo", ".parcel-cache"
    };

    private static readonly HashSet<string> ExcludeExts = new(StringComparer.OrdinalIgnoreCase)
    {
        ".dll", ".pdb", ".exe", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
        ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".tiff",
        ".woff", ".woff2", ".ttf", ".eot", ".otf",
        ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".webm",
        ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
        ".lock", ".log"
    };

    private const long MaxFileSize = 500 * 1024;   // skip files >500 KB
    private const int MaxFiles = 50_000;
    private const int CacheVersion = 1;

    private readonly object _lock = new();
    private readonly Dictionary<string, FileEntry> _files = new(StringComparer.OrdinalIgnoreCase);
    private readonly ManualResetEventSlim _firstScanDone = new(initialState: false);

    private string _root = string.Empty;
    private string? _cachePath;
    private FileSystemWatcher? _watcher;
    private System.Threading.Timer? _saveTimer;
    private CancellationTokenSource? _scanCts;
    private HashSet<string> _gitignoreDirs = new(StringComparer.OrdinalIgnoreCase);

    public string Root => _root;

    public int Count
    {
        get { lock (_lock) return _files.Count; }
    }

    /// <summary>Raised when the workspace root changes (or is cleared). Argument is the new root, or empty string when stopped.</summary>
    public event Action<string>? RootChanged;
    /// <summary>Raised when the initial scan completes after a root change.</summary>
    public event Action? InitialScanCompleted;
    /// <summary>Raised after a tracked file is added or modified. Argument is the workspace-relative path.</summary>
    public event Action<string>? FileUpdated;
    /// <summary>Raised after a tracked file is removed. Argument is the workspace-relative path.</summary>
    public event Action<string>? FileRemoved;

    /// <summary>Set the workspace root and start (or restart) indexing.</summary>
    public void SetRoot(string? root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
        {
            Stop();
            return;
        }

        var full = Path.GetFullPath(root);
        if (string.Equals(_root, full, StringComparison.OrdinalIgnoreCase) && Count > 0) return;

        Stop();
        _root = full;
        _cachePath = ComputeCachePath(_root);
        _gitignoreDirs = ReadGitignoreDirs(_root);
        _scanCts = new CancellationTokenSource();
        var token = _scanCts.Token;
        _firstScanDone.Reset();

        // Run the initial scan on a background thread so Configure returns immediately.
        Task.Run(() =>
        {
            try { ScanAll(token); }
            catch { /* non-fatal */ }
            finally
            {
                _firstScanDone.Set();
                try { InitialScanCompleted?.Invoke(); } catch { }
            }
        }, token);

        StartWatcher();
        try { RootChanged?.Invoke(_root); } catch { }
    }

    /// <summary>Block (up to <paramref name="timeoutMs"/>) for the initial scan to complete. Used so the first agent turn has a populated tree.</summary>
    public bool WaitForInitialScan(int timeoutMs) => _firstScanDone.Wait(timeoutMs);

    public IReadOnlyList<FileEntry> GetAll()
    {
        lock (_lock)
        {
            return _files.Values
                .OrderBy(f => f.RelativePath, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }

    public IReadOnlyList<FileEntry> Search(string query, int max = 100)
    {
        if (string.IsNullOrWhiteSpace(query)) return Array.Empty<FileEntry>();
        lock (_lock)
        {
            return _files.Values
                .Where(f => f.RelativePath.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderBy(f => f.RelativePath, StringComparer.OrdinalIgnoreCase)
                .Take(max)
                .ToList();
        }
    }

    /// <summary>Pretty-print a file tree, capped at <paramref name="maxLines"/>.</summary>
    public string BuildTreeSnapshot(int maxLines = 150)
    {
        var entries = GetAll();
        if (entries.Count == 0)
            return string.IsNullOrEmpty(_root) ? "(no workspace open)" : "(workspace not yet indexed)";

        var dirSet = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in entries)
        {
            var parts = e.RelativePath.Split('/');
            var built = new StringBuilder();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                if (built.Length > 0) built.Append('/');
                built.Append(parts[i]);
                dirSet.Add(built.ToString());
            }
        }

        var all = dirSet.Select(d => d + "/")
            .Concat(entries.Select(e => e.RelativePath))
            .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var sb = new StringBuilder();
        var rootName = Path.GetFileName(_root.TrimEnd(Path.DirectorySeparatorChar));
        if (string.IsNullOrEmpty(rootName)) rootName = _root;
        sb.Append(rootName).AppendLine("/");

        int n = 0;
        foreach (var entry in all)
        {
            var isDir = entry.EndsWith("/");
            var clean = isDir ? entry.TrimEnd('/') : entry;
            var depth = clean.Count(c => c == '/') + 1;
            var indent = new string(' ', depth * 2);
            var name = Path.GetFileName(clean);
            sb.Append(indent).Append(name);
            if (isDir) sb.Append('/');
            sb.AppendLine();
            n++;
            if (n >= maxLines)
            {
                sb.AppendLine($"  ... and {all.Count - n} more entries");
                break;
            }
        }
        return sb.ToString();
    }

    public void Dispose() => Stop();

    // ── scan ──

    private void ScanAll(CancellationToken token)
    {
        var cached = LoadCache();
        var fresh = new Dictionary<string, FileEntry>(StringComparer.OrdinalIgnoreCase);
        int count = 0;

        foreach (var path in EnumerateFiles(_root, token))
        {
            if (token.IsCancellationRequested) return;
            if (count >= MaxFiles) break;

            FileInfo fi;
            try { fi = new FileInfo(path); }
            catch { continue; }
            if (fi.Length > MaxFileSize) continue;

            var rel = ToRelative(path);
            var mtime = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds();

            if (cached.TryGetValue(rel, out var prev) && prev.Size == fi.Length && prev.MTimeMs == mtime)
            {
                fresh[rel] = prev;
            }
            else
            {
                fresh[rel] = new FileEntry
                {
                    RelativePath = rel,
                    Size = fi.Length,
                    MTimeMs = mtime,
                    Language = GuessLanguage(Path.GetExtension(path))
                };
            }
            count++;
        }

        lock (_lock)
        {
            _files.Clear();
            foreach (var kv in fresh) _files[kv.Key] = kv.Value;
        }
        SaveNow();
    }

    private IEnumerable<string> EnumerateFiles(string root, CancellationToken token)
    {
        var stack = new Stack<string>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            if (token.IsCancellationRequested) yield break;
            var dir = stack.Pop();

            string[] subdirs;
            try { subdirs = Directory.GetDirectories(dir); }
            catch { continue; }

            foreach (var sub in subdirs)
            {
                var name = Path.GetFileName(sub);
                if (ExcludeDirs.Contains(name)) continue;
                if (_gitignoreDirs.Contains(name)) continue;
                stack.Push(sub);
            }

            string[] files;
            try { files = Directory.GetFiles(dir); }
            catch { continue; }

            foreach (var f in files)
            {
                var ext = Path.GetExtension(f);
                if (ExcludeExts.Contains(ext)) continue;
                yield return f;
            }
        }
    }

    private string ToRelative(string fullPath)
    {
        var rel = Path.GetRelativePath(_root, fullPath);
        return rel.Replace('\\', '/');
    }

    // ── watcher / incremental ──

    private void StartWatcher()
    {
        try
        {
            _watcher = new FileSystemWatcher(_root)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.DirectoryName,
                InternalBufferSize = 64 * 1024
            };
            _watcher.Created += (_, e) => UpdateOne(e.FullPath);
            _watcher.Changed += (_, e) => UpdateOne(e.FullPath);
            _watcher.Renamed += (_, e) => { RemoveOne(e.OldFullPath); UpdateOne(e.FullPath); };
            _watcher.Deleted += (_, e) => RemoveOne(e.FullPath);
            _watcher.EnableRaisingEvents = true;
        }
        catch
        {
            _watcher = null;
        }
    }

    private bool ShouldTrack(string fullPath)
    {
        var rel = Path.GetRelativePath(_root, fullPath);
        if (string.IsNullOrEmpty(rel) || rel.StartsWith("..")) return false;

        var parts = rel.Replace('\\', '/').Split('/');
        for (int i = 0; i < parts.Length - 1; i++)
        {
            if (ExcludeDirs.Contains(parts[i])) return false;
            if (_gitignoreDirs.Contains(parts[i])) return false;
        }
        var ext = Path.GetExtension(fullPath);
        if (ExcludeExts.Contains(ext)) return false;
        return true;
    }

    private void UpdateOne(string fullPath)
    {
        if (!File.Exists(fullPath)) return;
        if (!ShouldTrack(fullPath)) return;
        try
        {
            var fi = new FileInfo(fullPath);
            if (fi.Length > MaxFileSize) return;
            var rel = ToRelative(fullPath);
            var entry = new FileEntry
            {
                RelativePath = rel,
                Size = fi.Length,
                MTimeMs = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                Language = GuessLanguage(Path.GetExtension(fullPath))
            };
            lock (_lock) _files[rel] = entry;
            ScheduleSave();
            try { FileUpdated?.Invoke(rel); } catch { }
        }
        catch { }
    }

    private void RemoveOne(string fullPath)
    {
        var rel = ToRelative(fullPath);
        bool removed;
        lock (_lock) removed = _files.Remove(rel);
        if (removed)
        {
            ScheduleSave();
            try { FileRemoved?.Invoke(rel); } catch { }
        }
    }

    private void Stop()
    {
        try { _scanCts?.Cancel(); } catch { }
        try { _scanCts?.Dispose(); } catch { }
        _scanCts = null;

        try { _watcher?.Dispose(); } catch { }
        _watcher = null;

        FlushSave();
        lock (_lock) _files.Clear();
        _root = string.Empty;
        _cachePath = null;
        _gitignoreDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        _firstScanDone.Set();
        try { RootChanged?.Invoke(string.Empty); } catch { }
    }

    // ── cache persistence ──

    private static string ComputeCachePath(string root)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(root.ToLowerInvariant()));
        var hash = Convert.ToHexString(bytes).Substring(0, 16);
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "JuniorStudio", "index");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, hash + ".json");
    }

    private Dictionary<string, FileEntry> LoadCache()
    {
        var map = new Dictionary<string, FileEntry>(StringComparer.OrdinalIgnoreCase);
        if (_cachePath is null || !File.Exists(_cachePath)) return map;
        try
        {
            using var fs = File.OpenRead(_cachePath);
            var data = JsonSerializer.Deserialize<CacheFile>(fs);
            if (data is null || data.Version != CacheVersion || data.Root is null) return map;
            if (!string.Equals(data.Root, _root, StringComparison.OrdinalIgnoreCase)) return map;
            if (data.Files is null) return map;
            foreach (var f in data.Files)
            {
                if (!string.IsNullOrEmpty(f.RelativePath))
                    map[f.RelativePath] = f;
            }
        }
        catch { }
        return map;
    }

    private void ScheduleSave()
    {
        try
        {
            _saveTimer?.Dispose();
            _saveTimer = new System.Threading.Timer(_ => SaveNow(), null, 1000, System.Threading.Timeout.Infinite);
        }
        catch { }
    }

    private void FlushSave()
    {
        try { _saveTimer?.Dispose(); _saveTimer = null; } catch { }
        SaveNow();
    }

    private void SaveNow()
    {
        if (_cachePath is null) return;
        try
        {
            CacheFile data;
            lock (_lock)
            {
                data = new CacheFile
                {
                    Version = CacheVersion,
                    Root = _root,
                    Files = _files.Values.ToList()
                };
            }
            var tmp = _cachePath + ".tmp";
            using (var fs = File.Create(tmp))
            {
                JsonSerializer.Serialize(fs, data);
            }
            File.Move(tmp, _cachePath, overwrite: true);
        }
        catch { }
    }

    private sealed class CacheFile
    {
        [JsonPropertyName("version")] public int Version { get; set; }
        [JsonPropertyName("root")] public string? Root { get; set; }
        [JsonPropertyName("files")] public List<FileEntry>? Files { get; set; }
    }

    // ── helpers ──

    /// <summary>Read the workspace root .gitignore and collect simple directory-only patterns.</summary>
    private static HashSet<string> ReadGitignoreDirs(string root)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var path = Path.Combine(root, ".gitignore");
        if (!File.Exists(path)) return set;
        try
        {
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#") || line.StartsWith("!")) continue;
                if (line.IndexOfAny(new[] { '*', '?', '[' }) >= 0) continue; // skip glob patterns
                if (!line.EndsWith("/")) continue; // dir-only
                var name = line.TrimEnd('/').TrimStart('/');
                if (name.Length > 0 && !name.Contains('/')) set.Add(name);
            }
        }
        catch { }
        return set;
    }

    private static string GuessLanguage(string ext) => ext.ToLowerInvariant() switch
    {
        ".cs" => "csharp",
        ".ts" => "typescript",
        ".tsx" => "typescriptreact",
        ".js" => "javascript",
        ".jsx" => "javascriptreact",
        ".py" => "python",
        ".java" => "java",
        ".go" => "go",
        ".rs" => "rust",
        ".rb" => "ruby",
        ".php" => "php",
        ".c" or ".h" => "c",
        ".cpp" or ".hpp" or ".cc" or ".cxx" => "cpp",
        ".swift" => "swift",
        ".kt" or ".kts" => "kotlin",
        ".dart" => "dart",
        ".html" or ".htm" => "html",
        ".css" => "css",
        ".scss" or ".sass" => "scss",
        ".json" => "json",
        ".xml" => "xml",
        ".yaml" or ".yml" => "yaml",
        ".md" or ".markdown" => "markdown",
        ".sql" => "sql",
        ".sh" or ".bash" => "shellscript",
        ".ps1" or ".psm1" or ".psd1" => "powershell",
        ".bicep" => "bicep",
        ".tf" or ".tfvars" => "terraform",
        ".csproj" or ".sln" or ".props" or ".targets" or ".vbproj" or ".fsproj" => "msbuild",
        ".vue" => "vue",
        ".svelte" => "svelte",
        ".toml" => "toml",
        ".ini" or ".cfg" or ".conf" => "ini",
        ".dockerfile" => "dockerfile",
        ".r" => "r",
        _ => "plaintext"
    };
}
