using System.Collections.Concurrent;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace JuniorStudio.Agent;

/// <summary>
/// Roslyn syntax-based symbol index over the workspace's C# files.
/// Subscribes to <see cref="WorkspaceIndex"/> change events so it reflects
/// edits without a full rescan. Pure syntax — no MSBuildWorkspace, no
/// compilation — so it stays fast and works on partially-loaded folders.
/// </summary>
internal sealed class SymbolIndex
{
    public sealed class SymbolEntry
    {
        public string Name { get; init; } = "";
        /// <summary>Roslyn declaration kind, e.g. <c>class</c>, <c>method</c>, <c>property</c>.</summary>
        public string Kind { get; init; } = "";
        /// <summary>Containing type/namespace path, dot-separated. Empty for top-level types.</summary>
        public string Container { get; init; } = "";
        /// <summary>Workspace-relative file path (forward slashes).</summary>
        public string FilePath { get; init; } = "";
        /// <summary>1-based line number of the declaration's identifier.</summary>
        public int Line { get; init; }
        /// <summary>Brief signature (first declaration line, trimmed).</summary>
        public string Signature { get; init; } = "";

        public string FullName => string.IsNullOrEmpty(Container) ? Name : Container + "." + Name;
    }

    private readonly WorkspaceIndex _files;
    private readonly object _lock = new();
    /// <summary>relPath -> symbols declared in that file.</summary>
    private readonly Dictionary<string, List<SymbolEntry>> _byFile =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentQueue<string> _pending = new();
    private readonly ManualResetEventSlim _initialDone = new(initialState: true);
    private CancellationTokenSource? _cts;
    private Task? _worker;
    private string _root = string.Empty;

    public SymbolIndex(WorkspaceIndex files)
    {
        _files = files;
        _files.RootChanged += OnRootChanged;
        _files.InitialScanCompleted += OnInitialScanCompleted;
        _files.FileUpdated += OnFileUpdated;
        _files.FileRemoved += OnFileRemoved;
    }

    /// <summary>Total symbols indexed.</summary>
    public int Count
    {
        get { lock (_lock) return _byFile.Values.Sum(v => v.Count); }
    }

    /// <summary>Number of .cs files with symbols.</summary>
    public int FileCount
    {
        get { lock (_lock) return _byFile.Count; }
    }

    /// <summary>Block (up to <paramref name="timeoutMs"/>) for the initial symbol scan to complete.</summary>
    public bool WaitForInitialScan(int timeoutMs) => _initialDone.Wait(timeoutMs);

    /// <summary>
    /// Find symbols whose name contains <paramref name="query"/> (case-insensitive).
    /// Optional <paramref name="kind"/> filter (e.g. "class", "method").
    /// Exact name matches are returned first.
    /// </summary>
    public IReadOnlyList<SymbolEntry> Find(string query, string? kind = null, int max = 50)
    {
        if (string.IsNullOrWhiteSpace(query)) return Array.Empty<SymbolEntry>();
        var q = query.Trim();
        var kindFilter = string.IsNullOrWhiteSpace(kind) ? null : kind!.Trim().ToLowerInvariant();
        var results = new List<SymbolEntry>();
        lock (_lock)
        {
            foreach (var list in _byFile.Values)
            {
                foreach (var s in list)
                {
                    if (kindFilter is not null && !s.Kind.Equals(kindFilter, StringComparison.OrdinalIgnoreCase)) continue;
                    if (s.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0)
                        results.Add(s);
                }
            }
        }
        return results
            .OrderByDescending(s => s.Name.Equals(q, StringComparison.OrdinalIgnoreCase))
            .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(s => s.FilePath, StringComparer.OrdinalIgnoreCase)
            .ThenBy(s => s.Line)
            .Take(max)
            .ToList();
    }

