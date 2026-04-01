/**
 * Middleware pipeline — three layers of interception.
 *
 * Inspired by Microsoft Agent Framework's layered middleware:
 *   - AgentMiddleware:    wraps the entire agent run
 *   - FunctionMiddleware: wraps individual tool/function execution
 *   - ChatMiddleware:     wraps individual LLM API calls
 *
 * Each middleware receives a context object and a `next` function.
 * Calling `next()` invokes the next middleware in the chain (or the
 * core handler at the bottom). Middleware can:
 *   - Modify the context before calling next (pre-processing)
 *   - Inspect/modify the result after next returns (post-processing)
 *   - Short-circuit by returning without calling next
 *   - Retry by calling next multiple times
 */

import type {
    ChatMessage,
    ChatOptions,
    ChatResponse,
    ToolResult,
    AgentResponse,
    AgentRunOptions,
} from './types';
import type { IChatClient } from './chatClient';
import type { IFunctionTool } from './tools';

// ── Context Objects ──

/** Context passed through the agent middleware pipeline. */
export interface AgentContext {
    /** The messages for this agent run. Middleware may mutate this. */
    messages: ChatMessage[];
    /** Run options. Middleware may mutate this. */
    options: AgentRunOptions;
    /** Tools available for this run. Middleware may add/remove tools. */
    tools: IFunctionTool[];
    /** The chat client being used. */
    client: IChatClient;
    /** Files edited during this run (for auto-fix, etc.). */
    editedFiles: Set<string>;
    /** Current iteration number (updated by the core loop). */
    iteration: number;
    /** Whether the run has been cancelled. */
    cancelled: boolean;
    /** Arbitrary state bag for middleware to share data. */
    state: Map<string, unknown>;
}

/** Context passed through the function middleware pipeline. */
export interface FunctionContext {
    /** The tool being invoked. */
    tool: IFunctionTool;
    /** The arguments to pass to the tool. */
    args: Record<string, unknown>;
    /** The tool call ID from the model. */
    callId: string;
    /** Arbitrary state bag (shared from AgentContext). */
    state: Map<string, unknown>;
}

/** Context passed through the chat middleware pipeline. */
export interface ChatContext {
    /** The chat client being called. */
    client: IChatClient;
    /** Messages to send. Middleware may mutate this. */
    messages: ChatMessage[];
    /** Chat options. Middleware may mutate this. */
    options: ChatOptions;
    /** Whether this is a streaming request. */
    stream: boolean;
}

// ── Middleware Interfaces ──

/**
 * Wraps an entire agent run. Use for cross-cutting concerns like
 * progress tracking, memory injection, auto-fix cycles.
 */
export interface AgentMiddleware {
    /** Unique name for debugging/logging. */
    readonly name: string;
    /**
     * Process an agent invocation.
     * @param context - The agent context (mutable).
     * @param next - Call to invoke the next middleware or core handler.
     * @returns The agent response (possibly modified).
     */
    process(context: AgentContext, next: () => Promise<AgentResponse>): Promise<AgentResponse>;
}

/**
 * Wraps individual tool/function execution. Use for retry logic,
 * confirmation, validation, logging.
 */
export interface FunctionMiddleware {
    readonly name: string;
    process(context: FunctionContext, next: () => Promise<ToolResult>): Promise<ToolResult>;
}

/**
 * Wraps individual LLM API calls. Use for context trimming,
 * error recovery, rate limiting.
 */
export interface ChatMiddleware {
    readonly name: string;
    process(context: ChatContext, next: () => Promise<ChatResponse>): Promise<ChatResponse>;
}

// ── Pipeline Execution ──

/**
 * Executes a stack of middleware in order, with a terminal handler.
 * Each middleware calls `next()` to proceed to the next one.
 */
export class MiddlewarePipeline {
    /**
     * Run a chain of AgentMiddleware around a core handler.
     */
    static async runAgent(
        middleware: AgentMiddleware[],
        context: AgentContext,
        handler: () => Promise<AgentResponse>
    ): Promise<AgentResponse> {
        let next = handler;
        for (let i = middleware.length - 1; i >= 0; i--) {
            const mw = middleware[i];
            const currentNext = next;
            next = () => mw.process(context, currentNext);
        }
        return next();
    }

    /**
     * Run a chain of FunctionMiddleware around a core handler.
     */
    static async runFunction(
        middleware: FunctionMiddleware[],
        context: FunctionContext,
        handler: () => Promise<ToolResult>
    ): Promise<ToolResult> {
        let next = handler;
        for (let i = middleware.length - 1; i >= 0; i--) {
            const mw = middleware[i];
            const currentNext = next;
            next = () => mw.process(context, currentNext);
        }
        return next();
    }

    /**
     * Run a chain of ChatMiddleware around a core handler.
     */
    static async runChat(
        middleware: ChatMiddleware[],
        context: ChatContext,
        handler: () => Promise<ChatResponse>
    ): Promise<ChatResponse> {
        let next = handler;
        for (let i = middleware.length - 1; i >= 0; i--) {
            const mw = middleware[i];
            const currentNext = next;
            next = () => mw.process(context, currentNext);
        }
        return next();
    }
}

/**
 * Exception that middleware can throw to terminate the pipeline early
 * and return a specific result.
 */
export class MiddlewareTermination extends Error {
    constructor(
        public readonly result: AgentResponse | ToolResult | ChatResponse,
        message?: string
    ) {
        super(message ?? 'Middleware terminated pipeline early');
        this.name = 'MiddlewareTermination';
    }
}
