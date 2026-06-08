/**
 * Shared types for the Junior agent extension.
 */

// ── Azure OpenAI Types ──

export interface AoaiConfig {
    provider: 'direct' | 'apim' | 'openai';
    endpoint: string;
    apimBaseUrl: string;
    authHeader: 'api-key' | 'bearer';
    authToken: string;
    deploymentId: string;
    apiVersion: string;
    maxTokens: number;
    temperature: number;
    authSession?: {
        providerId: string;
        scopes: string[];
    };
}

export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
    role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    /** Chat mode active when this message was submitted. */
    mode?: ChatMode;
    /** Original display text for user messages (before slash-command expansion) */
    displayText?: string;
    /** Structured working phases rendered in the chat UI for assistant tool turns. */
    workingPhases?: WorkingBlock[];
}

export interface FileAttachment {
    name: string;
    content: string;      // text content of the file
    language?: string;     // language id for syntax context
}

export interface ImageAttachment {
    name: string;
    dataUri: string;       // data:image/png;base64,...
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface AoaiStreamChunk {
    id: string;
    choices: Array<{
        delta: {
            role?: string;
            content?: string | null;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: TokenUsage;
}

// ── Tool System Types ──

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

export interface ToolResult {
    success: boolean;
    result: string;
}

/** A live progress update emitted by a tool while it executes. Currently used
 *  by A2A connected-agent delegation to surface the remote agent's reasoning /
 *  narration in real time instead of only at completion. */
export interface ToolProgressUpdate {
    /** Render channel. 'reasoning' is the remote model's thinking; 'narration'
     *  is progress / tool-call status; 'answer' is final content. */
    channel: 'reasoning' | 'narration' | 'answer';
    text: string;
}

/** Optional execution context handed to a ToolHandler. Handlers that don't need
 *  it ignore the second argument (backward compatible). */
export interface ToolContext {
    /** The tool call id, matching the working-block action entry. */
    callId: string;
    /** Cancellation signal for the current run. */
    signal?: AbortSignal;
    /** Emit an incremental progress update for live UI rendering. */
    onProgress?: (update: ToolProgressUpdate) => void;
}

export type ToolHandler = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;

// ── Ask-User (interactive question) Types ──

export interface AskUserOption {
    /** Display label and value for the option. */
    label: string;
    /** Optional secondary text shown with the option. */
    description?: string;
    /** Marks this option as the recommended/default choice. */
    recommended?: boolean;
}

export interface AskUserQuestion {
    /** Short unique identifier so answers can be mapped back to the question. */
    header: string;
    /** The question text to display to the user. */
    question: string;
    /** Optional markdown detail shown below the question for extra context. */
    detail?: string;
    /** Optional predefined choices. Omit for a free-text question. */
    options?: AskUserOption[];
    /** Allow selecting multiple options when options are provided. */
    multiSelect?: boolean;
    /** Allow a custom typed answer in addition to options. Defaults to true. */
    allowFreeformInput?: boolean;
}

/** Map of question header -> selected/typed answer value(s). */
export type AskUserAnswers = Record<string, string[]>;

// ── MCP Types ──

export interface McpAuthSessionConfig {
    /** VS Code authentication provider ID (for example: github) */
    providerId: string;
    /** Optional scopes to request from the auth provider */
    scopes?: string[];
    /** Header name to populate with the access token. Defaults to Authorization. */
    tokenHeader?: string;
    /** Prefix added before the token value. Defaults to Bearer. */
    tokenScheme?: string;
    /** Prompt the user to sign in if no session is already available. */
    createIfNone?: boolean;
}

export interface McpServerConfig {
    /** stdio transport: command to spawn */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** HTTP transport: base URL of the MCP server */
    url?: string;
    /** HTTP transport: extra headers (e.g. Authorization) */
    headers?: Record<string, string>;
    /** HTTP transport: populate auth headers from a VS Code auth provider session */
    authSession?: McpAuthSessionConfig;
}

export interface McpToolInfo {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

// ── Session Types ──

export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    transcript?: PersistedTranscript;
    createdAt: number;
    updatedAt: number;
    activeMode?: ChatMode;
    activePermissionLevel?: AgentPermissionLevel;
    /** Id of the active custom agent, if any. When set, the chat runs in agent mode with the persona applied. */
    activeCustomAgentId?: string;
    /** Id of the active Junior Dev Team, if any. When set, the chat runs in agent mode with a team persona applied. */
    activeDevTeamId?: string;
    /** Ids of connected (remote A2A) agents enabled as delegation targets for this session. */
    enabledConnectedAgentIds?: string[];
    runtimeState?: RuntimeSessionState;
}

export type AgentProvider = 'local' | 'copilot-cli';
export type ChatMode = 'ask' | 'plan' | 'agent';
export type AgentPermissionLevel = 'default' | 'bypass';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningSummary = 'auto' | 'detailed' | 'none';
export type ContextAttachmentKind = 'selection' | 'active-file' | 'open-editors' | 'diagnostics' | 'git-diff' | 'terminal';

export interface AgentProviderOption {
    value: AgentProvider;
    label: string;
}

export interface RuntimeSessionState {
    provider: AgentProvider;
    backendSessionId?: string;
}

export interface AgentPlanStep {
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export type WorkingBlockStatus = 'in_progress' | 'completed';

export type WorkingActionType =
    | 'read'
    | 'search'
    | 'review'
    | 'create'
    | 'edit'
    | 'todo'
    | 'analyze'
    | 'run'
    | 'check'
    | 'other';

export interface WorkingBlockProgressEntry {
    id: string;
    kind: 'progress';
    text: string;
    createdAt: number;
}

export interface WorkingBlockTerminalEntry {
    id: string;
    kind: 'terminal';
    text: string;
    createdAt: number;
}

export interface WorkingBlockActionEntry {
    id: string;
    kind: 'action';
    text: string;
    createdAt: number;
    actionType: WorkingActionType;
    status: 'running' | 'done' | 'error';
    repeatCount?: number;
    detail?: string;
    filePath?: string;
    toolName?: string;
    icon?: string;
    /** Live progress lines emitted by the tool (e.g. a remote A2A agent's
     *  reasoning / narration), rendered as a sub-log under the action. */
    progressLog?: ToolProgressUpdate[];
}

export type WorkingBlockEntry = WorkingBlockProgressEntry | WorkingBlockActionEntry | WorkingBlockTerminalEntry;

export interface WorkingBlock {
    id: string;
    status: WorkingBlockStatus;
    title: string;
    hidden?: boolean;
    summary?: string;
    entries: WorkingBlockEntry[];
    startedAt: number;
    completedAt?: number;
}

export interface PersistedUserTranscriptItem {
    id: string;
    kind: 'user';
    text: string;
    images?: string[];
    fileNames?: string[];
}

export interface PersistedAssistantTranscriptItem {
    id: string;
    kind: 'assistant';
    text: string;
    provider: AgentProvider;
    team?: DevTeamResponseSummary;
}

export interface DevTeamResponseSummary {
    id: string;
    name: string;
    members: Array<{
        role: string;
        agentName?: string;
        permission: 'write' | 'review' | 'read';
        deploymentId?: string;
        status?: 'consulted' | 'executed' | 'failed';
        error?: string;
    }>;
}

export interface DevTeamRoomEvent {
    teamId: string;
    teamName: string;
    memberRole?: string;
    agentName?: string;
    permission?: 'write' | 'review' | 'read';
    phase?: 'consult' | 'execute' | 'review';
    status: 'opened' | 'started' | 'done' | 'blocked' | 'failed' | 'completed';
    title: string;
    detail?: string;
}

export interface PersistedNarrationTranscriptItem {
    id: string;
    kind: 'narration';
    text: string;
}

export interface PersistedDevTeamRoomEventTranscriptItem {
    id: string;
    kind: 'dev-team-room-event';
    event: DevTeamRoomEvent;
}

export interface PersistedReasoningTranscriptItem {
    id: string;
    kind: 'reasoning';
    text: string;
}

export interface PersistedWorkingBlockTranscriptItem {
    id: string;
    kind: 'working-block';
    block: WorkingBlock;
}

export interface PersistedErrorTranscriptItem {
    id: string;
    kind: 'error';
    message: string;
}

export type PersistedTranscriptItem =
    | PersistedUserTranscriptItem
    | PersistedAssistantTranscriptItem
    | PersistedNarrationTranscriptItem
    | PersistedDevTeamRoomEventTranscriptItem
    | PersistedReasoningTranscriptItem
    | PersistedWorkingBlockTranscriptItem
    | PersistedErrorTranscriptItem;

export interface PersistedTranscript {
    version: 1;
    items: PersistedTranscriptItem[];
    activeAssistantMessageId?: string;
    activeReasoningItemId?: string;
    activeWorkingBlockId?: string;
}

// ── Webview Message Types ──

export type WebviewMessage =
    | { type: 'sendMessage'; text: string; mode: ChatMode; images?: string[]; files?: { name: string; content: string }[] }
    | { type: 'cancelAgent' }
    | { type: 'newSession' }
    | { type: 'selectModel' }
    | { type: 'selectModelById'; deploymentId: string }
    | { type: 'updateReasoningConfig'; effort?: ReasoningEffort; summary?: ReasoningSummary }
    | { type: 'selectAgentProvider'; provider: AgentProvider }
    | { type: 'selectPermissionLevel'; level: AgentPermissionLevel }
    | { type: 'selectChatMode'; mode: ChatMode }
    | { type: 'selectCustomAgent'; id: string | null }
    | { type: 'createCustomAgent' }
    | { type: 'editCustomAgent'; id: string }
    | { type: 'deleteCustomAgent'; id: string }
    | { type: 'selectDevTeam'; id: string | null }
    | { type: 'createDevTeam' }
    | { type: 'editDevTeam'; id: string }
    | { type: 'deleteDevTeam'; id: string }
    | { type: 'toggleConnectedAgent'; id: string; enabled: boolean }
    | { type: 'createConnectedAgent' }
    | { type: 'editConnectedAgent'; id: string }
    | { type: 'deleteConnectedAgent'; id: string }
    | { type: 'runPlanInAgent' }
    | { type: 'attachFile' }
    | { type: 'attachContext'; kind: ContextAttachmentKind }
    | { type: 'confirmAction'; actionId: string; approved: boolean; allowSession?: boolean; category?: string }
    | { type: 'askUserResponse'; requestId: string; answers: AskUserAnswers; cancelled?: boolean }
    | { type: 'continueIteration'; shouldContinue: boolean }
    | { type: 'fileChangeAction'; action: 'keep' | 'undo' }
    | { type: 'fileChangeFileAction'; file: string; action: 'keep' | 'undo' }
    | { type: 'openFileDiff'; file: string }
    | { type: 'requestFileDiff'; file: string }
    | { type: 'showInlineDiff'; file: string }
    | { type: 'switchSession'; sessionId: string }
    | { type: 'deleteSession'; sessionId: string }
    | { type: 'requestSessionList' }
    | { type: 'showTokenUsage' }
    | { type: 'requestSlashCommands' }
    | { type: 'openFile'; filePath: string }
    | { type: 'manageMcpServers' }
    | { type: 'splashOpenSettings' }
    | { type: 'splashSetApiKey' }
    | { type: 'splashDismissed'; showOnStartup: boolean }
    | { type: 'ready' };

export type ExtensionMessage =
    | { type: 'addUserMessage'; text: string; images?: string[]; fileNames?: string[] }
    | { type: 'restoreTranscript'; transcript: PersistedTranscript }
    | { type: 'setModels'; models: Array<{ name: string; deploymentId: string; supportsReasoning?: boolean }>; activeDeployment?: string; disabled?: boolean; title?: string; reasoning?: { visible: boolean; supported: boolean; effort: ReasoningEffort; summary: ReasoningSummary; wireApi: string; modelId?: string; title?: string } }
    | { type: 'setAgentProviders'; providers: AgentProviderOption[]; activeProvider: AgentProvider }
    | { type: 'setAgentProvider'; provider: AgentProvider }
    | { type: 'setPermissionLevel'; level: AgentPermissionLevel }
    | { type: 'setChatMode'; mode: ChatMode }
    | { type: 'setCustomAgents'; agents: Array<{ id: string; name: string; description?: string; scope: 'workspace' | 'global'; source?: 'junior' | 'agent-md'; readonly?: boolean }>; activeId: string | null }
    | { type: 'setDevTeams'; teams: Array<{ id: string; name: string; description?: string; scope: 'workspace' | 'global'; memberCount: number; members?: DevTeamResponseSummary['members'] }>; activeId: string | null }
    | { type: 'setConnectedAgents'; agents: Array<{ id: string; name: string; description?: string; endpoint: string; scope: 'workspace' | 'global' }>; enabledIds: string[] }
    | { type: 'searchCitations'; agentName: string; query: string; citations: Array<{ index: number; title: string; url?: string; snippet?: string; score?: number; rerankerScore?: number }> }
    | { type: 'planReady'; visible: boolean }
    | { type: 'agentStarted' }
    | { type: 'agentPlan'; steps: AgentPlanStep[] }
    | { type: 'startAssistantMessage'; team?: DevTeamResponseSummary }
    | { type: 'appendAssistantText'; text: string }
    | { type: 'endAssistantMessage' }
    | { type: 'toolCall'; name: string; args: string; id: string }
    | { type: 'toolResult'; id: string; result: string; success: boolean }
    | { type: 'error'; message: string }
    | { type: 'modelChanged'; model: string }
    | { type: 'sessionCleared' }
    | { type: 'setStatus'; status: string }
    | { type: 'confirmAction'; actionId: string; description: string; category?: string; diff?: string }
    | { type: 'askUser'; requestId: string; questions: AskUserQuestion[] }
    | { type: 'fileAttached'; name: string; content: string }
    | { type: 'contextAttached'; kind: ContextAttachmentKind; name: string; content: string }
    | { type: 'sessionList'; sessions: Array<{ id: string; title: string; updatedAt: number; messageCount: number }>; activeId: string }
    | { type: 'sessionSwitched' }
    | { type: 'fileChangeTick'; file: string; additions: number; deletions: number }
    | { type: 'fileDiffContent'; file: string; diff: string }
    | { type: 'fileChangeFileResolved'; file: string; action: 'kept' | 'undone' }
    | { type: 'fileChangeResolved'; action: 'kept' | 'undone' }
    | { type: 'agentDone' }
    | { type: 'continueIteration'; iterationCount: number }
    | { type: 'workingBlockStarted'; block: WorkingBlock }
    | { type: 'workingTextAppended'; blockId: string; entry: WorkingBlockProgressEntry }
    | { type: 'workingActionAdded'; blockId: string; entry: WorkingBlockActionEntry }
    | { type: 'workingActionUpdated'; blockId: string; entryId: string; status: 'running' | 'done' | 'error'; text?: string; detail?: string; filePath?: string; icon?: string; repeatCount?: number }
    | { type: 'workingActionProgress'; blockId: string; entryId: string; update: ToolProgressUpdate }
    | { type: 'workingBlockCompleted'; blockId: string; summary: string; completedAt: number }
    | { type: 'narrationText'; text: string }
    | { type: 'devTeamRoomEvent'; event: DevTeamRoomEvent }
    | { type: 'reasoningStart' }
    | { type: 'reasoningAppend'; text: string }
    | { type: 'reasoningEnd' }
    | { type: 'terminalOutput'; line: string }
    | { type: 'tokenUsage'; totalTokens: string; chatTokens: string; inlineTokens: string; chatPct: string; inlinePct: string; requests: number; chatPrompt: string; chatCompletion: string; inlinePrompt: string; inlineCompletion: string; chatPromptPct: string; chatCompletionPct: string; inlinePromptPct: string; inlineCompletionPct: string; chatRequests: number; inlineRequests: number; windowPct: number; contextWindow: string }
    | { type: 'slashCommands'; commands: Array<{ name: string; description: string }> }
    | { type: 'showSplash'; showOnStartup: boolean };