    /// <summary>Returns symbols declared in a single file, ordered by line.</summary>
    public IReadOnlyList<SymbolEntry> GetFileSymbols(string relPath)
    {
        if (string.IsNullOrWhiteSpace(relPath)) return Array.Empty<SymbolEntry>();
        var key = relPath.Replace('\\', '/').TrimStart('/');
        lock (_lock)
        {
            if (_byFile.TryGetValue(key, out var list))
                return list.OrderBy(s => s.Line).ToList();
        }
        return Array.Empty<SymbolEntry>();
    }

    // ── event handlers ──

    private void OnRootChanged(string newRoot)
    {
        // Cancel any in-flight worker, drop state, prepare for the new root.
        try { _cts?.Cancel(); } catch { }
        _cts = null;
        _worker = null;
        while (_pending.TryDequeue(out _)) { }
        lock (_lock) _byFile.Clear();
        _root = newRoot ?? string.Empty;
        if (string.IsNullOrEmpty(_root))
        {
            _initialDone.Set();
        }
        else
        {
            // Wait for WorkspaceIndex's initial scan; symbols populate from
            // OnInitialScanCompleted so we don't double-walk the tree.
            _initialDone.Reset();
        }
    }

    private void OnInitialScanCompleted()
    {
        if (string.IsNullOrEmpty(_root)) { _initialDone.Set(); return; }
        var cts = new CancellationTokenSource();
        _cts = cts;
        var token = cts.Token;
        _worker = Task.Run(() =>
        {
            try
            {
                foreach (var f in _files.GetAll())
                {
                    if (token.IsCancellationRequested) return;
                    if (!IsCSharp(f.RelativePath)) continue;
                    ParseAndStore(f.RelativePath);
                }
                DrainPending(token);
            }
            catch { }
            finally { _initialDone.Set(); }
        }, token);
    }

    private void OnFileUpdated(string relPath)
    {
        if (!IsCSharp(relPath)) return;
        _pending.Enqueue(relPath);
        // If the worker isn't running anymore, kick a small drain task.
        if (_worker is null || _worker.IsCompleted)
        {
            var cts = new CancellationTokenSource();
            _cts = cts;
            var token = cts.Token;
            _worker = Task.Run(() => DrainPending(token), token);
        }
    }

    private void OnFileRemoved(string relPath)
    {
        if (!IsCSharp(relPath)) return;
        var key = relPath.Replace('\\', '/').TrimStart('/');
        lock (_lock) _byFile.Remove(key);
    }

