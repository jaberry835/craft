/**
 * Framework barrel export.
 * Import everything from 'framework' in one line.
 */

// Core types
export type {
    ChatMessage,
    ToolCall,
    ToolDefinition,
    ToolResult,
    TokenUsage,
    ChatOptions,
    FinishReason,
    ChatResponse,
    ChatStreamChunk,
    AgentResponse,
    AgentResponseUpdate,
    AgentRunOptions,
} from './types';

// Agent
export type { IAgent } from './agent';
export { BaseAgent } from './agent';

// Chat client
export type { IChatClient } from './chatClient';
export { ChatClientWithMiddleware } from './chatClient';

// Middleware
export type {
    AgentContext,
    FunctionContext,
    ChatContext,
    AgentMiddleware,
    FunctionMiddleware,
    ChatMiddleware,
} from './middleware';
export { MiddlewarePipeline, MiddlewareTermination } from './middleware';

// Tools
export type { IFunctionTool, FunctionToolConfig } from './tools';
export { FunctionTool, ToolRegistry, ToolExecutor } from './tools';

// Response stream
export { ResponseStream } from './responseStream';

// Session
export type { AgentSession, IHistoryProvider } from './session';
export { InMemoryHistoryProvider } from './session';

// Context providers
export type { IContextProvider } from './contextProvider';
