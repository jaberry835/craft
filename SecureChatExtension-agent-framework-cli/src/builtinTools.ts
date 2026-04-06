/**
 * Built-in tools — the set of tools the agent can call to interact with the workspace.
 * These mirror what Copilot's agent mode can do: read/write files, search, terminal, etc.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { AgentPermissionLevel, ToolDefinition, ToolResult, ToolHandler } from './types';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { getSetting } from './config';
import { countLineChanges } from './diffUtils';
import { DEFAULT_PERMISSION_LEVEL, shouldConfirmLocalCategory } from './permissions';

export class BuiltinTools {
    private handlers: Map<string, ToolHandler> = new Map();
    private definitions: ToolDefinition[] = [];
    private permissionLevel: AgentPermissionLevel = DEFAULT_PERMISSION_LEVEL;
    private sessionAllowTerminal: boolean = false;
    private sessionAllowWrites: boolean = false;
    private pendingConfirmations: Map<string, { resolve: (approved: boolean) => void }> = new Map();
    private onConfirmRequest?: (actionId: string, description: string, category?: string, diff?: string) => void;
    private onFileTouched?: (relPath: string, additions: number, deletions: number) => void;
    private onSetPlan?: (steps: { id: string; title: string }[]) => void;
    private onUpdatePlanStep?: (stepId: string, status: string) => void;
    private onTerminalOutput?: (line: string) => void;
    /** Tracks files modified during an agent run. Stores original content for diff/undo. */
    private touchedFiles: Map<string, { relPath: string; isNew: boolean; originalContent: string }> = new Map();
    private originalContentProvider?: vscode.Disposable;
    /** Background terminal processes tracked by ID. */
    private backgroundProcesses: Map<string, { proc: cp.ChildProcess; output: string[]; command: string; startedAt: number; exited: boolean; exitCode: number | null }> = new Map();
    /** Maximum number of concurrent background processes */
    private static readonly MAX_BACKGROUND_PROCESSES = 10;

    constructor(
        private workspaceIndexer: WorkspaceIndexer,
        private symbolIndexer: SymbolIndexer,
        private semanticIndexer: SemanticIndexer
    ) {
        this.registerAll();
        // Provider that serves the pre-edit (snapshot) content for diff views
        this.originalContentProvider = vscode.workspace.registerTextDocumentContentProvider('junior-original', {
            provideTextDocumentContent: (uri: vscode.Uri) => {
                const fileUri = uri.with({ scheme: 'file' });
                const info = this.touchedFiles.get(fileUri.fsPath);
                return info ? info.originalContent : '';
            }
        });
    }

    setConfirmCallback(cb: (actionId: string, description: string, category?: string, diff?: string) => void) {
        this.onConfirmRequest = cb;
    }

    setFileTouchedCallback(cb: (relPath: string, additions: number, deletions: number) => void) {
        this.onFileTouched = cb;
    }

    setPlanCallback(cb: (steps: { id: string; title: string }[]) => void) {
        this.onSetPlan = cb;
    }

    setUpdatePlanStepCallback(cb: (stepId: string, status: string) => void) {
        this.onUpdatePlanStep = cb;
    }

    setTerminalOutputCallback(cb: (line: string) => void) {
        this.onTerminalOutput = cb;
    }

    setPermissionLevel(level: AgentPermissionLevel) {
        this.permissionLevel = level;
    }

    allowForSession(category: string) {
        if (category === 'terminal') { this.sessionAllowTerminal = true; }
        if (category === 'write') { this.sessionAllowWrites = true; }
    }

    resetSessionApprovals() {
        this.sessionAllowTerminal = false;
        this.sessionAllowWrites = false;
    }

    /** Snapshot original content before first edit. Returns true if this is a new snapshot. */
    private async snapshotOriginal(absPath: string, relPath: string): Promise<boolean> {
        if (this.touchedFiles.has(absPath)) { return false; }
        let originalContent = '';
        let isNew = false;
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
            originalContent = Buffer.from(bytes).toString('utf8');
        } catch {
            isNew = true;
        }
        this.touchedFiles.set(absPath, { relPath, isNew, originalContent });
        return true;
    }

    /** Notify callback with +/- counts (snapshot vs current disk content). */
    private notifyFileChanged(absPath: string, relPath: string): void {
        if (!this.onFileTouched) { return; }
        const info = this.touchedFiles.get(absPath);
        if (!info) { return; }
        let newContent = '';
        try {
            newContent = fs.readFileSync(absPath, 'utf8');
        } catch { return; }
        const { additions, deletions } = countLineChanges(info.originalContent, newContent);
        this.onFileTouched(relPath, additions, deletions);
    }

    /** Returns summary of pending file changes (snapshot vs current disk content) */
    getPendingChangeSummary(): { files: string[]; additions: number; deletions: number } | null {
        if (this.touchedFiles.size === 0) { return null; }
        const files: string[] = [];
        let additions = 0, deletions = 0;
        for (const [absPath, info] of this.touchedFiles) {
            files.push(info.relPath);
            try {
                const diskBytes = fs.readFileSync(absPath, 'utf8');
                const delta = countLineChanges(info.originalContent, diskBytes);
                additions += delta.additions;
                deletions += delta.deletions;
            } catch {
                // File was deleted? Ignore
            }
        }
        return files.length > 0 ? { files, additions, deletions } : null;
    }

    /** Undo all pending changes — restore original content from snapshots, delete new files */
    async undoAllChanges(): Promise<void> {
        await this.closeDiffEditors();
        for (const [absPath, info] of this.touchedFiles) {
            const uri = vscode.Uri.file(absPath);
            if (info.isNew) {
                // Close the tab, then delete the new file
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const input = tab.input as { uri?: vscode.Uri } | undefined;
                        if (input?.uri?.fsPath === absPath) {
                            try { await vscode.window.tabGroups.close(tab); } catch { /* ignore */ }
                        }
                    }
                }
                try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
            } else {
                // Restore original content to disk
                await vscode.workspace.fs.writeFile(uri, Buffer.from(info.originalContent, 'utf8'));
                // Refresh the open editor if any
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                if (doc) {
                    await vscode.window.showTextDocument(doc, { preserveFocus: true });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                }
            }
        }
        this.touchedFiles.clear();
    }

    /** Accept all pending changes — changes are already on disk, just clear tracking */
    async keepAllChanges(): Promise<void> {
        await this.closeDiffEditors();
        this.touchedFiles.clear();
    }

    /** Keep a single file — remove it from tracking (changes stay on disk) */
    async keepFile(relPath: string): Promise<void> {
        for (const [absPath, info] of this.touchedFiles) {
            if (info.relPath === relPath) {
                // Close its diff tab if open
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
                        if (input?.original?.scheme === 'junior-original' && input?.modified?.fsPath === absPath) {
                            try { await vscode.window.tabGroups.close(tab); } catch { /* ignore */ }
                        }
                    }
                }
                this.touchedFiles.delete(absPath);
                break;
            }
        }
    }

    /** Undo a single file — restore snapshot, remove from tracking */
    async undoFile(relPath: string): Promise<void> {
        for (const [absPath, info] of this.touchedFiles) {
            if (info.relPath === relPath) {
                const uri = vscode.Uri.file(absPath);
                // Close its diff tab
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
                        if (input?.original?.scheme === 'junior-original' && input?.modified?.fsPath === absPath) {
                            try { await vscode.window.tabGroups.close(tab); } catch { /* ignore */ }
                        }
                    }
                }
                if (info.isNew) {
                    // Close tab and delete new file
                    for (const group of vscode.window.tabGroups.all) {
                        for (const tab of group.tabs) {
                            const tinput = tab.input as { uri?: vscode.Uri } | undefined;
                            if (tinput?.uri?.fsPath === absPath) {
                                try { await vscode.window.tabGroups.close(tab); } catch { /* ignore */ }
                            }
                        }
                    }
                    try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
                } else {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(info.originalContent, 'utf8'));
                    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                    if (doc) {
                        await vscode.window.showTextDocument(doc, { preserveFocus: true });
                        await vscode.commands.executeCommand('workbench.action.files.revert');
                    }
                }
                this.touchedFiles.delete(absPath);
                break;
            }
        }
    }

    /** Check if all files have been individually resolved */
    hasPendingFiles(): boolean {
        return this.touchedFiles.size > 0;
    }

    /** Get the original content and absolute path for a touched file */
    getTouchedFileInfo(relPath: string): { absPath: string; originalContent: string } | undefined {
        for (const [absPath, info] of this.touchedFiles) {
            if (info.relPath === relPath) {
                return { absPath, originalContent: info.originalContent };
            }
        }
        return undefined;
    }

    /** Get touched file info by absolute/fs path */
    getTouchedFileInfoByPath(fsPath: string): { relPath: string; originalContent: string } | undefined {
        const info = this.touchedFiles.get(fsPath);
        if (!info) { return undefined; }
        return { relPath: info.relPath, originalContent: info.originalContent };
    }

    /** Get all touched file relative paths */
    getTouchedFileRelPaths(): string[] {
        return Array.from(this.touchedFiles.values()).map(v => v.relPath);
    }

    /** Snapshot a file before an external writer modifies it so Junior can show diffs later. */
    async trackExternalWriteStart(filePath: string): Promise<void> {
        const resolved = this.resolveWorkspaceFilePath(filePath);
        if (!resolved) { return; }
        await this.snapshotOriginal(resolved.absPath, resolved.relPath);
    }

    /** Recompute change stats for a file modified outside BuiltinTools and surface it in the diff dock. */
    trackExternalWriteComplete(filePath: string): void {
        const resolved = this.resolveWorkspaceFilePath(filePath);
        if (!resolved) { return; }
        if (!this.touchedFiles.has(resolved.absPath)) { return; }
        this.notifyFileChanged(resolved.absPath, resolved.relPath);
    }

    /** Get unified diff string for a specific file (for inline diff rendering) */
    getDiffForFile(relPath: string): string {
        for (const [absPath, info] of this.touchedFiles) {
            if (info.relPath === relPath) {
                let currentContent = '';
                try {
                    currentContent = fs.readFileSync(absPath, 'utf8');
                } catch { return ''; }
                return this.buildInlineDiff(info.originalContent, currentContent);
            }
        }
        return '';
    }

    /** Open diff editors for all touched files (on-disk original vs dirty buffer) */
    async openDiffEditors(): Promise<void> {
        for (const [absPath, info] of this.touchedFiles) {
            const fileUri = vscode.Uri.file(absPath);
            const origUri = fileUri.with({ scheme: 'junior-original' });
            try {
                await vscode.commands.executeCommand('vscode.diff',
                    origUri, fileUri,
                    `${info.relPath} (Junior changes)`,
                    { preview: false, preserveFocus: true }
                );
            } catch { /* best effort */ }
        }
    }

    /** Open diff editor for a single file by its relative path */
    async openDiffForFile(relPath: string): Promise<void> {
        for (const [absPath, info] of this.touchedFiles) {
            if (info.relPath === relPath) {
                const fileUri = vscode.Uri.file(absPath);
                const origUri = fileUri.with({ scheme: 'junior-original' });
                try {
                    await vscode.commands.executeCommand('vscode.diff',
                        origUri, fileUri,
                        `${info.relPath} (Junior changes)`,
                        { preview: false, preserveFocus: false }
                    );
                } catch { /* best effort */ }
                break;
            }
        }
    }

    /** Close all diff editor tabs opened by Junior */
    async closeDiffEditors(): Promise<void> {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri } | undefined;
                if (input?.original?.scheme === 'junior-original') {
                    try { await vscode.window.tabGroups.close(tab); } catch { /* ignore */ }
                }
            }
        }
    }

    dispose() {
        this.originalContentProvider?.dispose();
    }

    /** Discard tracking without saving or reverting */
    clearPendingChanges() {
        this.touchedFiles.clear();
    }

    resolveConfirmation(actionId: string, approved: boolean) {
        const pending = this.pendingConfirmations.get(actionId);
        if (pending) {
            pending.resolve(approved);
            this.pendingConfirmations.delete(actionId);
        }
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

    private resolveWorkspaceFilePath(filePath: string): { absPath: string; relPath: string } | undefined {
        if (!filePath) { return undefined; }
        const root = this.getWorkspaceRoot();
        if (!root) { return undefined; }

        const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        const normalizedRoot = path.resolve(root);
        const normalizedAbs = path.resolve(absPath);
        if (!normalizedAbs.startsWith(normalizedRoot)) {
            return undefined;
        }

        return {
            absPath: normalizedAbs,
            relPath: path.relative(normalizedRoot, normalizedAbs).replace(/\\/g, '/'),
        };
    }

    /** Validate that a file path is within the workspace root to prevent path traversal */
    private validatePath(filePath: string): string | null {
        const root = this.getWorkspaceRoot();
        if (!root) { return null; }
        // Block null bytes (can bypass path checks in some runtimes)
        if (filePath.includes('\0')) { return null; }
        // Block UNC paths on Windows (\\server\share)
        if (/^[\\/]{2}/.test(filePath)) { return null; }
        const resolved = path.resolve(root, filePath);
        // Normalize both to handle trailing separators and case on Windows
        const normalizedResolved = path.normalize(resolved);
        const normalizedRoot = path.normalize(root);
        if (!normalizedResolved.startsWith(normalizedRoot + path.sep) && normalizedResolved !== normalizedRoot) {
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

    private async requestConfirmation(description: string, category?: string, diff?: string): Promise<boolean> {
        if (!this.onConfirmRequest) { return true; }
        if (category === 'terminal') {
            if (this.sessionAllowTerminal || !shouldConfirmLocalCategory(this.permissionLevel, 'terminal')) {
                return true;
            }
        }
        if (category === 'write') {
            if (this.sessionAllowWrites || !shouldConfirmLocalCategory(this.permissionLevel, 'write')) {
                return true;
            }
        }
        const actionId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
            this.pendingConfirmations.set(actionId, { resolve });
            this.onConfirmRequest!(actionId, description, category, diff);
            // Timeout after 120s — auto-reject with visible feedback
            setTimeout(() => {
                if (this.pendingConfirmations.has(actionId)) {
                    this.pendingConfirmations.delete(actionId);
                    // Notify the user visibly so they know what happened
                    vscode.window.showWarningMessage(
                        'Junior: Action confirmation timed out and was automatically declined. You can re-run the task to try again.'
                    );
                    resolve(false);
                }
            }, 120000);
        });
    }

    /**
     * Build a compact unified-style diff string showing only changed lines with context.
     * Returns empty string if contents are identical.
     */
    private buildInlineDiff(oldText: string, newText: string): string {
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        const result: string[] = [];
        const ctx = 2; // context lines around changes

        // Simple LCS-based diff: walk both arrays
        const maxLen = Math.max(oldLines.length, newLines.length);
        let oi = 0, ni = 0;
        interface Hunk { lines: string[]; }
        const hunks: Hunk[] = [];
        let currentHunk: Hunk | null = null;
        let trailingCtx = 0;

        while (oi < oldLines.length || ni < newLines.length) {
            if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
                // matching line
                if (currentHunk) {
                    trailingCtx++;
                    currentHunk.lines.push('  ' + oldLines[oi]);
                    if (trailingCtx >= ctx) {
                        hunks.push(currentHunk);
                        currentHunk = null;
                    }
                }
                oi++; ni++;
            } else {
                // mismatch — consume removed/added
                if (!currentHunk) {
                    currentHunk = { lines: [] };
                    // add leading context
                    const start = Math.max(0, oi - ctx);
                    for (let c = start; c < oi; c++) {
                        currentHunk.lines.push('  ' + oldLines[c]);
                    }
                }
                trailingCtx = 0;
                // find next match using a lookahead
                let foundOi = -1, foundNi = -1;
                const look = 30;
                outer:
                for (let d = 1; d <= look; d++) {
                    for (let a = 0; a <= d; a++) {
                        const b = d - a;
                        if (oi + a < oldLines.length && ni + b < newLines.length && oldLines[oi + a] === newLines[ni + b]) {
                            foundOi = oi + a; foundNi = ni + b; break outer;
                        }
                        if (oi + b < oldLines.length && ni + a < newLines.length && oldLines[oi + b] === newLines[ni + a]) {
                            foundOi = oi + b; foundNi = ni + a; break outer;
                        }
                    }
                }
                if (foundOi >= 0) {
                    for (; oi < foundOi; oi++) { currentHunk.lines.push('- ' + oldLines[oi]); }
                    for (; ni < foundNi; ni++) { currentHunk.lines.push('+ ' + newLines[ni]); }
                } else {
                    // no match found — dump remaining as removed/added
                    for (; oi < oldLines.length; oi++) { currentHunk.lines.push('- ' + oldLines[oi]); }
                    for (; ni < newLines.length; ni++) { currentHunk.lines.push('+ ' + newLines[ni]); }
                }
            }
        }
        if (currentHunk) { hunks.push(currentHunk); }

        if (hunks.length === 0) { return ''; }
        for (const h of hunks) {
            if (result.length > 0) { result.push('  ---'); }
            result.push(...h.lines);
        }
        // Cap at 80 lines to avoid huge diffs in chat
        if (result.length > 80) {
            return result.slice(0, 80).join('\n') + '\n... (' + (result.length - 80) + ' more lines)';
        }
        return result.join('\n');
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
                // Check if document is already open (may be dirty/unsaved from a prior edit)
                const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                let content = openDoc
                    ? openDoc.getText()
                    : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

                const allLines = content.split('\n');
                const totalLines = allLines.length;
                const startLine = args.startLine ? parseInt(args.startLine as string, 10) : undefined;
                const endLine = args.endLine ? parseInt(args.endLine as string, 10) : undefined;

                const s = (startLine || 1) - 1;
                const e = endLine ? Math.min(endLine, totalLines) : totalLines;
                const slice = allLines.slice(s, e);

                // Prepend line numbers for orientation
                const numbered = slice.map((line, i) => `${s + i + 1}: ${line}`).join('\n');
                let result = numbered;
                let wasTruncated = false;

                // Cap at 100KB to avoid overloading context
                if (result.length > 100000) {
                    const truncated = result.slice(0, 100000);
                    const capLine = truncated.split('\n').length + s;
                    result = truncated + `\n\n... [truncated at ~line ${capLine} of ${totalLines}. Use startLine/endLine to read remaining sections.]`;
                    wasTruncated = true;
                }

                // Add range note so model knows what it got
                let rangeNote = '';
                if (startLine || endLine) {
                    rangeNote = `\n[Showing lines ${s + 1}-${e} of ${totalLines}]`;
                } else if (wasTruncated) {
                    // Already noted in truncation message
                } else if (totalLines > 500) {
                    rangeNote = `\n[Read all ${totalLines} lines]`;
                }

                return { success: true, result: result + rangeNote };
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

            try {
                const uri = vscode.Uri.file(absPath);

                // Snapshot original content before any changes
                await this.snapshotOriginal(absPath, filePath);

                // Ensure file exists on disk (for new files, create empty first)
                try {
                    await vscode.workspace.fs.stat(uri);
                } catch {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
                }

                // Write content to disk so git detects the change
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

                // Open document and show it
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

                this.notifyFileChanged(absPath, filePath);

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

            try {
                const uri = vscode.Uri.file(absPath);
                // Snapshot original before first edit
                await this.snapshotOriginal(absPath, filePath);

                // Read current content from open doc or disk
                const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                const content = openDoc
                    ? openDoc.getText()
                    : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

                let matchStr = oldStr;
                let count = content.split(oldStr).length - 1;

                // Fast path: if the file uses CRLF but the model sent LF, try with normalized line endings
                if (count === 0 && content.includes('\r\n') && !oldStr.includes('\r\n')) {
                    const crlfOld = oldStr.replace(/\n/g, '\r\n');
                    const crlfCount = content.split(crlfOld).length - 1;
                    if (crlfCount === 1) {
                        matchStr = crlfOld;
                        count = 1;
                    }
                }

                // Fallback 1: indentation-normalized line-by-line matching
                // Handles tab-vs-spaces, 2-space-vs-4-space, trailing whitespace differences
                if (count === 0) {
                    const contentLines = content.split('\n');
                    const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
                    const trimLine = (s: string) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
                    const trimmedOld = oldLines.map(trimLine);

                    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
                        let matches = true;
                        for (let j = 0; j < oldLines.length; j++) {
                            if (trimLine(contentLines[i + j]) !== trimmedOld[j]) {
                                matches = false;
                                break;
                            }
                        }
                        if (matches) {
                            const candidate = contentLines.slice(i, i + oldLines.length).join('\n');
                            // Verify this is the only match
                            let otherMatch = false;
                            for (let k = i + 1; k <= contentLines.length - oldLines.length; k++) {
                                let m2 = true;
                                for (let j = 0; j < oldLines.length; j++) {
                                    if (trimLine(contentLines[k + j]) !== trimmedOld[j]) {
                                        m2 = false;
                                        break;
                                    }
                                }
                                if (m2) { otherMatch = true; break; }
                            }
                            if (!otherMatch) {
                                matchStr = candidate;
                                count = 1;
                            }
                            break;
                        }
                    }
                }

                // Fallback 2: whitespace-collapsed matching (spaces/tabs → single space)
                if (count === 0) {
                    const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n/g, '\n');
                    const normContent = normalize(content);
                    const normOld = normalize(oldStr);
                    const normIdx = normContent.indexOf(normOld);
                    if (normIdx >= 0 && normContent.indexOf(normOld, normIdx + 1) === -1) {
                        // Single match — map normalized index back to original via incremental scan
                        // Build origToNorm: for each original char index, its normalized output length so far
                        const origToNorm: number[] = new Array(content.length);
                        let normLen = 0;
                        let prevWasSpace = false;
                        let prevWasNewline = false;
                        for (let oi = 0; oi < content.length; oi++) {
                            const ch = content[oi];
                            if (ch === '\r') {
                                // skip \r (handled as part of \r\n → \n)
                            } else if (ch === '\n') {
                                // collapse trailing spaces before newline already handled
                                normLen++;
                                prevWasSpace = false;
                                prevWasNewline = true;
                            } else if (ch === ' ' || ch === '\t') {
                                if (!prevWasSpace) {
                                    normLen++;
                                    prevWasSpace = true;
                                }
                                prevWasNewline = false;
                            } else {
                                normLen++;
                                prevWasSpace = false;
                                prevWasNewline = false;
                            }
                            origToNorm[oi] = normLen;
                        }
                        // Find origStart: first oi where origToNorm[oi] > normIdx
                        let origStart = 0;
                        for (let oi = 0; oi < content.length; oi++) {
                            if (origToNorm[oi] > normIdx) {
                                origStart = oi;
                                break;
                            }
                        }
                        // Expand from origStart to find matching candidate
                        const normEnd = normIdx + normOld.length;
                        for (let end = origStart + normOld.length; end <= content.length; end++) {
                            const candidate = content.slice(origStart, end);
                            if (normalize(candidate) === normOld) {
                                matchStr = candidate;
                                count = 1;
                                break;
                            }
                        }
                    }
                }

                if (count === 0) {
                    // Try to find the best-matching region to help the model
                    const lines = content.split('\n');
                    const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
                    const oldFirstLine = oldLines[0].trim();
                    const oldLastLine = oldLines[oldLines.length - 1].trim();
                    let bestLine = -1;
                    let bestScore = 0;
                    for (let i = 0; i < lines.length; i++) {
                        const trimmed = lines[i].trim();
                        if (trimmed.length === 0) { continue; }
                        if (trimmed.includes(oldFirstLine) || oldFirstLine.includes(trimmed)) {
                            let score = Math.min(trimmed.length, oldFirstLine.length);
                            // Bonus if the last line also matches nearby
                            if (oldLastLine && i + oldLines.length - 1 < lines.length) {
                                const endTrimmed = lines[i + oldLines.length - 1].trim();
                                if (endTrimmed.includes(oldLastLine) || oldLastLine.includes(endTrimmed)) {
                                    score += Math.min(endTrimmed.length, oldLastLine.length);
                                }
                            }
                            if (score > bestScore) { bestScore = score; bestLine = i; }
                        }
                    }
                    let snippet: string;
                    if (bestLine >= 0) {
                        const from = Math.max(0, bestLine - 3);
                        const to = Math.min(lines.length, bestLine + oldLines.length + 5);
                        snippet = lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
                        snippet = `Closest match near line ${bestLine + 1}:\n${snippet}`;
                    } else {
                        snippet = `First 30 lines:\n` + lines.slice(0, Math.min(30, lines.length)).map((l, i) => `${i + 1}: ${l}`).join('\n');
                    }
                    return {
                        success: false,
                        result: `old_string not found in the file (${lines.length} lines). Re-read the file to get exact current content, then retry. ${snippet}`
                    };
                }
                if (count > 1) {
                    // Help the model by showing the first few match locations
                    const lines = content.split('\n');
                    const matchLines: number[] = [];
                    const searchStr = matchStr;
                    let searchFrom = 0;
                    while (matchLines.length < 5) {
                        const idx = content.indexOf(searchStr, searchFrom);
                        if (idx < 0) { break; }
                        const lineNum = content.slice(0, idx).split('\n').length;
                        matchLines.push(lineNum);
                        searchFrom = idx + 1;
                    }
                    const locations = matchLines.length > 0
                        ? ` Found at lines: ${matchLines.join(', ')}${count > 5 ? ` (and ${count - 5} more)` : ''}.`
                        : '';
                    return { success: false, result: `old_string found ${count} times. Must match exactly once. Add more surrounding lines for context to make the match unique.${locations}` };
                }
                // Preserve the file's line-ending style in the replacement text
                let effectiveNewStr = newStr;
                if (matchStr.includes('\r\n') && !newStr.includes('\r\n')) {
                    effectiveNewStr = newStr.replace(/\n/g, '\r\n');
                }
                const updated = content.replace(matchStr, effectiveNewStr);

                // Write updated content to disk so git detects the change
                await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));

                // Open/refresh document and show it
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

                this.notifyFileChanged(absPath, filePath);

                const diag = await this.collectDiagnosticsAfterEdit(absPath, filePath);
                return { success: true, result: `File edited: ${filePath}${diag}` };
            } catch (e: unknown) {
                return { success: false, result: `Failed to edit file: ${e instanceof Error ? e.message : String(e)}` };
            }
        });

        // ── replace_lines ──
        this.register({
            type: 'function',
            function: {
                name: 'replace_lines',
                description: 'Replace a range of lines in a file with new content. Use this for larger edits like refactoring a function, rewriting a code block, or replacing 10+ lines where edit_file (exact string match) is fragile. Line numbers are 1-based and inclusive — use the line numbers from read_file output.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Relative path to the file' },
                        start_line: { type: 'number', description: '1-based first line to replace (inclusive)' },
                        end_line: { type: 'number', description: '1-based last line to replace (inclusive)' },
                        new_content: { type: 'string', description: 'The replacement content (replaces lines start_line through end_line)' }
                    },
                    required: ['path', 'start_line', 'end_line', 'new_content']
                }
            }
        }, async (args) => {
            const filePath = args.path as string;
            const startLine = Math.max(1, Math.round(Number(args.start_line)));
            const endLine = Math.max(startLine, Math.round(Number(args.end_line)));
            const newContent = args.new_content as string;
            const absPath = this.validatePath(filePath);
            if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

            try {
                const uri = vscode.Uri.file(absPath);
                await this.snapshotOriginal(absPath, filePath);

                const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                const content = openDoc
                    ? openDoc.getText()
                    : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

                const lines = content.split('\n');
                const totalLines = lines.length;

                if (startLine > totalLines) {
                    return { success: false, result: `start_line ${startLine} is beyond end of file (${totalLines} lines).` };
                }

                const clampedEnd = Math.min(endLine, totalLines);
                const removedLines = lines.slice(startLine - 1, clampedEnd);

                // Safety: warn if replacing a huge chunk (>50% of file)
                const replacePct = removedLines.length / totalLines;
                if (replacePct > 0.5 && totalLines > 20) {
                    // Still allow it, but note the scope in the result
                }

                // Build updated content
                const before = lines.slice(0, startLine - 1);
                const after = lines.slice(clampedEnd);
                const newLines = newContent.split('\n');
                const updated = [...before, ...newLines, ...after].join('\n');

                await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));

                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

                this.notifyFileChanged(absPath, filePath);

                const removed = clampedEnd - startLine + 1;
                const added = newLines.length;
                const diag = await this.collectDiagnosticsAfterEdit(absPath, filePath);
                return {
                    success: true,
                    result: `Replaced lines ${startLine}-${clampedEnd} in ${filePath} (removed ${removed}, added ${added} lines).${diag}`
                };
            } catch (e: unknown) {
                return { success: false, result: `Failed to replace lines: ${e instanceof Error ? e.message : String(e)}` };
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
                const excludeConfig = getSetting<string[]>('workspace.excludePatterns') || [];
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

            const approved = await this.requestConfirmation(`Rename "${symbol}" → "${newName}" in ${filePath}`, 'write');
            if (!approved) { return { success: false, result: 'User declined the rename.' }; }

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
                description: 'Execute a shell command in the workspace root and return stdout/stderr. Output is streamed live. Use for building, testing, installing packages, git operations, etc. Set background=true for long-running processes (dev servers, watchers) — returns a process ID you can check later with check_terminal_output.',
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The shell command to execute' },
                        cwd: { type: 'string', description: 'Optional working directory relative to workspace root' },
                        timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 30000). Use up to 120000 for slow builds. Ignored for background processes.' },
                        background: { type: 'boolean', description: 'If true, start the process in background and return immediately with a process ID. Use for dev servers, watchers, etc.' }
                    },
                    required: ['command']
                }
            }
        }, async (args) => {
            const command = args.command as string;
            const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 30000, 5000), 120000);
            const background = args.background === true || args.background === 'true';

            // Block dangerous commands — comprehensive patterns for both Unix and Windows
            const dangerous: RegExp[] = [
                // Unix destructive removals
                /rm\s+.*-[a-z]*r[a-z]*f[^a-z]|rm\s+.*-[a-z]*f[a-z]*r[^a-z]/i,  // rm -rf, rm -fr, and flag combos
                /rm\s+.*\s+\/(?:\s|$)/,                       // rm ... / (root)
                /rm\s+.*~\//,                                  // rm ~/
                /rm\s+.*\$HOME/i,                               // rm $HOME
                /rm\s+.*\/\*/,                                 // rm /*
                /find\s+\/\s+.*-delete/i,                      // find / -delete
                /mkfs\./i,                                      // mkfs.ext4 etc.
                /dd\s+.*of=\/dev\//i,                          // dd of=/dev/
                /chmod\s+.*-R\s+777\s+\//i,                    // chmod -R 777 /
                /chown\s+.*-R\s+.*\s+\//i,                     // chown -R ... /
                // Dangerous environment/disk operations
                /:(){ :|:& };:/,                                // fork bomb
                />\/dev\/sd[a-z]/i,                             // overwrite raw disk
                // Windows destructive commands
                /format\s+[a-z]:/i,                             // format C:
                /del\s+\/[sfq].*[a-z]:\\?$/i,                  // del /s /q C:\
                /del\s+\/[sfq].*\\\*/i,                        // del /s \*
                /rd\s+\/[sq].*[a-z]:\\?$/i,                    // rd /s /q C:\
                /rmdir\s+\/[sq].*[a-z]:\\?$/i,                 // rmdir /s /q C:\
                // PowerShell destructive commands
                /Remove-Item\s+.*-Recurse.*[\/\\]\s*$/i,       // Remove-Item -Recurse /
                /Remove-Item\s+.*-Recurse.*[a-z]:\\?\s*$/i,    // Remove-Item -Recurse C:\
                /Remove-Item\s+.*~[\/\\]?\s/i,                 // Remove-Item ~/
                /Clear-Content\s+.*[a-z]:\\?\s*$/i,            // Clear-Content C:\
                /Stop-Computer/i,                               // shutdown
                /Restart-Computer/i,                            // reboot
                // Cross-platform dangerous actions
                /shutdown\s/i,                                  // shutdown
                /reboot\b/i,                                    // reboot
                /init\s+0/,                                     // init 0
                /halt\b/i,                                      // halt
            ];
            for (const d of dangerous) {
                if (d.test(command)) {
                    return { success: false, result: 'Command blocked — potentially destructive system-wide command.' };
                }
            }

            const approved = await this.requestConfirmation(`Run command: ${command}${background ? ' (background)' : ''}`, 'terminal');
            if (!approved) { return { success: false, result: 'User declined the terminal command.' }; }

            const root = this.getWorkspaceRoot();
            const cwd = args.cwd ? this.validatePath(args.cwd as string) || root : root;
            const isWindows = process.platform === 'win32';
            const shell = isWindows ? 'cmd.exe' : '/bin/sh';
            const shellArgs = isWindows ? ['/c', command] : ['-c', command];

            const proc = cp.spawn(shell, shellArgs, {
                cwd,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            if (background) {
                // Clean up exited background processes before adding new ones
                for (const [id, bg] of this.backgroundProcesses) {
                    if (bg.exited) { this.backgroundProcesses.delete(id); }
                }

                // Enforce cap on concurrent background processes
                if (this.backgroundProcesses.size >= BuiltinTools.MAX_BACKGROUND_PROCESSES) {
                    proc.kill();
                    return {
                        success: false,
                        result: `Too many background processes (limit: ${BuiltinTools.MAX_BACKGROUND_PROCESSES}). Use check_terminal_output to review existing processes, or wait for some to finish.`
                    };
                }

                // Background mode — return immediately with a process ID
                const procId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                const entry = { proc, output: [] as string[], command, startedAt: Date.now(), exited: false, exitCode: null as number | null };
                this.backgroundProcesses.set(procId, entry);

                const collectOutput = (data: Buffer) => {
                    const lines = data.toString().split('\n');
                    for (const line of lines) {
                        if (line.length > 0) {
                            entry.output.push(line);
                            // Cap stored output at 500 lines
                            if (entry.output.length > 500) { entry.output.shift(); }
                            if (this.onTerminalOutput) { this.onTerminalOutput(line); }
                        }
                    }
                };

                proc.stdout?.on('data', collectOutput);
                proc.stderr?.on('data', collectOutput);
                proc.on('close', (code) => {
                    entry.exited = true;
                    entry.exitCode = code;
                });

                return { success: true, result: `Background process started (ID: ${procId}). Use check_terminal_output with this ID to see output or check if it's still running.` };
            }

            // Foreground mode — stream output and wait for completion
            return new Promise((resolve) => {
                const outputLines: string[] = [];
                let killed = false;

                const timer = setTimeout(() => {
                    killed = true;
                    proc.kill();
                }, timeoutMs);

                const collectLine = (data: Buffer) => {
                    const lines = data.toString().split('\n');
                    for (const line of lines) {
                        if (line.length > 0) {
                            outputLines.push(line);
                            if (this.onTerminalOutput) { this.onTerminalOutput(line); }
                        }
                    }
                };

                proc.stdout?.on('data', collectLine);
                proc.stderr?.on('data', collectLine);

                proc.on('close', (code) => {
                    clearTimeout(timer);
                    let output = outputLines.join('\n');

                    // Cap output
                    if (output.length > 30000) {
                        output = output.slice(0, 30000) + '\n... [output truncated]';
                    }

                    if (killed && output) {
                        resolve({
                            success: true,
                            result: output + `\n\n⚠ Command timed out after ${timeoutMs / 1000}s but produced output above.`
                        });
                    } else {
                        resolve({
                            success: code === 0,
                            result: output || '(no output)'
                        });
                    }
                });

                proc.on('error', (err) => {
                    clearTimeout(timer);
                    resolve({ success: false, result: `Failed to start process: ${err.message}` });
                });
            });
        });

        // ── check_terminal_output ──
        this.register({
            type: 'function',
            function: {
                name: 'check_terminal_output',
                description: 'Check the output and status of a background terminal process started with run_terminal_command(background=true). Returns recent output lines and whether the process is still running.',
                parameters: {
                    type: 'object',
                    properties: {
                        process_id: { type: 'string', description: 'The process ID returned by run_terminal_command in background mode' },
                        tail: { type: 'number', description: 'Number of recent output lines to return (default 50, max 200)' },
                        kill: { type: 'boolean', description: 'If true, kill the background process' }
                    },
                    required: ['process_id']
                }
            }
        }, async (args) => {
            const procId = args.process_id as string;
            const tail = Math.min(Math.max(Number(args.tail) || 50, 1), 200);
            const shouldKill = args.kill === true || args.kill === 'true';

            const entry = this.backgroundProcesses.get(procId);
            if (!entry) {
                const available = Array.from(this.backgroundProcesses.keys());
                return { success: false, result: `No background process with ID "${procId}".${available.length > 0 ? ' Available: ' + available.join(', ') : ''}` };
            }

            if (shouldKill && !entry.exited) {
                entry.proc.kill();
                return { success: true, result: `Process ${procId} killed.` };
            }

            const lines = entry.output.slice(-tail);
            const status = entry.exited
                ? `Exited with code ${entry.exitCode}`
                : `Running (${Math.round((Date.now() - entry.startedAt) / 1000)}s)`;
            const output = lines.length > 0 ? lines.join('\n') : '(no output yet)';

            return { success: true, result: `[${status}] Command: ${entry.command}\n\n${output}` };
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

            try {
                const uri = vscode.Uri.file(absPath);
                // Delete is destructive and can't be undone via dirty-buffer — confirm first
                const approved = await this.requestConfirmation(`Delete file: ${filePath}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the delete.' }; }
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

                const approved = await this.requestConfirmation(`Apply code action: ${match.title}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the code action.' }; }

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

        // ── set_plan ──
        this.register({
            type: 'function',
            function: {
                name: 'set_plan',
                description: 'Set the plan for the current task. Call this at the start of every task with 3-6 specific steps describing what you will do.',
                parameters: {
                    type: 'object',
                    properties: {
                        steps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: 'Unique step identifier (e.g. "step1")' },
                                    title: { type: 'string', description: 'Short description of the step' }
                                },
                                required: ['id', 'title']
                            },
                            description: 'Array of plan steps'
                        }
                    },
                    required: ['steps']
                }
            }
        }, async (args) => {
            const steps = args.steps as { id: string; title: string }[];
            if (this.onSetPlan) { this.onSetPlan(steps); }
            return { success: true, result: `Plan set with ${steps.length} steps.` };
        });

        // ── update_plan_step ──
        this.register({
            type: 'function',
            function: {
                name: 'update_plan_step',
                description: 'Update the status of a plan step. Call this as you begin and complete each step.',
                parameters: {
                    type: 'object',
                    properties: {
                        step_id: { type: 'string', description: 'The id of the step to update' },
                        status: { type: 'string', enum: ['in_progress', 'completed', 'failed'], description: 'New status for the step' }
                    },
                    required: ['step_id', 'status']
                }
            }
        }, async (args) => {
            const stepId = args.step_id as string;
            const status = args.status as string;
            if (this.onUpdatePlanStep) { this.onUpdatePlanStep(stepId, status); }
            return { success: true, result: `Step "${stepId}" marked as ${status}.` };
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
