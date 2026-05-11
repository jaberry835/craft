/**
 * Concrete ContextProvider implementations.
 *
 * These extract the scattered context-injection logic from AgentLoop
 * into composable beforeRun/afterRun hooks.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { IContextProvider } from '../framework/contextProvider';
import type { AgentContext } from '../framework/middleware';
import type { ChatMessage, AgentResponse } from '../framework/types';
import type { RetrievalRanker } from '../retrievalRanker';
import type { AgentTaskMemory } from '../taskMemory';
import type { BuiltinTools } from '../builtinTools';
import type { ToolResult } from '../types';
import { getSetting } from '../config';

// ── Custom Instructions Provider ──

/**
 * Loads custom project instructions from well-known file paths
 * (.junior/instructions.md, .github/copilot-instructions.md)
 * and appends them to the system prompt.
 */
export class CustomInstructionsProvider implements IContextProvider {
    readonly name = 'custom-instructions';

    async beforeRun(context: AgentContext): Promise<ChatMessage[] | void> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }

        const candidates = [
            path.join(root, '.junior', 'instructions.md'),
            path.join(root, '.github', 'copilot-instructions.md'),
        ];

        for (const filePath of candidates) {
            try {
                if (fs.existsSync(filePath)) {
                    let content = fs.readFileSync(filePath, 'utf-8').trim();
                    if (content.length > 0) {
                        if (content.length > 4000) {
                            content = content.slice(0, 4000) + '\n... [instructions truncated]';
                        }
                        // Find the system prompt and append
                        const systemMsg = context.messages.find(m => m.role === 'system');
                        if (systemMsg && typeof systemMsg.content === 'string') {
                            systemMsg.content += '\n\n## Custom Project Instructions\n' + content;
                        }
                        return;
                    }
                }
            } catch { /* ignore read errors */ }
        }
    }
}

// ── Workspace Context Provider ──

/**
 * Injects a context snapshot with open editors, diagnostics,
 * active file, and workspace name.
 */
export class WorkspaceContextProvider implements IContextProvider {
    readonly name = 'workspace-context';

    async beforeRun(context: AgentContext): Promise<ChatMessage[] | void> {
        const sections: string[] = [];

        // 1. Open editors
        try {
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const openFiles = tabs
                .map(t => {
                    const input = t.input as { uri?: vscode.Uri } | undefined;
                    return input?.uri ? vscode.workspace.asRelativePath(input.uri, false) : null;
                })
                .filter(Boolean);
            if (openFiles.length > 0) {
                sections.push('Open editors:\n' + openFiles.map(f => `  ${f}`).join('\n'));
            }
        } catch { /* ignore */ }

        // 2. Active diagnostics
        try {
            const allDiags = vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][];
            const important: string[] = [];
            for (const [uri, diags] of allDiags) {
                for (const d of diags) {
                    if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                    const relPath = vscode.workspace.asRelativePath(uri, false);
                    const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                    important.push(`  ${relPath}:${d.range.start.line + 1}: [${sev}] ${d.message}`);
                }
                if (important.length >= 20) { break; }
            }
            if (important.length > 0) {
                sections.push('Active diagnostics:\n' + important.join('\n'));
            }
        } catch { /* ignore */ }

        // 3. Active file
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
                const line = activeEditor.selection.active.line + 1;
                sections.push(`Active file: ${relPath} (cursor at line ${line})`);
            }
        } catch { /* ignore */ }

        // 4. Workspace name
        try {
            const wsName = vscode.workspace.workspaceFolders?.[0]?.name;
            if (wsName) {
                sections.push(`Workspace: ${wsName}`);
            }
        } catch { /* ignore */ }

        if (sections.length === 0) { return; }
        const contextPack = '[Context Snapshot]\n' + sections.join('\n\n');
        return [{ role: 'system', content: contextPack }];
    }
}

// ── Investigation Context Provider ──

/**
 * Performs autonomous investigation before the agent runs:
 * - Detects issue-like keywords
 * - Collects workspace diagnostics
 * - Ranks relevant files via RetrievalRanker
 * - Runs semantic search
 * - Records findings into TaskMemory
 */
export class InvestigationContextProvider implements IContextProvider {
    readonly name = 'investigation';

    constructor(
        private taskMemory: AgentTaskMemory,
        private retrievalRanker: RetrievalRanker,
        private builtinTools: BuiltinTools,
        private onStatus?: (status: string) => void
    ) {}

