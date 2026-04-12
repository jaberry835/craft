/**
 * Copilot SDK Runtime — implements AgentRuntime using @github/copilot-sdk.
 *
 * Spawns the Copilot CLI in server mode via the SDK, creates sessions,
 * and streams assistant responses + tool events back to the webview.
 */
import * as vscode from 'vscode';
import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import type { MCPServerConfig, PermissionRequest, PermissionRequestResult, SessionConfig } from '@github/copilot-sdk';
import * as path from 'path';
import { buildCopilotCliProcessEnv, resolveConfiguredCopilotCliLaunchSpec } from './copilotCliSupport';
import { BuiltinTools } from './builtinTools';
import { shouldAutoApproveCopilotPermission } from './permissions';

/** ProviderConfig is defined in SDK types but not re-exported; extract from SessionConfig. */
type ProviderConfig = NonNullable<SessionConfig['provider']>;
import { AgentRuntime, AgentCallbacks } from './agentRuntime';
import { getSetting } from './config';
import { TokenTracker } from './tokenTracker';
import {
    AgentPermissionLevel,
    AgentPlanStep,
    ChatMessage,
    ChatMode,
    ExtensionMessage,
    RuntimeSessionState,
    WorkingBlock,
    WorkingBlockActionEntry,
    WorkingActionType,
} from './types';

interface PendingPermission {
    actionId: string;
    category: string;
    filePath?: string;
    resolve: (result: PermissionRequestResult) => void;
}

type PromptContextProvider = (mode: ChatMode, text: string) => Promise<string>;

interface ToolCallMetadata {
    toolName?: string;
    toolTitle?: string;
    intentionSummary?: string;
    arguments?: Record<string, unknown>;
}

export class CopilotSdkRuntime implements AgentRuntime {
    private static readonly IDLE_TIMEOUT_RECOVERY_MS = 180000;
    private static readonly SEND_AND_WAIT_TIMEOUT_MS = 180000;
    private static readonly LONG_WAIT_STATUS_INTERVAL_MS = 5000;
    private static readonly LONG_WAIT_INACTIVITY_MS = 15000;

    private client?: CopilotClient;
    private session?: CopilotSession;
    private messages: ChatMessage[] = [];
    private running = false;
    private sessionId?: string;
    private assistantText = '';
    private assistantStarted = false;
    private pendingPermissions = new Map<string, PendingPermission>();
    private unsubscribers: Array<() => void> = [];
    private workingBlock?: WorkingBlock;
    private workingActionCounter = 0;
    private runStartTs = 0;
    private toolEntryIds = new Map<string, string>();
    private toolEntryPendingCounts = new Map<string, number>();
    private mergedActionEntries = new Map<string, WorkingBlockActionEntry>();
    private currentMode: ChatMode = 'agent';
    private approvedPlanExecution = false;
    private allowExternalResearch = false;
    private planSteps: AgentPlanStep[] = [];
    private sessionApprovedCategories = new Set<string>();
    private lastActivityTs = 0;
    private toolMetadataByCallId = new Map<string, ToolCallMetadata>();
    private lastBackgroundTaskSummary = '';
    private currentPromptContext = '';
    private longWaitStatusTimer?: NodeJS.Timeout;
    private lastLongWaitStatus = '';
    private permissionLevel: AgentPermissionLevel = 'default';
    /** Reject handle for an active waitForIdleEvent — allows cancel() to unblock it. */
    private pendingIdleReject?: (err: Error) => void;

    constructor(
        private readonly callbacks: AgentCallbacks,
        private readonly log?: (msg: string) => void,
        private readonly tokenTracker?: TokenTracker,
        private readonly getMcpServerConfigs?: () => Promise<Record<string, MCPServerConfig>>,
        private readonly builtinTools?: BuiltinTools,
        private readonly getPromptContext?: PromptContextProvider,
    ) {}

    isRunning(): boolean {
        return this.running;
    }

    getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    setMessages(messages: ChatMessage[]): void {
        this.messages = [...messages];
        this.sessionApprovedCategories.clear();
        this.toolEntryPendingCounts.clear();
        this.mergedActionEntries.clear();
        this.toolMetadataByCallId.clear();
        this.lastBackgroundTaskSummary = '';
        this.currentPromptContext = '';
    }

    clearMessages(): void {
        this.messages = [];
        this.disconnectSession();
        this.sessionId = undefined;
        this.toolEntryIds.clear();
        this.toolEntryPendingCounts.clear();
        this.mergedActionEntries.clear();
        this.sessionApprovedCategories.clear();
        this.toolMetadataByCallId.clear();
        this.lastBackgroundTaskSummary = '';
        this.currentPromptContext = '';
    }

    cancel(): void {
        if (!this.running) { return; }
        this.running = false;
        // Abort the current prompt
        this.session?.abort().catch(() => {});
        // Unblock any pending waitForIdleEvent
        if (this.pendingIdleReject) {
            this.pendingIdleReject(new Error('Cancelled by user'));
            this.pendingIdleReject = undefined;
        }
        // Reject any pending permission prompts
        for (const [, pending] of this.pendingPermissions) {
            pending.resolve({ kind: 'denied-interactively-by-user' });
        }
        this.pendingPermissions.clear();
    }

    resolveConfirmation(actionId: string, approved: boolean, allowSession?: boolean): void {
        const pending = this.pendingPermissions.get(actionId);
        if (!pending) { return; }
        const finalize = () => {
            if (approved && allowSession) {
                this.sessionApprovedCategories.add(pending.category);
            }
            pending.resolve(
                approved
                    ? { kind: 'approved' }
                    : { kind: 'denied-interactively-by-user' }
            );
            this.pendingPermissions.delete(actionId);
        };

        if (approved && pending.filePath) {
            void this.builtinTools?.trackExternalWriteStart(pending.filePath).finally(finalize);
            return;
        }

        finalize();
    }

    setPermissionLevel(level: AgentPermissionLevel): void {
        this.permissionLevel = level;
    }

    getSessionState(): RuntimeSessionState | undefined {
        if (!this.sessionId) { return undefined; }
        return {
            provider: 'copilot-cli',
            backendSessionId: this.sessionId,
        };
    }

    async restoreSessionState(state: RuntimeSessionState | undefined): Promise<void> {
        if (!state || state.provider !== 'copilot-cli' || !state.backendSessionId) {
            this.sessionId = undefined;
            return;
        }
        // We'll create a fresh session on next run() — the SDK manages session state internally
        this.sessionId = state.backendSessionId;
    }

