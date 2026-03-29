/**
 * Chat Webview Provider — the VS Code sidebar panel with a Copilot-style chat UI.
 * Implements `vscode.WebviewViewProvider` and communicates with the agent loop
 * via `ExtensionMessage` and `WebviewMessage` types.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentCallbacks } from './agentRuntime';
import { AgentRuntime } from './agentRuntime';
import { CopilotCliAcpRuntime } from './copilotCliAcpRuntime';
import { SessionManager } from './sessionManager';
import { ExtensionMessage, WebviewMessage, WorkingBlock, WorkingBlockActionEntry, WorkingActionType } from './types';
import { getSetting, updateSetting } from './config';
import { TokenTracker } from './tokenTracker';

/** Minimum interval (ms) between consecutive agent loop submissions */
const MIN_SUBMISSION_INTERVAL_MS = 2000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private webviewView?: vscode.WebviewView;
    private webviewPanel?: vscode.WebviewPanel;
    private agentRuntime?: AgentRuntime;
    private log: (msg: string) => void;
    private lastSubmissionTime = 0;

    constructor(
        private extensionUri: vscode.Uri,
        private sessionManager: SessionManager,
        log?: (msg: string) => void,
        private tokenTracker?: TokenTracker
    ) {
        this.log = log || (() => {});
    }

    /** The active webview, whether from the sidebar view or an editor panel tab. */
    private get webview(): vscode.Webview | undefined {
        return this.webviewPanel?.webview ?? this.webviewView?.webview;
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
            void this.handleWebviewMessage(msg);
        });
    }

    /** Open the chat as an editor tab (WebviewPanel). */
    openInTab(): void {
        // If already open, just reveal it
        if (this.webviewPanel) {
            this.webviewPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'junior.chatTab',
            'Junior Chat',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri]
            }
        );

        this.webviewPanel = panel;
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
        panel.webview.html = this.getHtmlContent(panel.webview);

        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            void this.handleWebviewMessage(msg);
        });

        panel.onDidDispose(() => {
            this.webviewPanel = undefined;
        });
    }

    focusView(): void {
        if (this.webviewPanel) {
            this.webviewPanel.reveal();
        } else {
            this.webviewView?.show(false);
        }
    }

    sendToWebview(msg: ExtensionMessage) {
        this.webview?.postMessage(msg);
    }

    /** Persist current agent loop messages to session storage (called on deactivate/reload). */
    saveCurrentSession() {
        if (this.agentRuntime) {
            const msgs = this.agentRuntime.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs, this.agentRuntime.getSessionState?.());
            }
        }
    }

    notifyModelChanged(model: string) {
        this.sendToWebview({ type: 'modelChanged', model });
        this.syncModelsToWebview();
    }

    private getModelConfig(): { models: Array<{ name: string; deploymentId: string }>; activeDeployment?: string; disabled?: boolean; title?: string } {
        const configuredModels = getSetting<Array<{ name: string; id: string }>>('copilotCli.models') || [];
        const activeModel = getSetting<string>('copilotCli.model') || '';

        // Build the dropdown list from the configured models
        const models = configuredModels.map(m => ({
            name: m.name || m.id || 'Unnamed',
            deploymentId: m.id || '__copilot_cli_default__'
        }));

        // If no models configured, show a single "default" entry
        if (models.length === 0) {
            models.push({ name: 'Copilot CLI default', deploymentId: '__copilot_cli_default__' });
        }

        // If the active model isn't in the list, add it so the dropdown shows it
        const activeId = activeModel || '__copilot_cli_default__';
        if (!models.some(m => m.deploymentId === activeId)) {
            models.push({ name: activeModel, deploymentId: activeModel });
        }

        return {
            models,
            activeDeployment: activeId,
            disabled: false,
            title: activeModel
                ? `Model: ${activeModel}`
                : 'Using the Copilot CLI default model'
        };
    }

    private syncModelsToWebview(): void {
        const { models, activeDeployment, disabled, title } = this.getModelConfig();
        this.sendToWebview({ type: 'setModels', models, activeDeployment, disabled, title });
    }

    sendMessageFromExtension(text: string) {
        this.handleUserMessage(text);
    }

    newSession() {
        // Save current session's messages before creating a new one
        if (this.agentRuntime) {
            const msgs = this.agentRuntime.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs, this.agentRuntime.getSessionState?.());
            }
        }
        if (this.agentRuntime?.isRunning()) {
            this.agentRuntime.cancel();
        }
        this.sessionManager.createNewSession();
        this.agentRuntime?.clearMessages();
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendSessionList();
    }

    toggleHistory() {
        this.sendToWebview({ type: 'toggleHistory' } as any);
    }

    cancelAgent() {
        this.agentRuntime?.cancel();
    }

    private async handleWebviewMessage(msg: WebviewMessage) {
        this.log(`Webview message received: ${msg.type}`);
        try {
            switch (msg.type) {
                case 'sendMessage':
                    await this.handleUserMessage(msg.text, msg.images, msg.files);
                    break;
                case 'cancelAgent':
                    this.cancelAgent();
                    break;
                case 'manageMcpServers':
                    vscode.commands.executeCommand('junior.manageMcpServers');
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
                    this.agentRuntime?.resolveConfirmation?.(msg.actionId, msg.approved, msg.allowSession);
                    break;
                case 'continueIteration':
                    this.agentRuntime?.resolveContinuation?.(msg.shouldContinue);
                    break;
                case 'openFile':
                    this.openFileInEditor(msg.filePath);
                    break;
                case 'attachFile':
                    this.handleAttachFile();
                    break;
                case 'showTokenUsage':
                    if (this.tokenTracker) { this.tokenTracker.showDetailedUsage(); }
                    break;
                case 'switchSession':
                    await this.handleSwitchSession(msg.sessionId);
                    break;
                case 'deleteSession':
                    this.handleDeleteSession(msg.sessionId);
                    break;
                case 'requestSessionList':
                    this.sendSessionList();
                    break;
                case 'ready':
                    this.log('Webview reported ready');
                    this.sendToWebview({ type: 'sessionCleared' });
                    this.syncModelsToWebview();
                    void this.restoreSession();
                    this.sendSessionList();
                    this.sendSlashCommands();
                    if (this.tokenTracker) {
                        this.tokenTracker.setWebviewSender((m) => this.sendToWebview(m));
                    }
                    break;
                case 'requestSlashCommands':
                    this.sendSlashCommands();
                    break;
                case 'showInlineDiff':
                    this.openFileDiffInEditor(msg.file, true);
                    break;
                case 'openFileDiff':
                    this.openFileDiffInEditor(msg.file, false);
                    break;
                case 'requestFileDiff':
                    this.handleRequestFileDiff(msg.file);
                    break;
                case 'fileChangeAction':
                    this.handleFileChangeAction(msg.action);
                    break;
                case 'fileChangeFileAction':
                    this.handleFileChangeFileAction(msg.file, msg.action);
                    break;
            }
        } catch (err: any) {
            this.log(`handleWebviewMessage error: ${err.message}\n${err.stack}`);
            this.sendToWebview({ type: 'error', message: `Internal error: ${err.message}` });
        }
    }

    private async handleUserMessage(text: string, images?: string[], files?: { name: string; content: string }[]) {
        if (!text.trim() && (!images || images.length === 0) && (!files || files.length === 0)) { return; }

        // Rate-limit: prevent rapid-fire submissions from stacking API calls
        const now = Date.now();
        const elapsed = now - this.lastSubmissionTime;
        if (elapsed < MIN_SUBMISSION_INTERVAL_MS && this.lastSubmissionTime > 0) {
            this.sendToWebview({ type: 'error', message: 'Please wait a moment before sending another message.' });
            return;
        }
        this.lastSubmissionTime = now;

        // Keep original text for display, resolve slash commands for the AI
        const displayText = text;
        text = this.resolveSlashCommand(text);

        // Echo the user message to the webview (show original, not the resolved template)
        const fileNames = files?.map(f => f.name);
        this.sendToWebview({ type: 'addUserMessage', text: displayText, images, fileNames });

        // Immediately activate stop button + thinking indicator so the user sees
        // feedback before any async runtime work (connection, session, etc.).
        this.sendToWebview({ type: 'agentStarted' });

        const callbacks: AgentCallbacks = {
            sendToWebview: (msg) => this.sendToWebview(msg)
        };

        const provider = this.getAgentProvider();
        await this.ensureRuntime(callbacks);
        const runtime = this.agentRuntime;
        if (!runtime) {
            throw new Error('Agent runtime failed to initialize.');
        }

        this.logActiveEndpointSource(provider);

        const slashDisplayText = displayText !== text ? displayText : undefined;
        try {
            await runtime.run(text, images, files, slashDisplayText);
        } finally {
            // Always persist — even if cancelled or errored
            this.sessionManager.updateMessages(runtime.getMessages(), runtime.getSessionState?.());
            this.sendSessionList();
        }
    }

    private getAgentProvider(): string {
        return 'copilot-cli';
    }

    private logActiveEndpointSource(_provider: string): void {
        const cliPath = getSetting<string>('copilotCli.path') || 'copilot';
        const copilotHome = getSetting<string>('copilotCli.home');
        const model = getSetting<string>('copilotCli.model') || 'default';
        const homeSource = copilotHome ? `junior.copilotCli.home=${copilotHome}` : 'COPILOT_HOME from process environment/default CLI location';

        this.log(
            `Endpoint source: provider=copilot-cli, transport=acp-stdio, cliPath=${cliPath}, model=${model}, homeSource=${homeSource}`
        );
    }

    private createAgentRuntime(callbacks: AgentCallbacks): AgentRuntime {
        return new CopilotCliAcpRuntime(callbacks, this.log);
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
        const newModel = deploymentId === '__copilot_cli_default__' ? '' : deploymentId;
        const oldModel = getSetting<string>('copilotCli.model') || '';
        await updateSetting('copilotCli.model', newModel, vscode.ConfigurationTarget.Global);
        this.syncModelsToWebview();

        // Model is passed via COPILOT_MODEL env at spawn time — restart the CLI
        if (newModel !== oldModel && this.agentRuntime) {
            this.log(`Model changed from "${oldModel || '(default)'}" to "${newModel || '(default)'}" — restarting CLI runtime`);
            this.agentRuntime.dispose?.();
            this.agentRuntime = undefined;
            await this.ensureRuntime({ sendToWebview: (msg) => this.sendToWebview(msg) });
        }
    }

    // ── Slash Command Support ──

    /** Get the list of directories to scan for slash command .md files */
    private getSlashCommandDirs(): string[] {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return []; }

        const custom = getSetting<string[]>('slashCommands.directories') || [];
        const defaults = [
            path.join(root, '.junior', 'commands'),
            path.join(root, '.github', 'copilot', 'commands'),
            path.join(root, '.github', 'commands'),
        ];

        const all = [...custom.map(d => path.isAbsolute(d) ? d : path.join(root, d)), ...defaults];
        return all.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
    }

    /** Discover all available slash commands from command directories */
    private discoverSlashCommands(): Array<{ name: string; description: string }> {
        const commands: Array<{ name: string; description: string }> = [];
        const seen = new Set<string>();

        for (const dir of this.getSlashCommandDirs()) {
            try {
                const entries = fs.readdirSync(dir);
                for (const entry of entries) {
                    if (!entry.endsWith('.md')) { continue; }
                    const name = entry.replace(/\.md$/i, '');
                    if (seen.has(name)) { continue; }
                    seen.add(name);

                    // Read first line as description
                    let description = '';
                    try {
                        const content = fs.readFileSync(path.join(dir, entry), 'utf-8');
                        const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
                        description = firstLine.replace(/^#+ */, '').trim().slice(0, 80);
                    } catch { /* ignore */ }

                    commands.push({ name: '/' + name, description });
                }
            } catch { /* directory unreadable */ }
        }

        return commands.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Send available slash commands to the webview for autocomplete */
    private sendSlashCommands() {
        const dirs = this.getSlashCommandDirs();
        this.log(`Slash command dirs found: ${dirs.length} → ${JSON.stringify(dirs)}`);
        const commands = this.discoverSlashCommands();
        this.log(`Slash commands discovered: ${commands.length} → ${commands.map(c => c.name).join(', ')}`);
        this.sendToWebview({ type: 'slashCommands', commands } as any);
    }

    /**
     * If the user's message starts with /commandName, find the matching .md file,
     * read its content, and prepend it to the user's message as context.
     */
    private resolveSlashCommand(text: string): string {
        const match = text.match(/^\/(\S+)\s*([\s\S]*)$/);
        if (!match) { return text; }

        const commandName = match[1];
        const userArgs = match[2].trim();

        for (const dir of this.getSlashCommandDirs()) {
            const filePath = path.join(dir, commandName + '.md');
            try {
                if (fs.existsSync(filePath)) {
                    const template = fs.readFileSync(filePath, 'utf-8').trim();
                    this.log(`Slash command /${commandName} resolved from ${filePath}`);

                    // Cap template at 8000 chars to avoid context blowup
                    const capped = template.length > 8000
                        ? template.slice(0, 8000) + '\n... [template truncated]'
                        : template;

                    if (userArgs) {
                        return `${capped}\n\n---\n\nUser request: ${userArgs}`;
                    }
                    return capped;
                }
            } catch { /* ignore read errors */ }
        }

        // No matching command file found — return original text
        return text;
    }

    private async openFileInEditor(filePath: string) {
        try {
            if (!filePath) {
                this.log('openFileInEditor: no filePath provided');
                return;
            }
            this.log(`openFileInEditor: attempting to open "${filePath}"`);
            let absPath = filePath;
            if (!path.isAbsolute(filePath)) {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (root) {
                    absPath = path.join(root, filePath);
                } else {
                    this.log('openFileInEditor: no workspace folder to resolve relative path');
                    return;
                }
            }
            this.log(`openFileInEditor: resolved to "${absPath}"`);
            const uri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
        } catch (err: any) {
            this.log(`openFileInEditor error: ${err.message}`);
        }
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

    private async handleSwitchSession(sessionId: string) {
        // Save current session's messages before switching away
        if (this.agentRuntime) {
            const msgs = this.agentRuntime.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs, this.agentRuntime.getSessionState?.());
            }
        }
        if (this.agentRuntime?.isRunning()) {
            this.agentRuntime.cancel();
        }
        const session = this.sessionManager.switchSession(sessionId);
        if (!session) { return; }
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendToWebview({ type: 'sessionSwitched' });
        await this.ensureRuntime({ sendToWebview: (msg) => this.sendToWebview(msg) });
        await this.restoreSession();
        this.sendSessionList();
    }

    private handleDeleteSession(sessionId: string) {
        const wasCurrent = this.sessionManager.getCurrentSession().id === sessionId;
        this.sessionManager.deleteSession(sessionId);
        if (wasCurrent) {
            if (this.agentRuntime?.isRunning()) { this.agentRuntime.cancel(); }
            this.agentRuntime?.clearMessages();
            this.sendToWebview({ type: 'sessionCleared' });
            void this.restoreSession();   // restore whatever session the manager switched to
        }
        this.sendSessionList();
    }

    private async restoreSession() {
        const session = this.sessionManager.getCurrentSession();
        await this.ensureRuntime({ sendToWebview: (msg) => this.sendToWebview(msg) });
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

        // Check if any assistant message has workingPhases — if so, those phases
        // already cover ALL the tool-calling iterations, so skip the fallback path.
        const hasStoredPhases = session.messages.some(
            m => m.role === 'assistant' && m.workingPhases && m.workingPhases.length > 0
        );

        // Replay messages to the webview for restoration
        // We accumulate consecutive tool-calling assistant messages into a single
        // working block so restore matches the live grouping behaviour.
        let pendingBlock: WorkingBlock | null = null;
        let pendingEntries: WorkingBlockActionEntry[] = [];

        // When working phases are stored, narration texts from earlier iterations
        // are queued and interleaved with phases when we encounter the message
        // that carries the workingPhases array.
        const pendingNarrations: string[] = [];

        const flushPendingBlock = () => {
            if (!pendingBlock || pendingEntries.length === 0) {
                pendingBlock = null;
                pendingEntries = [];
                return;
            }
            this.sendToWebview({ type: 'workingBlockStarted', block: pendingBlock });
            for (const entry of pendingEntries) {
                this.sendToWebview({ type: 'workingActionAdded', blockId: pendingBlock.id, entry });
            }
            this.sendToWebview({
                type: 'workingBlockCompleted',
                blockId: pendingBlock.id,
                summary: this.buildRestoreSummaryFromEntries(pendingEntries),
                completedAt: Date.now()
            });
            pendingBlock = null;
            pendingEntries = [];
        };

        for (const msg of session.messages) {
            if (msg.role === 'user' && msg.content) {
                flushPendingBlock();
                // Use displayText (original slash-command text) if available, otherwise fall back to content
                const display = (msg as any).displayText;
                // Handle multimodal content arrays
                if (Array.isArray(msg.content)) {
                    let text = '';
                    const images: string[] = [];
                    for (const part of msg.content) {
                        if (part.type === 'text') { text = part.text; }
                        else if (part.type === 'image_url') { images.push(part.image_url.url); }
                    }
                    this.sendToWebview({ type: 'addUserMessage', text: display || text, images: images.length > 0 ? images : undefined });
                } else {
                    this.sendToWebview({ type: 'addUserMessage', text: display || msg.content });
                }
            } else if (msg.role === 'assistant') {
                if (msg.workingPhases && msg.workingPhases.length > 0) {
                    // Collect narration from THIS message (last iteration) into the queue
                    if (msg.tool_calls && msg.tool_calls.length > 0
                        && msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                        pendingNarrations.push(msg.content.trim());
                    }

                    // Interleave queued narrations with working phases.
                    // narration[i] corresponds to phase[i].
                    flushPendingBlock();
                    for (let i = 0; i < msg.workingPhases.length; i++) {
                        const phase = msg.workingPhases[i];
                        // Emit assistant text that preceded this phase (CLI runtime)
                        if (phase.assistantTextBefore) {
                            this.sendToWebview({ type: 'startAssistantMessage' });
                            this.sendToWebview({ type: 'appendAssistantText', text: phase.assistantTextBefore });
                            this.sendToWebview({ type: 'endAssistantMessage' });
                        }
                        // Emit narration for this phase: prefer per-phase narration (CLI runtime),
                        // fall back to queued narrations from message content (native runtime).
                        const narrationText = phase.narration || (i < pendingNarrations.length ? pendingNarrations[i] : '');
                        if (narrationText) {
                            this.sendToWebview({ type: 'narrationText', text: narrationText });
                        }
                        const block: WorkingBlock = {
                            ...phase,
                            entries: []
                        };
                        this.sendToWebview({ type: 'workingBlockStarted', block });
                        for (const entry of phase.entries) {
                            if (entry.kind === 'progress') {
                                this.sendToWebview({ type: 'workingTextAppended', blockId: phase.id, entry });
                            } else {
                                this.sendToWebview({ type: 'workingActionAdded', blockId: phase.id, entry });
                            }
                        }
                        this.sendToWebview({
                            type: 'workingBlockCompleted',
                            blockId: phase.id,
                            summary: phase.summary || phase.title,
                            completedAt: phase.completedAt || phase.startedAt
                        });
                    }
                    // Emit any remaining narrations that didn't have a matching phase
                    for (let i = msg.workingPhases.length; i < pendingNarrations.length; i++) {
                        if (pendingNarrations[i]) {
                            this.sendToWebview({ type: 'narrationText', text: pendingNarrations[i] });
                        }
                    }
                    pendingNarrations.length = 0;
                } else if (hasStoredPhases && msg.tool_calls && msg.tool_calls.length > 0) {
                    // Queue narration for interleaving with phases later
                    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                        pendingNarrations.push(msg.content.trim());
                    }
                } else if (!hasStoredPhases && msg.tool_calls && msg.tool_calls.length > 0) {
                    // Emit narration immediately (no phases to interleave with)
                    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
                        flushPendingBlock();
                        this.sendToWebview({ type: 'narrationText', text: msg.content.trim() });
                    }

                    const realCalls = msg.tool_calls.filter((tc: any) =>
                        tc.function.name !== 'set_plan' && tc.function.name !== 'update_plan_step'
                    );
                    if (realCalls.length > 0) {
                        if (!pendingBlock) {
                            pendingBlock = this.createRestoreWorkingBlock('Working');
                        }
                        for (const tc of realCalls) {
                            let args: Record<string, unknown> = {};
                            try { args = JSON.parse(tc.function.arguments); } catch {}
                            const success = toolResults.get(tc.id) !== false;
                            const entry = this.describeToolForRestore(tc.function.name, args, success);
                            pendingEntries.push(entry);
                        }
                    }
                }

                // Render assistant text content only for plain assistant messages
                // (no tool calls, no working phases) OR for messages whose content
                // represents a real response alongside working phases (CLI runtime).
                const hasPhases = msg.workingPhases && msg.workingPhases.length > 0;
                const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
                const hasContent = msg.content && typeof msg.content === 'string' && msg.content.trim();
                if (hasContent) {
                    if (!hasPhases && !hasToolCalls) {
                        // Plain assistant message
                        flushPendingBlock();
                        this.sendToWebview({ type: 'startAssistantMessage' });
                        this.sendToWebview({ type: 'appendAssistantText', text: msg.content as string });
                        this.sendToWebview({ type: 'endAssistantMessage' });
                    } else if (hasPhases && !hasToolCalls) {
                        // CLI runtime: content is the final response after tool phases
                        this.sendToWebview({ type: 'startAssistantMessage' });
                        this.sendToWebview({ type: 'appendAssistantText', text: msg.content as string });
                        this.sendToWebview({ type: 'endAssistantMessage' });
                    }
                }
            }
        }
        flushPendingBlock();

        // Restore into the active runtime
        if (this.agentRuntime) {
            this.agentRuntime.setMessages([...session.messages]);
            if (session.runtimeState?.provider === 'copilot-cli') {
                await this.agentRuntime.restoreSessionState?.(session.runtimeState);
            }
        }
    }

    private async ensureRuntime(callbacks: AgentCallbacks): Promise<void> {
        const activeRuntimeProvider = this.agentRuntime?.getSessionState?.()?.provider;

        if (!this.agentRuntime || activeRuntimeProvider !== 'copilot-cli') {
            this.agentRuntime?.dispose?.();
            this.agentRuntime = this.createAgentRuntime(callbacks);
        }

        const session = this.sessionManager.getCurrentSession();
        this.agentRuntime.setMessages([...session.messages]);
        if (session.runtimeState?.provider === 'copilot-cli') {
            await this.agentRuntime.restoreSessionState?.(session.runtimeState);
        }
    }

    private createRestoreWorkingBlock(title: string): WorkingBlock {
        return {
            id: `restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            status: 'completed',
            title,
            summary: title,
            entries: [],
            startedAt: Date.now(),
            completedAt: Date.now()
        };
    }

    private buildRestoreWorkingSummary(actionCount: number): string {
        return actionCount === 1 ? 'Completed 1 action' : `Completed ${actionCount} actions`;
    }

    /** Build a descriptive summary from accumulated restore entries (same logic as agentLoop). */
    private buildRestoreSummaryFromEntries(entries: WorkingBlockActionEntry[]): string {
        if (entries.length === 0) { return 'Working'; }

        const counts = new Map<WorkingActionType, number>();
        for (const e of entries) {
            counts.set(e.actionType, (counts.get(e.actionType) || 0) + 1);
        }

        const describeBucket = (at: WorkingActionType, count: number): string => {
            switch (at) {
                case 'read': case 'review':
                    return `Reviewed ${count} file${count === 1 ? '' : 's'}`;
                case 'search':
                    return count === 1 ? 'Ran 1 search' : `Ran ${count} searches`;
                case 'create': {
                    if (count === 1) {
                        const single = entries.find(e => e.actionType === at);
                        return single?.text || 'Created 1 file';
                    }
                    return `Created ${count} files`;
                }
                case 'edit': {
                    if (count === 1) {
                        const single = entries.find(e => e.actionType === at);
                        return single?.text || 'Updated 1 file';
                    }
                    return `Updated ${count} files`;
                }
                case 'todo':
                    return count === 1 ? 'Created 1 todo' : `Created ${count} todos`;
                case 'analyze':
                    return count === 1 ? 'Analyzed 1 item' : `Analyzed ${count} items`;
                case 'run':
                    return count === 1 ? 'Ran 1 command' : `Ran ${count} commands`;
                case 'check':
                    return count === 1 ? 'Checked 1 item' : `Checked ${count} items`;
                default:
                    return count === 1 ? 'Completed 1 action' : `Completed ${count} actions`;
            }
        };

        const seen = new Set<WorkingActionType>();
        const parts: string[] = [];
        for (const e of entries) {
            if (seen.has(e.actionType)) { continue; }
            seen.add(e.actionType);
            parts.push(describeBucket(e.actionType, counts.get(e.actionType) || 0));
            if (parts.length >= 2) { break; }
        }

        return parts.length > 0 ? parts.join(' and ') : 'Working';
    }

    /** Describe a tool call for working block restore fallback. */
    private describeToolForRestore(name: string, args: Record<string, unknown>, success: boolean): WorkingBlockActionEntry {
        const shortPath = (p: unknown): string => {
            if (typeof p !== 'string') { return ''; }
            const parts = p.replace(/\\/g, '/').split('/');
            return parts.length > 3 ? parts.slice(-3).join('/') : p;
        };
        const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max) + '...';
        const choose = (doneText: string, failText: string) => success ? doneText : failText;

        const buildEntry = (
            text: string,
            actionType: WorkingBlockActionEntry['actionType'],
            icon: WorkingBlockActionEntry['icon'],
            detail?: string,
            filePath?: string
        ): WorkingBlockActionEntry => ({
            id: `restore_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            kind: 'action',
            text,
            createdAt: Date.now(),
            actionType,
            status: success ? 'done' : 'error',
            detail,
            filePath,
            toolName: name,
            icon: success ? icon : 'error'
        });

        switch (name) {
            case 'grep_search':
                return buildEntry(choose(`Searched for regex ${typeof args.pattern === 'string' ? `\`${args.pattern}\`` : ''}`, `Search failed for regex ${typeof args.pattern === 'string' ? `\`${args.pattern}\`` : ''}`), 'search', 'search', typeof args.include === 'string' ? `(${args.include})` : undefined);
            case 'search_files':
                return buildEntry(choose(`Searched files: ${args.query || ''}`, `File search failed: ${args.query || ''}`), 'search', 'search');
            case 'semantic_search':
                return buildEntry(choose(`Semantic search: ${args.query || ''}`, `Semantic search failed: ${args.query || ''}`), 'search', 'search');
            case 'find_symbol':
                return buildEntry(choose(`Found symbol: ${args.name || ''}`, `Symbol lookup failed: ${args.name || ''}`), 'search', 'search');
            case 'read_file':
                return buildEntry(choose(`Read ${shortPath(args.path)}`, `Failed to read ${shortPath(args.path)}`), 'read', 'read', args.startLine ? `lines ${args.startLine} to ${args.endLine || ''}` : undefined, typeof args.path === 'string' ? args.path : undefined);
            case 'list_directory':
                return buildEntry(choose(`Listed ${shortPath(args.path) || '.'}`, `Failed to list ${shortPath(args.path) || '.'}`), 'review', 'read');
            case 'get_file_tree':
                return buildEntry(choose('Loaded workspace file tree', 'Failed to load workspace file tree'), 'review', 'read');
            case 'get_diagnostics':
                return buildEntry(choose(`Checked diagnostics${args.path ? ' for ' + shortPath(args.path) : ''}`, `Failed to check diagnostics${args.path ? ' for ' + shortPath(args.path) : ''}`), 'check', 'check', undefined, typeof args.path === 'string' ? args.path : undefined);
            case 'write_file':
                return buildEntry(choose(`Created ${shortPath(args.path)}`, `Failed to create ${shortPath(args.path)}`), 'create', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
            case 'edit_file':
                return buildEntry(choose(`Edited ${shortPath(args.path)}`, `Failed to edit ${shortPath(args.path)}`), 'edit', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
            case 'replace_lines': {
                const rlStart = Number(args.start_line) || 1;
                const rlNewLines = typeof args.new_content === 'string' ? args.new_content.split('\n').length : 0;
                const rlEnd = rlStart + Math.max(rlNewLines, 1) - 1;
                return buildEntry(choose(`Rewrote lines ${rlStart}–${rlEnd} in ${shortPath(args.path)}`, `Failed to rewrite lines ${rlStart}–${rlEnd} in ${shortPath(args.path)}`), 'edit', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
            }
            case 'delete_file':
                return buildEntry(choose(`Deleted ${shortPath(args.path)}`, `Failed to delete ${shortPath(args.path)}`), 'edit', 'edit', undefined, typeof args.path === 'string' ? args.path : undefined);
            case 'run_terminal_command':
                return buildEntry(choose(`Ran: ${trunc(String(args.command || ''), 60)}`, `Command failed: ${trunc(String(args.command || ''), 60)}`), 'run', 'run');
            case 'check_terminal_output':
                return buildEntry(choose(`Checked terminal: ${args.process_id || ''}`, `Failed terminal check: ${args.process_id || ''}`), 'check', 'check');
            default:
                if (name.startsWith('mcp_')) {
                    return buildEntry(`MCP: ${name.replace(/^mcp_/, '')}`, 'other', 'run');
                }
                return buildEntry(`Ran: ${name}`, 'other', 'loading');
        }
    }

    // ── File Change Dock handlers ──

    private openFileDiffInEditor(file: string, _inline: boolean): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }
        const abs = path.isAbsolute(file) ? file : path.join(root, file);
        const fileUri = vscode.Uri.file(abs);
        this.log(`Opening diff for: ${abs}`);
        // Use git.openChange (shows side-by-side diff against HEAD)
        // Falls back to plain file open if git extension unavailable
        vscode.commands.executeCommand('git.openChange', fileUri).then(undefined, (err: any) => {
            this.log(`git.openChange failed: ${err?.message}, falling back to vscode.open`);
            vscode.commands.executeCommand('vscode.open', fileUri);
        });
    }

    private handleRequestFileDiff(file: string): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }
        const abs = path.isAbsolute(file) ? file : path.join(root, file);
        // Try unstaged diff first, then staged diff (HEAD), then full-file fallback
        cp.execFile('git', ['diff', '-U3', '--', abs], { cwd: root, timeout: 5000 }, (err, stdout) => {
            if (!err && stdout.trim()) {
                this.sendParsedDiff(file, stdout);
                return;
            }
            // Try staged diff against HEAD
            cp.execFile('git', ['diff', 'HEAD', '-U3', '--', abs], { cwd: root, timeout: 5000 }, (err2, stdout2) => {
                if (!err2 && stdout2.trim()) {
                    this.sendParsedDiff(file, stdout2);
                    return;
                }
                // Untracked new file — show full content as additions
                try {
                    const content = fs.readFileSync(abs, 'utf-8');
                    const lines = content.split('\n').map(l => `+ ${l}`).join('\n');
                    this.sendToWebview({ type: 'fileDiffContent', file, diff: lines });
                } catch {
                    this.sendToWebview({ type: 'fileDiffContent', file, diff: '' });
                }
            });
        });
    }

    private sendParsedDiff(file: string, rawDiff: string): void {
        const bodyLines: string[] = [];
        let pastHeader = false;
        for (const line of rawDiff.split('\n')) {
            if (!pastHeader) {
                if (line.startsWith('@@')) { pastHeader = true; }
                continue;
            }
            if (line.startsWith('+')) { bodyLines.push('+ ' + line.substring(1)); }
            else if (line.startsWith('-')) { bodyLines.push('- ' + line.substring(1)); }
            else if (line.startsWith(' ')) { bodyLines.push('  ' + line.substring(1)); }
            else if (line.startsWith('@@')) { bodyLines.push('  ---'); }
        }
        this.sendToWebview({ type: 'fileDiffContent', file, diff: bodyLines.join('\n') });
    }

    private handleFileChangeAction(action: 'keep' | 'undo'): void {
        if (action === 'undo') {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root) {
                cp.execFile('git', ['checkout', '--', '.'], { cwd: root, timeout: 10000 }, (err) => {
                    if (err) { this.log(`git checkout failed: ${err.message}`); }
                    // Also clean untracked files created by the agent
                    cp.execFile('git', ['clean', '-fd'], { cwd: root, timeout: 10000 }, () => {
                        this.sendToWebview({ type: 'fileChangeResolved', action: 'undone' });
                    });
                });
                return;
            }
        }
        this.sendToWebview({ type: 'fileChangeResolved', action: action === 'keep' ? 'kept' : 'undone' });
    }

    private handleFileChangeFileAction(file: string, action: 'keep' | 'undo'): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (action === 'undo' && root) {
            const abs = path.isAbsolute(file) ? file : path.join(root, file);
            // Check if file is tracked by git
            cp.execFile('git', ['ls-files', '--error-unmatch', abs], { cwd: root, timeout: 5000 }, (err) => {
                if (err) {
                    // Untracked file — delete it
                    fs.unlink(abs, () => {
                        this.sendToWebview({ type: 'fileChangeFileResolved', file, action: 'undone' });
                    });
                } else {
                    // Tracked file — restore from HEAD
                    cp.execFile('git', ['checkout', 'HEAD', '--', abs], { cwd: root, timeout: 5000 }, () => {
                        this.sendToWebview({ type: 'fileChangeFileResolved', file, action: 'undone' });
                    });
                }
            });
            return;
        }
        this.sendToWebview({ type: 'fileChangeFileResolved', file, action: action === 'keep' ? 'kept' : 'undone' });
    }

    // ── Webview HTML ──

    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
        );
        const codiconFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.ttf')
        );
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
@font-face {
    font-family: "codicon";
    font-display: block;
    src: url("${codiconFontUri}") format("truetype");
}
.codicon {
    font: normal normal normal 16px/1 codicon;
    display: inline-block;
    text-decoration: none;
    text-rendering: auto;
    text-align: center;
    -webkit-font-smoothing: antialiased;
}
.codicon-search:before { content: "\\ea6d"; }
.codicon-edit:before { content: "\\ea73"; }
.codicon-file:before { content: "\\ea7b"; }
.codicon-new-file:before { content: "\\ea7f"; }
.codicon-terminal:before { content: "\\ea85"; }
.codicon-error:before { content: "\\ea87"; }
.codicon-check:before { content: "\\eab2"; }
.codicon-loading:before { content: "\\eb19"; }
.codicon-play:before { content: "\\eb2c"; }
.codicon-list-tree:before { content: "\\eb86"; }
.codicon-pass:before { content: "\\eba4"; }
.codicon-arrow-up:before { content: "\\eaa1"; }
.codicon-debug-stop:before { content: "\\eaf7"; }
.codicon-add:before { content: "\\ea60"; }
.codicon-loading.codicon-modifier-spin {
    animation: codicon-spin 1.5s steps(30) infinite;
}
@keyframes codicon-spin {
    100% { transform: rotate(360deg); }
}
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
    white-space: normal;
    overflow-wrap: break-word;
    word-break: normal;
    font-size: 13px;
    line-height: 1.55;
}
.msg.assistant .content p {
    margin: 6px 0;
}
.msg.assistant .content p br {
    display: block;
    content: '';
    margin-bottom: 4px;
}
.msg.assistant .content p:first-child {
    margin-top: 0;
}
.msg.assistant .content p:last-child {
    margin-bottom: 0;
}
.msg.assistant .content h1,
.msg.assistant .content h2,
.msg.assistant .content h3 {
    margin: 6px 0 2px;
    font-weight: 700;
    line-height: 1.3;
}
.msg.assistant .content h1 { font-size: 1.1em; }
.msg.assistant .content h2 { font-size: 1.03em; }
.msg.assistant .content h3 { font-size: 0.98em; }
.msg.assistant .content ul,
.msg.assistant .content ol {
    margin: 6px 0;
    padding-left: 22px;
}
.msg.assistant .content li {
    margin: 3px 0;
    line-height: 1.5;
}
.msg.assistant .content li > ul,
.msg.assistant .content li > ol {
    margin: 2px 0;
}
.msg.assistant .content hr {
    display: none;
}
.msg.assistant .content code {
    background: var(--code-bg);
    padding: 2px 5px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
    color: var(--vscode-textPreformat-foreground, #d7ba7d);
}
.msg.assistant .content pre {
    background: var(--code-bg);
    padding: 12px 14px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
    line-height: 1.5;
}
.msg.assistant .content pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    color: inherit;
    font-size: inherit;
}
/* Markdown tables */
.msg.assistant .content table,
.narration-row table {
    border-collapse: collapse;
    margin: 6px 0;
    font-size: 12.5px;
    width: 100%;
    overflow-x: auto;
    display: block;
}
.msg.assistant .content th,
.narration-row th {
    text-align: left;
    padding: 4px 8px;
    border-bottom: 2px solid var(--border);
    font-weight: 600;
    font-size: 12px;
    color: var(--fg);
    white-space: nowrap;
}
.msg.assistant .content td,
.narration-row td {
    padding: 3px 8px;
    border-bottom: 1px solid rgba(128,128,128,0.15);
    font-size: 12px;
    color: var(--fg);
    opacity: 0.9;
}
.msg.assistant .content tr:last-child td,
.narration-row tr:last-child td {
    border-bottom: none;
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

/* CONTINUE ITERATION DIALOG */
.continue-iteration-dialog {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    margin: 4px 0;
    flex-shrink: 0;
}
.continue-iteration-dialog p { margin-bottom: 8px; font-size: 12px; color: var(--fg); }
.continue-iteration-dialog .continue-subtitle { font-size: 11px; color: var(--muted-fg, #888); margin-bottom: 8px; }
.continue-iteration-dialog .continue-actions { display: flex; gap: 6px; }
.continue-iteration-dialog button {
    font-size: 12px;
    padding: 4px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
}
.continue-iteration-dialog .btn-continue {
    background: var(--btn-bg);
    color: var(--btn-fg);
}
.continue-iteration-dialog .btn-continue:hover { background: var(--btn-hover); }
.continue-iteration-dialog .btn-pause {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg);
}
.continue-iteration-dialog .btn-pause:hover { background: var(--tool-bg); }

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

/* INLINE DIFF IN DOCK */
.dock-file-row {
    display: flex;
    align-items: center;
    gap: 6px;
}
.dock-file-toggle {
    font-size: 8px;
    cursor: pointer;
    color: var(--fg);
    opacity: 0.6;
    transition: transform 0.15s;
    user-select: none;
    flex-shrink: 0;
    width: 10px;
    text-align: center;
}
.dock-file-toggle.expanded { transform: rotate(90deg); }
.dock-file-toggle:hover { opacity: 1; }
.dock-inline-diff {
    margin: 2px 0 6px 16px;
    border-radius: 4px;
    background: var(--code-bg, rgba(0,0,0,0.2));
    overflow: hidden;
}
.dock-inline-diff.hidden { display: none; }
.dock-diff-loading, .dock-diff-empty {
    padding: 8px 12px;
    font-size: 11px;
    opacity: 0.6;
    font-style: italic;
}
.dock-diff-content {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
}
.diff-line {
    display: flex;
    padding: 0 8px;
    white-space: pre;
    min-height: 18px;
}
.diff-line-add { background: rgba(78, 201, 78, 0.12); }
.diff-line-del { background: rgba(244, 71, 71, 0.12); }
.diff-line-ctx { opacity: 0.6; }
.diff-line-sep {
    opacity: 0.3;
    justify-content: center;
    font-size: 10px;
    padding: 2px 8px;
}
.diff-gutter {
    width: 16px;
    flex-shrink: 0;
    text-align: center;
    user-select: none;
    opacity: 0.7;
}
.diff-line-add .diff-gutter { color: #4ec94e; }
.diff-line-del .diff-gutter { color: #f44747; }
.diff-text { flex: 1; }
.dock-file-actions .file-btn-editor {
    font-size: 11px;
    opacity: 0.5;
}
.dock-file-actions .file-btn-editor:hover { opacity: 1; }

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
    flex-direction: column;
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

/* ── WORKING BLOCKS (GHCP-style staged activity) ── */
.working-block {
    margin: 4px 0;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.018);
    overflow: hidden;
    flex-shrink: 0;
}
.working-block.live {
    border-color: rgba(55, 148, 255, 0.2);
}
.working-block.completed {
    border-color: rgba(255,255,255,0.04);
}
.working-block.completed .working-block-body {
    opacity: 0.55;
    transition: opacity 0.15s ease;
}
.working-block.completed:hover .working-block-body {
    opacity: 1;
}
.working-block-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    user-select: none;
}
.working-block.completed .working-block-header {
    cursor: pointer;
}
.working-block.completed .working-block-header:hover {
    background: rgba(255,255,255,0.035);
}
.wb-header-copy {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
}
.wb-leading {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 700;
    color: var(--user-msg);
    display: none;
}
.working-block.live .wb-leading {
    display: none;
}
.working-block.completed .wb-leading {
    display: inline;
    color: var(--vscode-descriptionForeground, rgba(255,255,255,0.65));
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.15s ease;
    background: none;
    -webkit-text-fill-color: currentColor;
}
.working-block.completed:hover .wb-leading {
    color: var(--fg);
}
.wb-title {
    min-width: 0;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
}
.working-block.completed .wb-title {
    display: none;
}
.wb-summary {
    display: none;
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
}
.wb-chevron {
    flex-shrink: 0;
    width: 12px;
    text-align: center;
    opacity: 0.7;
    font-size: 10px;
    transition: transform 0.15s ease;
}
.working-block.live .wb-chevron {
    opacity: 0.35;
}
.working-block.expanded .wb-chevron {
    transform: rotate(90deg);
}
.working-block-body {
    display: none;
    padding: 0 10px 8px 10px;
    max-height: 200px;
    overflow-y: auto;
}
.working-block-body::-webkit-scrollbar { width: 5px; }
.working-block-body::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.12);
    border-radius: 3px;
}
.working-block-body::-webkit-scrollbar-thumb:hover {
    background: rgba(255,255,255,0.25);
}
.working-block.completed .working-block-body {
    max-height: none;
    overflow-y: visible;
}
.working-block.live .working-block-body,
.working-block.expanded .working-block-body {
    display: block;
}
.wb-entries {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.wb-entry {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    animation: wb-fade-in 0.12s ease-out;
}
@keyframes wb-fade-in {
    from { opacity: 0; transform: translateY(1px); }
    to { opacity: 1; transform: translateY(0); }
}
.wb-entry.progress {
    padding: 2px 0 2px;
}
.wb-progress-marker {
    width: 6px;
    height: 6px;
    margin-top: 6px;
    border-radius: 50%;
    background: rgba(55, 148, 255, 0.6);
    flex-shrink: 0;
}
.wb-progress-text {
    font-size: 12px;
    line-height: 1.45;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    white-space: normal;
    overflow-wrap: break-word;
}
/* Inline narration rows between working blocks (GHCP-style agent chatter) */
.narration-row {
    padding: 8px 16px;
    color: var(--fg);
    font-size: 13px;
    line-height: 1.55;
    white-space: normal;
    overflow-wrap: break-word;
}
.narration-row p { margin: 6px 0; }
.narration-row p br {
    display: block;
    content: '';
    margin-bottom: 4px;
}
.narration-row p:first-child { margin-top: 0; }
.narration-row p:last-child { margin-bottom: 0; }
.narration-row code {
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 2px 5px;
    border-radius: 4px;
    font-size: 0.88em;
    color: var(--vscode-textPreformat-foreground, #d7ba7d);
}
.narration-row strong { color: var(--fg); }
.narration-row ul,
.narration-row ol {
    margin: 6px 0;
    padding-left: 22px;
}
.narration-row li {
    margin: 3px 0;
    line-height: 1.5;
}
.narration-row pre {
    background: var(--code-bg);
    padding: 12px 14px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
    line-height: 1.5;
}
.narration-row pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    color: inherit;
    font-size: inherit;
}
.wb-progress-text code {
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(255,255,255,0.06);
}
.wb-progress-text ol, .wb-progress-text ul {
    margin: 4px 0 4px 16px;
    padding: 0;
}
.wb-progress-text li {
    margin: 2px 0;
}
.wb-progress-text strong {
    color: var(--fg);
}
/* Done actions are flat rows (no card); running/error get a subtle highlight */
.wb-entry.action {
    padding: 3px 0;
}
.wb-entry.action.running {
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(55, 148, 255, 0.06);
    border: 1px solid rgba(55, 148, 255, 0.15);
}
.wb-entry.action.error {
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(244, 71, 71, 0.06);
    border: 1px solid rgba(244, 71, 71, 0.18);
}
.wb-action-icon {
    width: 16px;
    height: 16px;
    margin-top: 1px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    line-height: 1;
}
.wb-entry.action.done .wb-action-icon {
    color: var(--vscode-descriptionForeground, rgba(255,255,255,0.55));
}
.wb-entry.action.running .wb-action-icon {
    color: var(--user-msg);
}
.wb-entry.action.error .wb-action-icon {
    color: var(--error-fg);
}
.wb-action-copy {
    min-width: 0;
}
.wb-action-text {
    font-size: 12px;
    line-height: 1.35;
    color: var(--fg);
    overflow-wrap: anywhere;
}
.wb-entry.action.done .wb-action-text {
    color: var(--vscode-descriptionForeground, rgba(255,255,255,0.72));
}
.wb-action-detail {
    margin-top: 1px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.wb-action-diff {
    display: inline-flex;
    gap: 6px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    margin-left: 8px;
    flex-shrink: 0;
    align-self: center;
}
.wb-action-diff .diff-add { color: #4ec94e; }
.wb-action-diff .diff-del { color: #f44747; }
.wb-live-status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
}
.wb-live-text, #working-text, .working-block.live .wb-title {
    background: linear-gradient(
        90deg,
        var(--fg, #e8eaed) 0%,
        var(--fg, #e8eaed) 40%,
        #fff 50%,
        var(--fg, #e8eaed) 60%,
        var(--fg, #e8eaed) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: text-shimmer 2s ease-in-out infinite;
}
@keyframes text-shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
}
.pc-file-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 3px;
    color: #fff;
    margin-left: 5px;
    vertical-align: middle;
    letter-spacing: 0.3px;
    opacity: 0.9;
}

/* FILE LINKS + TERMINAL OUTPUT */
.pc-file-link {
    cursor: pointer;
    color: var(--vscode-textLink-foreground, #3794ff);
}
.pc-file-link:hover {
    text-decoration: underline;
}
.wb-terminal-output {
    margin: 6px 0 0 22px;
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
@keyframes thinking-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
}
@keyframes spinner-spin {
    to { transform: rotate(360deg); }
}
#working-indicator {
    display: none;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    margin: 8px 0;
    font-size: 13px;
    color: var(--fg);
    flex-shrink: 0;
    background: var(--tool-bg, rgba(255,255,255,0.04));
    border-radius: 8px;
    border: 1px solid var(--border);
}
#working-indicator .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--user-msg);
    border-radius: 50%;
    animation: spinner-spin 0.8s linear infinite;
    flex-shrink: 0;
}
#working-indicator.active {
    display: flex;
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
    overflow: visible;
    position: relative;
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
    gap: 2px;
    padding: 4px 6px;
    min-height: 32px;
}
/* Shared composer toolbar button base */
.composer-btn {
    background: none;
    border: none;
    color: var(--fg);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 6px;
    opacity: 0.55;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: opacity 0.12s, background 0.12s;
}
.composer-btn:hover {
    opacity: 1;
    background: rgba(255,255,255,0.1);
}
#btn-attach .codicon { font-size: 14px; }

/* Agent mode label */
.agent-mode {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--fg);
    opacity: 0.7;
    padding: 2px 6px;
    border-radius: 6px;
    cursor: default;
    user-select: none;
    flex-shrink: 0;
}
.agent-mode .agent-icon {
    font-size: 13px;
    opacity: 0.8;
}

/* Tools button SVG */
#btn-tools svg {
    width: 16px;
    height: 16px;
}

/* Spacer pushes tools + send to the right */
.composer-spacer { flex: 1; }

/* Send / Stop button — same base, slightly larger hit area */
#btn-send {
    width: 26px;
    height: 26px;
    padding: 0;
    font-size: 16px;
}
#btn-send.stop-mode {
    border: 1.5px solid var(--fg);
    color: var(--fg);
    border-radius: 50%;
    position: relative;
    opacity: 0.8;
    background: none;
}
#btn-send.stop-mode:hover {
    border-color: var(--error-fg);
    color: var(--error-fg);
    opacity: 1;
    background: none;
}
#btn-send.stop-mode .codicon {
    font-size: 14px;
}
.agent-stop-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    color: var(--error-fg);
}
.agent-stop-icon svg {
    width: 15px;
    height: 15px;
    display: block;
}
/* Spinning ring on stop button */
#btn-send.stop-mode::before {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--user-msg);
    animation: stop-spin 1s linear infinite;
}
@keyframes stop-spin {
    100% { transform: rotate(360deg); }
}

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
    margin: 8px 0;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.06);
}
.code-block-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(0,0,0,0.3);
    padding: 4px 10px;
    font-size: 11px;
}
.code-lang {
    opacity: 0.6;
    text-transform: lowercase;
    font-family: var(--vscode-editor-font-family, monospace);
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
    margin: 0;
    border-radius: 0;
    border: none;
}

#input-area .hint {
    font-size: 10px;
    opacity: 0.5;
    margin-top: 3px;
    text-align: right;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
#context-meter {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
}
#context-meter .meter-ring {
    width: 18px;
    height: 18px;
    position: relative;
}
#context-meter .meter-ring svg {
    width: 18px;
    height: 18px;
    transform: rotate(-90deg);
}
#context-meter .meter-ring .meter-bg {
    fill: none;
    stroke: var(--vscode-editorWidget-border, rgba(255,255,255,0.1));
    stroke-width: 3;
}
#context-meter .meter-ring .meter-fill {
    fill: none;
    stroke: var(--vscode-progressBar-background, #0078d4);
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.4s ease;
}
#context-meter .meter-label {
    white-space: nowrap;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transition: max-width 0.3s ease, opacity 0.3s ease;
}
#context-meter:hover .meter-label {
    max-width: 200px;
    opacity: 1;
}

/* Slash command autocomplete */
#slash-autocomplete {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    max-height: 180px;
    overflow-y: auto;
    background: var(--vscode-editorWidget-background, var(--input-bg));
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 4px;
    z-index: 100;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.25);
}
#slash-autocomplete.open { display: block; }
.slash-item {
    padding: 6px 10px;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
}
.slash-item:hover, .slash-item.active {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
}
.slash-item .slash-name {
    font-weight: 600;
    color: var(--user-msg);
    white-space: nowrap;
}
.slash-item .slash-desc {
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
        <span class="spinner"></span>
        <span id="working-text">Thinking...</span>
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
    <div id="composer-shell" style="position:relative;">
        <div id="slash-autocomplete"></div>
        <textarea id="input" rows="1" placeholder="Ask Junior anything..." autofocus></textarea>
        <div id="composer-toolbar">
            <button id="btn-attach" class="composer-btn" title="Attach context"><i class="codicon codicon-add"></i></button>
            <span class="agent-mode"><span class="agent-icon">&#9672;</span> Agent</span>
            <select id="model-select" title="Choose model deployment">
                <option value="">Loading models...</option>
            </select>
            <button id="btn-tools" class="composer-btn" title="MCP Tools"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="4" width="14" height="1.2" rx="0.6"/><circle cx="10.5" cy="4.6" r="2"/><rect x="1" y="10.8" width="14" height="1.2" rx="0.6"/><circle cx="5.5" cy="11.4" r="2"/></svg></button>
            <div class="composer-spacer"></div>
            <button id="btn-send" class="composer-btn" title="Send message (Enter)"><i class="codicon codicon-arrow-up"></i></button>
        </div>
    </div>
    <div class="hint"><span class="hint-text">Enter to send &middot; Shift+Enter for newline &middot; Paste images from clipboard</span><div id="context-meter"><div class="meter-ring"><svg viewBox="0 0 20 20"><circle class="meter-bg" cx="10" cy="10" r="8" /><circle class="meter-fill" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="50.27" /></svg></div><span class="meter-label">0 / 128.0K (0%)</span></div></div>
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



