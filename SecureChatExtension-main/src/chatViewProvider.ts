/**
 * Chat Webview Provider — the VS Code sidebar panel with a Copilot-style chat UI.
 * Implements `vscode.WebviewViewProvider` and communicates with the agent loop
 * via `ExtensionMessage` and `WebviewMessage` types.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { AgentLoop, AgentCallbacks } from './agentLoop';
import { AgentRuntime } from './agentRuntime';
import { CopilotSdkRuntime } from './copilotSdkRuntime';
import { AzureOpenAIClient } from './aoaiClient';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { SessionManager } from './sessionManager';
import { AgentPermissionLevel, AgentProvider, AgentProviderOption, ChatMode, ContextAttachmentKind, DevTeamResponseSummary, ExtensionMessage, WebviewMessage } from './types';
import { getSetting, updateSetting } from './config';
import { TokenTracker } from './tokenTracker';
import { formatCopilotCliRunError } from './errorFormatting';
import { InlineDiffDecorator } from './inlineDiffDecorator';
import { RetrievalRanker } from './retrievalRanker';
import { RepoPatternStore } from './repoPatternStore';
import { AgentTaskMemory } from './taskMemory';
import { shouldPersistTranscriptMessage } from './chatTranscript';
import { DEFAULT_PERMISSION_LEVEL } from './permissions';

/**
 * Strip a leading YAML frontmatter block (`---\n...\n---\n`) from a markdown
 * string. Used for `.prompt.md` files (spec-kit, VS Code prompts) which carry
 * tool/model metadata that the agent doesn't need in context.
 */
function stripFrontmatter(content: string): string {
    if (!content.startsWith('---')) { return content; }
    const end = content.indexOf('\n---', 3);
    if (end === -1) { return content; }
    const after = content.indexOf('\n', end + 4);
    return after === -1 ? '' : content.slice(after + 1);
}

function prefixDevTeamNarration(speaker: string, text: string): string {
    const trimmed = text.trim();
    if (!trimmed) { return text; }
    const prefix = `**${speaker}:**`;
    if (trimmed.startsWith(prefix)) { return text; }
    return `${prefix} ${trimmed}\n\n`;
}

function buildDevTeamMemberWorkOrder(team: DevTeamDef, member: DevTeamDef['members'][number], userRequest: string, memberNotes: string, consultContext: string): string {
    const notes = memberNotes.trim() || 'No prior notes from this member.';
    return `Junior Dev Team member execution pass.

Team: ${team.name}
Member: ${member.role}
Permission: ${member.permission}

Original human request:
${userRequest}

Your consult notes:
${notes}

Team consult context:
${consultContext}

Act now as ${member.role}. If implementation is needed, inspect the workspace and make the appropriate file edits using tools. Keep the scope tight and avoid unrelated changes.

Implementation completeness rules:
- If the team consult context contains grounded source-backed content for requested pages, sections, records, docs, or data, populate the deliverable from that content in this pass.
- Do not create empty shells, placeholder pages, or "populate later" sections for grounded content that is already available in the consult context.
- If some content is genuinely unavailable, still build the available grounded portions and mark only the unavailable portions as pending.
- Treat "I created the structure but need source content later" as incomplete when source excerpts are already present above.

Visible output rules for this worker pass:
- Write brief activity updates only, one short sentence at a time.
- Do not write final-answer sections such as "What changed", "What I validated", "What remains", "Recommendation", or "Next steps".
- Do not produce a detailed implementation summary; the Dev Team final synthesis will do that after your pass.
- End with one compact completion note in this form: "Done: <changed/checked in one sentence>."`;
}
import { ProviderRouter } from './providerRouter';
import { replaySessionMessages } from './sessionRestore';
import { CustomAgentDef, CustomAgentStore } from './customAgents';
import { CustomAgentEditor } from './customAgentEditor';
import { DevTeamDef, DevTeamStore } from './devTeams';
import { DevTeamEditor } from './devTeamEditor';
import { buildDevTeamConsultContext, DevTeamConsultResult, DevTeamRuntime, selectDevTeamExecutionResults } from './devTeamRuntime';
import { acquireSearchEntraToken, createSearchKnowledgeTool } from './tools/searchKnowledge';

