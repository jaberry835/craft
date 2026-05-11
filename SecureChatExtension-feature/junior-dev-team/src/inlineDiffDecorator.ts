/**
 * InlineDiffDecorator — GHCP-style inline diff rendering in the main editor.
 *
 * Opens changed files in the editor, highlights added/changed lines with green
 * backgrounds, and provides CodeLens "Accept | Reject" controls above each
 * change hunk.  Deleted lines are rendered as red "ghost" decorations.
 */
import * as vscode from 'vscode';

// ── Diff data structures ──

interface DiffHunk {
    /** 0-based start line in the modified (current) file */
    modifiedStart: number;
    /** Number of lines in the modified file for this hunk */
    modifiedCount: number;
    /** The original lines that were replaced / removed */
    originalLines: string[];
    status: 'pending' | 'accepted' | 'rejected';
}

interface FileDiffState {
    uri: vscode.Uri;
    relPath: string;
    originalContent: string;
    hunks: DiffHunk[];
}

// ── Decorator ──

export class InlineDiffDecorator implements vscode.CodeLensProvider, vscode.Disposable {
    private addedType: vscode.TextEditorDecorationType;
    private deletedType: vscode.TextEditorDecorationType;
    private fileDiffs = new Map<string, FileDiffState>(); // uri.fsPath → state
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private disposables: vscode.Disposable[] = [];
    private onFileResolved?: (relPath: string, action: 'keep' | 'undo') => void;
    private diffLookup?: (fsPath: string) => { relPath: string; originalContent: string } | undefined;

