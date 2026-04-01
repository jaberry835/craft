/**
 * Agent protocol and base implementation.
 *
 * An Agent wraps a ChatClient + tools + middleware and orchestrates
 * the iterative model→tool-call→tool-result loop.
 */

import type {
    ChatMessage,
    AgentResponse,
    AgentResponseUpdate,
    AgentRunOptions,
} from './types';
import type { ResponseStream } from './responseStream';

// ── Agent Interface ──

/**
 * Core agent protocol. Any object that satisfies this interface
 * can participate in the framework (duck-typing, like MS framework's
 * SupportsAgentRun protocol).
 */
export interface IAgent {
    /** Unique identifier for this agent instance. */
    readonly id: string;
    /** Human-readable name. */
    readonly name: string;
    /** Optional description of what this agent does. */
    readonly description?: string;

    /**
     * Run the agent to completion (non-streaming).
     * Returns after all iterations are done.
     */
    run(messages: ChatMessage[], options?: AgentRunOptions): Promise<AgentResponse>;

    /**
     * Run the agent with streaming updates.
     * Returns a ResponseStream that yields AgentResponseUpdate chunks
     * and resolves to a final AgentResponse.
     */
    runStream(messages: ChatMessage[], options?: AgentRunOptions): ResponseStream<AgentResponseUpdate, AgentResponse>;
}

// ── Base Agent ──

/**
 * Abstract base class providing common agent plumbing.
 * Subclasses implement the core run logic; this class adds middleware,
 * context providers, and session management.
 */
export abstract class BaseAgent implements IAgent {
    readonly id: string;
    readonly name: string;
    readonly description?: string;

    constructor(config: { id?: string; name: string; description?: string }) {
        this.id = config.id ?? `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.name = config.name;
        this.description = config.description;
    }

    abstract run(messages: ChatMessage[], options?: AgentRunOptions): Promise<AgentResponse>;
    abstract runStream(messages: ChatMessage[], options?: AgentRunOptions): ResponseStream<AgentResponseUpdate, AgentResponse>;
}
