/**
 * Core framework types for the TypeScript Agent Framework.
 *
 * Inspired by Microsoft Agent Framework (microsoft/agent-framework),
 * adapted for TypeScript and this VS Code extension's needs.
 *
 * These types are intentionally decoupled from the existing types.ts
 * (which carries Azure OpenAI wire-format details). Framework consumers
 * work with these abstractions; adapters bridge to the wire types.
 */

import type { ChatMessage, ToolCall, ToolDefinition, ToolResult, TokenUsage } from '../types';

// Re-export the types that the framework shares with the rest of the codebase.
export type { ChatMessage, ToolCall, ToolDefinition, ToolResult, TokenUsage };

// ── Chat Options ──

/** Options passed to a ChatClient when requesting a response. */
export interface ChatOptions {
    /** Tool definitions the model may invoke. */
    tools?: ToolDefinition[];
    /** How the model should select tools: 'auto' | 'required' | 'none'. */
    toolChoice?: 'auto' | 'required' | 'none';
    /** Maximum tokens for the completion. */
    maxTokens?: number;
    /** Sampling temperature. */
    temperature?: number;
    /** Stop sequences. */
    stop?: string[];
    /** Whether to use reasoning-compatible parameters (system→developer, no temp). */
    reasoningMode?: boolean;
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
}

// ── Chat Response ──

/** Finish reason from the model. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;

/** A complete (non-streaming) response from a ChatClient. */
export interface ChatResponse {
    /** The assistant message(s) produced. */
    messages: ChatMessage[];
    /** Why the model stopped generating. */
    finishReason: FinishReason;
    /** Token usage for this request. */
    usage?: TokenUsage;
    /** The model/deployment that produced this response. */
    modelId?: string;
}

// ── Streaming ──

/** A single chunk emitted during streaming. */
export type ChatStreamChunk =
    | { type: 'text'; text: string }
    | { type: 'toolCallStarted' }
    | { type: 'toolCalls'; calls: ToolCall[] }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'done' };

// ── Agent Response ──

/** Result of a full agent run (may span multiple LLM round-trips). */
export interface AgentResponse {
    /** All messages produced during the run (assistant + tool messages). */
    messages: ChatMessage[];
    /** Token usage aggregated across all iterations. */
    usage?: TokenUsage;
    /** The agent that produced this response. */
    agentId: string;
}

/** A streaming update emitted by an agent during its run. */
export interface AgentResponseUpdate {
    /** The type of update. */
    type: 'text' | 'toolCallStarted' | 'toolCalls' | 'toolResult' | 'usage' | 'iterationStart' | 'done';
    /** Text chunk (when type === 'text'). */
    text?: string;
    /** Tool calls from the model (when type === 'toolCalls'). */
    toolCalls?: ToolCall[];
    /** Tool result (when type === 'toolResult'). */
    toolResult?: { callId: string; name: string; result: ToolResult };
    /** Token usage (when type === 'usage'). */
    usage?: TokenUsage;
    /** Current iteration number (when type === 'iterationStart'). */
    iteration?: number;
}

// ── Agent Run Options ──

/** Options for an agent run. */
export interface AgentRunOptions extends ChatOptions {
    /** Maximum iterations of the model→tool loop. */
    maxIterations?: number;
    /** Session to use for history. */
    sessionId?: string;
}
