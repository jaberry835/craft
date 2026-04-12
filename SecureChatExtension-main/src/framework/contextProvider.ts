/**
 * Context providers — before/after hooks for agent runs.
 *
 * Inspired by Microsoft Agent Framework's BaseContextProvider.
 * Context providers inject information before the agent runs
 * (e.g., workspace context, diagnostics, memory) and can process
 * results afterward (e.g., record tool results into memory).
 */

import type { ChatMessage, AgentResponse } from './types';
import type { AgentContext } from './middleware';

/**
 * A context provider that runs before and/or after an agent run.
 * Providers are executed in registration order for `beforeRun`,
 * and in reverse order for `afterRun`.
 */
export interface IContextProvider {
    /** Unique name for debugging/logging. */
    readonly name: string;

    /**
     * Called before the agent starts processing.
     * Use this to inject system messages, add tools, or prepare context.
     *
     * @param context - The agent context (mutable). Add messages, tools, etc.
     * @returns Additional messages to prepend, or void to mutate context directly.
     */
    beforeRun?(context: AgentContext): Promise<ChatMessage[] | void>;

    /**
     * Called after the agent finishes processing.
     * Use this to record results, update memory, or clean up.
     *
     * @param context - The agent context.
     * @param response - The agent's response.
     */
    afterRun?(context: AgentContext, response: AgentResponse): Promise<void>;
}