    async run(mode: ChatMode, text: string, images?: string[], files?: { name: string; content: string }[], displayText?: string): Promise<void> {
        this.currentMode = mode;
        this.approvedPlanExecution = mode === 'agent' && /execute the approved plan above/i.test(text);
        this.allowExternalResearch = /\b(web|website|url|fetch|documentation|docs|microsoft learn|official docs|internet|online)\b/i.test(text);
        this.planSteps = [];
        this.running = true;
        this.assistantText = '';
        this.assistantStarted = false;
        this.workingBlock = undefined;
        this.workingActionCounter = 0;
        this.runStartTs = Date.now();
        this.lastActivityTs = this.runStartTs;
        this.toolEntryIds.clear();
        this.toolEntryPendingCounts.clear();
        this.mergedActionEntries.clear();
        this.toolMetadataByCallId.clear();
        this.lastBackgroundTaskSummary = '';
        this.callbacks.sendToWebview({ type: 'agentPlan', steps: [] });

        this.messages.push({
            role: 'user',
            content: text,
            mode,
            displayText,
        });

        // Match the local runtime: surface an immediate thinking state even before
        // the CLI emits reasoning/tool events.
        this.callbacks.sendToWebview({ type: 'setStatus', status: 'Thinking...' });
        this.startLongWaitStatusHeartbeat();

        try {
            await this.ensureSession();
            if (!this.session) {
                throw new Error('Copilot CLI session failed to initialize.');
            }

            this.currentPromptContext = await this.getPromptContext?.(mode, displayText || text) || '';
            const prompt = text;
            this.log?.(`[copilot-sdk] Sending prompt (${prompt.length} chars, mode=${mode})`);

            // Build attachments for images/files
            const attachments: Array<{ type: 'blob'; data: string; mimeType: string }> = [];
            if (images) {
                for (const img of images) {
                    // img is a data:image/...;base64,... URI
                    const match = img.match(/^data:(image\/\w+);base64,(.+)$/);
                    if (match) {
                        attachments.push({ type: 'blob', data: match[2], mimeType: match[1] });
                    }
                }
            }

            // sendAndWait blocks until session.idle
            try {
                await this.session.sendAndWait({
                    prompt,
                    ...(attachments.length > 0 ? { attachments } : {}),
                }, CopilotSdkRuntime.SEND_AND_WAIT_TIMEOUT_MS);
            } catch (err) {
                // If cancelled, exit silently — the finally block handles cleanup
                if (!this.running) { return; }
                if (this.shouldRecoverFromIdleTimeout(err)) {
                    this.log?.('[copilot-sdk] sendAndWait hit session.idle timeout; waiting for a later idle event');
                    this.callbacks.sendToWebview({ type: 'setStatus', status: this.describePendingWaitStatus() });
                    try {
                        await this.waitForIdleEvent(CopilotSdkRuntime.IDLE_TIMEOUT_RECOVERY_MS);
                    } catch (idleErr) {
                        // Cancelled during wait — exit silently
                        if (!this.running) { return; }
                        throw idleErr;
                    }
                } else {
                    throw err;
                }
            }

            // Finalize any open working block
            if (this.workingBlock) {
                this.finalizeWorkingBlock();
            }

            // End the assistant message stream if one was started
            if (this.assistantStarted) {
                this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                this.assistantStarted = false;
            }

            // Store assistant message
            if (this.assistantText.trim()) {
                this.messages.push({
                    role: 'assistant',
                    content: this.assistantText.trim(),
                });
            }

            this.log?.(`[copilot-sdk] Prompt completed in ${Date.now() - this.runStartTs}ms`);
        } finally {
            this.running = false;
            this.stopLongWaitStatusHeartbeat();
            this.callbacks.sendToWebview({ type: 'setStatus', status: '' });
            this.callbacks.sendToWebview({ type: 'agentDone' });
        }
    }

    dispose(): void {
        this.cancel();
        this.disconnectSession();
        this.client?.stop().catch(() => {});
        this.client = undefined;
    }

    // ── Private ──

    private async ensureClient(): Promise<CopilotClient> {
        if (this.client) { return this.client; }

        const cliEnv = buildCopilotCliProcessEnv();
        const additionalArgs = [...(getSetting<string[]>('copilotCli.additionalArgs') || [])];
        const configuredModel = getSetting<string>('copilotCli.model') || cliEnv.COPILOT_MODEL || '';

        if (configuredModel && !this.hasCliModelArg(additionalArgs)) {
            additionalArgs.push('--model', configuredModel);
        }

        const launchSpec = resolveConfiguredCopilotCliLaunchSpec(additionalArgs, cliEnv);
        const cliTarget = launchSpec.resolvedCliPath || launchSpec.cliPath;

        this.log?.(`[copilot-sdk] Creating client (cliPath=${launchSpec.cliPath}, target=${cliTarget}, args=${JSON.stringify(launchSpec.cliArgs)})`);

        this.client = new CopilotClient({
            cliPath: launchSpec.cliPath,
            cliArgs: launchSpec.cliArgs,
            useStdio: true,
            env: cliEnv,
        });

        // autoStart is true by default — createSession() will call start() internally.
        // We do an explicit start() here so errors surface early with a clear message.
        try {
            await this.client.start();
        } catch (err: any) {
            this.client = undefined;
            const msg = err?.message || String(err);
            const cliDescriptor = launchSpec.cliPath === cliTarget ? cliTarget : `${cliTarget} via ${launchSpec.cliPath}`;
            throw new Error(`Copilot CLI failed to start (cliPath=${cliDescriptor}): ${msg}`);
        }
        this.log?.('[copilot-sdk] Client started');
        return this.client;
    }

    private async ensureSession(): Promise<void> {
        if (this.session) { return; }

        const client = await this.ensureClient();
        const cliEnv = buildCopilotCliProcessEnv();
        const model = getSetting<string>('copilotCli.model') || cliEnv.COPILOT_MODEL || undefined;
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const mcpServers = await this.getMcpServerConfigs?.();

        // Build BYOK provider config if configured
        const provider = this.buildProviderConfig();

        const sessionConfig: SessionConfig = {
            ...(model ? { model } : {}),
            streaming: true,
            systemMessage: this.buildSystemMessageConfig(),
            excludedTools: this.buildExcludedTools(),
            hooks: this.buildSessionHooks(),
            ...(cwd ? { workingDirectory: cwd } : {}),
            ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
            ...(provider ? { provider } : {}),
            onPermissionRequest: (request, _invocation) => this.handlePermission(request),
        };

        this.log?.(`[copilot-sdk] Creating session (model=${model || 'default'}, mcpServers=${mcpServers ? Object.keys(mcpServers).length : 0})`);

        // Resume if we have a previous sessionId, otherwise create new
        if (this.sessionId) {
            try {
                this.session = await client.resumeSession(this.sessionId, sessionConfig);
                this.log?.(`[copilot-sdk] Resumed session ${this.sessionId}`);
            } catch (err) {
                this.log?.(`[copilot-sdk] Resume failed, creating new: ${err}`);
                this.session = await client.createSession(sessionConfig);
                this.sessionId = this.session.sessionId;
            }
        } else {
            this.session = await client.createSession(sessionConfig);
            this.sessionId = this.session.sessionId;
        }

        this.log?.(`[copilot-sdk] Session ready: ${this.sessionId}`);
        this.wireSessionEvents();
    }

