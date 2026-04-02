/**
 * ContextTrimMiddleware — ChatMiddleware that trims messages
 * to fit within the context window before sending to the LLM.
 *
 * Wraps the existing ContextManager to fit into the middleware pipeline.
 */

import type { ChatMiddleware, ChatContext } from '../framework/middleware';
import type { ChatResponse, ChatStreamChunk, ChatMessage } from '../framework/types';
import { ContextManager } from '../contextManager';

export interface ContextTrimMiddlewareOptions {
    /** Context window size in tokens. Default: 128000. */
    contextWindow?: number;
    /** Threshold ratio (0-1) at which to start trimming. Default: 0.70. */
    contextThreshold?: number;
}

export class ContextTrimMiddleware implements ChatMiddleware {
    readonly name = 'context-trim';
    private contextManager: ContextManager;

    constructor(options?: ContextTrimMiddlewareOptions) {
        this.contextManager = new ContextManager();
        // The ContextManager reads from VS Code settings by default.
        // Options here allow overriding for testing.
    }

    async process(context: ChatContext, next: () => Promise<ChatResponse>): Promise<ChatResponse> {
        // Trim messages in-place before passing to the next handler
        context.messages = this.contextManager.trimIfNeeded(context.messages);
        return next();
    }

    async *processStream(
        context: ChatContext,
        next: () => AsyncGenerator<ChatStreamChunk>
    ): AsyncGenerator<ChatStreamChunk> {
        context.messages = this.contextManager.trimIfNeeded(context.messages);
        yield* next();
    }

    /** Expose for emergency trim scenarios (used by RecoveryMiddleware). */
    emergencyTrim(messages: ChatMessage[]): ChatMessage[] {
        return this.contextManager.emergencyTrim(messages);
    }
}
