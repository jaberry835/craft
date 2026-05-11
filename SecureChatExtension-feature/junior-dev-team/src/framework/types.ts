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
    /** Reasoning effort hint (responses wire API only). */
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    /** Reasoning summary mode (responses wire API only). */
    reasoningSummary?: 'auto' | 'detailed' | 'none';
    /** Server-side conversation state id (responses wire API only). When set, the
     *  client sends only the new turn(s) plus this previous_response_id. */
    previousResponseId?: string;
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
    /** Server-side response id (responses wire API only). */
    responseId?: string;
    /** Reasoning summary text aggregated across the stream (responses wire API only). */
    reasoningSummary?: string;
}

// ── Streaming ──

/** A single chunk emitted during streaming. */
export type ChatStreamChunk =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'reasoningSummary'; text: string }
    | { type: 'toolCallStarted' }
    | { type: 'toolCalls'; calls: ToolCall[] }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'responseId'; id: string }
    | { type: 'done' }
    | { type: 'retry'; reason: string };

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

// ── Agent Run Options ──

/** Options for an agent run. */
export interface AgentRunOptions extends ChatOptions {
    /** Maximum iterations of the model→tool loop. */
    maxIterations?: number;
    /** Session to use for history. */
    sessionId?: string;
}