/** Minimum interval (ms) between consecutive agent loop submissions */
const MIN_SUBMISSION_INTERVAL_MS = 2000;
const MAX_CONTEXT_ATTACHMENT_CHARS = 120000;
const MAX_UNTRACKED_CONTEXT_FILES = 20;
const MAX_UNTRACKED_CONTEXT_FILE_CHARS = 40000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private webviewView?: vscode.WebviewView;
    private webviewPanel?: vscode.WebviewPanel;
    private agentLoop?: AgentLoop;
    private devTeamRuntime?: DevTeamRuntime;
    private devTeamConsultAbortController?: AbortController;
    private activeDevTeamNarrationSpeaker?: string;
    /** Copilot CLI runtime — used when agentProvider is 'copilot-cli' */
    private copilotRuntime?: AgentRuntime;
    /** Provider routing — model config, provider switching, availability */
    private providerRouter: ProviderRouter;
    /** Active permission level for the current chat session */
    private currentPermissionLevel: AgentPermissionLevel = DEFAULT_PERMISSION_LEVEL;
    /** Active chat mode */
    private activeMode: ChatMode = 'agent';
    /** Active custom agent id, if any. When set, runs use the agent loop with the persona overlay. */
    private activeCustomAgentId: string | null = null;
    /** Active Dev Team id, if any. When set, runs use a team coordinator persona overlay. */
    private activeDevTeamId: string | null = null;
    /** Per-turn Dev Team participation summary for the next assistant response. */
    private pendingDevTeamResponseSummary?: DevTeamResponseSummary;
    /** Recent terminal output streamed from Junior-run commands, used by the Terminal context attachment. */
    private recentTerminalLines: string[] = [];
    /** Cached list of custom agents to push to the webview. */
    private customAgentsCache: CustomAgentDef[] = [];
    /** Cached list of Dev Teams to push to the webview. */
    private devTeamsCache: DevTeamDef[] = [];
    private log: (msg: string) => void;
    private lastSubmissionTime = 0;
    private restoringTranscript = false;

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
        private globalState?: vscode.Memento,
        private customAgentStore?: CustomAgentStore,
        private devTeamStore?: DevTeamStore,
        private extensionContext?: vscode.ExtensionContext,
    ) {
        this.log = log || (() => {});
        this.providerRouter = new ProviderRouter(
            (msg) => this.sendToWebview(msg),
            this.log,
        );
        const currentSession = this.sessionManager.getCurrentSession();
        this.activeMode = this.getSessionMode(currentSession);
        this.activeCustomAgentId = currentSession.activeCustomAgentId ?? null;
        this.activeDevTeamId = currentSession.activeDevTeamId ?? null;
        this.currentPermissionLevel = currentSession.activePermissionLevel ?? DEFAULT_PERMISSION_LEVEL;
        this.refreshProviderAvailability();
        this.applyPermissionLevel(this.currentPermissionLevel, { persist: false, sync: false });
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

    /** Convenience accessor — delegates to providerRouter. */
    private get activeProvider(): AgentProvider { return this.providerRouter.activeProvider; }
    private set activeProvider(value: AgentProvider) { this.providerRouter.activeProvider = value; }

    /** Convenience accessor — delegates to providerRouter. */
    private get copilotCliAvailability() { return this.providerRouter.copilotCliAvailability; }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        const html = this.getHtmlContent(webviewView.webview);
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
        if (msg.type === 'terminalOutput') {
            this.captureRecentTerminalLine(msg.line);
        }
        if (msg.type === 'narrationText' && this.activeDevTeamNarrationSpeaker) {
            msg = { ...msg, text: prefixDevTeamNarration(this.activeDevTeamNarrationSpeaker, msg.text) };
        }
        if (msg.type === 'startAssistantMessage') {
            const team = this.pendingDevTeamResponseSummary;
            if (team) {
                msg = { ...msg, team };
                this.pendingDevTeamResponseSummary = undefined;
            }
        }
        this.webview?.postMessage(msg);
        if (!this.restoringTranscript) {
            this.captureTranscriptMessage(msg);
        }
    }

    /** Persist current agent loop messages to session storage (called on deactivate/reload). */
    saveCurrentSession() {
        this.sessionManager.flushPendingSave();
        if (this.activeProvider === 'copilot-cli' && this.copilotRuntime) {
            const msgs = this.copilotRuntime.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs, this.copilotRuntime.getSessionState?.(), this.activeMode, this.currentPermissionLevel);
            }
        } else if (this.agentLoop) {
            const msgs = this.agentLoop.getMessages();
            if (msgs.length > 0) {
                this.sessionManager.updateMessages(msgs, undefined, this.activeMode, this.currentPermissionLevel);
            }
        }
    }

    private captureTranscriptMessage(msg: ExtensionMessage): void {
        if (!shouldPersistTranscriptMessage(msg)) {
            return;
        }

        this.sessionManager.recordTranscriptMessage(msg, {
            provider: msg.type === 'startAssistantMessage' ? this.activeProvider : undefined,
            immediate: this.shouldPersistTranscriptImmediately(msg),
        });
    }

    private shouldPersistTranscriptImmediately(msg: ExtensionMessage): boolean {
        switch (msg.type) {
            case 'startAssistantMessage':
            case 'appendAssistantText':
            case 'endAssistantMessage':
            case 'narrationText':
            case 'workingBlockStarted':
            case 'workingTextAppended':
            case 'workingActionAdded':
            case 'workingActionUpdated':
            case 'workingBlockCompleted':
            case 'terminalOutput':
            case 'devTeamRoomEvent':
                return false;
            default:
                return true;
        }
    }

    notifyModelChanged(model: string) {
        this.sendToWebview({ type: 'modelChanged', model });
        this.syncModelsToWebview();
    }

    private getModelConfig() {
        return this.providerRouter.getModelConfig();
    }

    private syncModelsToWebview(): void {
        this.providerRouter.syncModelsToWebview();
    }

    private getAgentProviderOptions(): AgentProviderOption[] {
        return this.providerRouter.getAgentProviderOptions();
    }

    private syncProvidersToWebview(): void {
        this.providerRouter.syncProvidersToWebview();
    }

    private syncPermissionLevelToWebview(): void {
        this.sendToWebview({ type: 'setPermissionLevel', level: this.currentPermissionLevel });
    }

    private applyPermissionLevel(
        level: AgentPermissionLevel,
        options: { persist?: boolean; sync?: boolean } = {}
    ): void {
        this.currentPermissionLevel = level;
        this.builtinTools.setPermissionLevel(level);
        this.copilotRuntime?.setPermissionLevel?.(level);

        if (options.persist !== false) {
            this.sessionManager.setActivePermissionLevel(level);
        }
        if (options.sync !== false) {
            this.syncPermissionLevelToWebview();
        }
    }

    private async confirmPermissionLevel(level: AgentPermissionLevel): Promise<boolean> {
        if (level === 'default') {
            return true;
        }

        const warningKey = `junior.permissionWarningSeen.${level}`;
        if (this.globalState?.get<boolean>(warningKey, false)) {
            return true;
        }

        const action = await vscode.window.showWarningMessage(
            'Enable Bypass Approvals for this session?',
            {
                modal: true,
                detail: 'Bypass Approvals auto-approves all tool calls for this chat session, including file edits, terminal commands, and external tool calls.'
            },
            'Enable'
        );

        if (action !== 'Enable') {
            this.syncPermissionLevelToWebview();
            return false;
        }

        await this.globalState?.update(warningKey, true);
        return true;
    }

    private async handleSelectPermissionLevel(level: AgentPermissionLevel): Promise<void> {
        if (level === this.currentPermissionLevel) {
            this.syncPermissionLevelToWebview();
            return;
        }

        if (!(await this.confirmPermissionLevel(level))) {
            return;
        }

        this.applyPermissionLevel(level);
    }

    public refreshProviderAvailability(): void {
        this.providerRouter.refreshAvailability(() => {
            this.copilotRuntime?.dispose?.();
            this.copilotRuntime = undefined;
        });
    }

    public getAvailableAgentProviderOptions(): AgentProviderOption[] {
        this.refreshProviderAvailability();
        return this.getAgentProviderOptions();
    }

    sendMessageFromExtension(text: string) {
        this.handleUserMessage(text, this.activeMode);
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
            this.devTeamConsultAbortController?.abort();
            this.devTeamConsultAbortController = undefined;
            this.builtinTools.resetSessionApprovals();
            this.agentLoop?.clearMessages();
        }
        this.sessionManager.createNewSession(this.activeMode, DEFAULT_PERMISSION_LEVEL);
        this.applyPermissionLevel(DEFAULT_PERMISSION_LEVEL, { persist: false });
        this.sendToWebview({ type: 'sessionCleared' });
        this.sendToWebview({ type: 'setChatMode', mode: this.activeMode });
        this.sendToWebview({ type: 'planReady', visible: false });
        this.sendSessionList();
    }

    toggleHistory() {
        this.sendToWebview({ type: 'toggleHistory' } as any);
    }

    cancelAgent() {
        this.devTeamConsultAbortController?.abort();
        this.devTeamConsultAbortController = undefined;
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

    /** Public command entry for opening the Junior Dev Team editor. */
    createDevTeam() {
        void this.openDevTeamEditor();
    }

    private getSessionMode(session = this.sessionManager.getCurrentSession()): ChatMode {
        if (session.activeMode) { return session.activeMode; }
        for (let i = session.messages.length - 1; i >= 0; i--) {
            const message = session.messages[i];
            if (message.role === 'user' && message.mode) {
                return message.mode;
            }
        }
        return 'agent';
    }

    private isPlanExecutionApproval(text: string): boolean {
        const normalized = text.trim().toLowerCase();
        if (!normalized) { return false; }

        const approvalSignals = [
            /\bproceed\b/,
            /\bgo ahead\b/,
            /\bapproved?\b/,
            /\blooks good\b/,
            /\bexecute\b/,
            /\bimplement(?:ation)?\b/,
            /\bbuild\b.*\b(it|that|this)\b/,
            /\bapply\b.*\bplan\b/,
            /\bdo it\b/,
        ];

        return approvalSignals.some(pattern => pattern.test(normalized));
    }

    private setChatMode(mode: ChatMode, persist: boolean = true) {
        this.activeMode = mode;
        if (persist) {
            this.sessionManager.setActiveMode(mode);
        }
        this.sendToWebview({ type: 'setChatMode', mode });
        if (mode !== 'plan') {
            this.sendToWebview({ type: 'planReady', visible: false });
        }
    }

    // ── Custom Agents ──

    /** Push the current custom agent list + active selection to the webview. */
    private async syncCustomAgentsToWebview(): Promise<void> {
        if (!this.customAgentStore) {
            this.sendToWebview({ type: 'setCustomAgents', agents: [], activeId: this.activeCustomAgentId });
            return;
        }
        const agents = await this.customAgentStore.list();
        this.customAgentsCache = agents;
        // Drop the active selection if the agent has been deleted.
        if (this.activeCustomAgentId && !agents.some(a => a.id === this.activeCustomAgentId)) {
            this.activeCustomAgentId = null;
        }
        this.sendToWebview({
            type: 'setCustomAgents',
            agents: agents.map(a => ({
                id: a.id,
                name: a.name,
                description: a.description,
                scope: a.scope ?? 'global',
                source: a.source,
                readonly: a.readonly,
            })),
            activeId: this.activeCustomAgentId,
        });
    }

    /** Push the current Dev Team list + active selection to the webview. */
    private async syncDevTeamsToWebview(): Promise<void> {
        if (!this.devTeamStore) {
            this.sendToWebview({ type: 'setDevTeams', teams: [], activeId: this.activeDevTeamId });
            return;
        }
        const teams = await this.devTeamStore.list();
        this.devTeamsCache = teams;
        if (this.activeDevTeamId && !teams.some(team => team.id === this.activeDevTeamId)) {
            this.activeDevTeamId = null;
        }
        const agents = this.customAgentStore ? await this.customAgentStore.list() : [];
        const agentById = new Map(agents.map(agent => [agent.id, agent]));
        this.sendToWebview({
            type: 'setDevTeams',
            teams: teams.map(team => ({
                id: team.id,
                name: team.name,
                description: team.description,
                scope: team.scope ?? 'global',
                memberCount: team.members.length,
                members: team.members.map(member => ({
                    role: member.role,
                    agentName: member.agentId ? agentById.get(member.agentId)?.name : undefined,
                    permission: member.permission,
                    deploymentId: member.deploymentId,
                })),
            })),
            activeId: this.activeDevTeamId,
        });
    }

    /**
     * Apply the active custom agent (if any) to the existing AgentLoop. Must be
     * called before each run so newly-created or edited agents take effect.
     * Custom agents always force the local provider in agent mode.
     */
    private async applyActiveCustomAgent(): Promise<void> {
        if (!this.agentLoop) { return; }
        if (this.activeDevTeamId) {
            await this.applyActiveDevTeam();
            return;
        }
        if (!this.activeCustomAgentId || !this.customAgentStore) {
            this.agentLoop.setPersona(null);
            return;
        }
        const def = await this.customAgentStore.get(this.activeCustomAgentId);
        if (!def) {
            this.activeCustomAgentId = null;
            this.agentLoop.setPersona(null);
            return;
        }
        const extraTools = [];
        if (def.source === 'agent-md') {
            extraTools.push(this.agentLoop.createSubagentTool());
        }
        if (def.search) {
            const embedding = def.search.embedding;
            const tool = createSearchKnowledgeTool(def, {
                getSearchKey: () => this.customAgentStore!.getSearchKey(def.id),
                getEntraToken: () => acquireSearchEntraToken(def.search?.endpoint, {
                    authProviderId: def.search?.authProviderId,
                    entraScope: def.search?.entraScope,
                }),
                getEmbeddingKey: embedding && embedding.auth === 'key'
                    ? () => this.customAgentStore!.getEmbeddingKey(def.id)
                    : undefined,
                getEmbeddingEntraToken: embedding && embedding.auth === 'entra'
                    ? () => acquireSearchEntraToken(embedding.endpoint, {
                        authProviderId: embedding.authProviderId,
                        // Embedding endpoints (Azure OpenAI / APIM) use the Cognitive Services audience.
                        entraScope: embedding.entraScope || 'https://cognitiveservices.azure.com/.default',
                    })
                    : undefined,
                onCitations: (payload) => {
                    this.sendToWebview({
                        type: 'searchCitations',
                        agentName: payload.agentName,
                        query: payload.query,
                        citations: payload.citations,
                    });
                },
            });
            if (tool) { extraTools.push(tool); }
        }
        this.agentLoop.setPersona({ systemPrompt: def.systemPrompt, extraTools });
    }

    private async applyActiveDevTeam(): Promise<void> {
        if (!this.agentLoop) { return; }
        if (!this.activeDevTeamId || !this.devTeamStore) {
            this.agentLoop.setPersona(null);
            return;
        }
        const team = await this.devTeamStore.get(this.activeDevTeamId);
        if (!team) {
            this.activeDevTeamId = null;
            this.agentLoop.setPersona(null);
            return;
        }
        const agents = this.customAgentStore ? await this.customAgentStore.list() : [];
        this.agentLoop.setPersona({ systemPrompt: this.buildDevTeamPrompt(team, agents), extraTools: [] });
    }

    private buildDevTeamPrompt(team: DevTeamDef, agents: CustomAgentDef[]): string {
        const agentById = new Map(agents.map(agent => [agent.id, agent]));
        const memberLines = team.members.map(member => {
            const agent = member.agentId ? agentById.get(member.agentId) : undefined;
            const model = member.deploymentId ? `model ${member.deploymentId}` : 'current model';
            const permission = member.permission === 'write'
                ? 'may propose and apply edits when assigned implementation work'
                : member.permission === 'read'
                    ? 'read-only investigation only'
                    : 'review-only: provide findings and recommendations, do not edit files';
            return `- ${member.role}${agent ? ` (${agent.name})` : ''}: ${permission}; preferred ${model}.${agent?.description ? ` Specialty: ${agent.description}` : ''}`;
        });
        const routingLines = (team.routing || []).map(rule => {
            const roles = rule.memberIds
                .map(id => team.members.find(member => member.id === id)?.role)
                .filter(Boolean)
                .join(', ');
            return `- If the request matches /${rule.pattern}/i, include: ${roles}.`;
        });
        const personaSections = team.members
            .map(member => {
                const agent = member.agentId ? agentById.get(member.agentId) : undefined;
                if (!agent?.systemPrompt) { return ''; }
                return `### ${member.role}${agent.name ? ` - ${agent.name}` : ''}\n${agent.systemPrompt.trim()}`;
            })
            .filter(Boolean);

        return `You are Junior Dev Team, a coordinated AI development team running inside VS Code.

## Team
Name: ${team.name}
${team.description ? `Description: ${team.description}\n` : ''}
## Members
${memberLines.join('\n')}

## Coordination Rules
- Act as the Dev Team lead first: decide which members should contribute, then synthesize their perspectives into one useful answer.
- Make consulted member contributions visible using short labeled sections when it helps the user understand the work.
- Only write a section under a member role when that role actually contributed consult notes in the current turn. Put team-level synthesis under headings like Recommendation, Plan, Architecture, Risks, or Next steps. Do not use "Coordinator" as a visible speaker or heading.
- Keep file edits controlled: only members with Can edit permission may be represented as applying changes; review/read-only members provide analysis, risks, and recommendations.
- If multiple members disagree, summarize the tradeoff and make a recommendation.
- If a consulted member reports a true blocker with no safe scoped implementation path, stop before implementation and ask the human for the missing input. Do not fabricate specialist knowledge or claim completion.
- If members say a full build is blocked but a minimal, cited, source-backed scope is safe, proceed only with that bounded scope when the user's mode permits edits; do not show file contents as instructions instead of creating files.
- If grounded source-backed content was available to the worker, do not present unpopulated pages or "populate later" as a successful completion. Call it out as incomplete unless the files were populated from the grounded content.
- Do not create generic HR, legal, privacy, approval, or canonical-document blockers from the domain alone. Only treat those as blockers when the consulted source excerpts or the user explicitly impose them.
- Grounded source excerpts may be compacted for the Standup token budget. Do not describe that as the user's prompt being truncated, and do not ask the user to paste source material solely because Junior compacted retrieved excerpts.
- When the original user request was in Agent mode, do not say you cannot write files merely because the final synthesis pass is read-only. Either summarize the worker changes that were made, or explain the specific standup blocker that prevented writes.
- Per-member model preferences are part of team strategy. If this runtime is using a single active model, still preserve the intended perspective and capability described for each member.
- Stay grounded in the actual workspace and use tools normally. Do not pretend work happened if you did not inspect or change anything.
${team.memoryEnabled ? '- Capture durable project decisions in the final answer when they should become team memory.' : ''}

${routingLines.length ? `## Routing Hints\n${routingLines.join('\n')}\n` : ''}
${personaSections.length ? `## Member Personas\n${personaSections.join('\n\n')}\n` : ''}`;
    }

    private async handleSelectCustomAgent(id: string | null): Promise<void> {
        this.pendingDevTeamResponseSummary = undefined;
        if (this.activeProvider === 'copilot-cli' && id) {
            this.sendToWebview({ type: 'error', message: 'Custom agents are only available with the Local provider.' });
            await this.syncCustomAgentsToWebview();
            return;
        }
        this.activeCustomAgentId = id;
        if (id) {
            this.activeDevTeamId = null;
        }
        if (this.sessionManager.getCurrentSession()) {
            // Persist to the current session.
            const sess = this.sessionManager.getCurrentSession();
            (sess as any).activeCustomAgentId = id ?? undefined;
            (sess as any).activeDevTeamId = undefined;
        }
        if (id) {
            // Custom agents always run in agent mode.
            this.setChatMode('agent');
        }
        await this.applyActiveCustomAgent();
        await this.syncCustomAgentsToWebview();
        await this.syncDevTeamsToWebview();
    }

    private async handleSelectDevTeam(id: string | null): Promise<void> {
        this.pendingDevTeamResponseSummary = undefined;
        if (this.activeProvider === 'copilot-cli' && id) {
            this.sendToWebview({ type: 'error', message: 'Junior Dev Teams are only available with the Local provider.' });
            await this.syncDevTeamsToWebview();
            return;
        }
        this.activeDevTeamId = id;
        if (id) {
            this.activeCustomAgentId = null;
        }
        const sess = this.sessionManager.getCurrentSession();
        (sess as any).activeDevTeamId = id ?? undefined;
        (sess as any).activeCustomAgentId = undefined;
        if (id) {
            this.setChatMode('agent');
        }
        await this.applyActiveCustomAgent();
        await this.syncCustomAgentsToWebview();
        await this.syncDevTeamsToWebview();
    }

    private async openCustomAgentEditor(existingId?: string): Promise<void> {
        if (!this.customAgentStore || !this.extensionContext) {
            vscode.window.showErrorMessage('Custom agents are not available in this build.');
            return;
        }
        const existing = existingId ? await this.customAgentStore.get(existingId) : undefined;
        if (existing?.readonly) {
            vscode.window.showInformationMessage(`Junior discovered "${existing.name}" from an agent markdown file. Edit that file directly to change it.`);
            return;
        }
        await CustomAgentEditor.open(this.extensionContext, this.customAgentStore, {
            existing,
            onSaved: async (saved) => {
                this.pendingDevTeamResponseSummary = undefined;
                this.activeCustomAgentId = saved.id;
                this.activeDevTeamId = null;
                const sess = this.sessionManager.getCurrentSession();
                (sess as any).activeCustomAgentId = saved.id;
                (sess as any).activeDevTeamId = undefined;
                await this.applyActiveCustomAgent();
                await this.syncCustomAgentsToWebview();
                await this.syncDevTeamsToWebview();
                this.setChatMode('agent');
            },
        });
    }

    private async openDevTeamEditor(existingId?: string): Promise<void> {
        if (!this.devTeamStore || !this.extensionContext) {
            vscode.window.showErrorMessage('Junior Dev Teams are not available in this build.');
            return;
        }
        const existing = existingId ? await this.devTeamStore.get(existingId) : undefined;
        const modelConfig = this.getModelConfig();
        await DevTeamEditor.open(this.extensionContext, this.devTeamStore, {
            existing,
            customAgents: this.customAgentStore ? await this.customAgentStore.list() : [],
            models: modelConfig.models.map(model => ({ name: model.name, deploymentId: model.deploymentId })),
            onSaved: async (saved) => {
                this.pendingDevTeamResponseSummary = undefined;
                this.activeDevTeamId = saved.id;
                this.activeCustomAgentId = null;
                const sess = this.sessionManager.getCurrentSession();
                (sess as any).activeDevTeamId = saved.id;
                (sess as any).activeCustomAgentId = undefined;
                await this.applyActiveCustomAgent();
                await this.syncCustomAgentsToWebview();
                await this.syncDevTeamsToWebview();
                this.setChatMode('agent');
            },
        });
    }

    private async handleDeleteCustomAgent(id: string): Promise<void> {
        if (!this.customAgentStore) { return; }
        const def = await this.customAgentStore.get(id);
        if (!def) { return; }
        if (def.readonly) {
            vscode.window.showInformationMessage(`Junior discovered "${def.name}" from an agent markdown file. Remove the source file to hide it from the agent picker.`);
            return;
        }
        const choice = await vscode.window.showWarningMessage(
            `Delete custom agent "${def.name}"?`,
            { modal: true },
            'Delete',
        );
        if (choice !== 'Delete') { return; }
        await this.customAgentStore.delete(id, def.scope ?? 'global');
        if (this.activeCustomAgentId === id) {
            this.activeCustomAgentId = null;
            await this.applyActiveCustomAgent();
        }
        await this.syncCustomAgentsToWebview();
    }

    private async handleDeleteDevTeam(id: string): Promise<void> {
        if (!this.devTeamStore) { return; }
        const team = await this.devTeamStore.get(id);
        if (!team) { return; }
        const choice = await vscode.window.showWarningMessage(
            `Delete Junior Dev Team "${team.name}"?`,
            { modal: true },
            'Delete',
        );
        if (choice !== 'Delete') { return; }
        await this.devTeamStore.delete(id, team.scope ?? 'global');
        if (this.activeDevTeamId === id) {
            this.activeDevTeamId = null;
            await this.applyActiveCustomAgent();
        }
        await this.syncDevTeamsToWebview();
    }

    private handleWebviewMessage(msg: WebviewMessage) {
        try {
            switch (msg.type) {
                case 'sendMessage':
                    this.handleUserMessage(msg.text, msg.mode, msg.images, msg.files);
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
                case 'updateReasoningConfig':
                    void this.handleUpdateReasoningConfig(msg.effort, msg.summary);
                    break;
                case 'selectAgentProvider':
                    this.handleSelectAgentProvider(msg.provider);
                    break;
                case 'selectPermissionLevel':
                    void this.handleSelectPermissionLevel(msg.level);
                    break;
                case 'selectChatMode':
                    this.setChatMode(msg.mode);
                    break;
                case 'selectCustomAgent':
                    void this.handleSelectCustomAgent(msg.id);
                    break;
                case 'createCustomAgent':
                    void this.openCustomAgentEditor();
                    break;
                case 'editCustomAgent':
                    void this.openCustomAgentEditor(msg.id);
                    break;
                case 'deleteCustomAgent':
                    void this.handleDeleteCustomAgent(msg.id);
                    break;
                case 'selectDevTeam':
                    void this.handleSelectDevTeam(msg.id);
                    break;
                case 'createDevTeam':
                    void this.openDevTeamEditor();
                    break;
                case 'editDevTeam':
                    void this.openDevTeamEditor(msg.id);
                    break;
                case 'deleteDevTeam':
                    void this.handleDeleteDevTeam(msg.id);
                    break;
                case 'runPlanInAgent':
                    this.sendToWebview({ type: 'planReady', visible: false });
                    this.setChatMode('agent');
                    this.lastSubmissionTime = 0;
                    this.handleUserMessage('Execute the approved plan above. Proceed with the implementation.', 'agent');
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
                case 'attachContext':
                    void this.handleAttachContext(msg.kind);
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
                    this.refreshProviderAvailability();
                    this.syncProvidersToWebview();
                    this.sendToWebview({ type: 'setAgentProvider', provider: this.activeProvider });
                    this.syncPermissionLevelToWebview();
                    this.sendToWebview({ type: 'setChatMode', mode: this.activeMode });
                    void this.syncCustomAgentsToWebview();
                    void this.syncDevTeamsToWebview();
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

    private async handleUserMessage(text: string, mode: ChatMode, images?: string[], files?: { name: string; content: string }[]) {
        if (!text.trim() && (!images || images.length === 0) && (!files || files.length === 0)) { return; }
        this.pendingDevTeamResponseSummary = undefined;
        const autoExecuteApprovedPlan = mode === 'plan' && this.isPlanExecutionApproval(text);
        const effectiveMode: ChatMode = autoExecuteApprovedPlan ? 'agent' : mode;

        this.setChatMode(effectiveMode);
        this.sendToWebview({ type: 'planReady', visible: false });

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
        if (autoExecuteApprovedPlan) {
            text = `Execute the approved plan above. ${text}`;
        }

        // Echo the user message to the webview (show original, not the resolved template)
        const fileNames = files?.map(f => f.name);
        this.sendToWebview({ type: 'addUserMessage', text: displayText, images, fileNames });

        // Immediately activate stop button + thinking indicator
        this.sendToWebview({ type: 'agentStarted' });

        if (this.activeProvider === 'copilot-cli') {
            await this.handleUserMessageCopilotCli(effectiveMode, text, displayText, images, files);
        } else {
            await this.handleUserMessageLocal(effectiveMode, text, displayText, images, files);
        }
    }

    /** Handle user message with the local agent loop (Azure OpenAI) */
    private async handleUserMessageLocal(mode: ChatMode, text: string, displayText: string, images?: string[], files?: { name: string; content: string }[]) {

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

        this.builtinTools.setPermissionLevel(this.currentPermissionLevel);

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
            await this.applyActiveCustomAgent();
            text = await this.prepareDevTeamRunIfNeeded(mode, text, displayText);
            const finalMode: ChatMode = this.activeDevTeamId ? 'ask' : mode;
            await this.agentLoop.run(finalMode, text, images, files, slashDisplayText);

            // If files were changed, wait for Keep/Undo (user clicks file names to review diffs)
            const summary = this.builtinTools.getPendingChangeSummary();
            if (summary) {
                await this.waitForFileChangeAction();
            }
            if (mode === 'plan') {
                this.sendToWebview({ type: 'planReady', visible: true });
            }
        } finally {
            // Always persist — even if cancelled or errored
            this.sessionManager.updateMessages(this.agentLoop.getMessages(), undefined, this.activeMode, this.currentPermissionLevel);
            this.pendingDevTeamResponseSummary = undefined;
            this.sendSessionList();
        }
    }

    private async prepareDevTeamRunIfNeeded(mode: ChatMode, text: string, displayText: string): Promise<string> {
        const context = await this.runDevTeamConsultsIfNeeded(mode, text, displayText);
        if (!context) { return text; }
        this.sendToWebview({ type: 'agentStarted' });
        return `${text}\n\n---\n${context}`;
    }

    private async runDevTeamConsultsIfNeeded(mode: ChatMode, text: string, displayText: string): Promise<string> {
        if (!this.activeDevTeamId || !this.devTeamStore || this.activeProvider !== 'local') { return ''; }
        const team = await this.devTeamStore.get(this.activeDevTeamId);
        if (!team) { return ''; }
        const agents = this.customAgentStore ? await this.customAgentStore.list() : [];
        this.devTeamRuntime ??= new DevTeamRuntime(
            this.aoaiClient,
            { sendToWebview: msg => this.sendToWebview(msg) },
            this.tokenTracker,
            this.log,
            this.customAgentStore ? {
                getSearchKey: agentId => this.customAgentStore!.getSearchKey(agentId),
                getSearchEntraToken: config => acquireSearchEntraToken(config.endpoint, {
                    authProviderId: config.authProviderId,
                    entraScope: config.entraScope,
                }),
                getEmbeddingKey: agentId => this.customAgentStore!.getEmbeddingKey(agentId),
                getEmbeddingEntraToken: config => acquireSearchEntraToken(config.endpoint, {
                    authProviderId: config.authProviderId,
                    entraScope: config.entraScope || 'https://cognitiveservices.azure.com/.default',
                }),
                onCitations: payload => this.sendToWebview({
                    type: 'searchCitations',
                    agentName: payload.agentName,
                    query: payload.query,
                    citations: payload.citations,
                }),
            } : undefined,
        );
        this.devTeamConsultAbortController = new AbortController();
        try {
            const results = await this.devTeamRuntime.consult(team, agents, {
                mode,
                userText: text,
                displayText,
                signal: this.devTeamConsultAbortController.signal,
            });
            this.pendingDevTeamResponseSummary = this.buildDevTeamResponseSummaryFromResults(team, agents, results);
            const consultContext = buildDevTeamConsultContext(results);
            await this.runDevTeamMemberExecutionsIfNeeded(team, agents, results, { mode, text, displayText, consultContext });
            this.pendingDevTeamResponseSummary = this.buildDevTeamResponseSummaryFromResults(team, agents, results);
            return consultContext;
        } finally {
            this.devTeamConsultAbortController = undefined;
        }
    }

    private async runDevTeamMemberExecutionsIfNeeded(
        team: DevTeamDef,
        agents: CustomAgentDef[],
        results: DevTeamConsultResult[],
        options: { mode: ChatMode; text: string; displayText: string; consultContext: string },
    ): Promise<void> {
        if (!this.agentLoop || options.mode !== 'agent') { return; }
        const writeResults = selectDevTeamExecutionResults(results);
        if (writeResults.length === 0) { return; }

        for (const result of writeResults) {
            if (this.devTeamConsultAbortController?.signal.aborted) { break; }
            const member = result.member;
            const agent = result.agent ?? (member.agentId ? agents.find(candidate => candidate.id === member.agentId) : undefined);
            this.pendingDevTeamResponseSummary = this.buildSingleMemberResponseSummary(team, member, agent, 'executed');
            this.sendToWebview({
                type: 'devTeamRoomEvent',
                event: {
                    teamId: team.id,
                    teamName: team.name,
                    memberRole: member.role,
                    agentName: agent?.name,
                    permission: member.permission,
                    phase: 'execute',
                    status: 'started',
                    title: `${member.role} started implementation`,
                    detail: 'Applying the approved standup notes in the workspace.',
                },
            });
            this.sendToWebview({ type: 'agentStarted' });
            this.agentLoop.setPersona({
                systemPrompt: this.buildDevTeamMemberWorkerPrompt(team, member, agent),
                extraTools: this.buildCustomAgentExtraTools(agent),
            });
            if (member.deploymentId) {
                this.aoaiClient.setDeploymentOverride(member.deploymentId);
            }
            const workOrder = buildDevTeamMemberWorkOrder(team, member, options.displayText || options.text, result.text, options.consultContext);
            let workerStatus: 'done' | 'failed' = 'done';
            try {
                await this.agentLoop.run('agent', workOrder, undefined, undefined, `${member.role}: ${options.displayText}`);
            } catch (err) {
                workerStatus = 'failed';
                throw err;
            } finally {
                if (workerStatus === 'failed') {
                    this.sendToWebview({
                        type: 'devTeamRoomEvent',
                        event: {
                            teamId: team.id,
                            teamName: team.name,
                            memberRole: member.role,
                            agentName: agent?.name,
                            permission: member.permission,
                            phase: 'execute',
                            status: 'failed',
                            title: `${member.role} implementation failed`,
                            detail: 'Worker pass stopped before completion.',
                        },
                    });
                }
            }
            result.executed = true;
            const summary = this.builtinTools.getPendingChangeSummary();
            if (summary) {
                this.sendToWebview({
                    type: 'devTeamRoomEvent',
                    event: {
                        teamId: team.id,
                        teamName: team.name,
                        memberRole: member.role,
                        agentName: agent?.name,
                        permission: member.permission,
                        phase: 'execute',
                        status: 'done',
                        title: `${member.role} finished implementation`,
                        detail: `${summary.files.length} changed ${summary.files.length === 1 ? 'file is' : 'files are'} ready. Final synthesis is continuing; Keep/Undo will remain available afterward.`,
                    },
                });
            } else {
                this.sendToWebview({
                    type: 'devTeamRoomEvent',
                    event: {
                        teamId: team.id,
                        teamName: team.name,
                        memberRole: member.role,
                        agentName: agent?.name,
                        permission: member.permission,
                        phase: 'execute',
                        status: 'done',
                        title: `${member.role} finished implementation`,
                        detail: 'Worker pass completed; validation and final synthesis can continue.',
                    },
                });
            }
        }

        await this.applyActiveDevTeam();
    }

    private buildCustomAgentExtraTools(agent: CustomAgentDef | undefined) {
        if (!agent?.search || !this.customAgentStore) { return []; }
        const embedding = agent.search.embedding;
        const tool = createSearchKnowledgeTool(agent, {
            getSearchKey: () => this.customAgentStore!.getSearchKey(agent.id),
            getEntraToken: () => acquireSearchEntraToken(agent.search?.endpoint, {
                authProviderId: agent.search?.authProviderId,
                entraScope: agent.search?.entraScope,
            }),
            getEmbeddingKey: embedding && embedding.auth === 'key'
                ? () => this.customAgentStore!.getEmbeddingKey(agent.id)
                : undefined,
            getEmbeddingEntraToken: embedding && embedding.auth === 'entra'
                ? () => acquireSearchEntraToken(embedding.endpoint, {
                    authProviderId: embedding.authProviderId,
                    entraScope: embedding.entraScope || 'https://cognitiveservices.azure.com/.default',
                })
                : undefined,
            onCitations: (payload) => this.sendToWebview({ type: 'searchCitations', ...payload }),
        });
        return tool ? [tool] : [];
    }

    private buildDevTeamMemberWorkerPrompt(team: DevTeamDef, member: DevTeamDef['members'][number], agent: CustomAgentDef | undefined): string {
        const customInstructions = agent?.systemPrompt?.trim()
            ? `\n\n## Linked Custom Agent Instructions\n${agent.systemPrompt.trim()}`
            : '';
        return `You are ${member.role}, a member of the Junior Dev Team "${team.name}" running as an active worker inside VS Code.

## Permission
You are running in Junior's normal Agent mode for this member pass. You may inspect the workspace, edit files, run safe validation commands, and use available tools when needed. Follow Junior's normal confirmation and safety rules; if a write or terminal action needs approval, request it through the tools rather than telling the user to save files manually.

## Scope
- Work only on the task assigned in the current member work order.
- Use concise activity-log narration so the user can see what you are doing.
- Keep visible worker output short: one sentence per update, no long Markdown sections, and no final-answer-style summary.
- Do not speak for other team members. Use their consult notes only as input.
- Before editing, read the team consult context. Stop only if the consult context explicitly says execution is blocked with no safe scoped path. If the context permits a bounded or minimal implementation, edit the workspace for that approved scope and leave excluded work untouched.
- Treat retrieved source excerpts in the team consult context as sufficient source material for the requested bounded implementation. Do not invent HR, legal, privacy, approval, canonical-document, or publication blockers unless the source excerpts themselves mark content confidential, personal, restricted, or missing.
- When grounded source-backed content is present for requested pages, sections, records, docs, or data, populate the files from that content in this pass. Do not leave empty shells, placeholder pages, or "populate later" sections for content the standup already provided.
- If the source context covers only part of the request, implement the covered portion and label unknown or excluded parts instead of blocking all file edits.
- Grounded source excerpts may be compacted for the Standup token budget. Do not describe that as the user's prompt being truncated, and do not ask the user to paste source material solely because Junior compacted retrieved excerpts.
- Do not say you cannot write files from this session. When assigned implementation work, use the same file-editing tools and approval flow as normal Agent mode.
- If you cannot complete the assigned work safely, explain the blocker and stop.
- End with a compact completion note only. The Dev Team lead will produce the detailed final answer after this worker pass.${agent?.description ? `\n\nSpecialty: ${agent.description}` : ''}${customInstructions}`;
    }

    private buildSingleMemberResponseSummary(team: DevTeamDef, member: DevTeamDef['members'][number], agent: CustomAgentDef | undefined, status: 'consulted' | 'executed' | 'failed'): DevTeamResponseSummary {
        return {
            id: team.id,
            name: team.name,
            members: [{
                role: member.role,
                agentName: agent?.name,
                permission: member.permission,
                deploymentId: member.deploymentId,
                status,
            }],
        };
    }

    private buildDevTeamResponseSummaryFromResults(team: DevTeamDef, agents: CustomAgentDef[], results: DevTeamConsultResult[]): DevTeamResponseSummary {
        const agentById = new Map(agents.map(agent => [agent.id, agent]));
        const members: DevTeamConsultResult[] = results.length > 0 ? results : team.members.map(member => ({ member, text: '' }));
        return {
            id: team.id,
            name: team.name,
            members: members.map(result => {
                const agent = result.agent ?? (result.member.agentId ? agentById.get(result.member.agentId) : undefined);
                return {
                    role: result.member.role,
                    agentName: agent?.name,
                    permission: result.member.permission,
                    deploymentId: result.member.deploymentId,
                    status: result.error ? 'failed' as const : result.executed ? 'executed' as const : 'consulted' as const,
                    error: result.error,
                };
            }),
        };
    }

    /** Handle user message with the Copilot CLI runtime */
    private async handleUserMessageCopilotCli(mode: ChatMode, text: string, displayText: string, images?: string[], files?: { name: string; content: string }[]) {
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
            await runtime.run(mode, text, images, files, slashDisplayText);
            const summary = this.builtinTools.getPendingChangeSummary();
            if (summary) {
                await this.waitForFileChangeAction();
            }
            if (mode === 'plan') {
                this.sendToWebview({ type: 'planReady', visible: true });
            }
        } catch (err: any) {
            const msg = err?.message || String(err);
            this.log(`[copilot-cli] Run error: ${msg}`);
            this.sendToWebview({ type: 'error', message: formatCopilotCliRunError(msg) });
            this.sendToWebview({ type: 'agentDone' });
        } finally {
            // Always persist — even if cancelled or errored
            this.sessionManager.updateMessages(runtime.getMessages(), runtime.getSessionState?.(), this.activeMode, this.currentPermissionLevel);
            this.sendSessionList();
        }
    }

    /** Ensure the Copilot CLI runtime is initialized and session is loaded */
    private async ensureCopilotRuntime(callbacks: AgentCallbacks): Promise<void> {
        if (!this.copilotRuntime) {
            this.copilotRuntime = new CopilotSdkRuntime(
                callbacks,
                this.log,
                this.tokenTracker,
                () => this.mcpClient.getCopilotSdkServerConfigs(),
                this.builtinTools,
                (mode, promptText) => this.buildCopilotPromptContext(mode, promptText)
            );
        }

        this.copilotRuntime.setPermissionLevel?.(this.currentPermissionLevel);

        const session = this.sessionManager.getCurrentSession();
        this.copilotRuntime.setMessages([...session.messages]);
        if (session.runtimeState?.provider === 'copilot-cli') {
            await this.copilotRuntime.restoreSessionState?.(session.runtimeState);
        }
    }

    private async buildCopilotPromptContext(mode: ChatMode, userMessage: string): Promise<string> {
        const sections: string[] = [];
        const snapshotSections: string[] = [];
        const taskMemory = new AgentTaskMemory();
        const activeEditor = vscode.window.activeTextEditor;
        const activeFile = activeEditor
            ? vscode.workspace.asRelativePath(activeEditor.document.uri, false)
            : '';
        const mentionedFiles = this.extractMentionedFiles(userMessage);
        const diagnostics = this.collectVisibleDiagnostics(mode === 'ask' ? 4 : 8);
        const openEditors = this.collectOpenEditors();
        const ranked = this.retrievalRanker.rank(userMessage, {
            activeFile,
            mentionedFiles,
            diagnostics: diagnostics
                .map(line => this.parseDiagnosticLine(line))
                .filter(Boolean) as Array<{ filePath: string; severity: 'Error' | 'Warning'; message: string }>,
            maxCandidates: mode === 'ask' ? 4 : 6,
        });
        const taskFocus = this.inferTaskFocus({
            activeFile,
            openEditors,
            mentionedFiles,
            rankedFiles: ranked.map(candidate => candidate.filePath),
            diagnosticFiles: this.extractDiagnosticPaths(diagnostics),
        });

        taskMemory.noteUserRequest(userMessage);
        if (activeFile) {
            taskMemory.noteRelevantFile(activeFile, 'active editor');
            const cursorLine = activeEditor ? activeEditor.selection.active.line + 1 : 1;
            snapshotSections.push(`Active file: ${activeFile} (cursor at line ${cursorLine})`);
        }

        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
        if (workspaceName) {
            snapshotSections.push(`Workspace: ${workspaceName}`);
        }

        if (openEditors.length > 0) {
            snapshotSections.push('Open editors:\n' + openEditors.map(file => `  ${file}`).join('\n'));
            for (const filePath of openEditors.slice(0, 6)) {
                taskMemory.noteRelevantFile(filePath, 'open editor');
            }
        }

        if (diagnostics.length > 0) {
            snapshotSections.push('Active diagnostics:\n' + diagnostics.map(line => `  ${line}`).join('\n'));
            taskMemory.noteDiagnostics(diagnostics);
            taskMemory.noteRelevantFiles(this.extractDiagnosticPaths(diagnostics), 'diagnostic location');
            taskMemory.noteFinding(`There are ${diagnostics.length} visible diagnostics that may matter for this task.`);
        }

        if (taskFocus.taskRoot) {
            snapshotSections.push(`Likely task root: ${taskFocus.taskRoot}`);
        }

        if (taskFocus.languageLabel) {
            snapshotSections.push(`Likely implementation language for this request: ${taskFocus.languageLabel}`);
            snapshotSections.push(`Language guardrail: Stay in ${taskFocus.languageLabel} unless the user or files clearly point to another language.`);
        }

        const workspaceSignals = this.collectWorkspaceSignals(taskFocus.taskRoot);
        if (workspaceSignals.length > 0) {
            const title = taskFocus.taskRoot && taskFocus.taskRoot !== '.'
                ? 'Task-local project signals:'
                : 'Workspace signals:';
            snapshotSections.push(title + '\n' + workspaceSignals.map(line => `  ${line}`).join('\n'));
        }

        for (const filePath of mentionedFiles) {
            taskMemory.noteRelevantFile(filePath, 'mentioned by the user');
        }

        if (ranked.length > 0) {
            snapshotSections.push(
                'Likely relevant files for this request:\n' + ranked
                    .map(candidate => `  ${candidate.filePath} (${candidate.reasons[0] || 'relevant'})`)
                    .join('\n')
            );
            for (const candidate of ranked) {
                taskMemory.noteRelevantFile(candidate.filePath, candidate.reasons[0] || 'ranked as relevant context');
            }
            taskMemory.noteFinding(`Ranked likely files: ${ranked.slice(0, 3).map(candidate => `${candidate.filePath} (${candidate.reasons[0] || 'relevant'})`).join(', ')}.`);
        }

        if (snapshotSections.length > 0) {
            sections.push('[Context Snapshot]\n' + snapshotSections.join('\n\n'));
        }

        const taskPrompt = taskMemory.buildSystemMessage({
            maxRelevantFiles: mode === 'ask' ? 4 : 6,
            maxDiagnostics: mode === 'ask' ? 4 : 6,
            maxFindings: mode === 'ask' ? 3 : 4,
            maxSearches: 0,
            maxFailures: 0,
        });
        if (taskPrompt) {
            sections.push(taskPrompt);
        }

        const repoPrompt = this.repoPatternStore.buildSystemMessage({ maxFiles: 4, maxCommands: 1 });
        if (repoPrompt) {
            sections.push(repoPrompt);
        }

        return sections.join('\n\n');
    }

    private collectOpenEditors(): string[] {
        try {
            const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
            return Array.from(new Set(
                tabs
                    .map(tab => {
                        const input = tab.input as { uri?: vscode.Uri } | undefined;
                        return input?.uri ? vscode.workspace.asRelativePath(input.uri, false) : '';
                    })
                    .filter(Boolean)
            )).slice(0, 8);
        } catch {
            return [];
        }
    }

    private collectVisibleDiagnostics(limit: number): string[] {
        const lines: string[] = [];
        try {
            for (const [uri, diagnostics] of vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][]) {
                const relPath = vscode.workspace.asRelativePath(uri, false);
                for (const diagnostic of diagnostics) {
                    if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) {
                        continue;
                    }
                    const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                    lines.push(`${relPath}:${diagnostic.range.start.line + 1}: [${severity}] ${diagnostic.message}`);
                    if (lines.length >= limit) {
                        return lines;
                    }
                }
            }
        } catch {
            return lines;
        }
        return lines;
    }

    private collectWorkspaceSignals(taskRoot?: string): string[] {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return [];
        }

        const root = taskRoot && taskRoot !== '.'
            ? path.join(workspaceRoot, taskRoot.replace(/\//g, path.sep))
            : workspaceRoot;

        if (!fs.existsSync(root)) {
            return [];
        }

        const signals: string[] = [];
        const topLevelEntries: string[] = [];
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true }).slice(0, 8)) {
                topLevelEntries.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
            }
        } catch {
            // Ignore listing failures.
        }

        if (fs.existsSync(path.join(root, 'package.json'))) {
            signals.push('package.json present');
        }
        if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
            signals.push('tsconfig.json present');
        }
        if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) {
            signals.push('Python project files present');
        }

        try {
            const rootEntries = fs.readdirSync(root);
            if (rootEntries.some(name => name.endsWith('.csproj') || name.endsWith('.sln'))) {
                signals.push('C# solution files present');
            }
        } catch {
            // Ignore listing failures.
        }

        if (topLevelEntries.length > 0) {
            signals.push(`Top-level entries: ${topLevelEntries.join(', ')}`);
        }

        return signals;
    }

    private inferTaskFocus(input: {
        activeFile?: string;
        openEditors: string[];
        mentionedFiles: string[];
        rankedFiles: string[];
        diagnosticFiles: string[];
    }): { taskRoot: string; languageLabel?: string } {
        const files = [
            input.activeFile || '',
            ...input.openEditors,
            ...input.mentionedFiles,
            ...input.rankedFiles,
            ...input.diagnosticFiles,
        ].filter(Boolean);

        const taskRoot = this.pickLikelyTaskRoot(files);
        const languageLabel = this.inferLanguageLabel(files);
        return { taskRoot, languageLabel };
    }

    private pickLikelyTaskRoot(files: string[]): string {
        const counts = new Map<string, number>();

        for (const filePath of files) {
            const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
            if (!normalized) { continue; }

            const directory = path.posix.dirname(normalized);
            if (!directory || directory === '.') { continue; }

            const segments = directory.split('/');
            for (let i = 1; i <= segments.length; i++) {
                const candidate = segments.slice(0, i).join('/');
                counts.set(candidate, (counts.get(candidate) || 0) + 1);
            }
        }

        const ranked = Array.from(counts.entries()).sort((a, b) => {
            if (b[1] !== a[1]) {
                return b[1] - a[1];
            }
            return b[0].length - a[0].length;
        });

        return ranked[0]?.[0] || '.';
    }

    private inferLanguageLabel(files: string[]): string | undefined {
        const scores = new Map<string, number>();
        const addScore = (label: string, points: number) => {
            scores.set(label, (scores.get(label) || 0) + points);
        };

        for (const filePath of files) {
            const ext = path.extname(filePath).toLowerCase();
            switch (ext) {
                case '.py':
                    addScore('Python', 3);
                    break;
                case '.ts':
                case '.tsx':
                    addScore('TypeScript', 3);
                    break;
                case '.js':
                case '.jsx':
                    addScore('JavaScript', 3);
                    break;
                case '.cs':
                case '.csproj':
                case '.sln':
                    addScore('C#', 3);
                    break;
                case '.java':
                    addScore('Java', 3);
                    break;
                case '.go':
                    addScore('Go', 3);
                    break;
                case '.rs':
                    addScore('Rust', 3);
                    break;
            }
        }

        const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
        return ranked[0]?.[0];
    }

    private extractMentionedFiles(text: string): string[] {
        return Array.from(new Set(
            (text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|ps1|py|cs|csproj|sln|java|go|rs)\b/g) || [])
                .map(filePath => filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim())
                .filter(Boolean)
        ));
    }

    private extractDiagnosticPaths(lines: string[]): string[] {
        return Array.from(new Set(
            lines
                .map(line => line.match(/^([\w./-]+\.[\w]+):(\d+)/)?.[1] || '')
                .filter(Boolean)
        ));
    }

    private parseDiagnosticLine(line: string): { filePath: string; severity: 'Error' | 'Warning'; message: string } | null {
        const match = line.match(/^([\w./-]+\.[\w]+):(\d+): \[(Error|Warning)\] (.+)$/);
        if (!match) {
            return null;
        }
        return {
            filePath: match[1],
            severity: match[3] as 'Error' | 'Warning',
            message: match[4],
        };
    }

    private pendingFileChangeResolve?: (action: 'keep' | 'undo') => void;

    private waitForFileChangeAction(): Promise<'keep' | 'undo'> {
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
                resolve(action);
            };
            // Timeout: auto-keep after 5 minutes
            setTimeout(() => {
                if (this.pendingFileChangeResolve) {
                    this.builtinTools.clearPendingChanges();
                    this.pendingFileChangeResolve = undefined;
                    resolve('keep');
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

    private captureRecentTerminalLine(line: string): void {
        const normalized = line.replace(/\r?\n$/, '');
        if (!normalized.trim()) { return; }
        this.recentTerminalLines.push(normalized);
        if (this.recentTerminalLines.length > 300) {
            this.recentTerminalLines.splice(0, this.recentTerminalLines.length - 300);
        }
    }

    private async handleAttachContext(kind: ContextAttachmentKind): Promise<void> {
        try {
            const attachment = await this.resolveContextAttachment(kind);
            this.sendToWebview({ type: 'contextAttached', kind, name: attachment.name, content: attachment.content });
        } catch (err: any) {
            this.sendToWebview({ type: 'error', message: err?.message || String(err) });
        }
    }

    private async resolveContextAttachment(kind: ContextAttachmentKind): Promise<{ name: string; content: string }> {
        switch (kind) {
            case 'selection':
                return this.buildSelectionAttachment();
            case 'active-file':
                return this.buildActiveFileAttachment();
            case 'open-editors':
                return this.buildOpenEditorsAttachment();
            case 'diagnostics':
                return this.buildDiagnosticsAttachment();
            case 'git-diff':
                return this.buildGitDiffAttachment();
            case 'terminal':
                return this.buildTerminalAttachment();
        }
    }

    private buildSelectionAttachment(): { name: string; content: string } {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            throw new Error('Select code in the editor before attaching Selection context.');
        }
        const document = editor.document;
        const relPath = vscode.workspace.asRelativePath(document.uri, false);
        const startLine = editor.selection.start.line + 1;
        const endLine = editor.selection.end.line + 1;
        const selectedText = document.getText(editor.selection);
        const name = `Selection: ${relPath}:${startLine}-${endLine}`;
        return {
            name,
            content: this.truncateContextAttachment(name, `Selection from ${relPath} (lines ${startLine}-${endLine}, language ${document.languageId}):\n\n${selectedText}`),
        };
    }

    private buildActiveFileAttachment(): { name: string; content: string } {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error('Open a file before attaching Active File context.');
        }
        const document = editor.document;
        const relPath = vscode.workspace.asRelativePath(document.uri, false);
        const name = `Active file: ${relPath}`;
        const cursorLine = editor.selection.active.line + 1;
        return {
            name,
            content: this.truncateContextAttachment(name, `Active file ${relPath} (language ${document.languageId}, cursor line ${cursorLine}):\n\n${document.getText()}`),
        };
    }

    private buildOpenEditorsAttachment(): { name: string; content: string } {
        const openEditors = this.collectOpenEditors();
        if (openEditors.length === 0) {
            throw new Error('There are no open editor tabs to attach.');
        }
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const activePath = activeUri ? vscode.workspace.asRelativePath(activeUri, false) : undefined;
        const lines = openEditors.map(file => `${file === activePath ? '* ' : '- '}${file}`);
        return {
            name: 'Open editors',
            content: `Open editor tabs (* marks active editor):\n${lines.join('\n')}`,
        };
    }

    private buildDiagnosticsAttachment(): { name: string; content: string } {
        const lines = this.collectDetailedDiagnostics(80);
        if (lines.length === 0) {
            throw new Error('There are no current errors or warnings to attach.');
        }
        return {
            name: 'Diagnostics',
            content: this.truncateContextAttachment('Diagnostics', `Current workspace diagnostics:\n${lines.join('\n')}`),
        };
    }

    private async buildGitDiffAttachment(): Promise<{ name: string; content: string }> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('Open a workspace before attaching Git Diff context.');
        }
        const unstaged = await this.runGit(workspaceRoot, ['diff', '--no-ext-diff', '--']);
        const staged = await this.runGit(workspaceRoot, ['diff', '--cached', '--no-ext-diff', '--']);
        const untracked = await this.buildUntrackedFilesAttachmentSection(workspaceRoot);
        const sections: string[] = [];
        if (unstaged.trim()) { sections.push(`Unstaged changes:\n${unstaged.trimEnd()}`); }
        if (staged.trim()) { sections.push(`Staged changes:\n${staged.trimEnd()}`); }
        if (untracked.trim()) { sections.push(untracked.trimEnd()); }
        if (sections.length === 0) {
            throw new Error('There are no staged, unstaged, or untracked Git changes to attach.');
        }
        return {
            name: 'Git diff',
            content: this.truncateContextAttachment('Git diff', sections.join('\n\n')),
        };
    }

    private async buildUntrackedFilesAttachmentSection(workspaceRoot: string): Promise<string> {
        const raw = await this.runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
        const files = raw.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_CONTEXT_FILES);
        if (files.length === 0) { return ''; }

        const sections: string[] = [];
        for (const relPath of files) {
            const absPath = path.resolve(workspaceRoot, relPath);
            if (!this.isPathInside(absPath, workspaceRoot)) {
                continue;
            }
            try {
                const stat = await fs.promises.stat(absPath);
                if (!stat.isFile()) { continue; }
                if (stat.size > MAX_UNTRACKED_CONTEXT_FILE_CHARS * 4) {
                    sections.push(`--- ${relPath} ---\n[Skipped: untracked file is too large (${stat.size} bytes).]`);
                    continue;
                }
                const bytes = await fs.promises.readFile(absPath);
                const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                if (decoded.includes('\u0000')) {
                    sections.push(`--- ${relPath} ---\n[Skipped: untracked file appears to be binary.]`);
                    continue;
                }
                const content = decoded.length > MAX_UNTRACKED_CONTEXT_FILE_CHARS
                    ? `${decoded.slice(0, MAX_UNTRACKED_CONTEXT_FILE_CHARS)}\n\n[Truncated: ${decoded.length - MAX_UNTRACKED_CONTEXT_FILE_CHARS} characters omitted.]`
                    : decoded;
                sections.push(`--- ${relPath} ---\n${content.trimEnd()}`);
            } catch (err: any) {
                sections.push(`--- ${relPath} ---\n[Skipped: ${err?.message || String(err)}]`);
            }
        }

        const omitted = raw.split('\0').filter(Boolean).length - files.length;
        const suffix = omitted > 0 ? `\n\n[${omitted} additional untracked files omitted.]` : '';
        return sections.length > 0 ? `Untracked files:\n${sections.join('\n\n')}${suffix}` : '';
    }

    private isPathInside(candidate: string, parent: string): boolean {
        const relative = path.relative(parent, candidate);
        return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    private buildTerminalAttachment(): { name: string; content: string } {
        if (this.recentTerminalLines.length === 0) {
            throw new Error('Junior has not captured terminal output in this session yet. Run a command with Junior first, then attach Terminal context.');
        }
        const lines = this.recentTerminalLines.slice(-200).join('\n');
        return {
            name: 'Recent terminal output',
            content: this.truncateContextAttachment('Recent terminal output', `Recent terminal output captured from Junior-run commands:\n${lines}`),
        };
    }

    private collectDetailedDiagnostics(limit: number): string[] {
        const lines: string[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][]) {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            for (const diagnostic of diagnostics) {
                if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                const startLine = diagnostic.range.start.line + 1;
                const startColumn = diagnostic.range.start.character + 1;
                lines.push(`${relPath}:${startLine}:${startColumn}: [${severity}] ${diagnostic.message}`);
                if (lines.length >= limit) { return lines; }
            }
        }
        return lines;
    }

    private runGit(cwd: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            cp.execFile('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error((stderr || error.message || 'Git command failed.').trim()));
                    return;
                }
                resolve(stdout.toString());
            });
        });
    }

    private truncateContextAttachment(name: string, content: string): string {
        if (content.length <= MAX_CONTEXT_ATTACHMENT_CHARS) { return content; }
        const omitted = content.length - MAX_CONTEXT_ATTACHMENT_CHARS;
        return `${content.slice(0, MAX_CONTEXT_ATTACHMENT_CHARS)}\n\n[${name} truncated: ${omitted} characters omitted.]`;
    }

    private async handleSelectModelById(deploymentId: string) {
        await this.providerRouter.selectModel(deploymentId, () => {
            if (this.copilotRuntime) {
                this.copilotRuntime.dispose?.();
                this.copilotRuntime = undefined;
            }
        });
    }

    private async handleUpdateReasoningConfig(effort?: import('./types').ReasoningEffort, summary?: import('./types').ReasoningSummary) {
        await this.providerRouter.updateReasoningConfig({ effort, summary });
    }

    private async handleSelectAgentProvider(provider: AgentProvider) {
        await this.providerRouter.selectProvider(provider, () => this.saveCurrentSession());
    }

    // ── Slash Command Support ──
    // Supports two file shapes:
    //   `<name>.md`         — Junior's native slash command file
    //   `<name>.prompt.md`  — VS Code / spec-kit prompt file (may have YAML frontmatter)

    /** Get the list of directories to scan for slash command .md files */
    private getSlashCommandDirs(): string[] {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return []; }

        const custom = getSetting<string[]>('slashCommands.directories') || [];
        const defaults = [
            path.join(root, '.junior', 'commands'),
            path.join(root, '.github', 'copilot', 'commands'),
            path.join(root, '.github', 'commands'),
            // spec-kit (`specify init . --ai copilot`) writes prompts here
            path.join(root, '.github', 'prompts'),
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
                    if (!/\.(prompt\.)?md$/i.test(entry)) { continue; }
                    const name = entry.replace(/\.(prompt\.)?md$/i, '');
                    if (seen.has(name)) { continue; }
                    seen.add(name);

                    // Read first non-frontmatter line as description
                    let description = '';
                    try {
                        const content = stripFrontmatter(fs.readFileSync(path.join(dir, entry), 'utf-8'));
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
        const commands = this.discoverSlashCommands();
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
            for (const candidate of [commandName + '.md', commandName + '.prompt.md']) {
                const filePath = path.join(dir, candidate);
                try {
                    if (fs.existsSync(filePath)) {
                        const raw = fs.readFileSync(filePath, 'utf-8');
                        const template = stripFrontmatter(raw).trim();
                        this.log(`Slash command /${commandName} resolved from ${filePath}`);

                        // Cap template at 16000 chars to avoid context blowup
                        const capped = template.length > 16000
                            ? template.slice(0, 16000) + '\n... [template truncated]'
                            : template;

                        if (userArgs) {
                            return `${capped}\n\n---\n\nUser request: ${userArgs}`;
                        }
                        return capped;
                    }
                } catch { /* ignore read errors */ }
            }
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
        this.activeMode = this.getSessionMode(session);
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
                this.builtinTools.resetSessionApprovals();
                this.agentLoop?.clearMessages();
            }
            this.sendToWebview({ type: 'sessionCleared' });
            this.restoreSession();
        }
        this.sendSessionList();
    }

    private restoreSession() {
        const session = this.sessionManager.getCurrentSession();
        this.activeMode = this.getSessionMode(session);
        this.activeCustomAgentId = session.activeCustomAgentId ?? null;
        this.activeDevTeamId = session.activeDevTeamId ?? null;
        this.applyPermissionLevel(session.activePermissionLevel ?? DEFAULT_PERMISSION_LEVEL, { persist: false });
        this.sendToWebview({ type: 'setChatMode', mode: this.activeMode });
        this.sendToWebview({ type: 'planReady', visible: false });
        void this.syncCustomAgentsToWebview();
        void this.syncDevTeamsToWebview();

        if (session.transcript && session.transcript.items.length > 0) {
            this.restoringTranscript = true;
            try {
                this.sendToWebview({ type: 'restoreTranscript', transcript: session.transcript });
            } finally {
                this.restoringTranscript = false;
            }

            if (this.agentLoop) {
                this.agentLoop.setMessages([...session.messages]);
            }
            return;
        }

        if (session.messages.length === 0) { return; }

        this.restoringTranscript = true;
        try {
            replaySessionMessages(session.messages, (msg) => this.sendToWebview(msg));

            // Restore into agent loop
            if (this.agentLoop) {
                this.agentLoop.setMessages([...session.messages]);
            }
        } finally {
            this.restoringTranscript = false;
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
.codicon-person:before { content: "\\eb29"; }
.codicon-trash:before { content: "\\ea81"; }
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
.assistant-provider-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 7px;
    font-size: 11px;
    line-height: 1.2;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    letter-spacing: 0.2px;
    user-select: none;
}
.assistant-provider-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    opacity: 0.9;
}
.assistant-provider-icon svg {
    width: 14px;
    height: 14px;
    display: block;
}
.dev-team-response-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 8px;
    padding: 8px 10px;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.12));
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background, #1f1f1f) 76%, transparent);
}
.dev-team-response-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
}
.dev-team-response-icon {
    color: var(--accent, #2eaadc);
}
.dev-team-response-roster {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.dev-team-member-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    padding: 2px 7px 2px 5px;
    border-radius: 999px;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.12));
    color: var(--vscode-descriptionForeground, #9aa0a6);
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
    font-size: 11px;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dev-team-member-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 14%, transparent);
    font-size: 11px;
    line-height: 1;
}
.dev-team-member-status {
    flex: 0 0 auto;
    color: currentColor;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.9;
}
.dev-team-member-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.dev-team-member-agent {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-descriptionForeground, #9aa0a6);
}
.dev-team-member-agent::before {
    content: '/';
    margin: 0 2px 0 1px;
    opacity: 0.55;
}
.dev-team-member-chip.permission-write { color: var(--vscode-testing-iconPassed, #73c991); }
.dev-team-member-chip.permission-review { color: var(--vscode-testing-iconQueued, #cca700); }
.dev-team-member-chip.permission-read { color: var(--vscode-descriptionForeground, #9aa0a6); }
.dev-team-member-chip.consult-executed {
    color: var(--vscode-testing-iconPassed, #73c991);
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 45%, transparent);
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 10%, var(--vscode-editor-background));
}
.dev-team-member-chip.consult-failed {
    color: var(--vscode-errorForeground, #f48771);
    border-color: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 42%, transparent);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 9%, var(--vscode-editor-background));
}
.dev-team-speaker-heading {
    display: flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    margin: 14px 0 6px;
    padding: 2px 0;
    color: var(--vscode-foreground);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
}
.dev-team-speaker-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
    border-radius: 999px;
    color: var(--accent, #2eaadc);
    background: color-mix(in srgb, currentColor 14%, transparent);
    font-size: 11px;
    line-height: 1;
}
.dev-team-speaker-heading.permission-write .dev-team-speaker-icon { color: var(--vscode-testing-iconPassed, #73c991); }
.dev-team-speaker-heading.permission-review .dev-team-speaker-icon { color: var(--vscode-testing-iconQueued, #cca700); }
.dev-team-speaker-heading.permission-read .dev-team-speaker-icon { color: var(--vscode-descriptionForeground, #9aa0a6); }
.dev-team-speaker-heading.team-synthesis {
    margin-top: 4px;
}
.dev-team-speaker-heading.team-synthesis .dev-team-speaker-icon {
    color: var(--accent, #2eaadc);
}
.dev-team-speaker-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.dev-team-speaker-agent {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    font-size: 11px;
    font-weight: 500;
}
.dev-team-speaker-agent::before {
    content: '/';
    margin: 0 4px 0 1px;
    opacity: 0.55;
}
.dev-team-room-event {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    margin: 5px 0;
    padding: 7px 9px;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.12));
    border-radius: 6px;
    background: color-mix(in srgb, var(--vscode-sideBar-background, #1f1f1f) 70%, transparent);
}
.dev-team-room-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    color: var(--accent, #2eaadc);
    background: color-mix(in srgb, currentColor 14%, transparent);
    font-size: 12px;
    line-height: 1;
}
.dev-team-room-event.status-done .dev-team-room-icon { color: var(--vscode-testing-iconPassed, #73c991); }
.dev-team-room-event.status-blocked .dev-team-room-icon { color: var(--vscode-testing-iconQueued, #cca700); }
.dev-team-room-event.status-failed .dev-team-room-icon { color: var(--vscode-errorForeground, #f48771); }
.dev-team-room-copy {
    min-width: 0;
}
.dev-team-room-title {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    align-items: baseline;
    color: var(--vscode-foreground);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
}
.dev-team-room-agent {
    color: var(--vscode-descriptionForeground, #9aa0a6);
    font-size: 11px;
    font-weight: 500;
}
.dev-team-room-agent::before {
    content: '/';
    margin-right: 4px;
    opacity: 0.55;
}
.dev-team-room-detail {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
}
.dev-team-room-meta {
    margin-top: 3px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    font-size: 10.5px;
    line-height: 1.3;
    text-transform: uppercase;
    letter-spacing: 0.03em;
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
.sources-card {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin: 6px 0;
    padding: 8px 10px;
    font-size: 12px;
}
.sources-card .sources-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
}
.sources-card .sources-header .codicon { opacity: 0.7; }
.sources-card .sources-count {
    margin-left: auto;
    font-weight: 400;
    opacity: 0.6;
    font-size: 11px;
}
.sources-card .sources-query {
    margin: 4px 0 6px 22px;
    opacity: 0.65;
    font-style: italic;
    font-size: 11px;
}
.sources-card .sources-list {
    list-style: decimal;
    margin: 0;
    padding-left: 22px;
}
.sources-card .sources-item { margin: 4px 0; }
.sources-card .sources-item-title {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    font-weight: 500;
}
.sources-card a.sources-item-title:hover { text-decoration: underline; }
.sources-card .sources-item-meta {
    opacity: 0.55;
    font-size: 11px;
}
.sources-card .sources-item-snippet {
    margin-top: 2px;
    opacity: 0.75;
    font-size: 11px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sources-card .sources-more {
    margin: 5px 0 0 22px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    font-size: 11px;
    line-height: 1.3;
}

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
.working-block-wrapper.hidden-working-block {
    display: none;
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
    padding: 4px 0;
    font-size: 12.5px;
    line-height: 1.5;
}
.narration-row p { margin: 0 0 5px; }
.narration-row p:last-child { margin-bottom: 0; }
.narration-row ul,
.narration-row ol {
    margin: 5px 0 5px 18px;
    padding: 0;
}
.narration-row li {
    margin: 2px 0;
}
.narration-row code {
    background: rgba(255,255,255,0.07);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 12px;
}
.narration-row strong { color: var(--fg); }
/* Reasoning panel — collapsible "Thinking" details from the v1 responses API */
.reasoning-panel {
    margin: 4px 0 6px;
    padding: 0;
    border-left: 2px solid var(--vscode-textBlockQuote-border, rgba(255,255,255,0.18));
    background: rgba(255,255,255,0.03);
    border-radius: 3px;
}
.reasoning-summary {
    cursor: pointer;
    list-style: none;
    padding: 4px 8px;
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    user-select: none;
    display: flex;
    align-items: center;
    gap: 6px;
}
.reasoning-summary::-webkit-details-marker { display: none; }
.reasoning-summary::before {
    content: '\\25B8';
    font-size: 10px;
    transition: transform 120ms ease;
    color: var(--vscode-descriptionForeground, #b2b8bf);
}
.reasoning-panel[open] > .reasoning-summary::before {
    transform: rotate(90deg);
}
.reasoning-icon { opacity: 0.7; }
.reasoning-label { font-weight: 500; }
.reasoning-body {
    padding: 4px 10px 8px 22px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family, monospace);
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
    flex: 1;
}
.wb-action-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
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
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    white-space: normal;
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
    padding: 8px 10px 10px;
    flex-shrink: 0;
}
#input-area.drag-over {
    background: rgba(55, 148, 255, 0.1);
    border-top: 2px dashed var(--user-msg);
}
#composer-shell {
    border: 1px solid var(--input-border);
    border-radius: 10px;
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
    padding: 10px 12px 6px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    outline: none;
    min-height: 40px;
    max-height: 200px;
    line-height: 1.45;
}
#input-area textarea:focus {
    border-color: transparent;
}
#composer-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px 7px;
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
#btn-attach.active {
    opacity: 1;
    background: rgba(255,255,255,0.1);
}
.attach-menu {
    position: absolute;
    left: 8px;
    bottom: 36px;
    min-width: 210px;
    background: var(--vscode-dropdown-background, var(--input-bg));
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.28);
    padding: 5px;
    z-index: 100;
}
.attach-menu.hidden { display: none; }
.attach-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 5px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}
.attach-option:hover {
    background: rgba(255,255,255,0.08);
}
.attach-option .codicon {
    width: 16px;
    text-align: center;
    opacity: 0.85;
}
.attach-menu-separator {
    height: 1px;
    background: var(--border);
    margin: 4px 2px;
}

/* Chat mode dropdown */
.mode-dropdown {
    position: relative;
    flex-shrink: 0;
}
.mode-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 88px;
    border: 1px solid rgba(255,255,255,0.1);
    background: var(--vscode-editorWidget-background, rgba(255,255,255,0.05));
    color: var(--fg);
    border-radius: 10px;
    padding: 4px 8px;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, opacity 0.12s ease;
}
.mode-trigger:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.16);
}
.mode-trigger:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #3794ff);
    outline-offset: 1px;
}
.mode-trigger:disabled {
    opacity: 0.55;
    cursor: default;
}
.mode-trigger-label {
    flex: 0 1 auto;
    text-align: left;
}
.mode-trigger-chevron {
    width: 10px;
    height: 10px;
    opacity: 0.65;
    flex-shrink: 0;
    transition: transform 0.12s ease;
}
.mode-dropdown.open .mode-trigger-chevron {
    transform: rotate(180deg);
}
.mode-icon {
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground, #b2b8bf);
}
.mode-icon svg {
    width: 14px;
    height: 14px;
    display: block;
}
.mode-icon .codicon {
    font-size: 14px;
    line-height: 1;
}
.mode-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 176px;
    width: max-content;
    max-width: 260px;
    padding: 4px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.12);
    background: var(--vscode-editorWidget-background, #252526);
    box-shadow: 0 12px 28px rgba(0,0,0,0.28);
    z-index: 25;
}
.mode-menu.hidden {
    display: none;
}
.mode-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    border: none;
    background: transparent;
    color: var(--fg);
    border-radius: 8px;
    padding: 6px 7px;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
}
.mode-option:hover {
    background: rgba(255,255,255,0.06);
}
.mode-option.active {
    background: rgba(255,255,255,0.08);
}
.mode-option-label {
    flex: 1;
    text-align: left;
}
.mode-option-check {
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    color: var(--vscode-textLink-foreground, #3794ff);
}
.mode-option.active .mode-option-check {
    opacity: 1;
}
.mode-menu-separator {
    height: 1px;
    background: var(--vscode-panel-border, rgba(255,255,255,0.08));
    margin: 4px 2px;
}
.mode-option-action { font-style: italic; opacity: 0.85; }
.mode-option-action:hover { opacity: 1; }
.mode-option-custom { position: relative; }
.mode-option-custom .mode-option-actions {
    display: none;
    align-items: center;
    gap: 2px;
    margin-left: 4px;
}
.mode-option-custom:hover .mode-option-actions { display: inline-flex; }
.mode-option-custom .mode-option-actions button {
    background: none;
    border: none;
    color: var(--fg);
    opacity: 0.55;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 11px;
}
.mode-option-custom .mode-option-actions button:hover {
    opacity: 1;
    background: rgba(255,255,255,0.08);
}
.mode-option-scope {
    font-size: 9.5px;
    opacity: 0.55;
    margin-left: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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

.model-control {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 1;
    min-width: 0;
}
#model-select {
    display: none;
}
.model-trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 116px;
    max-width: 220px;
    min-height: 28px;
    box-sizing: border-box;
    border: 1px solid rgba(255,255,255,0.09);
    background: rgba(255,255,255,0.03);
    color: var(--vscode-dropdown-foreground, var(--input-fg));
    border-radius: 8px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.2;
    outline: none;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
}
.model-trigger:hover,
.model-trigger.active {
    background: rgba(255,255,255,0.05);
    border-color: rgba(255,255,255,0.14);
}
.model-trigger:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #3794ff);
    outline-offset: 1px;
}
.model-trigger:disabled {
    opacity: 0.55;
    cursor: default;
}
.model-trigger-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.model-trigger-meta {
    color: var(--vscode-descriptionForeground, #b2b8bf);
    font-size: 11.5px;
    white-space: nowrap;
    flex-shrink: 0;
}
.model-trigger-chevron {
    width: 10px;
    height: 10px;
    opacity: 0.65;
    flex-shrink: 0;
    transition: transform 0.12s ease;
}
.model-control.open .model-trigger-chevron {
    transform: rotate(180deg);
}
.model-menu,
.model-reasoning-submenu {
    background: var(--vscode-editorWidget-background, #252526);
    color: var(--fg);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    box-shadow: 0 12px 28px rgba(0,0,0,0.28);
}
.model-menu.hidden,
.model-reasoning-submenu.hidden {
    display: none;
}
.model-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 40;
    width: min(280px, calc(100vw - 24px));
    padding: 5px;
}
.model-search {
    width: 100%;
    box-sizing: border-box;
    margin: 0 0 4px;
    padding: 6px 7px;
    border: none;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    background: transparent;
    color: var(--input-fg);
    font-family: inherit;
    font-size: 12px;
    outline: none;
}
.model-list {
    max-height: 210px;
    overflow-y: auto;
}
.model-option,
.reasoning-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    border: none;
    background: transparent;
    color: var(--fg);
    border-radius: 5px;
    padding: 5px 7px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
}
.model-option:hover,
.reasoning-option:hover {
    background: rgba(255,255,255,0.07);
}
.model-option.active,
.reasoning-option.active {
    background: rgba(255,255,255,0.09);
}
.model-option-check,
.reasoning-option-check {
    width: 14px;
    flex-shrink: 0;
    color: var(--vscode-textLink-foreground, #3794ff);
    opacity: 0;
}
.model-option.active .model-option-check,
.reasoning-option.active .reasoning-option-check {
    opacity: 1;
}
.model-option-name,
.reasoning-option-label {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
}
.model-option-meta,
.reasoning-option-meta {
    color: var(--vscode-descriptionForeground, #b2b8bf);
    font-size: 11px;
    white-space: nowrap;
}
.model-reasoning-submenu {
    position: absolute;
    left: calc(100% + 7px);
    top: 0;
    z-index: 45;
    width: 320px;
    max-width: calc(100vw - 24px);
    padding: 6px;
}
.model-reasoning-submenu.open-left {
    left: auto;
    right: calc(100% + 7px);
}
.model-reasoning-submenu.open-right {
    left: calc(100% + 7px);
    right: auto;
}
.model-reasoning-submenu.open-inside {
    left: 0;
    right: auto;
    width: 100%;
}
.reasoning-section-title {
    padding: 5px 7px 4px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    font-size: 11px;
}
.reasoning-option-meta {
    flex: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
}
.reasoning-option-group + .reasoning-option-group {
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid rgba(255,255,255,0.08);
}
.model-note {
    padding: 6px 7px 4px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    font-size: 11px;
    line-height: 1.35;
}
.model-note:empty {
    display: none;
}
.model-trigger:focus {
    border-color: var(--vscode-focusBorder, var(--btn-bg));
}

/* Provider bar – sits below the composer shell, matches GHCP bottom bar */
#provider-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 4px 2px;
}
.footer-select-control {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 24px;
    box-sizing: border-box;
    color: var(--fg);
    opacity: 0.65;
    padding: 2px 6px;
    border-radius: 4px;
    transition: opacity 0.12s, background 0.12s;
}
.footer-select-control:hover,
.footer-select-control:focus-within {
    opacity: 1;
    background: rgba(255,255,255,0.08);
}
.footer-select-icon {
    width: 11px;
    height: 11px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    flex-shrink: 0;
}
.footer-select-icon svg {
    width: 11px;
    height: 11px;
    display: block;
}
#provider-select,
#permission-select {
    background: none;
    border: none;
    color: var(--fg);
    font-family: inherit;
    font-size: 11.5px;
    line-height: 1.2;
    cursor: pointer;
    padding: 0;
    outline: none;
    vertical-align: middle;
}
#provider-select {
    min-width: 88px;
}
#permission-select {
    min-width: 134px;
}
#provider-select option,
#permission-select option {
    background: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background, #252526));
    color: var(--vscode-dropdown-foreground, var(--input-fg));
    padding: 4px 8px;
    font-size: 11.5px;
}
#plan-action-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 2px 10px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
    font-size: 11.5px;
}
#plan-action-bar.hidden {
    display: none;
}
.plan-action-label {
    font-size: 11.5px;
    color: var(--vscode-descriptionForeground, #b2b8bf);
}
#btn-run-plan {
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.05);
    color: var(--fg);
    border-radius: 7px;
    padding: 5px 10px;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    line-height: 1.2;
}
#btn-run-plan:hover {
    background: rgba(255,255,255,0.09);
    border-color: rgba(255,255,255,0.18);
}
#provider-bar #context-meter {
    margin-left: auto;
    align-self: center;
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
    gap: 6px;
    padding: 2px 0 8px;
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
.attach-pill.context-pill {
    border-color: rgba(55, 148, 255, 0.55);
}
.attach-file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    flex-shrink: 0;
}
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
    <div id="plan-action-bar" class="hidden">
        <span class="plan-action-label">Proceed from Plan</span>
        <button id="btn-run-plan" title="Continue with execution in Agent mode">Start Implementation</button>
    </div>
    <div id="composer-shell" style="position:relative;">
        <div id="slash-autocomplete"></div>
        <textarea id="input" rows="1" placeholder="Ask Junior anything..." autofocus></textarea>
        <div id="composer-toolbar">
            <button id="btn-attach" class="composer-btn" title="Attach context" aria-haspopup="menu" aria-expanded="false"><i class="codicon codicon-add"></i></button>
            <div id="attach-menu" class="attach-menu hidden" role="menu" aria-label="Attach context">
                <button class="attach-option" data-attach-kind="file" role="menuitem" type="button"><i class="codicon codicon-file"></i><span>File...</span></button>
                <div class="attach-menu-separator" role="separator"></div>
                <button class="attach-option" data-attach-kind="selection" role="menuitem" type="button"><i class="codicon codicon-symbol-snippet"></i><span>Selection</span></button>
                <button class="attach-option" data-attach-kind="active-file" role="menuitem" type="button"><i class="codicon codicon-file-code"></i><span>Active file</span></button>
                <button class="attach-option" data-attach-kind="open-editors" role="menuitem" type="button"><i class="codicon codicon-layout-sidebar-left"></i><span>Open editors</span></button>
                <button class="attach-option" data-attach-kind="diagnostics" role="menuitem" type="button"><i class="codicon codicon-warning"></i><span>Diagnostics</span></button>
                <button class="attach-option" data-attach-kind="git-diff" role="menuitem" type="button"><i class="codicon codicon-git-compare"></i><span>Git diff</span></button>
                <button class="attach-option" data-attach-kind="terminal" role="menuitem" type="button"><i class="codicon codicon-terminal"></i><span>Recent terminal</span></button>
            </div>
            <div id="mode-switch" class="mode-dropdown">
                <button id="mode-trigger" class="mode-trigger" type="button" title="Chat mode" aria-haspopup="menu" aria-expanded="false">
                    <span id="mode-trigger-icon" class="mode-icon" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5.1 3.9h5.8A2.3 2.3 0 0 1 13.2 6.2v3.2a2.3 2.3 0 0 1-2.3 2.3H5.1a2.3 2.3 0 0 1-2.3-2.3V6.2a2.3 2.3 0 0 1 2.3-2.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.8 7.1H1.9M14.1 7.1h-.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6.3" cy="7.2" r=".75" fill="currentColor"/><circle cx="9.7" cy="7.2" r=".75" fill="currentColor"/><path d="M6 9.4c.6.45 1.2.65 2 .65s1.4-.2 2-.65" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                    </span>
                    <span id="mode-trigger-label" class="mode-trigger-label">Agent</span>
                    <span class="mode-trigger-chevron" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </span>
                </button>
                <div id="mode-menu" class="mode-menu hidden" role="menu" aria-label="Chat mode">
                    <button class="mode-option active" data-mode="agent" role="menuitemradio" aria-checked="true" type="button">
                        <span class="mode-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M5.1 3.9h5.8A2.3 2.3 0 0 1 13.2 6.2v3.2a2.3 2.3 0 0 1-2.3 2.3H5.1a2.3 2.3 0 0 1-2.3-2.3V6.2a2.3 2.3 0 0 1 2.3-2.3Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.8 7.1H1.9M14.1 7.1h-.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6.3" cy="7.2" r=".75" fill="currentColor"/><circle cx="9.7" cy="7.2" r=".75" fill="currentColor"/><path d="M6 9.4c.6.45 1.2.65 2 .65s1.4-.2 2-.65" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>
                        <span class="mode-option-label">Agent</span>
                        <span class="mode-option-check" aria-hidden="true"><i class="codicon codicon-check"></i></span>
                    </button>
                    <button class="mode-option" data-mode="ask" role="menuitemradio" aria-checked="false" type="button">
                        <span class="mode-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.75A2.25 2.25 0 0 1 5.25 2.5h5.5A2.25 2.25 0 0 1 13 4.75v3.5a2.25 2.25 0 0 1-2.25 2.25H7.1L4.4 12.8a.6.6 0 0 1-.99-.45v-1.87A2.25 2.25 0 0 1 3 8.25v-3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5.5 5.9h5M5.5 7.9h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>
                        <span class="mode-option-label">Ask</span>
                        <span class="mode-option-check" aria-hidden="true"><i class="codicon codicon-check"></i></span>
                    </button>
                    <button class="mode-option" data-mode="plan" role="menuitemradio" aria-checked="false" type="button">
                        <span class="mode-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h8M6.5 8H12M6.5 12H12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="4.25" cy="4" r=".85" fill="currentColor"/><circle cx="4.25" cy="8" r=".85" fill="currentColor"/><circle cx="4.25" cy="12" r=".85" fill="currentColor"/></svg></span>
                        <span class="mode-option-label">Plan</span>
                        <span class="mode-option-check" aria-hidden="true"><i class="codicon codicon-check"></i></span>
                    </button>
                    <div id="custom-agent-list"></div>
                    <div id="dev-team-list"></div>
                    <div class="mode-menu-separator" role="separator"></div>
                    <button class="mode-option mode-option-action" data-action="create-custom-agent" role="menuitem" type="button">
                        <span class="mode-icon" aria-hidden="true"><i class="codicon codicon-add"></i></span>
                        <span class="mode-option-label">Create custom agent…</span>
                    </button>
                    <button class="mode-option mode-option-action" data-action="create-dev-team" role="menuitem" type="button">
                        <span class="mode-icon" aria-hidden="true"><i class="codicon codicon-add"></i></span>
                        <span class="mode-option-label">Create Dev Team…</span>
                    </button>
                </div>
            </div>
            <div id="model-control" class="model-control">
                <select id="model-select" title="Choose model deployment" tabindex="-1" aria-hidden="true">
                    <option value="">Loading models...</option>
                </select>
                <button id="model-trigger" class="model-trigger" type="button" title="Choose model deployment" aria-haspopup="menu" aria-expanded="false">
                    <span id="model-trigger-label" class="model-trigger-label">Loading models...</span>
                    <span id="model-trigger-meta" class="model-trigger-meta"></span>
                    <span class="model-trigger-chevron" aria-hidden="true"><i class="codicon codicon-chevron-down"></i></span>
                </button>
                <div id="model-menu" class="model-menu hidden" role="menu" aria-label="Models">
                    <input id="model-search" class="model-search" type="text" placeholder="Search models" aria-label="Search models" />
                    <div id="model-list" class="model-list"></div>
                    <div id="model-reasoning-submenu" class="model-reasoning-submenu hidden" role="menu" aria-label="Reasoning options">
                        <div class="reasoning-option-group" data-reasoning-group="effort"></div>
                        <div class="reasoning-option-group" data-reasoning-group="summary"></div>
                        <div id="model-note" class="model-note"></div>
                    </div>
                </div>
            </div>
            <button id="btn-tools" class="composer-btn" title="MCP Tools"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="4" width="14" height="1.2" rx="0.6"/><circle cx="10.5" cy="4.6" r="2"/><rect x="1" y="10.8" width="14" height="1.2" rx="0.6"/><circle cx="5.5" cy="11.4" r="2"/></svg></button>
            <div class="composer-spacer"></div>
            <button id="btn-send" class="composer-btn" title="Send message (Enter)"><i class="codicon codicon-arrow-up"></i></button>
        </div>
    </div>
    <div id="provider-bar">
        <label class="footer-select-control" title="Agent provider">
            <span class="footer-select-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.1 3.9h5.8A2.3 2.3 0 0 1 13.2 6.2v3.2a2.3 2.3 0 0 1-2.3 2.3H5.1a2.3 2.3 0 0 1-2.3-2.3V6.2a2.3 2.3 0 0 1 2.3-2.3Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M2.8 7.1H1.9M14.1 7.1h-.9" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/><circle cx="6.3" cy="7.2" r=".75" fill="currentColor"/><circle cx="9.7" cy="7.2" r=".75" fill="currentColor"/><path d="M6 9.4c.6.45 1.2.65 2 .65s1.4-.2 2-.65" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>
            </span>
            <select id="provider-select" title="Agent provider">
                <option value="local">Local</option>
            </select>
        </label>
        <label class="footer-select-control" title="Approval mode for this chat session">
            <span class="footer-select-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.75 12.5 3.5v3.84c0 3.06-1.9 5.84-4.5 6.91-2.6-1.07-4.5-3.85-4.5-6.91V3.5L8 1.75Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="m6.35 7.95 1.1 1.1 2.35-2.35" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <select id="permission-select" title="Approval mode for this chat session">
                <option value="default">Default Approvals</option>
                <option value="bypass">Bypass Approvals</option>
            </select>
        </label>
        <div id="context-meter"><div class="meter-ring"><svg viewBox="0 0 20 20"><circle class="meter-bg" cx="10" cy="10" r="8" /><circle class="meter-fill" cx="10" cy="10" r="8" stroke-dasharray="50.27" stroke-dashoffset="50.27" /></svg></div><span class="meter-label">0 / 128.0K (0%)</span></div>
    </div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    // CSP nonces must be cryptographically unguessable. Use crypto.randomBytes,
    // not Math.random(). 16 bytes -> 22 base64url chars of entropy.
    return crypto.randomBytes(16).toString('base64').replace(/[+/=]/g, '');
}



