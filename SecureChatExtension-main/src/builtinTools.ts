/**
 * Built-in tools — the set of tools the agent can call to interact with the workspace.
 * These mirror what Copilot's agent mode can do: read/write files, search, terminal, etc.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { ToolDefinition, ToolResult, ToolHandler } from './types';
import { WorkspaceIndexer } from './workspaceIndexer';

export class BuiltinTools {
    private handlers: Map<string, ToolHandler> = new Map();
    private definitions: ToolDefinition[] = [];
    private confirmWrite: boolean = true;
    private confirmTerminal: boolean = true;
    private pendingConfirmations: Map<string, { resolve: (approved: boolean) => void }> = new Map();
    private onConfirmRequest?: (actionId: string, description: string) => void;

    constructor(
        private workspaceIndexer: WorkspaceIndexer
    ) {
        this.loadConfig();
        this.registerAll();
    }

    setConfirmCallback(cb: (actionId: string, description: string) => void) {
        this.onConfirmRequest = cb;
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

    private async requestConfirmation(description: string): Promise<boolean> {
        if (!this.onConfirmRequest) { return true; }
        const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
            this.pendingConfirmations.set(actionId, { resolve });
            this.onConfirmRequest!(actionId, description);
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
                const approved = await this.requestConfirmation(`Write file: ${filePath}`);
                if (!approved) { return { success: false, result: 'User declined the file write.' }; }
            }

            try {
                const uri = vscode.Uri.file(absPath);
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                return { success: true, result: `File written: ${filePath}` };
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
                const approved = await this.requestConfirmation(`Edit file: ${filePath}`);
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
                return { success: true, result: `File edited: ${filePath}` };
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

        // ── run_terminal_command ──
        this.register({
            type: 'function',
            function: {
                name: 'run_terminal_command',
                description: 'Execute a shell command in the workspace root and return stdout/stderr. Use for building, testing, installing packages, git operations, etc. Commands run with a timeout.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The shell command to execute' },
                        cwd: { type: 'string', description: 'Optional working directory relative to workspace root' }
                    },
                    required: ['command']
                }
            }
        }, async (args) => {
            const command = args.command as string;

            // Block dangerous commands
            const dangerous = [/rm\s+-rf\s+\//, /format\s+[a-z]:/i, /del\s+\/s\s+\/q\s+[a-z]:/i];
            for (const d of dangerous) {
                if (d.test(command)) {
                    return { success: false, result: 'Command blocked — potentially destructive system-wide command.' };
                }
            }

            if (this.confirmTerminal) {
                const approved = await this.requestConfirmation(`Run command: ${command}`);
                if (!approved) { return { success: false, result: 'User declined the terminal command.' }; }
            }

            const root = this.getWorkspaceRoot();
            const cwd = args.cwd ? this.validatePath(args.cwd as string) || root : root;

            return new Promise((resolve) => {
                const proc = cp.exec(command, {
                    cwd,
                    timeout: 30000,
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
                    resolve({
                        success: !error,
                        result: output || '(no output)'
                    });
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
                const approved = await this.requestConfirmation(`Delete file: ${filePath}`);
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
    }
}