    async beforeRun(context: AgentContext): Promise<ChatMessage[] | void> {
        const enabled = getSetting<boolean>('agent.autoInvestigate') ?? true;
        if (!enabled) { return; }
        const mode = context.state.get('chatMode');
        if (mode === 'ask') { return; }

        // Extract user message text from the last user message
        const lastUserMsg = [...context.messages].reverse().find(m => m.role === 'user');
        if (!lastUserMsg) { return; }
        const userMessage = typeof lastUserMsg.content === 'string'
            ? lastUserMsg.content
            : (lastUserMsg.content as Array<{ type: string; text?: string }>)
                ?.filter(p => p.type === 'text')
                .map(p => p.text)
                .join(' ') ?? '';

        const issueLike = /(issue|bug|error|warning|problem|broken|failing|fails|failure|exception|stack trace|diagnostic|not working|doesn't|doesnt|wrong)/i.test(userMessage);
        const maxCandidates = getSetting<number>('agent.autoInvestigateMaxFiles') ?? 4;
        const activeEditor = vscode.window.activeTextEditor;
        const activeFile = activeEditor
            ? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
            : '';

        if (activeFile) {
            this.taskMemory.noteRelevantFile(activeFile, 'active editor');
        }

        // Find mentioned files
        const mentionedFiles = userMessage.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|ps1)\b/g) || [];
        for (const filePath of mentionedFiles) {
            this.taskMemory.noteRelevantFile(filePath, 'mentioned by the user');
            const search = await this.runTool('search_files', { query: path.basename(filePath) });
            if (search?.success) {
                this.taskMemory.noteToolResult('search_files', { query: path.basename(filePath) }, search.result, true);
            }
        }

        // Collect diagnostics for issue-like requests
        const diagnostics = issueLike ? this.collectWorkspaceDiagnostics(8) : [];
        if (issueLike) {
            this.onStatus?.('Investigating likely issue context...');
            if (diagnostics.length > 0) {
                this.taskMemory.noteDiagnostics(diagnostics);
                this.taskMemory.noteRelevantFiles(this.extractDiagnosticPaths(diagnostics), 'diagnostic location');
                this.taskMemory.noteFinding(`There are ${diagnostics.length} visible diagnostics that may explain the issue.`);
            }
        }

        // Rank files
        const ranked = this.retrievalRanker.rank(userMessage, {
            activeFile,
            mentionedFiles,
            diagnostics: diagnostics.map(line => this.parseDiagnosticLine(line)).filter(Boolean) as Array<{ filePath: string; severity: 'Error' | 'Warning'; message: string }>,
            maxCandidates
        });

        for (const candidate of ranked) {
            const primaryReason = candidate.reasons[0] || 'ranked as relevant context';
            this.taskMemory.noteRelevantFile(candidate.filePath, primaryReason);
        }
        if (ranked.length > 0) {
            this.taskMemory.noteFinding(`Ranked likely files: ${ranked.slice(0, 3).map(c => `${c.filePath} (${c.reasons[0] || 'relevant'})`).join(', ')}.`);
        }

        // Semantic search
        const semanticQuery = activeFile ? `${userMessage} active file ${activeFile}` : userMessage;
        const semantic = await this.runTool('semantic_search', { query: semanticQuery, maxResults: String(maxCandidates) });
        if (semantic?.success && !/^No semantic matches found/i.test(semantic.result)) {
            this.taskMemory.noteToolResult('semantic_search', { query: semanticQuery }, semantic.result, true);
            const files = semantic.result
                .split(/\r?\n/)
                .map(line => line.match(/^Match \d+: ([\w./-]+\.[\w]+):(\d+)-/)?.[1])
                .filter(Boolean) as string[];
            if (files.length > 0) {
                this.taskMemory.noteFinding(`Semantic retrieval suggests starting with ${files.slice(0, 3).join(', ')}.`);
            }
        }
    }

    private async runTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
        const handler = this.builtinTools.getHandler(name);
        if (!handler) { return null; }
        try {
            return await handler(args);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.taskMemory.noteFailedAction(name, message);
            return { success: false, result: message };
        }
    }

    private collectWorkspaceDiagnostics(limit: number): string[] {
        const out: string[] = [];
        for (const [uri, diags] of vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][]) {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            for (const diag of diags) {
                if (diag.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                const severity = diag.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                out.push(`${relPath}:${diag.range.start.line + 1}: [${severity}] ${diag.message}`);
                if (out.length >= limit) { return out; }
            }
        }
        return out;
    }

    private extractDiagnosticPaths(lines: string[]): string[] {
        const out: string[] = [];
        for (const line of lines) {
            const match = line.match(/^([\w./-]+\.[\w]+):(\d+)/);
            if (match) { out.push(match[1]); }
        }
        return Array.from(new Set(out));
    }

    private parseDiagnosticLine(line: string): { filePath: string; severity: 'Error' | 'Warning'; message: string } | null {
        const match = line.match(/^([\w./-]+\.[\w]+):(\d+): \[(Error|Warning)\] (.+)$/);
        if (!match) { return null; }
        return { filePath: match[1], severity: match[3] as 'Error' | 'Warning', message: match[4] };
    }
}
