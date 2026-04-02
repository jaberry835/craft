/**
 * Chat Webview Provider — the VS Code sidebar panel with a Copilot-style chat UI.
 * Implements `vscode.WebviewViewProvider` and communicates with the agent loop
 * via `ExtensionMessage` and `WebviewMessage` types.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentLoop, AgentCallbacks } from './agentLoop';
import { AgentRuntime } from './agentRuntime';
import { CopilotSdkRuntime } from './copilotSdkRuntime';
import { AzureOpenAIClient } from './aoaiClient';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { SessionManager } from './sessionManager';
import { AgentProvider, ExtensionMessage, WebviewMessage, WorkingBlock, WorkingBlockActionEntry, WorkingActionType } from './types';
import { getSetting, updateSetting } from './config';
import { TokenTracker } from './tokenTracker';
import { InlineDiffDecorator } from './inlineDiffDecorator';
import { RetrievalRanker } from './retrievalRanker';
import { RepoPatternStore } from './repoPatternStore';

/** Minimum interval (ms) between consecutive agent loop submissions */
const MIN_SUBMISSION_INTERVAL_MS = 2000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private webviewView?: vscode.WebviewView;
    private webviewPanel?: vscode.WebviewPanel;
    private agentLoop?: AgentLoop;
    /** Copilot CLI runtime — used when agentProvider is 'copilot-cli' */
    private copilotRuntime?: AgentRuntime;
    /** Active agent provider */
    private activeProvider: AgentProvider = 'local';
    private log: (msg: string) => void;
    private lastSubmissionTime = 0;

    constructor(
        private extensionUri: vscode.Uri,
        private aoaiClient: AzureOpenAIClient,
        private builtinTools: BuiltinTools,
        private mcpClient: McpClient,
        private retrievalRanker: RetrievalRanker,
        private repoPatternStore: RepoPatternStore,
        private sessionManager: SessionManager,
        log?: (msg: string) => void,
        private tokenTracker?: TokenTracker,
        private inlineDiffDecorator?: InlineDiffDecorator,
        private globalState?: vscode.Memento
    ) {
        this.log = log || (() => {});
        this.activeProvider = (getSetting<string>('agentProvider') as AgentProvider) || 'local';
        // When a file is fully resolved via inline diff CodeLens, update the dock
        if (this.inlineDiffDecorator) {
            this.inlineDiffDecorator.setDiffLookup((fsPath) => this.builtinTools.getTouchedFileInfoByPath(fsPath));
            this.inlineDiffDecorator.setFileResolvedCallback((relPath, action) => {
                if (action === 'keep') {
                    this.builtinTools.keepFile(relPath);
                } else {
                    this.builtinTools.undoFile(relPath);
                }
                this.sendToWebview({
                    type: 'fileChangeFileResolved',
                    file: relPath,
                    action: action === 'keep' ? 'kept' : 'undone'
                });
                // Check if all files resolved
                if (!this.builtinTools.hasPendingFiles() && this.pendingFileChangeResolve) {
                    const res = this.pendingFileChangeResolve;
                    this.pendingFileChangeResolve = undefined;
                    this.sendToWebview({ type: 'fileChangeResolved', action: 'kept' });
                    res('keep');
                }
            });
        }
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
            this.handleWebviewMessage(msg);
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
            this.handleWebviewMessage(msg);
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
        if (this.activeProvider === 'copilot-cli' && this.copilotRuntime) {
            const msgs = this.copilotRuntime.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs, this.copilotRuntime.getSessionState?.());
            }
        } else if (this.agentLoop) {
            const msgs = this.agentLoop.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs);
            }
        }
    }

    notifyModelChanged(model: string) {
        this.sendToWebview({ type: 'modelChanged', model });
        this.syncModelsToWebview();
    }

    private getModelConfig(): { models: Array<{ name: string; deploymentId: string }>; activeDeployment?: string; disabled?: boolean; title?: string } {
        if (this.activeProvider === 'copilot-cli') {
            return this.getCopilotCliModelConfig();
        }
        const deployments = getSetting<Array<{ name: string; deploymentId: string }>>('azureOpenAI.deployments') || [];
        const activeDeployment = getSetting<string>('azureOpenAI.activeDeployment') || undefined;
        return {
            models: deployments.map(d => ({ name: d.name || d.deploymentId, deploymentId: d.deploymentId })),
            activeDeployment
        };
    }

    private getCopilotCliModelConfig(): { models: Array<{ name: string; deploymentId: string }>; activeDeployment?: string; disabled?: boolean; title?: string } {
        const configuredModels = getSetting<Array<{ name: string; id: string }>>('copilotCli.models') || [];
        const activeModel = getSetting<string>('copilotCli.model') || '';

        const models = configuredModels.map(m => ({
            name: m.name || m.id || 'Unnamed',
            deploymentId: m.id || '__copilot_cli_default__'
        }));

        if (models.length === 0) {
            models.push({ name: 'Copilot CLI default', deploymentId: '__copilot_cli_default__' });
        }

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

    showSplash(): void {
        const showOnStartup = this.globalState?.get<boolean>('junior.splashOnStartup', false) ?? false;
        this.sendToWebview({ type: 'showSplash', showOnStartup });
    }

    newSession() {
        // Save current session's messages before creating a new one
        this.saveCurrentSession();
        if (this.activeProvider === 'copilot-cli') {
            if (this.copilotRuntime?.isRunning()) { this.copilotRuntime.cancel(); }
            this.copilotRuntime?.clearMessages();
        } else {
            if (this.agentLoop?.isRunning()) { this.agentLoop.cancel(); }
            this.builtinTools.resetSessionApprovals();
            this.agentLoop?.clearMessages();
        }
        this.sessionManager.createNewSession();
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendSessionList();
    }

    toggleHistory() {
        this.sendToWebview({ type: 'toggleHistory' } as any);
    }

    cancelAgent() {
        if (this.activeProvider === 'copilot-cli') {
            this.copilotRuntime?.cancel();
        } else {
            this.agentLoop?.cancel();
        }
    }

    /** Public method for the command registrar to switch providers */
    setAgentProvider(provider: AgentProvider) {
        this.handleSelectAgentProvider(provider);
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
                case 'selectAgentProvider':
                    this.handleSelectAgentProvider(msg.provider);
                    break;
                case 'confirmAction':
                    if (this.activeProvider === 'copilot-cli') {
                        this.copilotRuntime?.resolveConfirmation?.(msg.actionId, msg.approved, msg.allowSession);
                    } else {
                        if (msg.allowSession && msg.category) {
                            this.builtinTools.allowForSession(msg.category);
                        }
                        this.builtinTools.resolveConfirmation(msg.actionId, msg.approved);
                    }
                    break;
                case 'continueIteration':
                    if (this.activeProvider === 'copilot-cli') {
                        // SDK handles continuation internally
                    } else {
                        this.agentLoop?.resolveContinuation(msg.shouldContinue);
                    }
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
                case 'requestFileDiff':
                    this.sendToWebview({
                        type: 'fileDiffContent',
                        file: msg.file,
                        diff: this.builtinTools.getDiffForFile(msg.file)
                    });
                    break;
                case 'showInlineDiff':
                    this.showInlineDiffForFile(msg.file);
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
                    this.sendToWebview({ type: 'setAgentProvider', provider: this.activeProvider });
                    this.syncModelsToWebview();
                    this.restoreSession();
                    this.sendSessionList();
                    this.sendSlashCommands();
                    if (this.tokenTracker) {
                        this.tokenTracker.setWebviewSender((m) => this.sendToWebview(m));
                    }
                    this.maybeSendSplash();
                    break;
                case 'requestSlashCommands':
                    this.sendSlashCommands();
                    break;
                case 'splashOpenSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'junior');
                    break;
                case 'splashSetApiKey':
                    vscode.commands.executeCommand('junior.setApiKey');
                    break;
                case 'splashDismissed':
                    if (this.globalState) {
                        this.globalState.update('junior.splashDismissed', true);
                        if (msg.showOnStartup) {
                            this.globalState.update('junior.splashOnStartup', true);
                        } else {
                            this.globalState.update('junior.splashOnStartup', false);
                        }
                    }
                    break;
            }
        } catch (err: any) {
            this.log(`handleWebviewMessage error: ${err.message}\n${err.stack}`);
            this.sendToWebview({ type: 'error', message: `Internal error: ${err.message}` });
        }
    }

    private maybeSendSplash(): void {
        if (!this.globalState) { return; }
        const dismissed = this.globalState.get<boolean>('junior.splashDismissed', false);
        const showOnStartup = this.globalState.get<boolean>('junior.splashOnStartup', false);
        if (!dismissed || showOnStartup) {
            this.sendToWebview({ type: 'showSplash', showOnStartup });
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

        // Immediately activate stop button + thinking indicator
        this.sendToWebview({ type: 'agentStarted' });

        if (this.activeProvider === 'copilot-cli') {
            await this.handleUserMessageCopilotCli(text, displayText, images, files);
        } else {
            await this.handleUserMessageLocal(text, displayText, images, files);
        }
    }

    /** Handle user message with the local agent loop (Azure OpenAI) */
    private async handleUserMessageLocal(text: string, displayText: string, images?: string[], files?: { name: string; content: string }[]) {

        const callbacks: AgentCallbacks = {
            sendToWebview: (msg) => this.sendToWebview(msg)
        };

        if (!this.agentLoop) {
            this.agentLoop = new AgentLoop(
                this.aoaiClient,
                this.builtinTools,
                this.mcpClient,
                this.retrievalRanker,
                this.repoPatternStore,
                callbacks,
                this.tokenTracker,
                this.log
            );
            // After reload, seed with persisted session messages so history isn't lost
            const session = this.sessionManager.getCurrentSession();
            if (session.messages.length > 0) {
                this.agentLoop.setMessages([...session.messages]);
            }
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

        const slashDisplayText = displayText !== text ? displayText : undefined;
        try {
            await this.agentLoop.run(text, images, files, slashDisplayText);

            // If files were changed, wait for Keep/Undo (user clicks file names to review diffs)
            const summary = this.builtinTools.getPendingChangeSummary();
            if (summary) {
                await this.waitForFileChangeAction();
            }
        } finally {
            // Always persist — even if cancelled or errored
            this.sessionManager.updateMessages(this.agentLoop.getMessages());
            this.sendSessionList();
        }
    }

    /** Handle user message with the Copilot CLI runtime */
    private async handleUserMessageCopilotCli(text: string, displayText: string, images?: string[], files?: { name: string; content: string }[]) {
        const callbacks: AgentCallbacks = {
            sendToWebview: (msg) => this.sendToWebview(msg)
        };

        try {
            await this.ensureCopilotRuntime(callbacks);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.log(`[copilot-cli] Runtime init failed: ${msg}`);
            this.sendToWebview({ type: 'error', message: `Copilot CLI failed to start: ${msg}` });
            this.sendToWebview({ type: 'agentDone' });
            return;
        }
        const runtime = this.copilotRuntime;
        if (!runtime) {
            this.sendToWebview({ type: 'error', message: 'Copilot CLI runtime failed to initialize.' });
            this.sendToWebview({ type: 'agentDone' });
            return;
        }

        const slashDisplayText = displayText !== text ? displayText : undefined;
        try {
            await runtime.run(text, images, files, slashDisplayText);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.log(`[copilot-cli] Run error: ${msg}`);
            this.sendToWebview({ type: 'error', message: `Copilot CLI error: ${msg}` });
            this.sendToWebview({ type: 'agentDone' });
        } finally {
            // Always persist — even if cancelled or errored
            this.sessionManager.updateMessages(runtime.getMessages(), runtime.getSessionState?.());
            this.sendSessionList();
        }
    }

    /** Ensure the Copilot CLI runtime is initialized and session is loaded */
    private async ensureCopilotRuntime(callbacks: AgentCallbacks): Promise<void> {
        if (!this.copilotRuntime) {
            this.copilotRuntime = new CopilotSdkRuntime(callbacks, this.log, this.tokenTracker);
        }

        const session = this.sessionManager.getCurrentSession();
        this.copilotRuntime.setMessages([...session.messages]);
        if (session.runtimeState?.provider === 'copilot-cli') {
            await this.copilotRuntime.restoreSessionState?.(session.runtimeState);
        }
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
                // Clear inline diff decorations
                this.inlineDiffDecorator?.clearAll();
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

    private async showInlineDiffForFile(relPath: string): Promise<void> {
        const info = this.builtinTools.getTouchedFileInfo(relPath);
        if (!info) {
            // Touched file data may have been cleared — just open the file.
            // If the decorator already has diff state, onDidChangeActiveTextEditor
            // will re-apply decorations automatically.
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root) {
                const absPath = require('path').join(root, relPath);
                try {
                    const uri = vscode.Uri.file(absPath);
                    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
                } catch { /* file may not exist */ }
            }
            return;
        }
        if (!this.inlineDiffDecorator) {
            this.builtinTools.openDiffForFile(relPath);
            return;
        }
        await this.inlineDiffDecorator.showFile(relPath, info.absPath, info.originalContent);
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
        if (this.activeProvider === 'copilot-cli') {
            const newModel = deploymentId === '__copilot_cli_default__' ? '' : deploymentId;
            const oldModel = getSetting<string>('copilotCli.model') || '';
            await updateSetting('copilotCli.model', newModel, vscode.ConfigurationTarget.Global);
            this.syncModelsToWebview();
            // Model is passed at session creation — restart the runtime
            if (newModel !== oldModel && this.copilotRuntime) {
                this.log(`Model changed from "${oldModel || '(default)'}" to "${newModel || '(default)'}" — restarting CLI runtime`);
                this.copilotRuntime.dispose?.();
                this.copilotRuntime = undefined;
            }
        } else {
            await updateSetting('azureOpenAI.activeDeployment', deploymentId, vscode.ConfigurationTarget.Global);
            this.syncModelsToWebview();
        }
    }

    private async handleSelectAgentProvider(provider: AgentProvider) {
        if (provider === this.activeProvider) { return; }
        this.log(`Switching agent provider: ${this.activeProvider} → ${provider}`);

        // Save current session before switching
        this.saveCurrentSession();

        this.activeProvider = provider;
        await updateSetting('agentProvider', provider, vscode.ConfigurationTarget.Global);

        // Notify webview of the new provider and refresh model list
        this.sendToWebview({ type: 'setAgentProvider', provider });
        this.syncModelsToWebview();
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

    private handleSwitchSession(sessionId: string) {
        // Save current session's messages before switching away
        this.saveCurrentSession();
        if (this.activeProvider === 'copilot-cli') {
            if (this.copilotRuntime?.isRunning()) { this.copilotRuntime.cancel(); }
        } else {
            if (this.agentLoop?.isRunning()) { this.agentLoop.cancel(); }
        }
        const session = this.sessionManager.switchSession(sessionId);
        if (!session) { return; }
        if (this.activeProvider === 'local') {
            this.builtinTools.resetSessionApprovals();
        }
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendToWebview({ type: 'sessionSwitched' });
        this.restoreSession();
        this.sendSessionList();
        // Sync runtime messages
        if (this.activeProvider === 'copilot-cli' && this.copilotRuntime) {
            this.copilotRuntime.setMessages([...session.messages]);
        } else if (this.agentLoop) {
            this.agentLoop.setMessages([...session.messages]);
        }
    }

    private handleDeleteSession(sessionId: string) {
        const wasCurrent = this.sessionManager.getCurrentSession().id === sessionId;
        this.sessionManager.deleteSession(sessionId);
        if (wasCurrent) {
            if (this.activeProvider === 'copilot-cli') {
                if (this.copilotRuntime?.isRunning()) { this.copilotRuntime.cancel(); }
                this.copilotRuntime?.clearMessages();
            } else {
                if (this.agentLoop?.isRunning()) { this.agentLoop.cancel(); }
                this.agentLoop?.clearMessages();
            }
            this.sendToWebview({ type: 'sessionCleared' });
            this.restoreSession();
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
                        // Emit narration for this phase if available
                        if (i < pendingNarrations.length && pendingNarrations[i]) {
                            this.sendToWebview({ type: 'narrationText', text: pendingNarrations[i] });
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
                // (no tool calls, no working phases).
                if ((!msg.workingPhases || msg.workingPhases.length === 0)
                    && (!msg.tool_calls || msg.tool_calls.length === 0)
                    && msg.content && typeof msg.content === 'string') {
                    flushPendingBlock();
                    this.sendToWebview({ type: 'startAssistantMessage' });
                    this.sendToWebview({ type: 'appendAssistantText', text: msg.content });
                    this.sendToWebview({ type: 'endAssistantMessage' });
                }
            }
        }
        flushPendingBlock();

        // Restore into agent loop
        if (this.agentLoop) {
            this.agentLoop.setMessages([...session.messages]);
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
.msg.assistant.cli-provider {
    padding-left: 10px;
    border-left: 2px solid rgba(55, 148, 255, 0.35);
}
.assistant-provider-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    font-size: 11px;
    line-height: 1.2;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    letter-spacing: 0.2px;
    user-select: none;
}
.msg.assistant .content {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
}
.msg.assistant .content p {
    margin: 2px 0;
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
    margin: 4px 0;
    padding-left: 18px;
}
.msg.assistant .content li {
    margin: 1px 0;
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
.working-block-wrapper {
    margin: 4px 0;
    flex-shrink: 0;
}
.working-block {
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.018);
    overflow: hidden;
}
.working-block-wrapper.live .working-block {
    border-color: rgba(55, 148, 255, 0.2);
}
.working-block-wrapper.completed .working-block {
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
}
.working-block.completed .wb-leading {
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
.working-block-wrapper.live .wb-chevron {
    opacity: 0.35;
}
.working-block.expanded .wb-chevron {
    transform: rotate(90deg);
}
.working-block-body {
    display: none;
    padding: 0 10px 8px 10px;
    max-height: 300px;
    overflow-y: auto;
}
.working-block-wrapper.live .working-block-body,
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
}
/* Inline narration rows between working blocks (GHCP-style agent chatter) */
.narration-row {
    padding: 6px 16px;
    color: var(--fg);
    font-size: 12.5px;
    line-height: 1.5;
}
.narration-row p { margin: 0 0 4px; }
.narration-row p:last-child { margin-bottom: 0; }
.narration-row code {
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 12px;
}
.narration-row strong { color: var(--fg); }
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
    padding: 4px 10px 6px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
}
.working-block-wrapper.completed .wb-live-status {
    display: none;
}
.wb-live-text, #working-text, .working-block-wrapper.live .wb-leading {
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
    min-width: 140px;
    max-width: 260px;
    background: var(--vscode-dropdown-background, var(--input-bg, #1e1e1e));
    color: var(--vscode-dropdown-foreground, var(--input-fg));
    border: 1px solid var(--vscode-dropdown-border, var(--input-border));
    border-radius: 6px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 12.5px;
    outline: none;
    cursor: pointer;
}
#model-select:focus {
    border-color: var(--vscode-focusBorder, var(--btn-bg));
}
#model-select option {
    background: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background, #252526));
    color: var(--vscode-dropdown-foreground, var(--input-fg));
    padding: 4px 8px;
    font-size: 12.5px;
}

/* Provider bar – sits below the composer shell, matches GHCP bottom bar */
#provider-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
}
#provider-select {
    background: none;
    border: none;
    color: var(--fg);
    opacity: 0.65;
    font-family: inherit;
    font-size: 11.5px;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    outline: none;
}
#provider-select:hover {
    opacity: 1;
    background: rgba(255,255,255,0.08);
}
#provider-select:focus {
    border-color: var(--vscode-focusBorder, var(--btn-bg));
}
#provider-select option {
    background: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background, #252526));
    color: var(--vscode-dropdown-foreground, var(--input-fg));
    padding: 4px 8px;
    font-size: 11.5px;
}

