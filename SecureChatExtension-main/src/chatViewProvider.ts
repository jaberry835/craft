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
        const config = vscode.workspace.getConfiguration('securechat.azureOpenAI');
        const deployments = config.get<Array<{ name: string; deploymentId: string }>>('deployments') || [];
        const activeDeployment = config.get<string>('activeDeployment') || undefined;
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
                    this.log('Executing securechat.selectModel command...');
                    vscode.commands.executeCommand('securechat.selectModel');
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
        this.builtinTools.setConfirmCallback((actionId, description, category) => {
            this.sendToWebview({ type: 'confirmAction', actionId, description, category });
        });

        await this.agentLoop.run(text, images, files);

        // Persist after run completes
        this.sessionManager.updateMessages(this.agentLoop.getMessages());
        this.sendSessionList();
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
        const config = vscode.workspace.getConfiguration('securechat.azureOpenAI');
        await config.update('activeDeployment', deploymentId, vscode.ConfigurationTarget.Global);
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
                this.sendToWebview({ type: 'startAssistantMessage' });
                if (msg.content && typeof msg.content === 'string') {
                    this.sendToWebview({ type: 'appendAssistantText', text: msg.content });
                }
                if (msg.tool_calls) {
                    for (const tc of msg.tool_calls) {
                        this.sendToWebview({
                            type: 'toolCall',
                            name: tc.function.name,
                            args: tc.function.arguments,
                            id: tc.id
                        });
                    }
                }
                this.sendToWebview({ type: 'endAssistantMessage' });
            }
        }

        // Restore into agent loop
        if (this.agentLoop) {
            this.agentLoop.setMessages([...session.messages]);
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

/* PLAN PANEL */
#plan-panel {
    display: none;
    margin: 4px 10px 2px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--tool-bg);
    font-size: 11px;
}
#plan-panel .plan-title {
    opacity: 0.8;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.2px;
}
#plan-panel .plan-step {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 1px 0;
}
#plan-panel .plan-step .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground, #888);
    flex-shrink: 0;
}
#plan-panel .plan-step.pending .dot { background: var(--vscode-descriptionForeground, #888); }
#plan-panel .plan-step.in_progress .dot { background: var(--user-msg); }
#plan-panel .plan-step.completed .dot { background: var(--success-fg); }
#plan-panel .plan-step.failed .dot { background: var(--error-fg); }
#plan-panel .plan-step .label { opacity: 0.95; }

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
<div id="plan-panel"></div>
<div id="messages">
    <div id="working-indicator">
        <div class="spinner-dots"><span></span><span></span><span></span></div>
        <span id="working-text">Working...</span>
    </div>
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


