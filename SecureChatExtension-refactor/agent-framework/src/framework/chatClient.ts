/**
 * ChatClient protocol — the LLM provider abstraction.
 *
 * Any LLM backend (Azure OpenAI, OpenAI, Anthropic, Ollama, etc.)
 * can be used with the framework by implementing this interface.
 * The existing AzureOpenAIClient will be adapted to implement this.
 */

import type { ChatMessage, ChatResponse, ChatStreamChunk, ChatOptions } from './types';

/**
 * A client that can send messages to an LLM and get a response.
 * This is the equivalent of MS framework's SupportsChatGetResponse protocol.
 */
export interface IChatClient {
    /**
     * Send messages and get a complete response (non-streaming).
     * Implementations may internally stream and collect, or use a
     * non-streaming API endpoint.
     */
    getResponse(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;

    /**
     * Send messages and get a streaming response.
     * Yields ChatStreamChunk objects as they arrive from the model.
     */
    getResponseStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatStreamChunk>;

    /** The model/deployment identifier currently in use. */
    readonly modelId: string;
}

/**
 * A ChatClient wrapper that applies ChatMiddleware before delegating
 * to an inner client. This enables intercepting/modifying LLM calls
 * without changing the client implementation.
 */
export class ChatClientWithMiddleware implements IChatClient {
    constructor(
        private inner: IChatClient,
        private middleware: import('./middleware').ChatMiddleware[]
    ) {}

    get modelId(): string {
        return this.inner.modelId;
    }

    async getResponse(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
        const context: import('./middleware').ChatContext = {
            client: this.inner,
            messages,
            options: options ?? {},
            stream: false,
        };

        const chain = this.buildChain(context);
        return chain();
    }

    async *getResponseStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        // For streaming, middleware wraps the full call but we delegate
        // to the inner client's streaming. Middleware that needs to intercept
        // streaming should wrap getResponse instead (collect + re-emit).
        yield* this.inner.getResponseStream(messages, options);
    }

    private buildChain(context: import('./middleware').ChatContext): () => Promise<ChatResponse> {
        let next = () => this.inner.getResponse(context.messages, context.options);
        // Build from innermost to outermost
        for (let i = this.middleware.length - 1; i >= 0; i--) {
            const mw = this.middleware[i];
            const currentNext = next;
            next = () => mw.process(context, currentNext);
        }
        return next;
    }
}
