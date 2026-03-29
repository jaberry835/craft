import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from './agentRuntime';
import { getSetting } from './config';
import {
    AgentPlanStep,
    ChatMessage,
    ContentPart,
    ExtensionMessage,
    RuntimeSessionState,
    WorkingActionType,
    WorkingBlock,
    WorkingBlockActionEntry
} from './types';

interface RuntimeCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: number | string | null;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
}

interface PendingPermissionRequest {
    requestId: number | string;
    options: Array<{ optionId: string; name: string; kind: string }>;
    category?: string;
}

interface ActiveToolCall {
    actionEntry: WorkingBlockActionEntry;
    blockId: string;
    status: 'running' | 'done' | 'error';
}

type AcpContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text: string } };

const ACP_PROTOCOL_VERSION = 1;

export class CopilotCliAcpRuntime implements AgentRuntime {
    private proc?: cp.ChildProcessWithoutNullStreams;
    private requestId = 1;
    private pendingRequests = new Map<number | string, PendingRequest>();
    private pendingPermissions = new Map<string, PendingPermissionRequest>();
    private sessionApprovedCategories = new Set<string>();
    private messages: ChatMessage[] = [];
    private running = false;
    private connected = false;
    private sessionId?: string;
    private pendingPromptId?: number;
    private stdoutBuffer = '';
    private messageProcessing: Promise<void> = Promise.resolve();
    private assistantText = '';
    private assistantStarted = false;
    private pendingThoughtText = '';
    private sawAssistantOutputSinceLastToolPhase = false;
    private workingBlock?: WorkingBlock;
    private allWorkingPhases: WorkingBlock[] = [];
    private activeToolCalls = new Map<string, ActiveToolCall>();
    private assistantTextOffset = 0;
    private currentPlanIds: string[] = [];
    private promptCapabilities = { image: false, embeddedContext: false };
    private sessionCapabilities: { loadSession: boolean } = { loadSession: false };
    private spawnError?: Error;

    constructor(
        private readonly callbacks: RuntimeCallbacks,
        private readonly log?: (msg: string) => void
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
        this.sessionId = undefined;
        this.sessionApprovedCategories.clear();
    }

    cancel(): void {
        if (!this.running) {
            return;
        }
        this.running = false;
        for (const [actionId, pending] of this.pendingPermissions) {
            this.sendResponse(pending.requestId, { outcome: { outcome: 'cancelled' } });
            this.pendingPermissions.delete(actionId);
        }
        if (this.sessionId) {
            this.sendNotification('session/cancel', { sessionId: this.sessionId });
        }
    }

    resolveConfirmation(actionId: string, approved: boolean, allowSession?: boolean): void {
        const pending = this.pendingPermissions.get(actionId);
        if (!pending) {
            return;
        }
        const preferredKinds = approved
            ? [allowSession ? 'allow_always' : 'allow_once', 'allow_once', 'allow_always']
            : [allowSession ? 'reject_always' : 'reject_once', 'reject_once', 'reject_always'];
        const option = preferredKinds
            .map(kind => pending.options.find(candidate => candidate.kind === kind))
            .find(Boolean);
        if (!option) {
            this.sendResponse(pending.requestId, { outcome: { outcome: 'cancelled' } });
        } else {
            this.sendResponse(pending.requestId, {
                outcome: {
                    outcome: 'selected',
                    optionId: option.optionId
                }
            });
        }
        this.pendingPermissions.delete(actionId);

        // Track session-level approval and auto-resolve other pending requests
        if (approved && allowSession && pending.category) {
            this.sessionApprovedCategories.add(pending.category);
            // Auto-approve any other pending requests of the same category
            for (const [otherId, otherPending] of this.pendingPermissions) {
                if (otherPending.category === pending.category) {
                    const autoOption = ['allow_always', 'allow_once']
                        .map(kind => otherPending.options.find(o => o.kind === kind))
                        .find(Boolean);
                    if (autoOption) {
                        this.sendResponse(otherPending.requestId, {
                            outcome: { outcome: 'selected', optionId: autoOption.optionId }
                        });
                        this.pendingPermissions.delete(otherId);
                        // Dismiss the dialog in the webview
                        this.callbacks.sendToWebview({
                            type: 'confirmAction',
                            actionId: otherId,
                            description: '',
                            category: '__dismiss__'
                        });
                    }
                }
            }
        }
    }

