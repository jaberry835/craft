/**
 * Shared types for the Junior agent extension.
 */

// ── Azure OpenAI Types ──

export interface AoaiConfig {
    provider: 'direct' | 'apim';
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

// ── Webview Message Types ──

export type WebviewMessage =
    | { type: 'sendMessage'; text: string; images?: string[]; files?: { name: string; content: string }[] }
    | { type: 'cancelAgent' }
    | { type: 'newSession' }
    | { type: 'selectModel' }
    | { type: 'selectModelById'; deploymentId: string }
    | { type: 'attachFile' }
    | { type: 'confirmAction'; actionId: string; approved: boolean; allowSession?: boolean; category?: string }
    | { type: 'fileChangeAction'; action: 'keep' | 'undo' }
    | { type: 'fileChangeFileAction'; file: string; action: 'keep' | 'undo' }
    | { type: 'openFileDiff'; file: string }
    | { type: 'switchSession'; sessionId: string }
    | { type: 'deleteSession'; sessionId: string }
    | { type: 'requestSessionList' }
    | { type: 'showTokenUsage' }
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
    | { type: 'fileChangeFileResolved'; file: string; action: 'kept' | 'undone' }
    | { type: 'fileChangeResolved'; action: 'kept' | 'undone' }
    | { type: 'agentDone' }
    | { type: 'progressCardStart'; title: string }
    | { type: 'progressCardStep'; icon: 'search' | 'read' | 'edit' | 'run' | 'check' | 'loading' | 'done' | 'error'; label: string; detail?: string; status?: 'running' | 'done' | 'error'; toolName?: string }
    | { type: 'progressCardEnd' }
    | { type: 'terminalOutput'; line: string }
    | { type: 'tokenUsage'; totalTokens: string; chatTokens: string; inlineTokens: string; chatPct: string; inlinePct: string; requests: number; chatPrompt: string; chatCompletion: string; inlinePrompt: string; inlineCompletion: string; chatPromptPct: string; chatCompletionPct: string; inlinePromptPct: string; inlineCompletionPct: string; chatRequests: number; inlineRequests: number; windowPct: number; contextWindow: string };