    private wireSessionEvents(): void {
        if (!this.session) { return; }

        // Clean up old subscriptions
        for (const unsub of this.unsubscribers) { unsub(); }
        this.unsubscribers = [];

        this.unsubscribers.push(
            this.session.on((event: any) => {
                if (!this.shouldLogSdkEvents()) { return; }
                this.log?.(`[copilot-sdk:event] ${this.formatSdkEventForLog(event)}`);
            })
        );

        this.unsubscribers.push(
            this.session.on('session.idle', (event: any) => {
                this.lastActivityTs = Date.now();
                this.lastBackgroundTaskSummary = this.describeBackgroundTasks(event.data?.backgroundTasks);
                if (this.lastBackgroundTaskSummary) {
                    this.callbacks.sendToWebview({ type: 'setStatus', status: this.lastBackgroundTaskSummary });
                }
            })
        );

        this.unsubscribers.push(
            this.session.on('assistant.message', (event: any) => {
                this.lastActivityTs = Date.now();

                for (const request of event.data?.toolRequests || []) {
                    if (!request?.toolCallId) { continue; }
                    this.toolMetadataByCallId.set(request.toolCallId, {
                        toolName: request.name,
                        toolTitle: typeof request.toolTitle === 'string' ? request.toolTitle : undefined,
                        intentionSummary: typeof request.intentionSummary === 'string' ? request.intentionSummary : undefined,
                        arguments: request.arguments && typeof request.arguments === 'object' ? request.arguments as Record<string, unknown> : undefined,
                    });
                }

                const content = typeof event.data?.content === 'string' ? event.data.content : '';
                if (!this.assistantText && content.trim()) {
                    if (!this.assistantStarted) {
                        if (this.workingBlock) {
                            this.finalizeWorkingBlock();
                        }
                        this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
                        this.assistantStarted = true;
                    }
                    this.assistantText = content;
                    this.callbacks.sendToWebview({ type: 'appendAssistantText', text: content });
                }
            })
        );

        // Streaming text deltas
        this.unsubscribers.push(
            this.session.on('assistant.message_delta', (event: any) => {
                this.lastActivityTs = Date.now();
                const delta = event.data?.deltaContent || '';
                if (!delta) { return; }

                if (!this.assistantStarted) {
                    // Close any open working block before starting text
                    if (this.workingBlock) {
                        this.finalizeWorkingBlock();
                    }
                    this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
                    this.assistantStarted = true;
                }
                this.assistantText += delta;
                this.callbacks.sendToWebview({ type: 'appendAssistantText', text: delta });
            })
        );

        // Reasoning deltas (thinking)
        this.unsubscribers.push(
            this.session.on('assistant.reasoning_delta', (event: any) => {
                this.lastActivityTs = Date.now();
                const delta = event.data?.deltaContent || '';
                if (delta) {
                    this.callbacks.sendToWebview({ type: 'narrationText', text: delta });
                }
            })
        );

        // Native token accounting from the Copilot CLI/SDK.
        this.unsubscribers.push(
            this.session.on('assistant.usage', (event: any) => {
                this.lastActivityTs = Date.now();
                const inputTokens = Number(event.data?.inputTokens || 0);
                const outputTokens = Number(event.data?.outputTokens || 0);
                if (!this.tokenTracker || (inputTokens <= 0 && outputTokens <= 0)) {
                    return;
                }

                this.log?.(`[copilot-sdk] Tokens: +${inputTokens}p/${outputTokens}c`);
                this.tokenTracker.record('chat', {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                });
            })
        );

        // Current context window burden from the active CLI session.
        this.unsubscribers.push(
            this.session.on('session.usage_info', (event: any) => {
                this.lastActivityTs = Date.now();
                const currentTokens = Number(event.data?.currentTokens || 0);
                const tokenLimit = Number(event.data?.tokenLimit || 0);
                if (!this.tokenTracker || currentTokens <= 0) {
                    return;
                }

                this.tokenTracker.setContextSize(currentTokens, tokenLimit > 0 ? tokenLimit : undefined);
            })
        );

        // Tool execution started
        this.unsubscribers.push(
            this.session.on('tool.execution_start', (event: any) => {
                this.lastActivityTs = Date.now();
                const toolName = event.data?.toolName || 'tool';
                const toolCallId = event.data?.toolCallId as string | undefined;
                const toolMeta = toolCallId ? this.toolMetadataByCallId.get(toolCallId) : undefined;
                this.log?.(`[copilot-sdk] Tool started: ${toolName}`);

                if (this.handlePlanToolEvent(toolName, event.data)) {
                    if (toolCallId) {
                        this.toolEntryIds.set(toolCallId, '');
                    }
                    return;
                }

                if (this.shouldHideTool(toolName)) {
                    if (toolCallId) {
                        this.toolEntryIds.set(toolCallId, '');
                    }
                    return;
                }

                // If assistant text was streaming, end it before showing tool
                if (this.assistantStarted) {
                    this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                    this.assistantStarted = false;
                }

                // Ensure we have a working block
                if (!this.workingBlock) {
                    this.startWorkingBlock('Working');
                }

                const created = this.createToolEntry(toolName, event.data, toolMeta);
                const entry = created.entry;
                if (toolCallId) {
                    this.toolEntryIds.set(toolCallId, entry.id);
                }
                this.toolEntryPendingCounts.set(entry.id, (this.toolEntryPendingCounts.get(entry.id) || 0) + 1);
                if (created.isNew) {
                    this.callbacks.sendToWebview({
                        type: 'workingActionAdded',
                        blockId: this.workingBlock!.id,
                        entry,
                    });
                } else {
                    this.callbacks.sendToWebview({
                        type: 'workingActionUpdated',
                        blockId: this.workingBlock!.id,
                        entryId: entry.id,
                        status: 'running',
                        text: entry.text,
                        filePath: entry.filePath,
                        icon: entry.icon,
                        repeatCount: entry.repeatCount,
                    });
                }
            })
        );

        // Tool execution completed
        this.unsubscribers.push(
            this.session.on('tool.execution_complete', (event: any) => {
                this.lastActivityTs = Date.now();
                const toolName = event.data?.toolName || 'tool';
                const toolCallId = event.data?.toolCallId as string | undefined;
                const entryId = toolCallId ? this.toolEntryIds.get(toolCallId) : undefined;
                this.log?.(`[copilot-sdk] Tool completed: ${toolName}`);

                if (toolCallId) {
                    this.toolEntryIds.delete(toolCallId);
                }

                if (!entryId) {
                    return;
                }

                const entry = this.findWorkingActionEntry(entryId);
                const remaining = Math.max((this.toolEntryPendingCounts.get(entryId) || 1) - 1, 0);
                if (remaining > 0) {
                    this.toolEntryPendingCounts.set(entryId, remaining);
                } else {
                    this.toolEntryPendingCounts.delete(entryId);
                }

                if (this.workingBlock) {
                    const resultPatch = this.describeToolCompletionPatch(event.data, entry);
                    this.callbacks.sendToWebview({
                        type: 'workingActionUpdated',
                        blockId: this.workingBlock.id,
                        entryId,
                        status: event.data?.success === false ? 'error' : remaining > 0 ? 'running' : 'done',
                        text: resultPatch.text,
                        detail: resultPatch.detail,
                        filePath: resultPatch.filePath,
                        repeatCount: entry?.repeatCount,
                    });
                }

                if (event.data?.success !== false && entry?.filePath && (entry.actionType === 'edit' || entry.actionType === 'create')) {
                    this.builtinTools?.trackExternalWriteComplete(entry.filePath);
                }

                if (toolCallId) {
                    this.toolMetadataByCallId.delete(toolCallId);
                }
            })
        );

        this.unsubscribers.push(
            this.session.on('session.workspace_file_changed', (event: any) => {
                this.lastActivityTs = Date.now();
                const relPath = typeof event.data?.path === 'string' ? event.data.path.trim() : '';
                if (!relPath || !this.workingBlock) {
                    return;
                }

                const targetEntry = [...this.workingBlock.entries]
                    .reverse()
                    .find((entry): entry is WorkingBlockActionEntry => entry.kind === 'action' && (entry.actionType === 'edit' || entry.actionType === 'create'));

                if (!targetEntry) {
                    return;
                }

                targetEntry.filePath = relPath;
                targetEntry.text = targetEntry.actionType === 'create'
                    ? `Create ${this.shortPath(relPath)}`
                    : `Edit ${this.shortPath(relPath)}`;

                if (!targetEntry.detail) {
                    targetEntry.detail = event.data?.operation === 'create' ? 'Workspace file created' : 'Workspace file updated';
                }

                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: this.workingBlock.id,
                    entryId: targetEntry.id,
                    status: targetEntry.status,
                    text: targetEntry.text,
                    detail: targetEntry.detail,
                    filePath: targetEntry.filePath,
                    repeatCount: targetEntry.repeatCount,
                });
            })
        );

        this.unsubscribers.push(
            this.session.on('session.info', (event: any) => {
                this.lastActivityTs = Date.now();
                const message = typeof event.data?.message === 'string' ? event.data.message.trim() : '';
                if (!message || !this.workingBlock) {
                    return;
                }

                if (/^(authentication|configuration|model)\b/i.test(String(event.data?.infoType || ''))) {
                    return;
                }

                this.callbacks.sendToWebview({ type: 'setStatus', status: message });
            })
        );

        this.unsubscribers.push(
            this.session.on('session.warning', (event: any) => {
                this.lastActivityTs = Date.now();
                const message = typeof event.data?.message === 'string' ? event.data.message.trim() : '';
                if (!message) {
                    return;
                }
                this.callbacks.sendToWebview({ type: 'setStatus', status: message });
            })
        );

        this.unsubscribers.push(
            this.session.on('tool.execution_progress', (event: any) => {
                this.lastActivityTs = Date.now();
                const toolCallId = event.data?.toolCallId as string | undefined;
                const entryId = toolCallId ? this.toolEntryIds.get(toolCallId) : undefined;
                const progressMessage = typeof event.data?.progressMessage === 'string'
                    ? event.data.progressMessage.trim()
                    : '';

                if (!entryId || !progressMessage || !this.workingBlock) {
                    return;
                }

                const entry = this.findWorkingActionEntry(entryId);
                const detail = this.describeProgressDetail(progressMessage, entry?.repeatCount || 1);
                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: this.workingBlock.id,
                    entryId,
                    status: 'running',
                    detail,
                    repeatCount: entry?.repeatCount,
                });
            })
        );

        this.unsubscribers.push(
            this.session.on('tool.execution_partial_result', (event: any) => {
                this.lastActivityTs = Date.now();
                const toolCallId = event.data?.toolCallId as string | undefined;
                const entryId = toolCallId ? this.toolEntryIds.get(toolCallId) : undefined;
                const partialOutput = typeof event.data?.partialOutput === 'string'
                    ? event.data.partialOutput.trim()
                    : '';

                if (!entryId || !partialOutput || !this.workingBlock) {
                    return;
                }

                const entry = this.findWorkingActionEntry(entryId);
                // Only show partial output for action types where it's meaningful
                if (entry && (entry.actionType === 'read' || entry.actionType === 'review' || entry.actionType === 'search')) {
                    return;
                }
                const detail = this.describePartialOutputDetail(partialOutput, entry?.repeatCount || 1);
                if (!detail) {
                    return;
                }

                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: this.workingBlock.id,
                    entryId,
                    status: 'running',
                    detail,
                    repeatCount: entry?.repeatCount,
                });
            })
        );
    }

    private buildProviderConfig(): ProviderConfig | undefined {
        const cliEnv = buildCopilotCliProcessEnv();
        const baseUrl = getSetting<string>('copilotCli.providerBaseUrl') || cliEnv.COPILOT_PROVIDER_BASE_URL;
        if (!baseUrl) { return undefined; }

        const type = (getSetting<string>('copilotCli.providerType') || cliEnv.COPILOT_PROVIDER_TYPE || 'openai') as 'openai' | 'azure' | 'anthropic';
        const apiKey = getSetting<string>('copilotCli.providerApiKey') || cliEnv.COPILOT_PROVIDER_API_KEY || undefined;
        const bearerToken = getSetting<string>('copilotCli.providerBearerToken') || cliEnv.COPILOT_PROVIDER_BEARER_TOKEN || undefined;
        const wireApi = (getSetting<string>('copilotCli.providerWireApi') || cliEnv.COPILOT_PROVIDER_WIRE_API || undefined) as 'completions' | 'responses' | undefined;
        const azureApiVersion = getSetting<string>('copilotCli.providerAzureApiVersion') || cliEnv.COPILOT_PROVIDER_AZURE_API_VERSION || undefined;

        const config: ProviderConfig = {
            type,
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            ...(bearerToken ? { bearerToken } : {}),
            ...(wireApi ? { wireApi } : {}),
            ...(type === 'azure' && azureApiVersion ? { azure: { apiVersion: azureApiVersion } } : {}),
        };

        this.log?.(`[copilot-sdk] BYOK provider: type=${type}, baseUrl=${baseUrl}`);
        return config;
    }

    private handlePermission(request: PermissionRequest): Promise<PermissionRequestResult> {
        const normalizedTool = this.normalizeToolName(String((request as any).toolName || ''));
        const writeFilePath = request.kind === 'write' ? this.getPermissionWriteFilePath(request) : undefined;
        this.lastActivityTs = Date.now();

        if (this.sessionApprovedCategories.has(request.kind)) {
            return this.approvePermissionRequest(writeFilePath);
        }

        if (request.kind === 'read') {
            return Promise.resolve({ kind: 'approved' });
        }

        if (this.currentMode !== 'agent') {
            if (request.kind === 'custom-tool' && (normalizedTool === 'set_plan' || normalizedTool === 'setplan' || normalizedTool === 'update_plan_step' || normalizedTool === 'updateplanstep' || normalizedTool === 'report_intent' || normalizedTool === 'reportintent')) {
                return Promise.resolve({ kind: 'approved' });
            }
            this.log?.(`[copilot-sdk] Denied ${request.kind} permission in ${this.currentMode} mode`);
            return Promise.resolve({ kind: 'denied-interactively-by-user' });
        }

        if (this.approvedPlanExecution && request.kind === 'url' && !this.allowExternalResearch) {
            this.log?.('[copilot-sdk] Denied url permission during approved-plan execution (local-first mode)');
            return Promise.resolve({ kind: 'denied-interactively-by-user' });
        }

        if (shouldAutoApproveCopilotPermission(this.permissionLevel, request.kind)) {
            return this.approvePermissionRequest(writeFilePath);
        }

        // For everything else: show confirmation in webview
        const actionId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const description = this.describePermission(request);

        return new Promise<PermissionRequestResult>((resolve) => {
            this.pendingPermissions.set(actionId, { actionId, category: request.kind, filePath: writeFilePath, resolve });
            this.callbacks.sendToWebview({
                type: 'confirmAction',
                actionId,
                description,
                category: request.kind,
            });
        });
    }

    private approvePermissionRequest(filePath?: string): Promise<PermissionRequestResult> {
        if (!filePath) {
            return Promise.resolve({ kind: 'approved' });
        }

        return this.builtinTools
            ? this.builtinTools.trackExternalWriteStart(filePath).then(() => ({ kind: 'approved' as const }))
            : Promise.resolve({ kind: 'approved' as const });
    }

    private getPermissionWriteFilePath(request: PermissionRequest): string | undefined {
        return typeof (request as any).fileName === 'string' && (request as any).fileName.trim()
            ? (request as any).fileName.trim()
            : undefined;
    }

    private describePermission(request: PermissionRequest): string {
        switch (request.kind) {
            case 'write':
                return `Write file: ${this.shortenPathsInText((request as any).fileName || 'unknown')}`;
            case 'shell':
                return `Run command: ${this.shortenPathsInText((request as any).fullCommandText || 'unknown')}`;
            case 'mcp':
                return `Call MCP tool: ${(request as any).toolName || 'unknown'}`;
            case 'custom-tool':
                return `Call tool: ${(request as any).toolName || 'unknown'}`;
            case 'url':
                return `Fetch URL`;
            default:
                return `Permission: ${request.kind}`;
        }
    }

    private shouldRecoverFromIdleTimeout(err: unknown): boolean {
        const message = err instanceof Error ? err.message : String(err || '');
        if (!/session\.idle/i.test(message) || !/timeout/i.test(message)) {
            return false;
        }

        return this.pendingPermissions.size > 0
            || this.toolEntryIds.size > 0
            || !!this.workingBlock
            || this.assistantText.length > 0
            || Date.now() - this.lastActivityTs < 15000;
    }

    private waitForIdleEvent(timeoutMs: number): Promise<void> {
        if (!this.session) {
            return Promise.resolve();
        }
        if (!this.running) {
            return Promise.reject(new Error('Cancelled by user'));
        }

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let disposeIdle: (() => void) | undefined;
            let timer: NodeJS.Timeout | undefined;

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                if (disposeIdle) {
                    try { disposeIdle(); } catch { }
                    disposeIdle = undefined;
                }
                this.pendingIdleReject = undefined;
            };

            const finish = (callback: () => void) => {
                if (settled) { return; }
                settled = true;
                cleanup();
                callback();
            };

            // Register so cancel() can unblock us
            this.pendingIdleReject = (err: Error) => {
                finish(() => reject(err));
            };

            disposeIdle = this.session!.on('session.idle', () => {
                this.lastActivityTs = Date.now();
                finish(resolve);
            });

            timer = setTimeout(() => {
                finish(() => reject(new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`)));
            }, timeoutMs);
        });
    }

    private startWorkingBlock(title: string): void {
        const block: WorkingBlock = {
            id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            status: 'in_progress',
            title,
            entries: [],
            startedAt: Date.now(),
        };
        this.workingBlock = block;
        this.mergedActionEntries.clear();
        this.toolEntryPendingCounts.clear();
        this.callbacks.sendToWebview({ type: 'workingBlockStarted', block });
    }

    private finalizeWorkingBlock(): void {
        if (!this.workingBlock) { return; }
        const count = this.workingBlock.entries.length;
        const summary = count === 1 ? 'Completed 1 action' : `Completed ${count} actions`;
        this.callbacks.sendToWebview({
            type: 'workingBlockCompleted',
            blockId: this.workingBlock.id,
            summary,
            completedAt: Date.now(),
        });
        this.workingBlock = undefined;
        this.mergedActionEntries.clear();
        this.toolEntryPendingCounts.clear();
    }

    private createToolEntry(toolName: string, data: any, toolMeta?: ToolCallMetadata): { entry: WorkingBlockActionEntry; isNew: boolean } {
        this.workingActionCounter++;
        const entryId = `tool_${toolName}_${this.workingActionCounter}`;
        const actionType = this.classifyTool(toolName);
        const args = this.readToolArgs(data, toolMeta);
        const filePath = this.readStringArg(args, ['filePath', 'path', 'file', 'targetFile', 'target_file']);

        const entry: WorkingBlockActionEntry = {
            id: entryId,
            kind: 'action',
            text: this.describeToolAction(toolName, data, toolMeta),
            createdAt: Date.now(),
            actionType,
            status: 'running',
            repeatCount: 1,
            detail: this.describeToolDetail(toolName, data, actionType, 1, toolMeta),
            filePath,
            toolName,
        };

        const mergeKey = this.getWorkingActionMergeKey(entry);
        const existing = this.mergedActionEntries.get(mergeKey);
        if (existing) {
            existing.repeatCount = (existing.repeatCount || 1) + 1;
            existing.status = 'running';
            existing.detail = this.describeToolDetail(toolName, data, actionType, existing.repeatCount, toolMeta);
            return { entry: existing, isNew: false };
        }

        // Track in working block entries
        if (this.workingBlock) {
            this.workingBlock.entries.push(entry);
        }

        this.mergedActionEntries.set(mergeKey, entry);

        return { entry, isNew: true };
    }

    private getWorkingActionMergeKey(entry: WorkingBlockActionEntry): string {
        return [entry.actionType, entry.filePath || '', entry.text].join('::');
    }

    private findWorkingActionEntry(entryId: string): WorkingBlockActionEntry | undefined {
        if (!this.workingBlock) { return undefined; }
        return this.workingBlock.entries.find((entry): entry is WorkingBlockActionEntry => entry.kind === 'action' && entry.id === entryId);
    }

    private shouldHideTool(toolName: string): boolean {
        const normalized = this.normalizeToolName(toolName);
        return normalized === 'reportintent'
            || normalized === 'report_intent'
            || normalized === 'setplan'
            || normalized === 'set_plan'
            || normalized === 'updateplanstep'
            || normalized === 'update_plan_step';
    }

    private buildSystemMessageConfig(): SessionConfig['systemMessage'] {
        return {
            mode: 'append',
            content: [
                'You are running inside Junior, a VS Code coding assistant.',
                'The host may inject per-turn mode instructions and workspace context through SDK hooks. Treat that injected context as authoritative for the current turn.',
                'When workspace context already identifies the language, likely files, active editor, or diagnostics, do not ask the user to repeat those facts.',
                'Do not use the sql tool as a scratchpad, todo list, or task tracker for workspace coding tasks.',
                'Prefer concise answers in chat, but perform concrete workspace actions when the current turn allows edits or commands.'
            ].join('\n')
        };
    }

    private buildExcludedTools(): string[] {
        return ['sql'];
    }

    private buildSessionHooks(): SessionConfig['hooks'] {
        return {
            onSessionStart: async () => ({
                additionalContext: [
                    'Junior session context:',
                    '- The user is interacting through a VS Code extension UI.',
                    '- Ask, Plan, and Agent are separate host-controlled modes.',
                    '- File review and confirmation prompts may be surfaced by the host UI instead of the model asking for approval directly.'
                ].join('\n')
            }),
            onUserPromptSubmitted: async (input: { prompt: string }) => ({
                modifiedPrompt: input.prompt,
                additionalContext: this.buildTurnContext(this.currentMode, input.prompt, this.currentPromptContext)
            })
        };
    }

    private buildTurnContext(mode: ChatMode, prompt: string, promptContext?: string): string {
        const approvedPlanExecution = /execute the approved plan above/i.test(prompt);
        const modeInstructions = mode === 'ask'
            ? [
                'Turn mode: Ask',
                '- Answer directly and concisely.',
                '- Use read-only tools only when needed.',
                '- Do not edit files, run commands, call MCP tools, or fetch URLs.',
                '- If the user wants implementation, edits, generated code to be applied, or commands to be run, say Ask mode is read-only and explicitly direct them to Agent mode.',
                '- Mention Plan mode when a read-only preflight plan would help.'
            ]
            : mode === 'plan'
                ? [
                    'Turn mode: Plan',
                    '- Investigate with read-only tools.',
                    '- Call set_plan with 3-6 concrete steps once you understand the task.',
                    '- Do not edit files, run commands, call MCP tools, or fetch URLs.',
                    '- Stop after presenting the plan for approval.'
                ]
                : [
                    'Turn mode: Agent',
                    '- You may read files, edit files, run commands, call MCP tools, and use other available tools as needed.',
                    '- When the user asks for implementation, perform the work instead of only describing what should be done.',
                    '- Start with concrete actions in the workspace immediately.',
                    '- Use the provided workspace context as your initial map of the repo. Do not ask the user to restate facts already present there.',
                    ...(approvedPlanExecution ? [
                        '- The plan is already approved. Do not restate the plan or ask for approval again. Begin executing it now and report progress as you go.',
                        '- Work local-first: prefer files already mentioned by the user, nearby project files, and direct symbol or text matches in the workspace.',
                        '- Use at most 1-2 targeted searches or reads to find the implementation point, then start editing.',
                        '- Avoid repeated search variants for the same concept once you already have a viable hit.',
                        '- Do not use URL fetches or external documentation unless the user explicitly asked for them or the task is blocked on API details not present in the repository.',
                        '- Once you identify the target file, make the change and validate it instead of continuing to investigate.'
                    ] : [])
                ];

        const sections = [modeInstructions.join('\n')];
        if (promptContext?.trim()) {
            sections.push(
                'Workspace context for this turn:\n' + promptContext.trim()
            );
        }
        return sections.join('\n\n');
    }

    private handlePlanToolEvent(toolName: string, data: any): boolean {
        const normalized = this.normalizeToolName(toolName);
        const args = this.readToolArgs(data);

        if (normalized === 'set_plan' || normalized === 'setplan') {
            const rawSteps = Array.isArray(args.steps) ? args.steps : [];
            this.planSteps = rawSteps
                .filter((step: any) => step && typeof step.id === 'string' && typeof step.title === 'string')
                .map((step: any, index: number) => ({
                    id: step.id,
                    title: step.title,
                    status: this.currentMode === 'agent' && index === 0 ? 'in_progress' : 'pending',
                }));
            this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
            return true;
        }

        if (normalized === 'update_plan_step' || normalized === 'updateplanstep') {
            const stepId = typeof args.step_id === 'string' ? args.step_id : typeof args.stepId === 'string' ? args.stepId : '';
            const status = typeof args.status === 'string' ? args.status : '';
            const step = this.planSteps.find(s => s.id === stepId);
            if (step && (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'failed')) {
                step.status = status;
                this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
            }
            return true;
        }

        return false;
    }

    private classifyTool(name: string): WorkingActionType {
        const normalized = this.normalizeToolName(name);
        if (normalized.includes('read') || normalized.includes('view')) { return 'read'; }
        if (normalized.includes('search') || normalized.includes('grep') || normalized.includes('find') || normalized.includes('glob')) { return 'search'; }
        if (normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) { return 'edit'; }
        if (normalized.includes('create') || normalized.includes('write')) { return 'create'; }
        if (normalized.includes('run') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('bash')) { return 'run'; }
        return 'other';
    }

    private describeToolAction(toolName: string, data: any, toolMeta?: ToolCallMetadata): string {
        if (toolMeta?.toolTitle?.trim()) {
            return this.shortenPathsInText(this.summarizeUiText(toolMeta.toolTitle.trim(), 88));
        }

        const args = this.readToolArgs(data, toolMeta);
        const normalized = this.normalizeToolName(toolName);

        if (normalized === 'glob') {
            const pattern = this.readStringArg(args, ['pattern', 'query', 'glob']);
            return pattern ? `Find files matching ${this.summarizeUiText(pattern, 60)}` : 'Find matching files';
        }
        if (normalized.includes('view') || normalized.includes('read')) {
            const filePath = this.readStringArg(args, ['filePath', 'path', 'file']);
            return filePath ? `Open ${this.shortPath(filePath)}` : 'Open file';
        }
        if (normalized.includes('grep') || normalized.includes('search') || normalized.includes('find')) {
            const query = this.readStringArg(args, ['query', 'pattern', 'text']);
            return query ? `Search for ${this.summarizeUiText(query, 60)}` : 'Search workspace';
        }
        if (normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) {
            const filePath = this.readStringArg(args, ['filePath', 'path', 'file']);
            return filePath ? `Edit ${this.shortPath(filePath)}` : 'Editing file...';
        }
        if (normalized.includes('create') || normalized.includes('write')) {
            const filePath = this.readStringArg(args, ['filePath', 'path', 'file']);
            return filePath ? `Create ${this.shortPath(filePath)}` : 'Create file';
        }
        if (normalized.includes('run') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('bash')) {
            const goal = this.readStringArg(args, ['goal', 'label', 'title', 'description']);
            const explanation = this.readStringArg(args, ['explanation', 'reason']);
            if (goal) {
                return `Run ${this.summarizeUiText(goal, 68)}`;
            }
            if (explanation) {
                return `Run ${this.summarizeUiText(explanation, 68)}`;
            }
            return 'Run command';
        }

        return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    private describeToolDetail(toolName: string, data: any, actionType: WorkingActionType, repeatCount: number, toolMeta?: ToolCallMetadata): string | undefined {
        const args = this.readToolArgs(data, toolMeta);
        const normalized = this.normalizeToolName(toolName);
        const details: string[] = [];
        const startLine = this.readNumberArg(args, ['startLine', 'start_line', 'fromLine', 'from_line', 'line']);
        const endLine = this.readNumberArg(args, ['endLine', 'end_line', 'toLine', 'to_line']);

        if (toolMeta?.intentionSummary?.trim()) {
            details.push(this.shortenPathsInText(this.summarizeUiText(toolMeta.intentionSummary.trim(), 132)));
        } else if (actionType === 'run') {
            const goal = this.readStringArg(args, ['goal', 'label', 'title', 'description']);
            const explanation = this.readStringArg(args, ['explanation', 'reason']);
            const runSummary = goal || explanation;
            if (runSummary) {
                details.push(this.shortenPathsInText(this.summarizeUiText(runSummary, 132)));
            }
        }

        if ((normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) && startLine && endLine && endLine >= startLine) {
            details.push(`Rewriting lines ${startLine}-${endLine}`);
        } else if ((normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) && startLine) {
            details.push(`Editing near line ${startLine}`);
        }

        if (repeatCount > 1) {
            if (actionType === 'edit') {
                details.push(`${repeatCount} edit passes`);
            } else if (actionType === 'read') {
                details.push(`${repeatCount} reads`);
            } else if (actionType === 'search') {
                details.push(`${repeatCount} searches`);
            } else {
                details.push(`${repeatCount} passes`);
            }
        }

        return details.length > 0 ? details.join(' • ') : undefined;
    }

    private summarizeUiText(text: string, maxLength: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return '';
        }

        if (normalized.length <= maxLength) {
            return normalized;
        }

        return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
    }

    private describeProgressDetail(progressMessage: string, repeatCount: number): string {
        const trimmed = this.shortenPathsInText(progressMessage.replace(/\s+/g, ' ').trim());
        if (repeatCount > 1) {
            return `${trimmed} • ${repeatCount} edit passes`;
        }
        return trimmed;
    }

    private describePartialOutputDetail(partialOutput: string, repeatCount: number): string | undefined {
        const firstLine = partialOutput
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(line => this.isMeaningfulUiDetail(line));

        if (!firstLine) {
            return undefined;
        }

        const normalized = this.shortenPathsInText(firstLine.length > 140 ? firstLine.slice(0, 137) + '...' : firstLine);
        if (repeatCount > 1) {
            return `${normalized} • ${repeatCount} edit passes`;
        }
        return normalized;
    }

    private normalizeToolName(toolName: string): string {
        return toolName.toLowerCase().replace(/[\s-]+/g, '_');
    }

    private readToolArgs(data: any, toolMeta?: ToolCallMetadata): Record<string, unknown> {
        const args = data?.arguments;
        if (!args) { return toolMeta?.arguments || {}; }
        if (typeof args === 'string') {
            try {
                return { ...(toolMeta?.arguments || {}), ...JSON.parse(args) };
            } catch {
                return toolMeta?.arguments || {};
            }
        }
        return typeof args === 'object' ? { ...(toolMeta?.arguments || {}), ...args } : (toolMeta?.arguments || {});
    }

    private describeToolCompletionPatch(data: any, entry: WorkingBlockActionEntry | undefined): { text?: string; detail?: string; filePath?: string } {
        const patch: { text?: string; detail?: string; filePath?: string } = {};
        if (!entry) {
            return patch;
        }

        // Only extract detail from tool output for action types where it's meaningful.
        // For read/review/search the label already describes what happened; showing the
        // first line of file content ("import os", "{") is noisy, not helpful.
        const showOutputDetail = entry.actionType === 'edit' || entry.actionType === 'create' || entry.actionType === 'run' || entry.actionType === 'other';

        if (data?.success === false) {
            // Always show error detail
            const detail = this.extractCompletionDetail(data);
            if (detail) {
                patch.detail = detail;
            }
        } else if (showOutputDetail) {
            const detail = this.extractCompletionDetail(data);
            if (detail) {
                patch.detail = entry.repeatCount && entry.repeatCount > 1 && !/\bpasses\b/i.test(detail)
                    ? `${detail} • ${entry.repeatCount} ${entry.actionType === 'edit' ? 'edit passes' : 'passes'}`
                    : detail;
            } else {
                if (entry.actionType === 'edit') {
                    patch.detail = 'File updated';
                } else if (entry.actionType === 'create') {
                    patch.detail = 'File created';
                }
            }
        } else if (data?.success !== false) {
            // For read/search: clear any noisy detail that was set during progress
            patch.detail = '';
        }

        const resultPath = this.extractCompletionFilePath(data);
        if (resultPath) {
            patch.filePath = resultPath;
            patch.text = entry.actionType === 'create'
                ? `Create ${this.shortPath(resultPath)}`
                : entry.actionType === 'edit'
                    ? `Edit ${this.shortPath(resultPath)}`
                    : entry.text;
            entry.filePath = resultPath;
        }

        if (patch.detail) {
            entry.detail = patch.detail;
        }
        if (patch.text) {
            entry.text = patch.text;
        }

        return patch;
    }

    private extractCompletionDetail(data: any): string | undefined {
        const detailedContent = typeof data?.result?.detailedContent === 'string' ? data.result.detailedContent : '';
        const content = typeof data?.result?.content === 'string' ? data.result.content : '';
        const errorMessage = typeof data?.error?.message === 'string' ? data.error.message : '';
        const blockText = Array.isArray(data?.result?.contents)
            ? data.result.contents
                .map((block: any) => {
                    if (block?.type === 'terminal' || block?.type === 'text') {
                        return typeof block.text === 'string' ? block.text : '';
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n')
            : '';

        const source = detailedContent || blockText || content || errorMessage;
        if (!source) {
            return undefined;
        }

        const line = source
            .split(/\r?\n/)
            .map((raw: string) => raw.trim())
            .find((raw: string) => this.isMeaningfulUiDetail(raw));

        if (!line) {
            return undefined;
        }

        const trimmedLine = line.length > 160 ? `${line.slice(0, 157)}...` : line;
        return this.shortenPathsInText(trimmedLine);
    }

    private isMeaningfulUiDetail(line: string): boolean {
        const normalized = line.trim();
        if (!normalized) {
            return false;
        }

        // Too short to be meaningful (single chars like '{', '[', etc.)
        if (normalized.length < 4) {
            return false;
        }

        // Diff / patch markers
        if (/^[-+@#*=]{2,}/.test(normalized) || /^diff\b/i.test(normalized)) {
            return false;
        }

        // Diff content lines: single +/- followed by code
        if (/^[+-][a-zA-Z#\s{}\[\]()\/"']/.test(normalized)) {
            return false;
        }

        // Git index lines
        if (/^index\s+[0-9a-f]/i.test(normalized)) {
            return false;
        }

        if (/^(create|new|deleted) file mode \d+$/i.test(normalized)) {
            return false;
        }

        if (/^(rename from|rename to)\b/i.test(normalized)) {
            return false;
        }

        if (/^(---|\+\+\+)\s/.test(normalized)) {
            return false;
        }

        if (/^@@\s.*\s@@/.test(normalized)) {
            return false;
        }

        // Code-like lines that don't explain anything to the user
        if (/^(import |from |require\(|#include |using |package |namespace )/.test(normalized)) {
            return false;
        }

        // Comment-only lines
        if (/^(#!?\/|#\s|\*\s|\/\*|\/\/)/.test(normalized)) {
            return false;
        }

        // Lines that are just a bracket, brace, paren, or trivial punctuation
        if (/^[{}\[\]();:,]+$/.test(normalized)) {
            return false;
        }

        // Hex-only hashes (git SHAs, etc.)
        if (/^[0-9a-f]{7,}$/i.test(normalized)) {
            return false;
        }

        // JSON key-value that's just structural (e.g. '"name": "value"')
        if (/^"[^"]+"\s*:\s*/.test(normalized) && normalized.length < 60) {
            return false;
        }

        return true;
    }

    private extractCompletionFilePath(data: any): string | undefined {
        const result = data?.result;
        const directPath = typeof result?.path === 'string' ? result.path.trim() : '';
        if (directPath) {
            return directPath;
        }

        if (Array.isArray(result?.contents)) {
            for (const block of result.contents) {
                if (block?.type === 'resource' && typeof block.uri === 'string' && block.uri.trim()) {
                    return block.uri.trim();
                }
            }
        }

        return undefined;
    }

    private describeBackgroundTasks(backgroundTasks: any): string {
        const agentDescriptions = Array.isArray(backgroundTasks?.agents)
            ? backgroundTasks.agents
                .map((agent: any) => typeof agent?.description === 'string' ? agent.description.trim() : '')
                .filter(Boolean)
            : [];
        const shellDescriptions = Array.isArray(backgroundTasks?.shells)
            ? backgroundTasks.shells
                .map((shell: any) => typeof shell?.description === 'string' ? shell.description.trim() : '')
                .filter(Boolean)
            : [];

        const descriptions = [...agentDescriptions, ...shellDescriptions].slice(0, 2);
        if (descriptions.length === 0) {
            return '';
        }

        return descriptions.length === 1
            ? `Background task still running: ${descriptions[0]}`
            : `Background tasks still running: ${descriptions.join(' • ')}`;
    }

    private describePendingWaitStatus(): string {
        if (this.lastBackgroundTaskSummary) {
            return this.lastBackgroundTaskSummary;
        }

        if (this.toolEntryIds.size > 0) {
            return 'Tool execution is still in progress inside Copilot CLI';
        }

        if (this.workingBlock?.entries.some((entry) => entry.kind === 'action' && entry.status === 'running')) {
            return 'Waiting for the active tool step to finish';
        }

        if (this.workingBlock?.entries.some((entry) => entry.kind === 'action')) {
            return 'Waiting for Copilot CLI to emit the final assistant response';
        }

        return 'Copilot CLI is still working';
    }

    private startLongWaitStatusHeartbeat(): void {
        this.stopLongWaitStatusHeartbeat();
        this.lastLongWaitStatus = '';
        this.longWaitStatusTimer = setInterval(() => {
            if (!this.running) {
                return;
            }

            const idleMs = Date.now() - this.lastActivityTs;
            if (idleMs < CopilotSdkRuntime.LONG_WAIT_INACTIVITY_MS) {
                this.lastLongWaitStatus = '';
                return;
            }

            const status = this.describeLongWaitStatus(idleMs, Date.now() - this.runStartTs);
            if (!status || status === this.lastLongWaitStatus) {
                return;
            }

            this.lastLongWaitStatus = status;
            this.callbacks.sendToWebview({ type: 'setStatus', status });
        }, CopilotSdkRuntime.LONG_WAIT_STATUS_INTERVAL_MS);
    }

    private stopLongWaitStatusHeartbeat(): void {
        if (this.longWaitStatusTimer) {
            clearInterval(this.longWaitStatusTimer);
            this.longWaitStatusTimer = undefined;
        }
        this.lastLongWaitStatus = '';
    }

    private describeLongWaitStatus(idleMs: number, totalRunMs: number): string {
        const baseStatus = this.describePendingWaitStatus();
        const idleSeconds = Math.max(1, Math.round(idleMs / 1000));
        const totalSeconds = Math.max(1, Math.round(totalRunMs / 1000));

        if (baseStatus === 'Copilot CLI is still working') {
            return `Waiting on Copilot CLI / model provider (${idleSeconds}s since the last update, ${totalSeconds}s total). This can happen during provider retries or rate limiting.`;
        }

        return `${baseStatus} (${idleSeconds}s since the last update)`;
    }

    private shouldLogSdkEvents(): boolean {
        return Boolean(getSetting<boolean>('copilotCli.logSdkEvents'));
    }

    private formatSdkEventForLog(event: any): string {
        const type = String(event?.type || 'unknown');
        const data = event?.data || {};

        switch (type) {
            case 'assistant.message_delta':
            case 'assistant.reasoning_delta': {
                const delta = typeof data?.deltaContent === 'string' ? data.deltaContent : '';
                return `${type} len=${delta.length} preview=${this.previewText(delta)}`;
            }
            case 'assistant.message': {
                const content = typeof data?.content === 'string' ? data.content : '';
                const toolCount = Array.isArray(data?.toolRequests) ? data.toolRequests.length : 0;
                return `${type} len=${content.length} toolRequests=${toolCount} preview=${this.previewText(content)}`;
            }
            case 'tool.execution_start':
                return `${type} tool=${data?.toolName || 'unknown'} args=${this.previewJson(data?.arguments)}`;
            case 'tool.execution_progress':
                return `${type} toolCallId=${data?.toolCallId || 'unknown'} progress=${this.previewText(String(data?.progressMessage || ''))}`;
            case 'tool.execution_partial_result':
                return `${type} toolCallId=${data?.toolCallId || 'unknown'} output=${this.previewText(String(data?.partialOutput || ''))}`;
            case 'tool.execution_complete':
                return `${type} toolCallId=${data?.toolCallId || 'unknown'} success=${Boolean(data?.success)} result=${this.previewText(String(data?.result?.detailedContent || data?.result?.content || data?.error?.message || ''))}`;
            case 'session.idle':
                return `${type} background=${this.previewJson(data?.backgroundTasks)}`;
            default:
                return `${type} data=${this.previewJson(data)}`;
        }
    }

    private previewText(value: string, maxLength = 160): string {
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (!normalized) {
            return '""';
        }
        const preview = normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
        return JSON.stringify(preview);
    }

    private previewJson(value: unknown, maxLength = 240): string {
        try {
            const raw = JSON.stringify(value);
            if (!raw) {
                return 'null';
            }
            return raw.length > maxLength ? `${raw.slice(0, maxLength - 3)}...` : raw;
        } catch {
            return '"[unserializable]"';
        }
    }

    private readStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = args[key];
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return undefined;
    }

    private readNumberArg(args: Record<string, unknown>, keys: string[]): number | undefined {
        for (const key of keys) {
            const value = args[key];
            if (typeof value === 'number' && Number.isFinite(value)) {
                return value;
            }
            if (typeof value === 'string' && value.trim()) {
                const parsed = Number(value.trim());
                if (Number.isFinite(parsed)) {
                    return parsed;
                }
            }
        }
        return undefined;
    }

    private hasCliModelArg(args: string[]): boolean {
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg === '--model' || arg === '-m') {
                return true;
            }
            if (arg.startsWith('--model=')) {
                return true;
            }
        }
        return false;
    }

    private shortPath(filePath: string): string {
        const normalized = filePath.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length >= 2) {
            return parts.slice(-2).join('/');
        }
        return path.basename(filePath) || filePath;
    }

    /** Replace absolute file paths in free-form text with their last 2 segments. */
    private shortenPathsInText(text: string): string {
        // Match Windows paths  (C:\foo\bar\...) and Unix paths (/home/user/...)
        return text.replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|opt|usr|etc|mnt)\/)[^\s"'`;,)}\]]+/g, (match) => {
            return this.shortPath(match);
        });
    }

    private disconnectSession(): void {
        for (const unsub of this.unsubscribers) { unsub(); }
        this.unsubscribers = [];
        this.session?.disconnect().catch(() => {});
        this.session = undefined;
        this.toolEntryIds.clear();
    }
}