    getSessionState(): RuntimeSessionState | undefined {
        return {
            provider: 'copilot-cli',
            backendSessionId: this.sessionId
        };
    }

    async restoreSessionState(state: RuntimeSessionState | undefined): Promise<void> {
        if (!state || state.provider !== 'copilot-cli' || !state.backendSessionId) {
            this.sessionId = undefined;
            return;
        }
        await this.ensureConnected();
        if (!this.sessionCapabilities.loadSession) {
            this.sessionId = undefined;
            return;
        }
        try {
            await this.request('session/load', {
                sessionId: state.backendSessionId,
                cwd: this.getWorkspaceRoot(),
                mcpServers: []
            });
            this.sessionId = state.backendSessionId;
        } catch (err) {
            this.log?.(`ACP session/load failed, creating a fresh session instead: ${String(err)}`);
            this.sessionId = undefined;
        }
    }

    async run(text: string, images?: string[], files?: { name: string; content: string }[], displayText?: string): Promise<void> {
        this.running = true;
        this.assistantText = '';
        this.assistantStarted = false;
        this.pendingThoughtText = '';
        this.sawAssistantOutputSinceLastToolPhase = false;
        this.workingBlock = undefined;
        this.allWorkingPhases = [];
        this.activeToolCalls.clear();
        this.assistantTextOffset = 0;
        this.currentPlanIds = [];

        this.messages.push({
            role: 'user',
            content: this.toChatContent(text, images),
            displayText
        });

        await this.ensureConnected();
        await this.ensureSession();

        const content = this.buildPromptContent(text, images, files);

        try {
            const promptId = this.requestId++;
            this.pendingPromptId = promptId;
            const response = await this.request('session/prompt', {
                sessionId: this.sessionId,
                prompt: content
            }, promptId);
            await this.drainPendingMessages();
            // Force-complete any open working block before flushing final thoughts
            if (this.workingBlock) {
                this.forceCompleteWorkingBlock();
            }
            if (this.pendingThoughtText.trim()) {
                if (!this.sawAssistantOutputSinceLastToolPhase) {
                    this.flushPendingThoughtAsAssistant();
                } else {
                    this.flushPendingThoughtAsNarration();
                }
            }
            if (this.assistantStarted) {
                this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
                this.assistantStarted = false;
            }
            // Only store trailing assistant text (after last working phase) as content;
            // per-phase segments are stored on each WorkingBlock.assistantTextBefore.
            const finalContent = this.allWorkingPhases.length > 0
                ? this.assistantText.substring(this.assistantTextOffset).trim()
                : this.assistantText.trim();
            if (finalContent || this.allWorkingPhases.length > 0) {
                const assistantMsg: ChatMessage = { role: 'assistant', content: finalContent };
                if (this.allWorkingPhases.length > 0) {
                    assistantMsg.workingPhases = [...this.allWorkingPhases];
                }
                this.messages.push(assistantMsg);
            }
            if (response?.stopReason === 'cancelled') {
                return;
            }
        } finally {
            this.pendingPromptId = undefined;
            this.running = false;
            this.callbacks.sendToWebview({ type: 'agentDone' });
        }
    }

    dispose(): void {
        for (const pending of this.pendingRequests.values()) {
            pending.reject(new Error('Copilot CLI ACP runtime disposed.'));
        }
        this.pendingRequests.clear();
        if (this.proc && !this.proc.killed) {
            this.proc.kill();
        }
        this.proc = undefined;
        this.cleanupStrayNulFile();
    }

    private cleanupStrayNulFile(): void {
        if (process.platform !== 'win32') {
            return;
        }
        try {
            const nulPath = path.join(this.getWorkspaceRoot(), 'nul');
            if (fs.existsSync(nulPath) && fs.statSync(nulPath).isFile()) {
                fs.unlinkSync(nulPath);
                this.log?.('Removed stray "nul" file left by Copilot CLI.');
            }
        } catch {
            // Best-effort; ignore errors.
        }
    }

