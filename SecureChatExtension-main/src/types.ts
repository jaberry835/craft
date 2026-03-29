/**
 * Shared types for the Junior agent extension.
 */

// ── Azure OpenAI Types ──

export interface AoaiConfig {
    provider: 'direct' | 'apim' | 'openai';
    endpoint: string;
    apimBaseUrl: string;
    apiKey: string;
    deploymentId: string;
    apiVersion: string;
    maxTokens: number;
    temperature: number;
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

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

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
    createdAt: number;
    updatedAt: number;
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

export interface WorkingBlockActionEntry {
    id: string;
    kind: 'action';
    text: string;
    createdAt: number;
    actionType: WorkingActionType;
    status: 'running' | 'done' | 'error';
    detail?: string;
    filePath?: string;
    toolName?: string;
    icon?: string;
}

export type WorkingBlockEntry = WorkingBlockProgressEntry | WorkingBlockActionEntry;

export interface WorkingBlock {
    id: string;
    status: WorkingBlockStatus;
    title: string;
    summary?: string;
    entries: WorkingBlockEntry[];
    startedAt: number;
    completedAt?: number;
}

// ── Webview Message Types ──

export type WebviewMessage =
    | { type: 'sendMessage'; text: string; images?: string[]; files?: { name: string; content: string }[] }
    | { type: 'cancelAgent' }
    | { type: 'newSession' }
    | { type: 'selectModel' }
    | { type: 'selectModelById'; deploymentId: string }
    | { type: 'attachFile' }
    | { type: 'confirmAction'; actionId: string; approved: boolean; allowSession?: boolean; category?: string }
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
    | { type: 'ready' };

export type ExtensionMessage =
    | { type: 'addUserMessage'; text: string; images?: string[]; fileNames?: string[] }
    | { type: 'setModels'; models: Array<{ name: string; deploymentId: string }>; activeDeployment?: string }
    | { type: 'agentPlan'; steps: AgentPlanStep[] }
    | { type: 'startAssistantMessage' }
    | { type: 'appendAssistantText'; text: string }
    | { type: 'endAssistantMessage' }
    | { type: 'toolCall'; name: string; args: string; id: string }
    | { type: 'toolResult'; id: string; result: string; success: boolean }
    | { type: 'error'; message: string }
    | { type: 'modelChanged'; model: string }
    | { type: 'sessionCleared' }
    | { type: 'setStatus'; status: string }
    | { type: 'confirmAction'; actionId: string; description: string; category?: string; diff?: string }
    | { type: 'fileAttached'; name: string; content: string }
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
    | { type: 'workingActionUpdated'; blockId: string; entryId: string; status: 'running' | 'done' | 'error'; text?: string; detail?: string; filePath?: string; icon?: string }
    | { type: 'workingBlockCompleted'; blockId: string; summary: string; completedAt: number }
    | { type: 'narrationText'; text: string }
    | { type: 'terminalOutput'; line: string }
    | { type: 'tokenUsage'; totalTokens: string; chatTokens: string; inlineTokens: string; chatPct: string; inlinePct: string; requests: number; chatPrompt: string; chatCompletion: string; inlinePrompt: string; inlineCompletion: string; chatPromptPct: string; chatCompletionPct: string; inlinePromptPct: string; inlineCompletionPct: string; chatRequests: number; inlineRequests: number; windowPct: number; contextWindow: string }
    | { type: 'slashCommands'; commands: Array<{ name: string; description: string }> };