/* ATTACHMENT PREVIEW */

/* ── SPLASH SCREEN ── */
#splash-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
}
#splash-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
}
#splash-card {
    position: relative;
    z-index: 1;
    background: rgba(30, 30, 30, 0.92);
    border: 1px solid rgba(0, 164, 239, 0.35);
    border-radius: 16px;
    padding: 40px 36px 30px;
    max-width: 380px;
    width: 90%;
    text-align: center;
    box-shadow: 0 0 60px rgba(0, 164, 239, 0.15), 0 4px 30px rgba(0,0,0,0.5);
    backdrop-filter: blur(8px);
}
#splash-card h1 {
    margin: 0 0 6px;
    font-size: 28px;
    font-weight: 700;
    background: linear-gradient(135deg, #00A4EF, #7FBA00, #FFB900, #F25022);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}
#splash-card .splash-subtitle {
    color: #aaa;
    font-size: 13px;
    margin-bottom: 28px;
}
.splash-buttons {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 22px;
}
.splash-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 11px 18px;
    border: none;
    border-radius: 8px;
    font-size: 13.5px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: transform 0.15s, box-shadow 0.15s;
}
.splash-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.splash-btn:active { transform: translateY(0); }
.splash-btn.settings-btn {
    background: linear-gradient(135deg, #00A4EF, #0078D4);
    color: #fff;
}
.splash-btn.apikey-btn {
    background: linear-gradient(135deg, #FFB900, #F7630C);
    color: #1e1e1e;
}
.splash-start {
    display: inline-block;
    margin: 8px 0 18px;
    color: #7FBA00;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: none;
    font-family: inherit;
    transition: color 0.15s;
}
.splash-start:hover { color: #9ee200; text-decoration: underline; }
.splash-checkbox {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 11.5px;
    color: #888;
}
.splash-checkbox input { accent-color: #00A4EF; cursor: pointer; }
.splash-checkbox label { cursor: pointer; }

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
<div id="messages">
    <div id="working-indicator">
        <span id="working-text">Thinking</span>
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
<div id="status-bar"></div>
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
    <div id="provider-bar">
        <select id="provider-select" title="Agent provider">
            <option value="local">▫ Local</option>
            <option value="copilot-cli">✦ Copilot CLI</option>
        </select>
    </div>
    <div class="hint"><div id="context-meter"><div class="meter-ring"><svg viewBox="0 0 20 20"><circle class="meter-bg" cx="10" cy="10" r="8" /><circle class="meter-fill" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="50.27" /></svg></div><span class="meter-label">0 / 128.0K (0%)</span></div></div>
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