    private async ensureConnected(): Promise<void> {
        if (this.connected) {
            return;
        }

        this.log?.('Starting Copilot CLI...');
        const cliPath = getSetting<string>('copilotCli.path') || 'copilot';
        const additionalArgs = getSetting<string[]>('copilotCli.additionalArgs') || [];
        const env = { ...process.env } as NodeJS.ProcessEnv;
        const copilotHome = getSetting<string>('copilotCli.home');
        const model = getSetting<string>('copilotCli.model');

        // Prevent Copilot CLI telemetry exporters from inheriting a file/console
        // sink that can materialize stray trace artifacts in the workspace.
        delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
        delete env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
        delete env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
        delete env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
        delete env.OTEL_EXPORTER_OTLP_PROTOCOL;
        delete env.OTEL_TRACES_EXPORTER;
        delete env.OTEL_METRICS_EXPORTER;
        delete env.OTEL_LOGS_EXPORTER;
        env.OTEL_SDK_DISABLED = 'true';
        env.OTEL_TRACES_EXPORTER = 'none';
        env.OTEL_METRICS_EXPORTER = 'none';
        env.OTEL_LOGS_EXPORTER = 'none';

        if (copilotHome) {
            env.COPILOT_HOME = copilotHome;
        }
        if (model) {
            env.COPILOT_MODEL = model;
        }

        const spawnSpec = this.resolveSpawnSpec(cliPath, additionalArgs);

        this.proc = cp.spawn(spawnSpec.command, spawnSpec.args, {
            cwd: this.getWorkspaceRoot(),
            env,
            stdio: 'pipe'
        });

        this.spawnError = undefined;
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (chunk: string) => this.log?.(`[copilot-cli] ${chunk.trim()}`));
        this.proc.on('error', (err) => {
            this.spawnError = err;
            const message = `Failed to start Copilot CLI: ${err.message}`;
            this.connected = false;
            this.callbacks.sendToWebview({ type: 'error', message });
            for (const pending of this.pendingRequests.values()) {
                pending.reject(new Error(message));
            }
            this.pendingRequests.clear();
        });
        this.proc.on('exit', (code, signal) => {
            const message = `Copilot CLI exited (code=${String(code)}, signal=${String(signal)})`;
            this.connected = false;
            this.proc = undefined;
            for (const pending of this.pendingRequests.values()) {
                pending.reject(new Error(message));
            }
            this.pendingRequests.clear();
            // The Copilot CLI (or its Go runtime) sometimes creates a literal "nul"
            // file in the cwd on Windows instead of using the NUL device.  Clean it up.
            this.cleanupStrayNulFile();
        });

