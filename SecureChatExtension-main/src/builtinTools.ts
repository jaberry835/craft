/**
 * Built-in tools — the set of tools the agent can call to interact with the workspace.
 * These mirror what Copilot's agent mode can do: read/write files, search, terminal, etc.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentPermissionLevel, ToolDefinition, ToolResult, ToolHandler, AskUserQuestion, AskUserAnswers } from './types';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { countLineChanges } from './diffUtils';
import { DEFAULT_PERMISSION_LEVEL, shouldConfirmLocalCategory } from './permissions';
import { ToolContext, ToolCallbacks, BackgroundProcessEntry } from './tools/types';
import { createFileTools, createSearchTools, createTerminalTools, createCodeActionTools, createPlanTools, createAskUserTools } from './tools';

export class BuiltinTools {
    private handlers: Map<string, ToolHandler> = new Map();
    private definitions: ToolDefinition[] = [];
    private permissionLevel: AgentPermissionLevel = DEFAULT_PERMISSION_LEVEL;
    private sessionAllowTerminal: boolean = false;
    private sessionAllowWrites: boolean = false;
    private pendingConfirmations: Map<string, { resolve: (approved: boolean) => void }> = new Map();
    private pendingQuestions: Map<string, { resolve: (answers: AskUserAnswers | null) => void }> = new Map();
    private onConfirmRequest?: (actionId: string, description: string, category?: string, diff?: string) => void;
    private onAskUserRequest?: (requestId: string, questions: AskUserQuestion[]) => void;
    private onFileTouched?: (relPath: string, additions: number, deletions: number) => void;
    /** Tracks files modified during an agent run. Stores original content for diff/undo. */
    private touchedFiles: Map<string, { relPath: string; isNew: boolean; originalContent: string }> = new Map();
    private originalContentProvider?: vscode.Disposable;
    /** Background terminal processes tracked by ID. */
    private backgroundProcesses: Map<string, BackgroundProcessEntry> = new Map();
    /** Maximum number of concurrent background processes */
    private static readonly MAX_BACKGROUND_PROCESSES = 10;
    /** Mutable callbacks object shared with extracted tool modules. */
    private toolCallbacks: ToolCallbacks = {};

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

    setAskUserCallback(cb: (requestId: string, questions: AskUserQuestion[]) => void) {
        this.onAskUserRequest = cb;
    }

    setFileTouchedCallback(cb: (relPath: string, additions: number, deletions: number) => void) {
        this.onFileTouched = cb;
    }

    setPlanCallback(cb: (steps: { id: string; title: string }[]) => void) {
        this.toolCallbacks.onSetPlan = cb;
    }

    setUpdatePlanStepCallback(cb: (stepId: string, status: string) => void) {
        this.toolCallbacks.onUpdatePlanStep = cb;
    }

    setTerminalOutputCallback(cb: (line: string) => void) {
        this.toolCallbacks.onTerminalOutput = cb;
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

    resolveQuestions(requestId: string, answers: AskUserAnswers | null) {
        const pending = this.pendingQuestions.get(requestId);
        if (pending) {
            pending.resolve(answers);
            this.pendingQuestions.delete(requestId);
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
     * Ask the user one or more structured questions and wait for the answers.
     * Resolves with a header->values map, or null if dismissed/timed out.
     */
    private async askUser(questions: AskUserQuestion[]): Promise<AskUserAnswers | null> {
        if (!this.onAskUserRequest || questions.length === 0) { return null; }
        const requestId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
            this.pendingQuestions.set(requestId, { resolve });
            this.onAskUserRequest!(requestId, questions);
            // Timeout after 5 minutes — auto-dismiss with visible feedback.
            setTimeout(() => {
                if (this.pendingQuestions.has(requestId)) {
                    this.pendingQuestions.delete(requestId);
                    vscode.window.showWarningMessage(
                        'Junior: Question timed out without an answer. You can re-run the task to try again.'
                    );
                    resolve(null);
                }
            }, 300000);
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
        const ctx = this.createToolContext();
        for (const entry of [
            ...createFileTools(ctx),
            ...createSearchTools(ctx),
            ...createTerminalTools(ctx),
            ...createCodeActionTools(ctx),
            ...createPlanTools(ctx),
            ...createAskUserTools(ctx),
        ]) {
            this.register(entry.definition, entry.handler);
        }
    }

    /** Build the shared context object that extracted tool modules use. */
    private createToolContext(): ToolContext {
        return {
            validatePath: (p) => this.validatePath(p),
            getWorkspaceRoot: () => this.getWorkspaceRoot(),
            snapshotOriginal: (a, r) => this.snapshotOriginal(a, r),
            notifyFileChanged: (a, r) => this.notifyFileChanged(a, r),
            collectDiagnosticsAfterEdit: (a, r) => this.collectDiagnosticsAfterEdit(a, r),
            requestConfirmation: (d, c) => this.requestConfirmation(d, c),
            askUser: (q) => this.askUser(q),
            resolveSymbolPosition: (f, s, l) => this.resolveSymbolPosition(f, s, l),
            workspaceIndexer: this.workspaceIndexer,
            symbolIndexer: this.symbolIndexer,
            semanticIndexer: this.semanticIndexer,
            callbacks: this.toolCallbacks,
            backgroundProcesses: this.backgroundProcesses,
            maxBackgroundProcesses: BuiltinTools.MAX_BACKGROUND_PROCESSES,
        };
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
