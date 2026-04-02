/**
 * Copilot SDK Runtime — implements AgentRuntime using @github/copilot-sdk.
 *
 * Spawns the Copilot CLI in server mode via the SDK, creates sessions,
 * and streams assistant responses + tool events back to the webview.
 */
import * as vscode from 'vscode';
import { CopilotClient, CopilotSession, approveAll } from '@github/copilot-sdk';
import type { PermissionRequest, PermissionRequestResult, SessionConfig } from '@github/copilot-sdk';
import * as path from 'path';

/** ProviderConfig is defined in SDK types but not re-exported; extract from SessionConfig. */
type ProviderConfig = NonNullable<SessionConfig['provider']>;
import { AgentRuntime, AgentCallbacks } from './agentRuntime';
import { getSetting } from './config';
import { TokenTracker } from './tokenTracker';
import {
    ChatMessage,
    ExtensionMessage,
    RuntimeSessionState,
    WorkingBlock,
    WorkingBlockActionEntry,
    WorkingActionType,
} from './types';

interface PendingPermission {
    actionId: string;
    resolve: (result: PermissionRequestResult) => void;
}

export class CopilotSdkRuntime implements AgentRuntime {
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

    constructor(
        private readonly callbacks: AgentCallbacks,
        private readonly log?: (msg: string) => void,
        private readonly tokenTracker?: TokenTracker,
    ) {}

    isRunning(): boolean {
        return this.running;
    }

    getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    setMessages(messages: ChatMessage[]): void {
        this.messages = [...messages];
    }

    clearMessages(): void {
        this.messages = [];
        this.disconnectSession();
        this.sessionId = undefined;
        this.toolEntryIds.clear();
    }

    cancel(): void {
        if (!this.running) { return; }
        this.running = false;
        // Abort the current prompt
        this.session?.abort().catch(() => {});
        // Reject any pending permission prompts
        for (const [, pending] of this.pendingPermissions) {
            pending.resolve({ kind: 'denied-interactively-by-user' });
        }
        this.pendingPermissions.clear();
    }