    private void DrainPending(CancellationToken token)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (_pending.TryDequeue(out var rel))
        {
            if (token.IsCancellationRequested) return;
            if (!seen.Add(rel)) continue;
            ParseAndStore(rel);
        }
    }

    private static bool IsCSharp(string relPath) =>
        relPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)
        && !relPath.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)
        && !relPath.EndsWith(".g.i.cs", StringComparison.OrdinalIgnoreCase)
        && !relPath.EndsWith(".designer.cs", StringComparison.OrdinalIgnoreCase);

    // ── parsing ──

    private void ParseAndStore(string relPath)
    {
        if (string.IsNullOrEmpty(_root)) return;
        var key = relPath.Replace('\\', '/').TrimStart('/');
        var full = Path.Combine(_root, key.Replace('/', Path.DirectorySeparatorChar));
        if (!File.Exists(full))
        {
            lock (_lock) _byFile.Remove(key);
            return;
        }

        string text;
        try { text = File.ReadAllText(full); }
        catch
        {
            lock (_lock) _byFile.Remove(key);
            return;
        }

        List<SymbolEntry> symbols;
        try
        {
            var tree = CSharpSyntaxTree.ParseText(text, path: full);
            var root = tree.GetRoot();
            var walker = new Walker(key, tree);
            walker.Visit(root);
            symbols = walker.Symbols;
        }
        catch
        {
            lock (_lock) _byFile.Remove(key);
            return;
        }

        lock (_lock) _byFile[key] = symbols;
    }

    private sealed class Walker : CSharpSyntaxWalker
    {
        private readonly string _file;
        private readonly SyntaxTree _tree;
        private readonly Stack<string> _container = new();
        public List<SymbolEntry> Symbols { get; } = new();

        public Walker(string filePath, SyntaxTree tree) : base(SyntaxWalkerDepth.Node)
        {
            _file = filePath;
            _tree = tree;
        }

        private string CurrentContainer() =>
            _container.Count == 0 ? string.Empty : string.Join(".", _container.Reverse());

        private void Add(string name, string kind, SyntaxToken identifier, SyntaxNode declaration)
        {
            if (string.IsNullOrEmpty(name)) return;
            var span = identifier.GetLocation().GetLineSpan();
            var line = span.StartLinePosition.Line + 1;
            Symbols.Add(new SymbolEntry
            {
                Name = name,
                Kind = kind,
                Container = CurrentContainer(),
                FilePath = _file,
                Line = line,
                Signature = ExtractSignature(declaration)
            });
        }

        private static string ExtractSignature(SyntaxNode node)
        {
            // First non-empty line of the declaration, trimmed and capped.
            var raw = node.ToString();
            using var reader = new StringReader(raw);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                var t = line.Trim();
                if (t.Length == 0) continue;
                return t.Length > 200 ? t.Substring(0, 200) + "…" : t;
            }
            return string.Empty;
        }

        public override void VisitNamespaceDeclaration(NamespaceDeclarationSyntax node)
        {
            _container.Push(node.Name.ToString());
            base.VisitNamespaceDeclaration(node);
            _container.Pop();
        }

        public override void VisitFileScopedNamespaceDeclaration(FileScopedNamespaceDeclarationSyntax node)
        {
            _container.Push(node.Name.ToString());
            base.VisitFileScopedNamespaceDeclaration(node);
            _container.Pop();
        }

        public override void VisitClassDeclaration(ClassDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "class", node.Identifier, node);
            _container.Push(node.Identifier.Text);
            base.VisitClassDeclaration(node);
            _container.Pop();
        }

        public override void VisitStructDeclaration(StructDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "struct", node.Identifier, node);
            _container.Push(node.Identifier.Text);
            base.VisitStructDeclaration(node);
            _container.Pop();
        }

        public override void VisitInterfaceDeclaration(InterfaceDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "interface", node.Identifier, node);
            _container.Push(node.Identifier.Text);
            base.VisitInterfaceDeclaration(node);
            _container.Pop();
        }

        public override void VisitRecordDeclaration(RecordDeclarationSyntax node)
        {
            var kind = node.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "record struct" : "record";
            Add(node.Identifier.Text, kind, node.Identifier, node);
            _container.Push(node.Identifier.Text);
            base.VisitRecordDeclaration(node);
            _container.Pop();
        }

        public override void VisitEnumDeclaration(EnumDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "enum", node.Identifier, node);
            // Don't recurse into enum members — too noisy.
        }

        public override void VisitDelegateDeclaration(DelegateDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "delegate", node.Identifier, node);
        }

        public override void VisitMethodDeclaration(MethodDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "method", node.Identifier, node);
            // Don't recurse into method bodies; locals aren't useful for symbol search.
        }

        public override void VisitConstructorDeclaration(ConstructorDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "constructor", node.Identifier, node);
        }

        public override void VisitPropertyDeclaration(PropertyDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "property", node.Identifier, node);
        }

        public override void VisitEventDeclaration(EventDeclarationSyntax node)
        {
            Add(node.Identifier.Text, "event", node.Identifier, node);
        }

        public override void VisitEventFieldDeclaration(EventFieldDeclarationSyntax node)
        {
            foreach (var v in node.Declaration.Variables)
                Add(v.Identifier.Text, "event", v.Identifier, node);
        }

        public override void VisitFieldDeclaration(FieldDeclarationSyntax node)
        {
            foreach (var v in node.Declaration.Variables)
                Add(v.Identifier.Text, "field", v.Identifier, node);
        }

        public override void VisitIndexerDeclaration(IndexerDeclarationSyntax node)
        {
            Add("this[]", "indexer", node.ThisKeyword, node);
        }
    }
}