        this.log?.('Connecting to Copilot CLI...');
        const init = await this.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientInfo: {
                name: 'junior',
                title: 'Junior',
                version: '1.1.1'
            },
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false
            }
        });

        this.promptCapabilities = {
            image: Boolean(init?.agentCapabilities?.promptCapabilities?.image),
            embeddedContext: Boolean(init?.agentCapabilities?.promptCapabilities?.embeddedContext)
        };
        this.sessionCapabilities = {
            loadSession: Boolean(init?.agentCapabilities?.loadSession)
        };
        this.connected = true;
        this.log?.('Copilot CLI connected.');
    }

    private resolveSpawnSpec(cliPath: string, additionalArgs: string[]): { command: string; args: string[] } {
        const acpArgs = ['--acp', '--stdio', ...additionalArgs];
        if (process.platform !== 'win32') {
            return { command: cliPath, args: acpArgs };
        }

        const ext = path.extname(cliPath).toLowerCase();
        if (ext === '.exe' || ext === '.cmd' || ext === '.bat') {
            return { command: cliPath, args: acpArgs };
        }

        const resolvedCliPath = this.resolveWindowsCommandPath(cliPath);
        const resolvedExt = path.extname(resolvedCliPath).toLowerCase();
        if (resolvedExt === '.exe' || resolvedExt === '.cmd' || resolvedExt === '.bat') {
            return { command: resolvedCliPath, args: acpArgs };
        }

        if (resolvedExt === '.ps1' || resolvedExt === '.psm1') {
            const shellCommand = this.resolvePowerShellCommand();
            return {
                command: shellCommand,
                args: ['-NoProfile', '-NoLogo', '-File', resolvedCliPath, ...acpArgs]
            };
        }

        return { command: resolvedCliPath, args: acpArgs };
    }

    private resolveWindowsCommandPath(cliPath: string): string {
        if (path.extname(cliPath)) {
            return cliPath;
        }
        const directMatch = this.findWindowsCommandCandidate(cliPath);
        if (directMatch) {
            return directMatch;
        }
        if (path.isAbsolute(cliPath)) {
            return cliPath;
        }
        const whereResult = cp.spawnSync('where.exe', [cliPath], {
            cwd: this.getWorkspaceRoot(),
            encoding: 'utf8'
        });
        if (whereResult.status === 0 && typeof whereResult.stdout === 'string') {
            const match = whereResult.stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .find(Boolean);
            if (match) {
                return this.findWindowsCommandCandidate(match) || match;
            }
        }
        return cliPath;
    }

    private findWindowsCommandCandidate(basePath: string): string | undefined {
        const candidates = [
            `${basePath}.exe`,
            `${basePath}.ps1`,
            `${basePath}.psm1`,
            `${basePath}.cmd`,
            `${basePath}.bat`,
            basePath
        ];
        return candidates.find(candidate => {
            try {
                return fs.existsSync(candidate);
            } catch {
                return false;
            }
        });
    }

    private resolvePowerShellCommand(): string {
        const candidates = ['pwsh', 'powershell.exe'];
        for (const candidate of candidates) {
            try {
                const probe = cp.spawnSync(candidate, ['-NoProfile', '-NoLogo', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
                    cwd: this.getWorkspaceRoot(),
                    encoding: 'utf8'
                });
                if (probe.status === 0) {
                    return candidate;
                }
            } catch {
                // Try the next shell candidate.
            }
        }
        return 'pwsh';
    }

    private async ensureSession(): Promise<void> {
        if (this.sessionId) {
            return;
        }
        const created = await this.request('session/new', {
            cwd: this.getWorkspaceRoot(),
            mcpServers: []
        });
        this.sessionId = created.sessionId;
    }

    private buildPromptContent(text: string, images?: string[], files?: { name: string; content: string }[]): AcpContentBlock[] {
        const content: AcpContentBlock[] = [{ type: 'text', text }];
        if (files && this.promptCapabilities.embeddedContext) {
            for (const file of files) {
                const mimeType = this.guessMimeType(file.name);
                const uri = vscode.Uri.file(path.join(this.getWorkspaceRoot(), file.name)).toString();
                content.push({
                    type: 'resource',
                    resource: {
                        uri,
                        mimeType,
                        text: file.content
                    }
                });
            }
        }
        if (images && this.promptCapabilities.image) {
            for (const image of images) {
                const match = image.match(/^data:(.*?);base64,(.*)$/);
                if (!match) {
                    continue;
                }
                content.push({
                    type: 'image',
                    mimeType: match[1],
                    data: match[2]
                });
            }
        }
        return content;
    }

    private toChatContent(text: string, images?: string[]): string | ContentPart[] {
        if (!images || images.length === 0) {
            return text;
        }
        const parts: ContentPart[] = [{ type: 'text', text }];
        for (const image of images) {
            parts.push({ type: 'image_url', image_url: { url: image } });
        }
        return parts;
    }

    private onStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            let message: JsonRpcMessage;
            try {
                message = JSON.parse(trimmed) as JsonRpcMessage;
            } catch {
                this.log?.(`Ignoring non-JSON ACP output: ${trimmed}`);
                continue;
            }
            this.messageProcessing = this.messageProcessing
                .then(() => this.handleJsonRpcMessage(message))
                .catch(err => {
                    this.log?.(`ACP message handling failed: ${String(err)}`);
                });
        }
    }

    private async drainPendingMessages(): Promise<void> {
        await this.messageProcessing;
        if (this.stdoutBuffer.trim().length > 0) {
            const trailing = this.stdoutBuffer.trim();
            this.stdoutBuffer = '';
            try {
                const message = JSON.parse(trailing) as JsonRpcMessage;
                await this.handleJsonRpcMessage(message);
            } catch {
                this.log?.(`Ignoring trailing non-JSON ACP output: ${trailing}`);
            }
        }
    }

    private async handleJsonRpcMessage(message: JsonRpcMessage): Promise<void> {
        if (message.method) {
            if (message.id !== undefined) {
                await this.handleIncomingRequest(message);
                return;
            }
            this.handleIncomingNotification(message.method, message.params);
            return;
        }

        if (message.id === undefined) {
            return;
        }
        if (message.id === null) {
            return;
        }
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
            return;
        }
        this.pendingRequests.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error.message));
        } else {
            pending.resolve(message.result);
        }
    }

    private async handleIncomingRequest(message: JsonRpcMessage): Promise<void> {
        if (message.method === 'session/request_permission') {
            const params = message.params || {};
            const toolCall = params.toolCall || {};
            const actionId = `acp_perm_${String(message.id)}`;
            const category = this.toolKindToCategory(toolCall.kind);
            const options: Array<{ optionId: string; name: string; kind: string }> = Array.isArray(params.options) ? params.options : [];

            // Auto-approve read-only operations (read, search, fetch, think)
            // — only write and terminal operations need user confirmation
            if (!category) {
                const autoOption = ['allow_always', 'allow_once']
                    .map(kind => options.find(o => o.kind === kind))
                    .find(Boolean);
                if (autoOption) {
                    this.sendResponse(message.id!, {
                        outcome: { outcome: 'selected', optionId: autoOption.optionId }
                    });
                    return;
                }
            }

            // Auto-approve if this category was previously session-approved
            if (category && this.sessionApprovedCategories.has(category)) {
                const autoOption = ['allow_always', 'allow_once']
                    .map(kind => options.find(o => o.kind === kind))
                    .find(Boolean);
                if (autoOption) {
                    this.sendResponse(message.id!, {
                        outcome: { outcome: 'selected', optionId: autoOption.optionId }
                    });
                    return;
                }
            }

            this.pendingPermissions.set(actionId, {
                requestId: message.id!,
                options,
                category
            });
            this.callbacks.sendToWebview({
                type: 'confirmAction',
                actionId,
                description: toolCall.title || 'Allow Copilot CLI to perform this action?',
                category
            });
            return;
        }

        this.sendError(message.id!, -32601, `Unsupported ACP request: ${message.method}`);
    }

    private handleIncomingNotification(method: string, params: any): void {
        if (method !== 'session/update') {
            return;
        }
        const update = params?.update;
        if (!update || typeof update.sessionUpdate !== 'string') {
            return;
        }
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                this.handleAgentMessageChunk(update);
                break;
            case 'agent_thought_chunk':
                this.handleAgentThoughtChunk(update);
                break;
            case 'tool_call':
                this.handleToolCall(update);
                break;
            case 'tool_call_update':
                this.handleToolCallUpdate(update);
                break;
            case 'plan':
                this.handlePlan(update);
                break;
            case 'session_info_update':
                break;
            default:
                break;
        }
    }

    private handleAgentMessageChunk(update: any): void {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') {
            return;
        }
        // Transition from working → messaging: force-complete any open working block
        if (this.workingBlock) {
            this.forceCompleteWorkingBlock();
        }
        this.flushPendingThoughtAsNarration();
        if (!this.assistantStarted) {
            this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
            this.assistantStarted = true;
        }
        this.sawAssistantOutputSinceLastToolPhase = true;
        this.assistantText += update.content.text;
        this.callbacks.sendToWebview({ type: 'appendAssistantText', text: update.content.text });
    }

    private handleAgentThoughtChunk(update: any): void {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') {
            return;
        }
        // Just buffer — don't flush or complete blocks. Thoughts are flushed
        // only on phase transitions (tool→message, idle→tool, or prompt end).
        this.pendingThoughtText += update.content.text;
    }

    private handleToolCall(update: any): void {
        const toolCallId = String(update.toolCallId || '');
        if (!toolCallId) {
            return;
        }
        // End any active assistant message (messaging → working transition)
        if (this.assistantStarted) {
            this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
            this.assistantStarted = false;
        }
        // Reuse an existing working block for sequential tool calls;
        // only create a new block when transitioning from a non-working phase.
        if (!this.workingBlock) {
            // Capture assistant text emitted since last phase for session restore
            const segment = this.assistantText.substring(this.assistantTextOffset).trim();
            this.assistantTextOffset = this.assistantText.length;
            const narration = this.flushPendingThoughtAsNarration();
            // Derive a descriptive title from the narration or thought text
            const title = this.deriveWorkingTitle(narration);
            this.workingBlock = this.createWorkingBlock(title);
            if (segment) {
                this.workingBlock.assistantTextBefore = segment;
            }
            if (narration) {
                this.workingBlock.narration = narration;
            }
            this.callbacks.sendToWebview({ type: 'workingBlockStarted', block: this.workingBlock });
        }
        this.sawAssistantOutputSinceLastToolPhase = false;
        const entry: WorkingBlockActionEntry = {
            id: `acp_tool_${toolCallId}`,
            kind: 'action',
            text: update.title || 'Running tool',
            createdAt: Date.now(),
            actionType: this.toolKindToActionType(update.kind),
            status: 'running',
            toolName: update.kind || 'other',
            icon: this.toolKindToIcon(update.kind)
        };
        this.activeToolCalls.set(toolCallId, {
            actionEntry: entry,
            blockId: this.workingBlock.id,
            status: 'running'
        });
        this.workingBlock.entries.push(entry);
        this.callbacks.sendToWebview({
            type: 'workingActionAdded',
            blockId: this.workingBlock.id,
            entry
        });
    }

    private handleToolCallUpdate(update: any): void {
        const toolCallId = String(update.toolCallId || '');
        const active = this.activeToolCalls.get(toolCallId);
        if (!active) {
            return;
        }
        const mappedStatus = this.normalizeToolCallStatus(update.status);
        const detail = this.extractToolContentText(update.content);
        const filePath = this.extractToolFilePath(update.content) || undefined;
        // If the update carries a richer title or we can derive one from the file path,
        // pass it along so the UI label improves from a bare "Editing file".
        let text: string | undefined;
        if (update.title && update.title !== active.actionEntry.text) {
            text = update.title;
        } else if (filePath && active.actionEntry.text === 'Editing file') {
            text = `Editing ${filePath}`;
        }
        this.callbacks.sendToWebview({
            type: 'workingActionUpdated',
            blockId: active.blockId,
            entryId: active.actionEntry.id,
            status: mappedStatus,
            text,
            detail: detail || undefined,
            filePath,
            icon: this.toolKindToIcon(update.kind || active.actionEntry.toolName)
        });
        if (text) { active.actionEntry.text = text; }
        if (filePath) { active.actionEntry.filePath = filePath; }
        if (detail) { active.actionEntry.detail = detail; }
        active.actionEntry.status = mappedStatus;
        active.status = mappedStatus;
        // Don't complete the working block here — let it stay open so sequential
        // tool calls accumulate in the same block. The block is completed when
        // a message chunk arrives or the prompt finishes.

        // Emit fileChangeTick for completed file-writing tool calls
        const resolvedPath = filePath || active.actionEntry.filePath;
        const toolKind = update.kind || active.actionEntry.toolName;
        this.log?.(`[toolCallUpdate] id=${toolCallId} status=${mappedStatus} kind=${toolKind} path=${resolvedPath || '(none)'} isWrite=${this.isWriteToolKind(toolKind)}`);
        if (mappedStatus === 'done' && resolvedPath && this.isWriteToolKind(toolKind)) {
            void this.emitFileChangeTick(resolvedPath);
        }
    }

    private handlePlan(update: any): void {
        if (this.workingBlock) {
            this.forceCompleteWorkingBlock();
        }
        this.flushPendingThoughtAsNarration();
        if (this.assistantStarted) {
            this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
            this.assistantStarted = false;
        }
        const entries = Array.isArray(update.entries) ? update.entries : [];
        this.currentPlanIds = entries.map((_: unknown, index: number) => `acp_plan_${index}`);
        const steps: AgentPlanStep[] = entries.map((entry: any, index: number) => ({
            id: this.currentPlanIds[index],
            title: String(entry.content || `Step ${index + 1}`),
            status: entry.status === 'in_progress'
                ? 'in_progress'
                : entry.status === 'completed'
                    ? 'completed'
                    : 'pending'
        }));
        this.callbacks.sendToWebview({ type: 'agentPlan', steps });
    }

    private forceCompleteWorkingBlock(): void {
        if (!this.workingBlock) {
            return;
        }
        // Mark any still-running tools as done to avoid orphaned spinners
        for (const [, active] of this.activeToolCalls) {
            if (active.status === 'running') {
                this.callbacks.sendToWebview({
                    type: 'workingActionUpdated',
                    blockId: active.blockId,
                    entryId: active.actionEntry.id,
                    status: 'done'
                });
                active.status = 'done';
            }
        }
        this.completeWorkingBlock();
    }

    private completeWorkingBlock(): void {
        if (!this.workingBlock) {
            return;
        }
        const actions = [...this.activeToolCalls.values()];
        const summary = actions.length === 1 ? 'Completed 1 action' : `Completed ${actions.length} actions`;
        const completedAt = Date.now();
        this.workingBlock.status = 'completed';
        this.workingBlock.summary = summary;
        this.workingBlock.completedAt = completedAt;
        // Snapshot the completed block for session persistence
        this.allWorkingPhases.push({ ...this.workingBlock, entries: [...this.workingBlock.entries] });
        this.callbacks.sendToWebview({
            type: 'workingBlockCompleted',
            blockId: this.workingBlock.id,
            summary,
            completedAt
        });
        this.workingBlock = undefined;
        this.activeToolCalls.clear();
    }

    private normalizeToolCallStatus(status: unknown): 'running' | 'done' | 'error' {
        const value = String(status || '').trim().toLowerCase();
        if (!value || value === 'running' || value === 'in_progress' || value === 'pending' || value === 'started') {
            return 'running';
        }
        if (
            value === 'completed' ||
            value === 'complete' ||
            value === 'done' ||
            value === 'success' ||
            value === 'succeeded' ||
            value === 'finished'
        ) {
            return 'done';
        }
        if (
            value === 'failed' ||
            value === 'error' ||
            value === 'rejected' ||
            value === 'cancelled' ||
            value === 'canceled' ||
            value === 'denied'
        ) {
            return 'error';
        }
        this.log?.(`[copilot-cli] Unrecognized tool_call_update status "${value}"; treating as running.`);
        return 'running';
    }

    private flushPendingThoughtAsNarration(): string {
        let text = this.pendingThoughtText
            .replace(/\r/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        this.pendingThoughtText = '';
        if (!text) {
            return '';
        }
        // Strip standalone "Thinking" / "Exploring ..." labels the GHCP CLI emits
        text = text.replace(/^Thinking[.\s]*/i, '').trim();
        if (!text) {
            return '';
        }
        this.callbacks.sendToWebview({ type: 'narrationText', text });
        return text;
    }

    private flushPendingThoughtAsAssistant(): void {
        let text = this.pendingThoughtText
            .replace(/\r/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        this.pendingThoughtText = '';
        if (!text) {
            return;
        }
        // Strip standalone "Thinking" label
        text = text.replace(/^Thinking[.\s]*/i, '').trim();
        if (!text) {
            return;
        }
        this.callbacks.sendToWebview({ type: 'startAssistantMessage' });
        this.callbacks.sendToWebview({ type: 'appendAssistantText', text });
        this.callbacks.sendToWebview({ type: 'endAssistantMessage' });
        this.assistantText += (this.assistantText ? '\n\n' : '') + text;
        this.sawAssistantOutputSinceLastToolPhase = true;
    }

    private request(method: string, params: any, id?: number): Promise<any> {
        const requestId = id ?? this.requestId++;
        const payload: JsonRpcMessage = {
            jsonrpc: '2.0',
            id: requestId,
            method,
            params
        };
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            this.writeJson(payload);
        });
    }

    private sendNotification(method: string, params: any): void {
        this.writeJson({ jsonrpc: '2.0', method, params });
    }

    private sendResponse(id: number | string, result: any): void {
        this.writeJson({ jsonrpc: '2.0', id, result });
    }

    private sendError(id: number | string, code: number, message: string): void {
        this.writeJson({ jsonrpc: '2.0', id, error: { code, message } });
    }

    private writeJson(payload: JsonRpcMessage): void {
        if (!this.proc?.stdin.writable) {
            throw new Error('Copilot CLI ACP process is not writable.');
        }
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
    }

    private toolKindToActionType(kind: string | undefined): WorkingActionType {
        switch (kind) {
            case 'read': return 'read';
            case 'search': return 'search';
            case 'edit':
            case 'delete':
            case 'move':
                return 'edit';
            case 'execute': return 'run';
            case 'fetch': return 'check';
            case 'think': return 'analyze';
            default: return 'other';
        }
    }

    private toolKindToCategory(kind: string | undefined): string | undefined {
        switch (kind) {
            case 'edit':
            case 'delete':
            case 'move':
                return 'write';
            case 'execute':
                return 'terminal';
            default:
                return undefined;
        }
    }

    private toolKindToIcon(kind: string | undefined): string {
        switch (kind) {
            case 'read': return 'read';
            case 'search': return 'search';
            case 'edit':
            case 'delete':
            case 'move':
                return 'edit';
            case 'execute': return 'run';
            case 'fetch': return 'check';
            default: return 'loading';
        }
    }

    private isWriteToolKind(kind: string | undefined): boolean {
        return kind === 'edit' || kind === 'delete' || kind === 'move';
    }

    private async emitFileChangeTick(filePath: string): Promise<void> {
        const root = this.getWorkspaceRoot();
        const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        this.log?.(`[fileChangeTick] emitting for: ${rel} (abs: ${abs})`);
        try {
            const { additions, deletions } = await this.gitDiffNumstat(root, abs);
            this.log?.(`[fileChangeTick] git diff: +${additions} -${deletions}`);
            this.callbacks.sendToWebview({ type: 'fileChangeTick', file: rel, additions, deletions });
        } catch (gitErr) {
            this.log?.(`[fileChangeTick] git diff failed: ${gitErr}, trying file read fallback`);
            // If git fails (untracked new file, no git, etc.), count lines as additions
            try {
                const content = await fs.promises.readFile(abs, 'utf-8');
                const lines = content.split('\n').length;
                this.callbacks.sendToWebview({ type: 'fileChangeTick', file: rel, additions: lines, deletions: 0 });
            } catch {
                this.callbacks.sendToWebview({ type: 'fileChangeTick', file: rel, additions: 0, deletions: 0 });
            }
        }
    }

    private gitDiffNumstat(cwd: string, filePath: string): Promise<{ additions: number; deletions: number }> {
        return new Promise((resolve, reject) => {
            cp.execFile('git', ['diff', '--numstat', '--', filePath], { cwd, timeout: 5000 }, (err, stdout) => {
                if (err) { return reject(err); }
                const line = stdout.trim();
                if (!line) { return reject(new Error('no diff output')); }
                const parts = line.split('\t');
                resolve({
                    additions: parseInt(parts[0], 10) || 0,
                    deletions: parseInt(parts[1], 10) || 0,
                });
            });
        });
    }

    private extractToolContentText(content: any[] | undefined): string {
        if (!Array.isArray(content)) {
            return '';
        }
        const texts = content
            .filter(item => item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string')
            .map(item => item.content.text.trim())
            .filter(Boolean);
        return texts.join('\n').slice(0, 1000);
    }

    private extractToolFilePath(content: any[] | undefined): string {
        if (!Array.isArray(content)) {
            return '';
        }
        const diff = content.find(item => item?.type === 'diff' && typeof item.path === 'string');
        return diff?.path || '';
    }

    private getWorkspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    }

    private guessMimeType(fileName: string): string {
        const ext = path.extname(fileName).toLowerCase();
        switch (ext) {
            case '.ts': return 'text/typescript';
            case '.tsx': return 'text/typescriptreact';
            case '.js': return 'text/javascript';
            case '.jsx': return 'text/javascriptreact';
            case '.json': return 'application/json';
            case '.md': return 'text/markdown';
            case '.py': return 'text/x-python';
            case '.cs': return 'text/x-csharp';
            default: return 'text/plain';
        }
    }

    /** Extract a short descriptive title from the narration text (first sentence/line). */
    private deriveWorkingTitle(narration: string): string {
        if (!narration) {
            return 'Working';
        }
        // Take the first sentence or line, whichever is shorter
        const firstLine = narration.split(/\n/)[0].trim();
        const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0];
        const raw = firstSentence.length < firstLine.length ? firstSentence : firstLine;
        // Truncate to a reasonable length for a title
        const maxLen = 60;
        const title = raw.length > maxLen ? raw.substring(0, maxLen).replace(/\s+\S*$/, '') + '…' : raw;
        return title || 'Working';
    }

    private createWorkingBlock(title: string): WorkingBlock {
        return {
            id: `acp_work_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            status: 'in_progress',
            title,
            entries: [],
            startedAt: Date.now()
        };
    }
}