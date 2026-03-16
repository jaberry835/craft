/**
 * Chat Webview Provider — the VS Code sidebar panel with a Copilot-style chat UI.
 * Implements `vscode.WebviewViewProvider` and communicates with the agent loop
 * via `ExtensionMessage` and `WebviewMessage` types.
 */
import * as vscode from 'vscode';
import { AgentLoop, AgentCallbacks } from './agentLoop';
import { AzureOpenAIClient } from './aoaiClient';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { SessionManager } from './sessionManager';
import { ExtensionMessage, WebviewMessage } from './types';
import { getSetting, updateSetting } from './config';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private webviewView?: vscode.WebviewView;
    private agentLoop?: AgentLoop;
    private log: (msg: string) => void;

    constructor(
        private extensionUri: vscode.Uri,
        private aoaiClient: AzureOpenAIClient,
        private builtinTools: BuiltinTools,
        private mcpClient: McpClient,
        private sessionManager: SessionManager,
        log?: (msg: string) => void
    ) {
        this.log = log || (() => {});
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.log('resolveWebviewView called');
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        const html = this.getHtmlContent(webviewView.webview);
        this.log('Generated HTML length: ' + html.length);
        this.log('HTML head snippet: ' + html.substring(0, 500));
        webviewView.webview.html = html;

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            this.handleWebviewMessage(msg);
        });
    }

    focusView(): void {
        this.webviewView?.show(false);
    }

    sendToWebview(msg: ExtensionMessage) {
        this.webviewView?.webview.postMessage(msg);
    }

    notifyModelChanged(model: string) {
        this.sendToWebview({ type: 'modelChanged', model });
        this.syncModelsToWebview();
    }

    private getModelConfig(): { models: Array<{ name: string; deploymentId: string }>; activeDeployment?: string } {
        const deployments = getSetting<Array<{ name: string; deploymentId: string }>>('azureOpenAI.deployments') || [];
        const activeDeployment = getSetting<string>('azureOpenAI.activeDeployment') || undefined;
        return {
            models: deployments.map(d => ({ name: d.name || d.deploymentId, deploymentId: d.deploymentId })),
            activeDeployment
        };
    }

    private syncModelsToWebview(): void {
        const { models, activeDeployment } = this.getModelConfig();
        this.sendToWebview({ type: 'setModels', models, activeDeployment });
    }

    sendMessageFromExtension(text: string) {
        this.handleUserMessage(text);
    }

    newSession() {
        if (this.agentLoop?.isRunning()) {
            this.agentLoop.cancel();
        }
        this.builtinTools.resetSessionApprovals();
        this.sessionManager.createNewSession();
        this.agentLoop?.clearMessages();
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendSessionList();
    }

    toggleHistory() {
        this.sendToWebview({ type: 'toggleHistory' } as any);
    }

    cancelAgent() {
        this.agentLoop?.cancel();
    }

    private handleWebviewMessage(msg: WebviewMessage) {
        this.log(`Webview message received: ${msg.type}`);
        try {
            switch (msg.type) {
                case 'sendMessage':
                    this.handleUserMessage(msg.text, msg.images, msg.files);
                    break;
                case 'cancelAgent':
                    this.cancelAgent();
                    break;
                case 'newSession':
                    this.newSession();
                    break;
                case 'selectModel':
                    this.log('Executing junior.selectModel command...');
                    vscode.commands.executeCommand('junior.selectModel');
                    break;
                case 'selectModelById':
                    this.handleSelectModelById(msg.deploymentId);
                    break;
                case 'confirmAction':
                    if (msg.allowSession && msg.category) {
                        this.builtinTools.allowForSession(msg.category);
                    }
                    this.builtinTools.resolveConfirmation(msg.actionId, msg.approved);
                    break;
                case 'fileChangeAction':
                    this.handleFileChangeAction(msg.action);
                    break;
                case 'fileChangeFileAction':
                    this.handleFileChangeFileAction(msg.file, msg.action);
                    break;
                case 'openFileDiff':
                    this.builtinTools.openDiffForFile(msg.file);
                    break;
                case 'attachFile':
                    this.handleAttachFile();
                    break;
                case 'switchSession':
                    this.handleSwitchSession(msg.sessionId);
                    break;
                case 'deleteSession':
                    this.handleDeleteSession(msg.sessionId);
                    break;
                case 'requestSessionList':
                    this.sendSessionList();
                    break;
                case 'ready':
                    this.log('Webview reported ready');
                    this.syncModelsToWebview();
                    this.restoreSession();
                    this.sendSessionList();
                    break;
            }
        } catch (err: any) {
            this.log(`handleWebviewMessage error: ${err.message}\n${err.stack}`);
            this.sendToWebview({ type: 'error', message: `Internal error: ${err.message}` });
        }
    }

    private async handleUserMessage(text: string, images?: string[], files?: { name: string; content: string }[]) {
        if (!text.trim() && (!images || images.length === 0) && (!files || files.length === 0)) { return; }

        // Echo the user message to the webview (with attachments)
        const fileNames = files?.map(f => f.name);
        this.sendToWebview({ type: 'addUserMessage', text, images, fileNames });

        const callbacks: AgentCallbacks = {
            sendToWebview: (msg) => this.sendToWebview(msg)
        };

        if (!this.agentLoop) {
            this.agentLoop = new AgentLoop(
                this.aoaiClient,
                this.builtinTools,
                this.mcpClient,
                callbacks
            );
        }

        // Confirmation callback for built-in tools
        this.builtinTools.setConfirmCallback((actionId, description, category, diff) => {
            this.sendToWebview({ type: 'confirmAction', actionId, description, category, diff });
        });

        // Live file-change callback — sends tick to webview as each file is touched
        this.builtinTools.setFileTouchedCallback((relPath, additions, deletions) => {
            this.sendToWebview({ type: 'fileChangeTick', file: relPath, additions, deletions });
        });

        // Live terminal output callback — stream command output to webview
        this.builtinTools.setTerminalOutputCallback((line) => {
            this.sendToWebview({ type: 'terminalOutput', line });
        });

        // Plan callbacks — forward to agentLoop
        this.builtinTools.setPlanCallback((steps) => {
            this.agentLoop!.setPlan(steps);
        });
        this.builtinTools.setUpdatePlanStepCallback((stepId, status) => {
            this.agentLoop!.updatePlanStep(stepId, status as any);
        });

        await this.agentLoop.run(text, images, files);

        // If files were changed, wait for Keep/Undo (user clicks file names to review diffs)
        const summary = this.builtinTools.getPendingChangeSummary();
        if (summary) {
            await this.waitForFileChangeAction();
        }

        // Persist after run completes
        this.sessionManager.updateMessages(this.agentLoop.getMessages());
        this.sendSessionList();
    }

    private pendingFileChangeResolve?: (action: 'keep' | 'undo') => void;

    private waitForFileChangeAction(): Promise<void> {
        return new Promise((resolve) => {
            this.pendingFileChangeResolve = async (action) => {
                if (action === 'undo') {
                    await this.builtinTools.undoAllChanges();
                    this.sendToWebview({ type: 'fileChangeResolved', action: 'undone' });
                } else {
                    await this.builtinTools.keepAllChanges();
                    this.sendToWebview({ type: 'fileChangeResolved', action: 'kept' });
                }
                resolve();
            };
            // Timeout: auto-keep after 5 minutes
            setTimeout(() => {
                if (this.pendingFileChangeResolve) {
                    this.builtinTools.clearPendingChanges();
                    this.pendingFileChangeResolve = undefined;
                    resolve();
                }
            }, 300000);
        });
    }

    private handleFileChangeAction(action: 'keep' | 'undo') {
        if (this.pendingFileChangeResolve) {
            const res = this.pendingFileChangeResolve;
            this.pendingFileChangeResolve = undefined;
            res(action);
        }
    }

    private async handleFileChangeFileAction(file: string, action: 'keep' | 'undo') {
        if (action === 'undo') {
            await this.builtinTools.undoFile(file);
        } else {
            await this.builtinTools.keepFile(file);
        }
        this.sendToWebview({
            type: 'fileChangeFileResolved',
            file,
            action: action === 'keep' ? 'kept' : 'undone'
        });
        // If all files resolved individually, auto-resolve the whole dock
        if (!this.builtinTools.hasPendingFiles() && this.pendingFileChangeResolve) {
            const res = this.pendingFileChangeResolve;
            this.pendingFileChangeResolve = undefined;
            this.sendToWebview({ type: 'fileChangeResolved', action: 'kept' });
            // Don't call keepAll/undoAll — already individually handled
            await this.builtinTools.closeDiffEditors();
            res('keep'); // resolve the promise so the agent loop continues
        }
    }

    private async handleAttachFile() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            filters: { 'All Files': ['*'] }
        });
        if (!uris || uris.length === 0) { return; }

        for (const uri of uris) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const name = uri.path.split('/').pop() || 'file';
                const content = new TextDecoder().decode(bytes);
                this.sendToWebview({ type: 'fileAttached', name, content });
            } catch (err: any) {
                this.log(`Failed to read attached file: ${err.message}`);
            }
        }
    }

    private async handleSelectModelById(deploymentId: string) {
        if (!deploymentId) { return; }
        await updateSetting('azureOpenAI.activeDeployment', deploymentId, vscode.ConfigurationTarget.Global);
        this.syncModelsToWebview();
    }

    private sendSessionList() {
        const sessions = this.sessionManager.getSessions().map(s => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length
        }));
        this.sendToWebview({
            type: 'sessionList',
            sessions,
            activeId: this.sessionManager.getCurrentSession().id
        });
    }

    private handleSwitchSession(sessionId: string) {
        if (this.agentLoop?.isRunning()) {
            this.agentLoop.cancel();
        }
        const session = this.sessionManager.switchSession(sessionId);
        if (!session) { return; }
        this.builtinTools.resetSessionApprovals();
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendToWebview({ type: 'sessionSwitched' });
        this.restoreSession();
        this.sendSessionList();
        // Sync agent loop messages
        if (this.agentLoop) {
            this.agentLoop.setMessages([...session.messages]);
        }
    }

    private handleDeleteSession(sessionId: string) {
        const wasCurrent = this.sessionManager.getCurrentSession().id === sessionId;
        this.sessionManager.deleteSession(sessionId);
        if (wasCurrent) {
            if (this.agentLoop?.isRunning()) { this.agentLoop.cancel(); }
            this.agentLoop?.clearMessages();
            this.sendToWebview({ type: 'sessionCleared' });
            this.restoreSession();   // restore whatever session the manager switched to
        }
        this.sendSessionList();
    }

    private restoreSession() {
        const session = this.sessionManager.getCurrentSession();
        if (session.messages.length === 0) { return; }

        // Build a map of tool_call_id → success for completed tool results
        const toolResults = new Map<string, boolean>();
        for (const msg of session.messages) {
            if ((msg as any).role === 'tool' && (msg as any).tool_call_id) {
                // If content starts with error indicators, mark as failed
                const content = String((msg as any).content || '');
                const failed = content.startsWith('Error') || content.startsWith('Failed') || content.startsWith('VALIDATION');
                toolResults.set((msg as any).tool_call_id, !failed);
            }
        }

        // Replay messages to the webview for restoration
        for (const msg of session.messages) {
            if (msg.role === 'user' && msg.content) {
                // Handle multimodal content arrays
                if (Array.isArray(msg.content)) {
                    let text = '';
                    const images: string[] = [];
                    for (const part of msg.content) {
                        if (part.type === 'text') { text = part.text; }
                        else if (part.type === 'image_url') { images.push(part.image_url.url); }
                    }
                    this.sendToWebview({ type: 'addUserMessage', text, images: images.length > 0 ? images : undefined });
                } else {
                    this.sendToWebview({ type: 'addUserMessage', text: msg.content });
                }
            } else if (msg.role === 'assistant') {
                // If the assistant message has tool_calls, render them as a progress card
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    // Filter out meta-tools for the card title
                    const realCalls = msg.tool_calls.filter((tc: any) =>
                        tc.function.name !== 'set_plan' && tc.function.name !== 'update_plan_step'
                    );
                    if (realCalls.length > 0) {
                        this.sendToWebview({ type: 'progressCardStart', title: 'Working' });
                        for (const tc of realCalls) {
                            let args: Record<string, unknown> = {};
                            try { args = JSON.parse(tc.function.arguments); } catch {}
                            const desc = this.describeToolForRestore(tc.function.name, args);
                            const success = toolResults.get(tc.id) !== false;
                            this.sendToWebview({
                                type: 'progressCardStep',
                                icon: success ? 'done' : 'error',
                                label: desc.label,
                                detail: desc.detail,
                                status: success ? 'done' : 'error',
                                toolName: tc.function.name
                            });
                        }
                        this.sendToWebview({ type: 'progressCardEnd' });
                    }
                }

                // Render assistant text content (if any)
                if (msg.content && typeof msg.content === 'string') {
                    this.sendToWebview({ type: 'startAssistantMessage' });
                    this.sendToWebview({ type: 'appendAssistantText', text: msg.content });
                    this.sendToWebview({ type: 'endAssistantMessage' });
                }
            }
        }

        // Restore into agent loop
        if (this.agentLoop) {
            this.agentLoop.setMessages([...session.messages]);
        }
    }

    /** Describe a tool call for the progress card during session restore (mirrors AgentLoop.describeToolForProgress) */
    private describeToolForRestore(name: string, args: Record<string, unknown>): { label: string; detail?: string } {
        const shortPath = (p: unknown): string => {
            if (typeof p !== 'string') { return ''; }
            const parts = p.replace(/\\/g, '/').split('/');
            return parts.length > 3 ? parts.slice(-3).join('/') : p;
        };
        const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max) + '...';

        switch (name) {
            case 'grep_search':
                return { label: `Searched for regex ${typeof args.pattern === 'string' ? `\`${args.pattern}\`` : ''}`, detail: typeof args.include === 'string' ? `(${args.include})` : undefined };
            case 'search_files':
                return { label: `Searched files: ${args.query || ''}` };
            case 'semantic_search':
                return { label: `Semantic search: ${args.query || ''}` };
            case 'find_symbol':
                return { label: `Found symbol: ${args.name || ''}` };
            case 'read_file':
                return { label: `Read ${shortPath(args.path)}`, detail: args.startLine ? `lines ${args.startLine} to ${args.endLine || ''}` : undefined };
            case 'list_directory':
                return { label: `Listed ${shortPath(args.path) || '.'}` };
            case 'get_file_tree':
                return { label: 'Loaded workspace file tree' };
            case 'get_diagnostics':
                return { label: `Diagnostics${args.path ? ' for ' + shortPath(args.path) : ''}` };
            case 'write_file':
                return { label: `Created ${shortPath(args.path)}` };
            case 'edit_file':
                return { label: `Edited ${shortPath(args.path)}` };
            case 'delete_file':
                return { label: `Deleted ${shortPath(args.path)}` };
            case 'run_terminal_command':
                return { label: `Ran: ${trunc(String(args.command || ''), 60)}` };
            case 'check_terminal_output':
                return { label: `Checked terminal: ${args.process_id || ''}` };
            default:
                if (name.startsWith('mcp_')) {
                    return { label: `MCP: ${name.replace(/^mcp_/, '')}` };
                }
                return { label: `Ran: ${name}` };
        }
    }

    // ── Webview HTML ──

    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
        );
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
:root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, transparent);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --border: var(--vscode-panel-border, var(--vscode-widget-border, #333));
    --code-bg: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.15));
    --user-msg: var(--vscode-textLink-foreground, #3794ff);
    --tool-bg: var(--vscode-editorWidget-background, rgba(0,0,0,0.1));
    --error-fg: var(--vscode-errorForeground, #f44);
    --success-fg: var(--vscode-testing-iconPassed, #4a4);
    --scrollbar: var(--vscode-scrollbarSlider-background);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
    height: 100%;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
}
body { display: flex; flex-direction: column; }



/* STATUS */
#status-bar {
    font-size: 11px;
    padding: 3px 10px;
    opacity: 0.7;
    flex-shrink: 0;
    min-height: 0;
    transition: min-height 0.15s;
    overflow: hidden;
}
#status-bar.active { min-height: 20px; }

/* MESSAGES */
#messages {
    flex: 1;
    min-height: 0;          /* allow flex item to shrink below content so overflow-y scrolls */
    overflow-y: auto;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

/* PLAN PANEL (above input) */
#plan-panel {
    border-top: 1px solid var(--border);
    background: var(--tool-bg);
    font-size: 12px;
    flex-shrink: 0;
}
#plan-panel.hidden { display: none; }
.plan-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;
}
.plan-toggle {
    font-size: 10px;
    transition: transform 0.15s;
    color: var(--fg);
}
#plan-panel.expanded .plan-toggle { transform: rotate(90deg); }
.plan-title { font-weight: 600; }
.plan-progress { font-size: 11px; margin-left: 2px; }
.plan-steps {
    display: none;
    padding: 0 10px 6px 26px;
}
#plan-panel.expanded .plan-steps { display: block; }
.plan-step {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
    font-size: 11px;
}
.plan-step .plan-icon { flex-shrink: 0; font-size: 12px; }
.plan-step.pending .plan-icon { color: var(--vscode-descriptionForeground, #888); }
.plan-step.in_progress .plan-icon { color: var(--user-msg); }
.plan-step.completed .plan-icon { color: var(--success-fg); }
.plan-step.failed .plan-icon { color: var(--error-fg); }
#messages::-webkit-scrollbar { width: 6px; }
#messages::-webkit-scrollbar-thumb {
    background: var(--scrollbar);
    border-radius: 3px;
}

.msg { line-height: 1.45; word-wrap: break-word; flex-shrink: 0; }
.msg.user {
    background: rgba(55, 148, 255, 0.08);
    border-radius: 8px;
    padding: 8px 10px;
    border-left: 3px solid var(--user-msg);
}
.msg.user .label {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--user-msg);
    margin-bottom: 4px;
}
.msg.assistant { padding: 4px 0; }
.msg.assistant .content {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
}
.msg.assistant .content h1,
.msg.assistant .content h2,
.msg.assistant .content h3 {
    margin: 8px 0 4px;
    font-weight: 700;
    line-height: 1.3;
}
.msg.assistant .content h1 { font-size: 1.1em; }
.msg.assistant .content h2 { font-size: 1.03em; }
.msg.assistant .content h3 { font-size: 0.98em; }
.msg.assistant .content ul,
.msg.assistant .content ol {
    margin: 6px 0;
    padding-left: 18px;
}
.msg.assistant .content li {
    margin: 2px 0;
}
.msg.assistant .content hr {
    display: none;
}
.msg.assistant .content code {
    background: var(--code-bg);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
}
.msg.assistant .content pre {
    background: var(--code-bg);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 6px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
    line-height: 1.4;
}

/* TOOL CALLS */
.tool-block {
    background: var(--tool-bg);
    border-radius: 6px;
    margin: 4px 0;
    border: 1px solid var(--border);
    overflow: hidden;
    flex-shrink: 0;
}
.tool-block .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    cursor: pointer;
    font-size: 12px;
    user-select: none;
}
.tool-block .tool-header .tool-icon { opacity: 0.6; }
.tool-block .tool-header .tool-name { font-weight: 600; }
.tool-block .tool-header .tool-status {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.6;
}
.tool-block .tool-detail {
    display: none;
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
}
.tool-block.expanded .tool-detail { display: block; }
.tool-block .tool-result {
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
}
.tool-block .tool-result.success { color: var(--success-fg); }
.tool-block .tool-result.failure { color: var(--error-fg); }

/* CONFIRM DIALOG */
.confirm-dialog {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    margin: 4px 0;
    flex-shrink: 0;
}
.confirm-dialog p { margin-bottom: 8px; font-size: 12px; }
.confirm-dialog .confirm-actions { display: flex; gap: 6px; }
.confirm-dialog button {
    font-size: 12px;
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
}
.confirm-dialog .btn-approve {
    background: var(--btn-bg);
    color: var(--btn-fg);
}
.confirm-dialog .btn-approve:hover { background: var(--btn-hover); }
.confirm-dialog .btn-session {
    background: transparent;
    border: 1px solid var(--btn-bg);
    color: var(--btn-bg);
}
.confirm-dialog .btn-session:hover { background: var(--btn-bg); color: var(--btn-fg); }
.confirm-dialog .btn-deny {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg);
}

/* DIFF PREVIEW */
.diff-preview {
    max-height: 240px;
    overflow: auto;
    margin-bottom: 8px;
    border-radius: 4px;
    background: var(--code-bg, rgba(0,0,0,0.15));
    font-size: 11px;
    line-height: 1.4;
}
.diff-preview pre {
    margin: 0;
    padding: 6px 8px;
    white-space: pre;
    font-family: var(--vscode-editor-font-family, monospace);
}
.diff-preview .diff-add { color: #4ec94e; }
.diff-preview .diff-del { color: #f44747; text-decoration: line-through; }
.diff-preview .diff-ctx { opacity: 0.55; }

/* FILE CHANGE DOCK */
#file-change-dock {
    background: var(--tool-bg);
    border-top: 1px solid var(--border);
    padding: 0;
    flex-shrink: 0;
    font-size: 12px;
}
#file-change-dock.hidden { display: none; }
#file-change-dock.resolved { opacity: 0.65; }
.dock-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;
}
.dock-toggle {
    font-size: 10px;
    transition: transform 0.15s;
    color: var(--fg);
}
#file-change-dock.expanded .dock-toggle { transform: rotate(90deg); }
.dock-summary { font-weight: 600; }
.dock-counts { margin-left: auto; display: flex; gap: 6px; }
.dock-add { color: #4ec94e; }
.dock-del { color: #f44747; }
.dock-actions { display: flex; gap: 6px; margin-left: 8px; }
.dock-actions button {
    font-size: 11px;
    padding: 2px 10px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-weight: 600;
}
.dock-actions .btn-keep { background: var(--btn-bg); color: var(--btn-fg); }
.dock-actions .btn-keep:hover { background: var(--btn-hover); }
.dock-actions .btn-undo { background: transparent; border: 1px solid var(--border); color: var(--fg); }
.dock-actions .btn-undo:hover { background: rgba(255,255,255,0.08); }
.dock-files {
    display: none;
    padding: 0 10px 6px 26px;
}
#file-change-dock.expanded .dock-files { display: block; }
.dock-file-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
}
.dock-file-entry.resolved { opacity: 0.5; }
.dock-file-name { color: var(--link-fg, #3794ff); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dock-file-name:hover { text-decoration: underline; }
.dock-file-counts { display: flex; gap: 6px; }
.dock-file-actions { display: flex; gap: 2px; margin-left: 6px; }
.dock-file-actions button {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 13px;
    padding: 0 3px;
    line-height: 1;
    border-radius: 3px;
    opacity: 0.7;
}
.dock-file-actions button:hover { opacity: 1; background: rgba(255,255,255,0.1); }
.dock-file-actions .file-btn-keep { color: #4ec94e; }
.dock-file-actions .file-btn-undo { color: #f44747; }
.dock-file-status { font-size: 10px; font-weight: 600; margin-left: 6px; }
.dock-file-status.kept { color: #4ec94e; }
.dock-file-status.undone { color: #f44747; }
.dock-resolved-label { font-weight: 600; font-size: 12px; }
.dock-resolved-kept { color: #4ec94e; }
.dock-resolved-undone { color: #f44747; }

/* ERROR */
.error-msg {
    color: var(--error-fg);
    font-size: 12px;
    padding: 6px 8px;
    border-left: 3px solid var(--error-fg);
    background: rgba(255, 68, 68, 0.06);
    border-radius: 4px;
    flex-shrink: 0;
}

/* ── PROGRESS CARD (GHCP-style "Working" panel) ── */
.progress-card {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin: 6px 0;
    overflow: hidden;
    flex-shrink: 0;
}
.progress-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    font-size: 13px;
    font-weight: 600;
}
.progress-card-header .pc-title-text {
    flex: 1;
    font-style: italic;
    font-weight: 400;
    opacity: 0.85;
}
.progress-card-header .pc-toggle {
    font-size: 10px;
    transition: transform 0.15s;
    opacity: 0.5;
}
.progress-card.expanded .pc-toggle {
    transform: rotate(90deg);
}
.progress-card-header .pc-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-top-color: var(--user-msg);
    border-radius: 50%;
    animation: pc-spin 0.8s linear infinite;
}
.progress-card.done .pc-spinner {
    display: none;
}
.progress-card-header .pc-done-icon {
    display: none;
    color: var(--success-fg);
    font-size: 14px;
}
.progress-card.done .pc-done-icon {
    display: inline;
}
@keyframes pc-spin {
    to { transform: rotate(360deg); }
}
.progress-card-body {
    display: none;
    padding: 0 12px 10px 12px;
}
.progress-card.expanded .progress-card-body {
    display: block;
}
.pc-timeline {
    position: relative;
    padding-left: 22px;
}
.pc-timeline::before {
    content: '';
    position: absolute;
    left: 7px;
    top: 4px;
    bottom: 4px;
    width: 2px;
    background: var(--border);
    border-radius: 1px;
}
.pc-step {
    position: relative;
    padding: 4px 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
    line-height: 1.4;
    animation: pc-fade-in 0.2s ease-out;
}
@keyframes pc-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
}
.pc-step-icon {
    position: absolute;
    left: -22px;
    top: 4px;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    border-radius: 50%;
    background: var(--bg);
    z-index: 1;
    border: 2px solid var(--border);
}
.pc-step.running .pc-step-icon {
    border-color: var(--user-msg);
    color: var(--user-msg);
    animation: pc-pulse 1.5s ease-in-out infinite;
}
.pc-step.done .pc-step-icon {
    border-color: var(--success-fg);
    color: var(--success-fg);
}
.pc-step.error .pc-step-icon {
    border-color: var(--error-fg);
    color: var(--error-fg);
}
@keyframes pc-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(55, 148, 255, 0.3); }
    50% { box-shadow: 0 0 0 4px rgba(55, 148, 255, 0); }
}
.pc-step-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.pc-step.running .pc-step-label {
    opacity: 0.9;
}
.pc-step.done .pc-step-label {
    opacity: 0.65;
}
.pc-step-detail {
    font-size: 11px;
    opacity: 0.5;
    white-space: nowrap;
}
.pc-step-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 5px;
    background: var(--border);
}
.pc-step.running .pc-step-status-dot {
    background: var(--user-msg);
    animation: pc-dot-blink 1s ease-in-out infinite;
}
.pc-step.done .pc-step-status-dot {
    background: var(--success-fg);
}
.pc-step.error .pc-step-status-dot {
    background: var(--error-fg);
}
@keyframes pc-dot-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
}

/* TERMINAL OUTPUT BLOCK */
.pc-terminal-output {
    margin: 4px 0 4px 24px;
    padding: 6px 8px;
    background: var(--input-bg, rgba(0,0,0,0.15));
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    font-size: 11px;
    line-height: 1.4;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--fg);
    opacity: 0.85;
}

/* WORKING SPINNER */
#working-indicator {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 12px;
    opacity: 0.7;
    flex-shrink: 0;
}
#working-indicator.active {
    display: flex;
}
#working-indicator .spinner-dots {
    display: flex;
    gap: 3px;
}
#working-indicator .spinner-dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--fg);
    opacity: 0.3;
    animation: dot-pulse 1.4s ease-in-out infinite;
}
#working-indicator .spinner-dots span:nth-child(2) { animation-delay: 0.2s; }
#working-indicator .spinner-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
}

/* INPUT */
#input-area {
    border-top: 1px solid var(--border);
    padding: 6px 8px;
    flex-shrink: 0;
}
#input-area.drag-over {
    background: rgba(55, 148, 255, 0.1);
    border-top: 2px dashed var(--user-msg);
}
#composer-shell {
    border: 1px solid var(--input-border);
    border-radius: 8px;
    background: var(--input-bg);
    overflow: hidden;
}
#input-area textarea {
    width: 100%;
    background: var(--input-bg);
    color: var(--input-fg);
    border: none;
    border-radius: 0;
    padding: 8px 10px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    outline: none;
    min-height: 36px;
    max-height: 200px;
    line-height: 1.4;
}
#input-area textarea:focus {
    border-color: transparent;
}
#composer-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-top: 1px solid var(--border);
    padding: 4px 6px;
    min-height: 32px;
}
#btn-attach {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    font-size: 15px;
    padding: 4px 6px;
    border-radius: 4px;
    opacity: 0.6;
    flex-shrink: 0;
}
#btn-attach:hover { opacity: 1; background: rgba(255,255,255,0.08); }

/* HISTORY PANEL */
#history-panel {
    display: none;
    max-height: 50vh;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
}
#history-panel.open { display: block; }
#history-panel::-webkit-scrollbar { width: 6px; }
#history-panel::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 3px; }
.history-item {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
    gap: 6px;
    border-bottom: 1px solid rgba(128,128,128,0.1);
}
.history-item:hover { background: rgba(255,255,255,0.04); }
.history-item.active {
    background: rgba(55, 148, 255, 0.1);
    border-left: 2px solid var(--user-msg);
}
.history-item .hi-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.history-item .hi-meta {
    font-size: 10px;
    opacity: 0.5;
    white-space: nowrap;
}
.history-item .hi-delete {
    background: none;
    border: none;
    color: var(--fg);
    opacity: 0.3;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    border-radius: 3px;
    flex-shrink: 0;
}
.history-item .hi-delete:hover { opacity: 1; color: var(--error-fg); background: rgba(255,68,68,0.1); }

#model-select {
    width: auto;
    min-width: 130px;
    max-width: 210px;
    background: transparent;
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 6px;
    padding: 3px 7px;
    font-family: inherit;
    font-size: 11px;
    outline: none;
}
#model-select:focus {
    border-color: var(--vscode-focusBorder, var(--btn-bg));
}

/* ATTACHMENT PREVIEW */
#attach-preview {
    display: none;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 0;
}
.attach-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    max-width: 200px;
}
.attach-pill span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-thumb { height: 24px; width: 24px; object-fit: cover; border-radius: 2px; }
.attach-remove {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    opacity: 0.6;
    flex-shrink: 0;
}
.attach-remove:hover { opacity: 1; }

/* USER ATTACHMENTS IN MESSAGES */
.user-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 4px 0;
}
.user-attach-img {
    max-width: 160px;
    max-height: 120px;
    border-radius: 4px;
    border: 1px solid var(--border);
}
.user-attach-file {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
}

/* CODE BLOCK COPY BUTTON */
.code-block-wrapper {
    position: relative;
    margin: 6px 0;
}
.code-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(0,0,0,0.2);
    padding: 2px 8px;
    border-radius: 4px 4px 0 0;
    font-size: 11px;
}
.code-lang {
    opacity: 0.6;
    text-transform: lowercase;
}
.copy-btn {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    opacity: 0.6;
}
.copy-btn:hover { opacity: 1; background: rgba(255,255,255,0.1); }
.code-block-wrapper pre {
    margin-top: 0;
    border-radius: 0 0 4px 4px;
}

#input-area .hint {
    font-size: 10px;
    opacity: 0.5;
    margin-top: 3px;
    text-align: right;
}
</style>
</head>
<body>

<div id="history-panel">
    <div id="history-list"></div>
</div>
<div id="status-bar"></div>
<div id="messages">
    <div id="working-indicator">
        <div class="spinner-dots"><span></span><span></span><span></span></div>
        <span id="working-text">Working...</span>
    </div>
</div>
<div id="file-change-dock" class="hidden">
    <div class="dock-header">
        <span class="dock-toggle" title="Expand/collapse">&#9654;</span>
        <span class="dock-summary"></span>
        <span class="dock-counts"><span class="dock-add">+0</span> <span class="dock-del">-0</span></span>
        <div class="dock-actions">
            <button class="btn-keep">Keep All</button>
            <button class="btn-undo">Undo All</button>
        </div>
    </div>
    <div class="dock-files"></div>
</div>
<div id="plan-panel" class="hidden">
    <div class="plan-header">
        <span class="plan-toggle">&#9654;</span>
        <span class="plan-title">Plan</span>
        <span class="plan-progress"></span>
    </div>
    <div class="plan-steps"></div>
</div>
<div id="input-area">
    <div id="attach-preview"></div>
    <div id="composer-shell">
        <textarea id="input" rows="1" placeholder="Ask Junior anything..." autofocus></textarea>
        <div id="composer-toolbar">
            <button id="btn-attach" title="Attach file">&#128206;</button>
            <select id="model-select" title="Choose model deployment">
                <option value="">Loading models...</option>
            </select>
        </div>
    </div>
    <div class="hint">Enter to send &middot; Shift+Enter for newline &middot; Paste images from clipboard</div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}



