/**
 * Built-in tools — the set of tools the agent can call to interact with the workspace.
 * These mirror what Copilot's agent mode can do: read/write files, search, terminal, etc.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { ToolDefinition, ToolResult, ToolHandler } from './types';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';

export class BuiltinTools {
    private handlers: Map<string, ToolHandler> = new Map();
    private definitions: ToolDefinition[] = [];
    private confirmWrite: boolean = true;
    private confirmTerminal: boolean = true;
    private sessionAllowTerminal: boolean = false;
    private sessionAllowWrites: boolean = false;
    private pendingConfirmations: Map<string, { resolve: (approved: boolean) => void }> = new Map();
    private onConfirmRequest?: (actionId: string, description: string, category?: string) => void;

    constructor(
        private workspaceIndexer: WorkspaceIndexer,
        private symbolIndexer: SymbolIndexer,
        private semanticIndexer: SemanticIndexer
    ) {
        this.loadConfig();
        this.registerAll();
    }

    setConfirmCallback(cb: (actionId: string, description: string, category?: string) => void) {
        this.onConfirmRequest = cb;
    }

    allowForSession(category: string) {
        if (category === 'terminal') { this.sessionAllowTerminal = true; }
        if (category === 'write') { this.sessionAllowWrites = true; }
    }

    resetSessionApprovals() {
        this.sessionAllowTerminal = false;
        this.sessionAllowWrites = false;
    }

    resolveConfirmation(actionId: string, approved: boolean) {
        const pending = this.pendingConfirmations.get(actionId);
        if (pending) {
            pending.resolve(approved);
            this.pendingConfirmations.delete(actionId);
        }
    }

    private loadConfig() {
        const cfg = vscode.workspace.getConfiguration('securechat.agent');
        this.confirmWrite = cfg.get<boolean>('confirmWrites') ?? true;
        this.confirmTerminal = cfg.get<boolean>('confirmTerminal') ?? true;
    }

    getDefinitions(): ToolDefinition[] {
        return this.definitions;
    }

    getHandler(name: string): ToolHandler | undefined {
        return this.handlers.get(name);
    }

    private register(def: ToolDefinition, handler: ToolHandler) {
        this.definitions.push(def);
        this.handlers.set(def.function.name, handler);
    }

    private getWorkspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    }

    /** Validate that a file path is within the workspace root to prevent path traversal */
    private validatePath(filePath: string): string | null {
        const root = this.getWorkspaceRoot();
        if (!root) { return null; }
        const resolved = path.resolve(root, filePath);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
            return null;
        }
        return resolved;
    }

    /**
     * Wait briefly for the language server to re-analyze a file, then collect
     * Error/Warning diagnostics.  Returns a newline-separated summary or empty string.
     */
    private async collectDiagnosticsAfterEdit(absPath: string, relPath: string): Promise<string> {
        // Give language servers a moment to refresh
        await new Promise(r => setTimeout(r, 750));
        const uri = vscode.Uri.file(absPath);
        const diags = vscode.languages.getDiagnostics(uri);
        // Only surface errors and warnings — ignore hints/info
        const important = diags.filter(d =>
            d.severity === vscode.DiagnosticSeverity.Error ||
            d.severity === vscode.DiagnosticSeverity.Warning
        );
        if (important.length === 0) { return ''; }
        const lines = important.map(d => {
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
            return `  ${relPath}:${d.range.start.line + 1}: [${sev}] ${d.message}`;
        });
        return '\n\n⚠ Post-edit diagnostics:\n' + lines.join('\n');
    }

    private async requestConfirmation(description: string, category?: string): Promise<boolean> {
        if (!this.onConfirmRequest) { return true; }
        // Check session-level approval
        if (category === 'terminal' && this.sessionAllowTerminal) { return true; }
        if (category === 'write' && this.sessionAllowWrites) { return true; }
        const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
            this.pendingConfirmations.set(actionId, { resolve });
            this.onConfirmRequest!(actionId, description, category);
            // Timeout after 60s — auto-reject
            setTimeout(() => {
                if (this.pendingConfirmations.has(actionId)) {
                    this.pendingConfirmations.delete(actionId);
                    resolve(false);
                }
            }, 60000);
        });
    }

    private registerAll() {
        // ── read_file ──
        this.register({
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read the contents of a file in the workspace. Returns the file content as text. Use relative paths from workspace root.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to the file from workspace root' },
                        startLine: { type: 'string', description: 'Optional start line (1-based)' },
                        endLine: { type: 'string', description: 'Optional end line (1-based, inclusive)' }
                    },
                    required: ['path']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            try {
                const uri = vscode.Uri.file(absPath);
                const bytes = await vscode.workspace.fs.readFile(uri);
                let content = Buffer.from(bytes).toString('utf8');

                const startLine = args.startLine ? parseInt(args.startLine as string, 10) : undefined;
                const endLine = args.endLine ? parseInt(args.endLine as string, 10) : undefined;
                if (startLine || endLine) {
                    const lines = content.split('\n');
                    const s = (startLine || 1) - 1;
                    const e = endLine || lines.length;
                    content = lines.slice(s, e).join('\n');
                }

                // Cap at 50KB to avoid overloading context
                if (content.length > 50000) {
                    content = content.slice(0, 50000) + '\n\n... [truncated — file too large, use startLine/endLine to read sections]';
                }
                return { success: true, result: content };
            } catch (e: unknown) {
                return { success: false, result: `Failed to read file: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── write_file ──
        this.register({
            type: 'function',
            function: {
                name: 'write_file',
                description: 'Create or overwrite a file in the workspace with the given content. Parent directories are created automatically.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to the file from workspace root' },
                        content: { type: 'string', description: 'Full content to write to the file' }
                    },
                    required: ['path', 'content']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const content = args.content as string;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            if (this.confirmWrite) {
                const approved = await this.requestConfirmation(`Write file: ${filePath}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the file write.' }; }
            }

            try {
                const uri = vscode.Uri.file(absPath);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                const diag = await this.collectDiagnosticsAfterEdit(absPath, filePath);
                return { success: true, result: `File written: ${filePath}${diag}` };
            } catch (e: unknown) {
                return { success: false, result: `Failed to write file: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── edit_file ──
        this.register({
            type: 'function',
            function: {
                name: 'edit_file',
                description: 'Replace an exact string in a file with a new string. The old_string must match exactly (including whitespace). Use this for targeted edits.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to the file' },
                        old_string: { type: 'string', description: 'The exact text to find and replace (must match exactly once)' },
                        new_string: { type: 'string', description: 'The replacement text' }
                    },
                    required: ['path', 'old_string', 'new_string']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const oldStr = args.old_string as string;
            const newStr = args.new_string as string;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            if (this.confirmWrite) {
                const approved = await this.requestConfirmation(`Edit file: ${filePath}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the edit.' }; }
            }

            try {
                const uri = vscode.Uri.file(absPath);
                const bytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(bytes).toString('utf8');
                const count = content.split(oldStr).length - 1;
                if (count === 0) {
                    return { success: false, result: 'old_string not found in the file.' };
                }
                if (count > 1) {
                    return { success: false, result: `old_string found ${count} times. Must match exactly once. Add more context.` };
                }
                const updated = content.replace(oldStr, newStr);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
                const diag = await this.collectDiagnosticsAfterEdit(absPath, filePath);
                return { success: true, result: `File edited: ${filePath}${diag}` };
            } catch (e: unknown) {
                return { success: false, result: `Failed to edit file: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── list_directory ──
        this.register({
            type: 'function',
            function: {
                name: 'list_directory',
                description: 'List files and subdirectories in a directory. Returns names with / suffix for directories.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to directory (use "" or "." for workspace root)' }
                    },
                    required: ['path']
                }
            }
        }, async (args) => {
            const dirPath = (args.path as string) || '.';
            const absPath = this.validatePath(dirPath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            try {
                const uri = vscode.Uri.file(absPath);
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const listing = entries.map(([name, type]: [string, vscode.FileType]) =>
                    type === vscode.FileType.Directory ? name + '/' : name
                ).sort();
                return { success: true, result: listing.join('\n') };
            } catch (e: unknown) {
                return { success: false, result: `Failed to list directory: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── search_files ──
        this.register({
            type: 'function',
            function: {
                name: 'search_files',
                description: 'Search for files whose path matches a query string. Returns matching file paths.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Substring to search for in file paths' }
                    },
                    required: ['query']
                }
            }
        }, async (args) => {
            const query = args.query as string;
            const matches = this.workspaceIndexer.searchFiles(query);
            if (matches.length === 0) {
                return { success: true, result: 'No files match.' };
            }
            return { success: true, result: matches.slice(0, 50).join('\n') };
        });

        // ── grep_search ──
        this.register({
            type: 'function',
            function: {
                name: 'grep_search',
                description: 'Search for a text pattern (regex or literal) across files in the workspace. Returns matching lines with file paths and line numbers.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: 'Search pattern (text or regex)' },
                        include: { type: 'string', description: 'Optional glob to limit which files to search (e.g. "**/*.ts")' },
                        isRegex: { type: 'string', description: '"true" if pattern is regex, "false" for literal (default: false)' }
                    },
                    required: ['pattern']
                }
            }
        }, async (args) => {
            const pattern = args.pattern as string;
            const include = args.include as string | undefined;
            const isRegex = (args.isRegex as string) === 'true';

            try {
                const regex = isRegex ? new RegExp(pattern, 'i') : null;
                const root = this.getWorkspaceRoot();
                const excludeConfig = vscode.workspace.getConfiguration('securechat.workspace')
                    .get<string[]>('excludePatterns') || [];
                const exclude = excludeConfig.length > 0 ? `{${excludeConfig.join(',')}}` : undefined;

                const uris = await vscode.workspace.findFiles(include || '**/*', exclude, 5000);
                const results: string[] = [];
                const maxResults = 50;

                for (const uri of uris) {
                    if (results.length >= maxResults) { break; }
                    try {
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        const content = Buffer.from(bytes).toString('utf8');
                        const lines = content.split('\n');
                        const relPath = vscode.workspace.asRelativePath(uri, false);

                        for (let i = 0; i < lines.length; i++) {
                            if (results.length >= maxResults) { break; }
                            const match = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(pattern.toLowerCase());
                            if (match) {
                                results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                            }
                        }
                    } catch {
                        // skip unreadable
                    }
                }

                return {
                    success: true,
                    result: results.length > 0
                        ? results.join('\n')
                        : 'No matches found.'
                };
            } catch (e: unknown) {
                return { success: false, result: `Search failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── semantic_search ──
        this.register({
            type: 'function',
            function: {
                name: 'semantic_search',
                description: 'Find conceptually relevant code snippets by meaning (not just exact keyword matches). Best for architecture/questions like "where is model selection handled" or "how does indexing work".',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Natural language or keyword query describing what you need' },
                        maxResults: { type: 'string', description: 'Optional max number of chunks to return (default 8, max 20)' }
                    },
                    required: ['query']
                }
            }
        }, async (args) => {
            const query = args.query as string;
            const requested = args.maxResults ? parseInt(args.maxResults as string, 10) : 8;
            const maxResults = Math.max(1, Math.min(20, isNaN(requested) ? 8 : requested));

            const matches = this.semanticIndexer.search(query, maxResults);
            if (matches.length === 0) {
                return { success: true, result: 'No semantic matches found. Try broader wording or run Index Workspace first.' };
            }

            const sections: string[] = [];
            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                const snippet = m.text.length > 1200 ? `${m.text.slice(0, 1200)}\n... [truncated]` : m.text;
                sections.push(
                    `Match ${i + 1}: ${m.filePath}:${m.startLine}-${m.endLine} (score ${m.score.toFixed(3)})\n${snippet}`
                );
            }

            const result = sections.join('\n\n');
            return {
                success: true,
                result: result.length > 20000 ? `${result.slice(0, 20000)}\n\n... [truncated]` : result
            };
        });

        // ── get_file_tree ──
        this.register({
            type: 'function',
            function: {
                name: 'get_file_tree',
                description: 'Get the workspace file tree showing all indexed files and directories.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        }, async () => {
            return { success: true, result: this.workspaceIndexer.getFileTree() };
        });

        // ── get_document_symbols ──
        this.register({
            type: 'function',
            function: {
                name: 'get_document_symbols',
                description: 'List symbols (classes, functions, methods, variables, etc.) for a specific file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative file path from workspace root' }
                    },
                    required: ['path']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            const relPath = vscode.workspace.asRelativePath(vscode.Uri.file(absPath), false);
            const symbols = this.symbolIndexer.getFileSymbols(relPath);
            if (symbols.length === 0) {
                return { success: true, result: `No symbols found for ${relPath}.` };
            }

            const lines = symbols.slice(0, 200).map(s => {
                const container = s.containerName ? ` (in ${s.containerName})` : '';
                return `${s.filePath}:${s.line}:${s.character} [${s.kind}] ${s.name}${container}`;
            });
            return { success: true, result: lines.join('\n') };
        });

        // ── find_symbol ──
        this.register({
            type: 'function',
            function: {
                name: 'find_symbol',
                description: 'Find symbol definitions by name across the indexed workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Symbol name or partial name to search for' },
                        includeLocals: { type: 'string', description: 'Optional: "true" to include local variables/properties/parameters (default false)' }
                    },
                    required: ['name']
                }
            }
        }, async (args) => {
            const name = args.name as string;
            const includeLocals = (args.includeLocals as string) === 'true';
            const preferredKinds = new Set(['Class', 'Interface', 'Method', 'Function', 'Constructor', 'Namespace', 'Enum']);

            let matches = this.symbolIndexer.findSymbolsByName(name, 200);

            // Default mode: filter to high-signal symbol kinds for cleaner navigation results.
            if (!includeLocals) {
                matches = matches.filter(s => preferredKinds.has(s.kind));
            }

            // De-duplicate by file + line + name (requested UX behavior).
            const deduped: typeof matches = [];
            const seen = new Set<string>();
            for (const s of matches) {
                const key = `${s.filePath}|${s.line}|${s.name}`;
                if (seen.has(key)) { continue; }
                seen.add(key);
                deduped.push(s);
            }

            if (deduped.length === 0) {
                return { success: true, result: `No symbol matches for "${name}".` };
            }

            const lines = deduped.slice(0, 100).map(s => {
                const container = s.containerName ? ` (in ${s.containerName})` : '';
                return `${s.filePath}:${s.line}:${s.character} [${s.kind}] ${s.name}${container}`;
            });
            return { success: true, result: lines.join('\n') };
        });

        // ── go_to_definition ──
        this.register({
            type: 'function',
            function: {
                name: 'go_to_definition',
                description: 'Find the definition location for a symbol in a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative file path containing a symbol usage' },
                        symbol: { type: 'string', description: 'Symbol name to resolve' },
                        lineHint: { type: 'string', description: 'Optional 1-based line number where symbol appears' }
                    },
                    required: ['path', 'symbol']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const symbol = args.symbol as string;
            const lineHint = args.lineHint ? parseInt(args.lineHint as string, 10) : undefined;

            const resolved = await this.resolveSymbolPosition(filePath, symbol, lineHint);
            if (!resolved) {
                return { success: false, result: `Could not resolve symbol position for ${symbol} in ${filePath}.` };
            }

            try {
                const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
                    'vscode.executeDefinitionProvider',
                    resolved.uri,
                    resolved.position
                );

                if (!defs || defs.length === 0) {
                    return { success: true, result: `No definition found for ${symbol}.` };
                }

                const lines = defs.slice(0, 50).map((d) => {
                    const uri = 'targetUri' in d ? d.targetUri : d.uri;
                    const range = 'targetRange' in d ? d.targetRange : d.range;
                    const rel = vscode.workspace.asRelativePath(uri, false);
                    return `${rel}:${range.start.line + 1}:${range.start.character + 1}`;
                });
                return { success: true, result: lines.join('\n') };
            } catch (e: unknown) {
                return { success: false, result: `Definition lookup failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── find_references ──
        this.register({
            type: 'function',
            function: {
                name: 'find_references',
                description: 'Find references for a symbol in a file.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative file path containing a symbol usage/definition' },
                        symbol: { type: 'string', description: 'Symbol name to find references for' },
                        lineHint: { type: 'string', description: 'Optional 1-based line number where symbol appears' },
                        includeDeclaration: { type: 'string', description: '"true" to include declarations, default false' }
                    },
                    required: ['path', 'symbol']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const symbol = args.symbol as string;
            const lineHint = args.lineHint ? parseInt(args.lineHint as string, 10) : undefined;
            const includeDeclaration = (args.includeDeclaration as string) === 'true';

            const resolved = await this.resolveSymbolPosition(filePath, symbol, lineHint);
            if (!resolved) {
                return { success: false, result: `Could not resolve symbol position for ${symbol} in ${filePath}.` };
            }

            try {
                const refs = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
                    'vscode.executeReferenceProvider',
                    resolved.uri,
                    resolved.position
                );

                if (!refs || refs.length === 0) {
                    return { success: true, result: `No references found for ${symbol}.` };
                }

                const currentFile = vscode.workspace.asRelativePath(resolved.uri, false);
                const currentLine = resolved.position.line + 1;

                const filtered = includeDeclaration
                    ? refs
                    : refs.filter(r => {
                        const rel = vscode.workspace.asRelativePath(r.uri, false);
                        const line = r.range.start.line + 1;
                        return !(rel === currentFile && line === currentLine);
                    });

                const lines = filtered.slice(0, 200).map(r => {
                    const rel = vscode.workspace.asRelativePath(r.uri, false);
                    return `${rel}:${r.range.start.line + 1}:${r.range.start.character + 1}`;
                });
                return {
                    success: true,
                    result: lines.length > 0 ? lines.join('\n') : `No references found for ${symbol} (after filtering declaration).`
                };
            } catch (e: unknown) {
                return { success: false, result: `Reference lookup failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── rename_symbol ──
        this.register({
            type: 'function',
            function: {
                name: 'rename_symbol',
                description: 'Rename a symbol (variable, function, class, etc.) across all files using VS Code\'s rename provider. This is like pressing F2 — it updates all references, imports, and usages project-wide.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to a file containing the symbol' },
                        symbol: { type: 'string', description: 'Current name of the symbol to rename' },
                        newName: { type: 'string', description: 'New name for the symbol' },
                        lineHint: { type: 'number', description: 'Optional 1-based line number where the symbol appears' }
                    },
                    required: ['path', 'symbol', 'newName']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const symbol = args.symbol as string;
            const newName = args.newName as string;
            const lineHint = args.lineHint as number | undefined;

            if (this.confirmWrite) {
                const approved = await this.requestConfirmation(`Rename "${symbol}" → "${newName}" in ${filePath}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the rename.' }; }
            }

            try {
                const resolved = await this.resolveSymbolPosition(filePath, symbol, lineHint);
                if (!resolved) {
                    return { success: false, result: `Could not find symbol "${symbol}" in ${filePath}` };
                }

                const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                    'vscode.executeDocumentRenameProvider',
                    resolved.uri,
                    resolved.position,
                    newName
                );

                if (!edit || edit.size === 0) {
                    return { success: false, result: `Rename provider returned no edits for "${symbol}". The language server may not support rename at this location.` };
                }

                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    return { success: false, result: 'Failed to apply rename edits.' };
                }

                // Summarize what changed
                const entries = edit.entries();
                const fileCount = entries.length;
                let editCount = 0;
                const changedFiles: string[] = [];
                for (const [uri, edits] of entries) {
                    editCount += edits.length;
                    changedFiles.push(vscode.workspace.asRelativePath(uri, false));
                }

                return {
                    success: true,
                    result: `Renamed "${symbol}" → "${newName}" — ${editCount} edit(s) across ${fileCount} file(s):\n${changedFiles.join('\n')}`
                };
            } catch (e: unknown) {
                return { success: false, result: `Rename failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── run_terminal_command ──
        this.register({
            type: 'function',
            function: {
                name: 'run_terminal_command',
                description: 'Execute a shell command in the workspace root and return stdout/stderr. Use for building, testing, installing packages, git operations, etc. Do NOT use for long-running or watch-mode commands (e.g. tsc --watch, npm start, dev servers) — they will time out. Default timeout is 30 seconds; use the timeout_ms parameter for commands that need longer (e.g. full builds).',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The shell command to execute' },
                        cwd: { type: 'string', description: 'Optional working directory relative to workspace root' },
                        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 30000). Use up to 120000 for slow builds. Do not use for indefinite processes.' }
                    },
                    required: ['command']
                }
            }
        }, async (args) => {
            const command = args.command as string;
            const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 30000, 5000), 120000);

            // Block dangerous commands
            const dangerous = [/rm\s+-rf\s+\//, /format\s+[a-z]:/i, /del\s+\/s\s+\/q\s+[a-z]:/i];
            for (const d of dangerous) {
                if (d.test(command)) {
                    return { success: false, result: 'Command blocked — potentially destructive system-wide command.' };
                }
            }

            if (this.confirmTerminal) {
                const approved = await this.requestConfirmation(`Run command: ${command}`, 'terminal');
                if (!approved) { return { success: false, result: 'User declined the terminal command.' }; }
            }

            const root = this.getWorkspaceRoot();
            const cwd = args.cwd ? this.validatePath(args.cwd as string) || root : root;

            return new Promise((resolve) => {
                const proc = cp.exec(command, {
                    cwd,
                    timeout: timeoutMs,
                    maxBuffer: 1024 * 512,
                    env: { ...process.env }
                }, (error: cp.ExecException | null, stdout: string, stderr: string) => {
                    let output = '';
                    if (stdout) { output += stdout; }
                    if (stderr) { output += (output ? '\n' : '') + stderr; }
                    if (error && !output) { output = error.message; }

                    // Cap output
                    if (output.length > 30000) {
                        output = output.slice(0, 30000) + '\n... [output truncated]';
                    }

                    // If timed out but captured output, treat as partial success
                    const timedOut = error && (error as any).killed;
                    if (timedOut && output) {
                        resolve({
                            success: true,
                            result: output + `\n\n⚠ Command timed out after ${timeoutMs / 1000}s but produced output above.`
                        });
                    } else {
                        resolve({
                            success: !error,
                            result: output || '(no output)'
                        });
                    }
                });
            });
        });

        // ── delete_file ──
        this.register({
            type: 'function',
            function: {
                name: 'delete_file',
                description: 'Delete a file from the workspace.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to the file to delete' }
                    },
                    required: ['path']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            if (this.confirmWrite) {
                const approved = await this.requestConfirmation(`Delete file: ${filePath}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the delete.' }; }
            }

            try {
                const uri = vscode.Uri.file(absPath);
                await vscode.workspace.fs.delete(uri);
                return { success: true, result: `Deleted: ${filePath}` };
            } catch (e: unknown) {
                return { success: false, result: `Failed to delete: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── get_diagnostics ──
        this.register({
            type: 'function',
            function: {
                name: 'get_diagnostics',
                description: 'Get compiler errors, warnings and lint issues for a file or all open files from VS Code.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Optional relative path. Leave empty for all diagnostics.' }
                    },
                    required: []
                }
            }
        }, async (args) => {
            const filePath = args.path as string | undefined;
            let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

            if (filePath) {
                const absPath = this.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path.' }; }
                const uri = vscode.Uri.file(absPath);
                diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
            } else {
                diagnostics = vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][];
            }

            const results: string[] = [];
            for (const [uri, diags] of diagnostics) {
                if (diags.length === 0) { continue; }
                const relPath = vscode.workspace.asRelativePath(uri, false);
                for (const d of diags) {
                    const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
                    results.push(`${relPath}:${d.range.start.line + 1}: [${severity}] ${d.message}`);
                }
            }

            return {
                success: true,
                result: results.length > 0 ? results.join('\n') : 'No diagnostics found.'
            };
        });

        // ── get_open_editors ──
        this.register({
            type: 'function',
            function: {
                name: 'get_open_editors',
                description: 'List the currently open editor tabs / files in VS Code.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        }, async () => {
            const tabs = vscode.window.tabGroups.all.flatMap((g: vscode.TabGroup) => g.tabs);
            const files = tabs
                .map((t: vscode.Tab) => {
                    const input = t.input as { uri?: vscode.Uri } | undefined;
                    return input?.uri ? vscode.workspace.asRelativePath(input.uri, false) : null;
                })
                .filter(Boolean);

            return {
                success: true,
                result: files.length > 0 ? files.join('\n') : 'No editors open.'
            };
        });

        // ── apply_code_action ──
        this.register({
            type: 'function',
            function: {
                name: 'apply_code_action',
                description: 'List and optionally apply a VS Code code action (quick-fix / auto-fix) for a diagnostic at a given location. Call with apply=false first to see available fixes, then call again with apply=true and the action title.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to the file' },
                        line: { type: 'number', description: 'Line number (1-based) of the diagnostic' },
                        apply: { type: 'boolean', description: 'If false, list available actions. If true, apply the action matching the title.' },
                        title: { type: 'string', description: 'Title of the code action to apply (required when apply=true)' }
                    },
                    required: ['path', 'line']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const line = (args.line as number) - 1; // convert to 0-based
            const shouldApply = args.apply as boolean ?? false;
            const targetTitle = args.title as string | undefined;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            try {
                const uri = vscode.Uri.file(absPath);
                const range = new vscode.Range(line, 0, line, 1000);
                const actions: vscode.CodeAction[] = await vscode.commands.executeCommand(
                    'vscode.executeCodeActionProvider', uri, range
                );

                if (!actions || actions.length === 0) {
                    return { success: true, result: 'No code actions available at this location.' };
                }

                if (!shouldApply) {
                    // List mode
                    const listing = actions.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
                    return { success: true, result: `Available code actions:\n${listing}` };
                }

                // Apply mode — find matching action
                if (!targetTitle) {
                    return { success: false, result: 'Must provide title when apply=true.' };
                }

                const match = actions.find(a =>
                    a.title.toLowerCase().includes(targetTitle.toLowerCase())
                );
                if (!match) {
                    const listing = actions.map(a => `  - ${a.title}`).join('\n');
                    return { success: false, result: `No action matching "${targetTitle}". Available:\n${listing}` };
                }

                if (this.confirmWrite) {
                    const approved = await this.requestConfirmation(`Apply code action: ${match.title}`, 'write');
                    if (!approved) { return { success: false, result: 'User declined the code action.' }; }
                }

                // Apply workspace edit if present
                if (match.edit) {
                    await vscode.workspace.applyEdit(match.edit);
                }
                // Execute command if present
                if (match.command) {
                    await vscode.commands.executeCommand(
                        match.command.command,
                        ...(match.command.arguments || [])
                    );
                }

                return { success: true, result: `Applied code action: ${match.title}` };
            } catch (e: unknown) {
                return { success: false, result: `Failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        });
    }

    private async resolveSymbolPosition(
        filePath: string,
        symbol: string,
        lineHint?: number
    ): Promise<{ uri: vscode.Uri; position: vscode.Position } | null> {
        const absPath = this.validatePath(filePath);
        if (!absPath) { return null; }
        const uri = vscode.Uri.file(absPath);
        const relPath = vscode.workspace.asRelativePath(uri, false);

        if (lineHint && lineHint > 0) {
            return { uri, position: new vscode.Position(lineHint - 1, 0) };
        }

        const pos = this.symbolIndexer.getPositionForSymbol(relPath, symbol);
        if (pos) {
            return { uri, position: pos };
        }

        // fallback: try to find the symbol text in the file
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString('utf8');
            const lines = content.split('\n');
            const target = symbol.toLowerCase();
            for (let i = 0; i < lines.length; i++) {
                const idx = lines[i].toLowerCase().indexOf(target);
                if (idx >= 0) {
                    return { uri, position: new vscode.Position(i, idx) };
                }
            }
        } catch {
            // ignore
        }

        return null;
    }
}