    constructor() {
        this.addedType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
            isWholeLine: true,
            overviewRulerColor: '#4ec94e',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            before: {
                contentText: '',
                width: '3px',
                backgroundColor: '#4ec94e',
                margin: '0 6px 0 0',
            },
        });
        this.deletedType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
            isWholeLine: true,
            overviewRulerColor: '#f44747',
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            before: {
                contentText: '',
                width: '3px',
                backgroundColor: '#f44747',
                margin: '0 6px 0 0',
            },
        });

        // Re-apply decorations when user switches editors.
        // If the file has pending diffs from builtinTools but hasn't been
        // registered yet (user opened it from Explorer, not the chat panel),
        // auto-register it so decorations + CodeLens appear immediately.
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (!editor) { return; }
                const fsPath = editor.document.uri.fsPath;
                if (!this.fileDiffs.has(fsPath) && this.diffLookup) {
                    const info = this.diffLookup(fsPath);
                    if (info) {
                        const currentContent = editor.document.getText();
                        const hunks = this.computeHunks(info.originalContent, currentContent);
                        if (hunks.length > 0) {
                            this.fileDiffs.set(fsPath, {
                                uri: editor.document.uri,
                                relPath: info.relPath,
                                originalContent: info.originalContent,
                                hunks,
                            });
                            this._onDidChangeCodeLenses.fire();
                        }
                    }
                }
                this.applyDecorations(editor);
            })
        );
    }

    /** Set callback for when all hunks in a file are resolved */
    setFileResolvedCallback(cb: (relPath: string, action: 'keep' | 'undo') => void) {
        this.onFileResolved = cb;
    }

    /** Set lookup function for touched-file info (keyed by fsPath) */
    setDiffLookup(cb: (fsPath: string) => { relPath: string; originalContent: string } | undefined) {
        this.diffLookup = cb;
    }

    // ── Public API ──

    /**
     * Show inline diff for a file.  Opens the file in the editor if not already
     * visible, computes hunks, applies decorations, and fires CodeLens refresh.
     */
    async showFile(relPath: string, absPath: string, originalContent: string): Promise<void> {
        const uri = vscode.Uri.file(absPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: false,
        });
        const currentContent = doc.getText();
        const hunks = this.computeHunks(originalContent, currentContent);
        this.fileDiffs.set(uri.fsPath, { uri, relPath, originalContent, hunks });
        this.applyDecorations(editor);
        this._onDidChangeCodeLenses.fire();
    }

    /** Check whether we're tracking inline diffs for any files */
    hasActiveDiffs(): boolean {
        return this.fileDiffs.size > 0;
    }

    /** Accept a specific hunk — mark it accepted and update UI */
    acceptHunk(fsPath: string, hunkIndex: number): void {
        const state = this.fileDiffs.get(fsPath);
        if (!state || hunkIndex >= state.hunks.length) { return; }
        state.hunks[hunkIndex].status = 'accepted';
        this.refreshFile(fsPath);
        this.checkAllResolved(fsPath);
    }

    /** Reject a specific hunk — revert its lines to original and update UI */
    async rejectHunk(fsPath: string, hunkIndex: number): Promise<void> {
        const state = this.fileDiffs.get(fsPath);
        if (!state || hunkIndex >= state.hunks.length) { return; }
        const hunk = state.hunks[hunkIndex];

        // Apply the revert edit
        const doc = await vscode.workspace.openTextDocument(state.uri);
        const edit = new vscode.WorkspaceEdit();
        const startPos = new vscode.Position(hunk.modifiedStart, 0);
        let endPos: vscode.Position;
        if (hunk.modifiedCount > 0) {
            const endLine = hunk.modifiedStart + hunk.modifiedCount;
            endPos = endLine < doc.lineCount
                ? new vscode.Position(endLine, 0)
                : doc.lineAt(doc.lineCount - 1).range.end;
        } else {
            endPos = startPos;
        }
        const replacementText = hunk.originalLines.length > 0
            ? hunk.originalLines.join('\n') + '\n'
            : '';
        edit.replace(state.uri, new vscode.Range(startPos, endPos), replacementText);
        await vscode.workspace.applyEdit(edit);
        await doc.save();

        // Recompute all hunks since line numbers shifted
        const newContent = doc.getText();
        const newHunks = this.computeHunks(state.originalContent, newContent);
        // Transfer accepted status from old hunks that still match
        state.hunks = newHunks;
        this.refreshFile(fsPath);
        this.checkAllResolved(fsPath);
    }

    /** Accept all pending hunks for a file */
    acceptFile(fsPath: string): void {
        const state = this.fileDiffs.get(fsPath);
        if (!state) { return; }
        for (const h of state.hunks) {
            if (h.status === 'pending') { h.status = 'accepted'; }
        }
        this.refreshFile(fsPath);
        this.checkAllResolved(fsPath);
    }

    /** Reject all pending hunks (full file revert) */
    async rejectFile(fsPath: string): Promise<void> {
        const state = this.fileDiffs.get(fsPath);
        if (!state) { return; }
        // Write the original content back
        const doc = await vscode.workspace.openTextDocument(state.uri);
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(state.uri, fullRange, state.originalContent);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        this.clearFile(fsPath);
        if (this.onFileResolved && state) {
            this.onFileResolved(state.relPath, 'undo');
        }
    }

    /** Remove tracking for a file and clear its decorations */
    clearFile(fsPath: string): void {
        this.fileDiffs.delete(fsPath);
        // Clear decorations on any visible editor for this file
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.fsPath === fsPath) {
                editor.setDecorations(this.addedType, []);
                editor.setDecorations(this.deletedType, []);
            }
        }
        this._onDidChangeCodeLenses.fire();
    }

    /** Clear all tracked files */
    clearAll(): void {
        for (const fsPath of [...this.fileDiffs.keys()]) {
            this.clearFile(fsPath);
        }
    }

    // ── CodeLensProvider ──

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const state = this.fileDiffs.get(document.uri.fsPath);
        if (!state) { return []; }

        const lenses: vscode.CodeLens[] = [];

        for (let i = 0; i < state.hunks.length; i++) {
            const hunk = state.hunks[i];
            if (hunk.status !== 'pending') { continue; }
            const line = Math.max(0, hunk.modifiedStart);
            const range = new vscode.Range(line, 0, line, 0);

            lenses.push(new vscode.CodeLens(range, {
                title: '$(check) Accept Change',
                command: 'junior.inlineDiff.acceptHunk',
                arguments: [document.uri.fsPath, i],
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: '$(discard) Reject Change',
                command: 'junior.inlineDiff.rejectHunk',
                arguments: [document.uri.fsPath, i],
            }));
        }

        // File-level lens at top if there are pending hunks
        const pendingCount = state.hunks.filter(h => h.status === 'pending').length;
        if (pendingCount > 1) {
            const topRange = new vscode.Range(0, 0, 0, 0);
            lenses.unshift(new vscode.CodeLens(topRange, {
                title: `$(check-all) Accept All (${pendingCount} changes)`,
                command: 'junior.inlineDiff.acceptFile',
                arguments: [document.uri.fsPath],
            }));
            lenses.unshift(new vscode.CodeLens(topRange, {
                title: '$(discard) Reject All',
                command: 'junior.inlineDiff.rejectFile',
                arguments: [document.uri.fsPath],
            }));
        }

        return lenses;
    }

    // ── Internals ──

    private refreshFile(fsPath: string): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.fsPath === fsPath) {
                this.applyDecorations(editor);
            }
        }
        this._onDidChangeCodeLenses.fire();
    }

    private checkAllResolved(fsPath: string): void {
        const state = this.fileDiffs.get(fsPath);
        if (!state) { return; }
        const pending = state.hunks.filter(h => h.status === 'pending');
        if (pending.length === 0) {
            // All hunks resolved — notify and clean up
            this.clearFile(fsPath);
            if (this.onFileResolved) {
                this.onFileResolved(state.relPath, 'keep');
            }
        }
    }

    private applyDecorations(editor: vscode.TextEditor): void {
        const state = this.fileDiffs.get(editor.document.uri.fsPath);
        if (!state) {
            editor.setDecorations(this.addedType, []);
            editor.setDecorations(this.deletedType, []);
            return;
        }

        const addedRanges: vscode.DecorationOptions[] = [];
        const deletedRanges: vscode.DecorationOptions[] = [];

        for (const hunk of state.hunks) {
            if (hunk.status !== 'pending') { continue; }

            // Highlight added/modified lines in green
            for (let l = hunk.modifiedStart; l < hunk.modifiedStart + hunk.modifiedCount; l++) {
                if (l < editor.document.lineCount) {
                    addedRanges.push({ range: editor.document.lineAt(l).range });
                }
            }

            // If there were deleted lines, show a red marker on the line before the insertion
            if (hunk.originalLines.length > 0 && hunk.modifiedCount === 0) {
                // Pure deletion — mark the line at the insertion point
                const markerLine = Math.max(0, hunk.modifiedStart - 1);
                if (markerLine < editor.document.lineCount) {
                    const delCount = hunk.originalLines.length;
                    deletedRanges.push({
                        range: editor.document.lineAt(markerLine).range,
                        renderOptions: {
                            after: {
                                contentText: `  ⊖ ${delCount} line${delCount > 1 ? 's' : ''} deleted`,
                                color: new vscode.ThemeColor('editorGutter.deletedBackground'),
                                fontStyle: 'italic',
                                margin: '0 0 0 16px',
                            }
                        }
                    });
                }
            } else if (hunk.originalLines.length > 0) {
                // Modification — show deleted line count as suffix on the line above
                const markerLine = Math.max(0, hunk.modifiedStart - 1);
                if (markerLine < editor.document.lineCount && markerLine !== hunk.modifiedStart) {
                    deletedRanges.push({
                        range: editor.document.lineAt(markerLine).range,
                        renderOptions: {
                            after: {
                                contentText: `  ⊖ ${hunk.originalLines.length} replaced`,
                                color: new vscode.ThemeColor('editorGutter.deletedBackground'),
                                fontStyle: 'italic',
                                margin: '0 0 0 16px',
                            }
                        }
                    });
                }
            }
        }

        editor.setDecorations(this.addedType, addedRanges);
        editor.setDecorations(this.deletedType, deletedRanges);
    }

    /**
     * Compute diff hunks between original and modified text.
     * Groups consecutive changed lines into hunks with context awareness.
     */
    private computeHunks(original: string, modified: string): DiffHunk[] {
        const oldLines = original.split('\n');
        const newLines = modified.split('\n');

        // Build a simple line-level diff using a greedy LCS approach
        const hunks: DiffHunk[] = [];
        let oi = 0, ni = 0;

        while (oi < oldLines.length || ni < newLines.length) {
            // Skip matching lines
            if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
                oi++; ni++;
                continue;
            }

            // Found a difference — collect the hunk
            const hunkOrigStart = oi;
            const hunkModStart = ni;
            const removedLines: string[] = [];

            // Look ahead to find next sync point
            let foundOi = -1, foundNi = -1;
            const look = 50;
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
                for (; oi < foundOi; oi++) { removedLines.push(oldLines[oi]); }
                const addedCount = foundNi - ni;
                hunks.push({
                    modifiedStart: hunkModStart,
                    modifiedCount: addedCount,
                    originalLines: removedLines,
                    status: 'pending',
                });
                ni = foundNi;
            } else {
                // No sync found — rest of file is one big hunk
                for (; oi < oldLines.length; oi++) { removedLines.push(oldLines[oi]); }
                const addedCount = newLines.length - ni;
                hunks.push({
                    modifiedStart: hunkModStart,
                    modifiedCount: addedCount,
                    originalLines: removedLines,
                    status: 'pending',
                });
                ni = newLines.length;
            }
        }

        return hunks;
    }

    dispose(): void {
        this.addedType.dispose();
        this.deletedType.dispose();
        this.clearAll();
        this._onDidChangeCodeLenses.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }
}