    resolveConfirmation(actionId: string, approved: boolean, _allowSession?: boolean): void {
        const pending = this.pendingPermissions.get(actionId);
        if (!pending) { return; }
        pending.resolve(
            approved
                ? { kind: 'approved' }
                : { kind: 'denied-interactively-by-user' }
        );
        this.pendingPermissions.delete(actionId);
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

    async run(text: string, images?: string[], files?: { name: string; content: string }[], displayText?: string): Promise<void> {
        this.running = true;
        this.assistantText = '';
        this.assistantStarted = false;
        this.workingBlock = undefined;
        this.workingActionCounter = 0;
        this.runStartTs = Date.now();
        this.toolEntryIds.clear();

        this.messages.push({
            role: 'user',
            content: text,
            displayText,
        });

        // Match the local runtime: surface an immediate thinking state even before
        // the CLI emits reasoning/tool events.
        this.callbacks.sendToWebview({ type: 'setStatus', status: 'Thinking...' });

        try {
            await this.ensureSession();
            if (!this.session) {
                throw new Error('Copilot CLI session failed to initialize.');
            }

            this.log?.(`[copilot-sdk] Sending prompt (${text.length} chars)`);

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
            const response = await this.session.sendAndWait({
                prompt: text,
                ...(attachments.length > 0 ? { attachments } : {}),
            });

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

        const cliPath = getSetting<string>('copilotCli.path') || 'copilot';
        const additionalArgs = [...(getSetting<string[]>('copilotCli.additionalArgs') || [])];
        const configuredModel = getSetting<string>('copilotCli.model') || '';

        if (configuredModel && !this.hasCliModelArg(additionalArgs)) {
            additionalArgs.push('--model', configuredModel);
        }

        this.log?.(`[copilot-sdk] Creating client (cliPath=${cliPath}, args=${JSON.stringify(additionalArgs)})`);

        this.client = new CopilotClient({
            cliPath,
            cliArgs: additionalArgs,
            useStdio: true,
        });

        // autoStart is true by default — createSession() will call start() internally.
        // We do an explicit start() here so errors surface early with a clear message.
        try {
            await this.client.start();
        } catch (err: any) {
            this.client = undefined;
            const msg = err?.message || String(err);
            throw new Error(`Copilot CLI failed to start (cliPath=${cliPath}): ${msg}`);
        }
        this.log?.('[copilot-sdk] Client started');
        return this.client;
    }

    private async ensureSession(): Promise<void> {
        if (this.session) { return; }

        const client = await this.ensureClient();
        const model = getSetting<string>('copilotCli.model') || undefined;
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        // Build BYOK provider config if configured
        const provider = this.buildProviderConfig();

        const sessionConfig: SessionConfig = {
            ...(model ? { model } : {}),
            streaming: true,
            ...(cwd ? { workingDirectory: cwd } : {}),
            ...(provider ? { provider } : {}),
            onPermissionRequest: (request, _invocation) => this.handlePermission(request),
        };

        this.log?.(`[copilot-sdk] Creating session (model=${model || 'default'})`);

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

        // Streaming text deltas
        this.unsubscribers.push(
            this.session.on('assistant.message_delta', (event: any) => {
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
                const delta = event.data?.deltaContent || '';
                if (delta) {
                    this.callbacks.sendToWebview({ type: 'narrationText', text: delta });
                }
            })
        );

        // Tool execution started
        this.unsubscribers.push(
            this.session.on('tool.execution_start', (event: any) => {
                const toolName = event.data?.toolName || 'tool';
                const toolCallId = event.data?.toolCallId as string | undefined;
                this.log?.(`[copilot-sdk] Tool started: ${toolName}`);

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

                const entry = this.createToolEntry(toolName, event.data);
                if (toolCallId) {
                    this.toolEntryIds.set(toolCallId, entry.id);
                }
                this.callbacks.sendToWebview({
                    type: 'workingActionAdded',
                    blockId: this.workingBlock!.id,
                    entry,
                });
            })
        );

        // Tool execution completed
        this.unsubscribers.push(
            this.session.on('tool.execution_complete', (event: any) => {
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

                if (this.workingBlock) {
                    this.callbacks.sendToWebview({
                        type: 'workingActionUpdated',
                        blockId: this.workingBlock.id,
                        entryId,
                        status: event.data?.success === false ? 'error' : 'done',
                    });
                }
            })
        );
    }

    private buildProviderConfig(): ProviderConfig | undefined {
        const baseUrl = getSetting<string>('copilotCli.providerBaseUrl');
        if (!baseUrl) { return undefined; }

        const type = (getSetting<string>('copilotCli.providerType') || 'openai') as 'openai' | 'azure' | 'anthropic';
        const apiKey = getSetting<string>('copilotCli.providerApiKey') || undefined;
        const bearerToken = getSetting<string>('copilotCli.providerBearerToken') || undefined;
        const wireApi = (getSetting<string>('copilotCli.providerWireApi') || undefined) as 'completions' | 'responses' | undefined;
        const azureApiVersion = getSetting<string>('copilotCli.providerAzureApiVersion') || undefined;

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
        const autoApproveWrites = getSetting<boolean>('copilotCli.autoApproveWrites') || false;
        const autoApproveTerminal = getSetting<boolean>('copilotCli.autoApproveTerminal') || false;

        // Auto-approve reads always
        if (request.kind === 'read') {
            return Promise.resolve({ kind: 'approved' });
        }

        // Auto-approve writes if configured
        if (request.kind === 'write' && autoApproveWrites) {
            return Promise.resolve({ kind: 'approved' });
        }

        // Auto-approve shell if configured
        if (request.kind === 'shell' && autoApproveTerminal) {
            return Promise.resolve({ kind: 'approved' });
        }

        // For everything else: show confirmation in webview
        const actionId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const description = this.describePermission(request);

        return new Promise<PermissionRequestResult>((resolve) => {
            this.pendingPermissions.set(actionId, { actionId, resolve });
            this.callbacks.sendToWebview({
                type: 'confirmAction',
                actionId,
                description,
                category: request.kind,
            });
        });
    }

    private describePermission(request: PermissionRequest): string {
        switch (request.kind) {
            case 'write':
                return `Write file: ${(request as any).fileName || 'unknown'}`;
            case 'shell':
                return `Run command: ${(request as any).fullCommandText || 'unknown'}`;
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

    private startWorkingBlock(title: string): void {
        const block: WorkingBlock = {
            id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            status: 'in_progress',
            title,
            entries: [],
            startedAt: Date.now(),
        };
        this.workingBlock = block;
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
    }

    private createToolEntry(toolName: string, data: any): WorkingBlockActionEntry {
        this.workingActionCounter++;
        const entryId = `tool_${toolName}_${this.workingActionCounter}`;
        const actionType = this.classifyTool(toolName);

        const entry: WorkingBlockActionEntry = {
            id: entryId,
            kind: 'action',
            text: this.describeToolAction(toolName, data),
            createdAt: Date.now(),
            actionType,
            status: 'running',
            toolName,
        };

        // Track in working block entries
        if (this.workingBlock) {
            this.workingBlock.entries.push(entry);
        }

        return entry;
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

    private classifyTool(name: string): WorkingActionType {
        const normalized = this.normalizeToolName(name);
        if (normalized.includes('read') || normalized.includes('view')) { return 'read'; }
        if (normalized.includes('search') || normalized.includes('grep') || normalized.includes('find') || normalized.includes('glob')) { return 'search'; }
        if (normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) { return 'edit'; }
        if (normalized.includes('create') || normalized.includes('write')) { return 'create'; }
        if (normalized.includes('run') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('bash')) { return 'run'; }
        return 'other';
    }

    private describeToolAction(toolName: string, data: any): string {
        const args = data?.arguments || {};
        const normalized = this.normalizeToolName(toolName);

        if (normalized === 'glob') {
            const pattern = this.readStringArg(args, ['pattern', 'query', 'glob']);
            return pattern ? `Find files matching ${pattern}` : 'Find matching files';
        }
        if (normalized.includes('view') || normalized.includes('read')) {
            const filePath = this.readStringArg(args, ['filePath', 'path', 'file']);
            return filePath ? `Open ${this.shortPath(filePath)}` : 'Open file';
        }
        if (normalized.includes('grep') || normalized.includes('search') || normalized.includes('find')) {
            const query = this.readStringArg(args, ['query', 'pattern', 'text']);
            return query ? `Search for ${query}` : 'Search workspace';
        }
        if (normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) {
            const filePath = this.readStringArg(args, ['filePath', 'path', 'file']);
            return filePath ? `Edit ${this.shortPath(filePath)}` : 'Edit files';
        }
        if (normalized.includes('create') || normalized.includes('write')) {
            const filePath = this.readStringArg(args, ['filePath', 'path', 'file']);
            return filePath ? `Create ${this.shortPath(filePath)}` : 'Create file';
        }
        if (normalized.includes('run') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('bash')) {
            const command = this.readStringArg(args, ['command', 'cmd', 'script']);
            return command ? `Run ${command}` : 'Run command';
        }

        return toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    private normalizeToolName(toolName: string): string {
        return toolName.toLowerCase().replace(/[\s-]+/g, '_');
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

    private disconnectSession(): void {
        for (const unsub of this.unsubscribers) { unsub(); }
        this.unsubscribers = [];
        this.session?.disconnect().catch(() => {});
        this.session = undefined;
        this.toolEntryIds.clear();
    }
}
