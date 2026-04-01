/**
 * Adapter that wraps the existing AzureOpenAIClient to implement
 * the framework's IChatClient interface.
 *
 * This is an additive adapter — the original AzureOpenAIClient is
 * unchanged. This class delegates to it while conforming to the
 * framework's protocol.
 */

import type { AzureOpenAIClient } from '../aoaiClient';
import type { IChatClient } from '../framework/chatClient';
import type { ChatMessage, ChatOptions, ChatResponse, ChatStreamChunk, ToolCall } from '../framework/types';

export class AoaiChatClientAdapter implements IChatClient {
    constructor(private inner: AzureOpenAIClient) {}

    get modelId(): string {
        return this.inner.getEffectiveDeployment();
    }

    /**
     * Non-streaming: collects the full stream into a ChatResponse.
     */
    async getResponse(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
        const assistantMessages: ChatMessage[] = [];
        let toolCalls: ToolCall[] | undefined;
        let assistantText = '';
        let usage: ChatResponse['usage'];

        for await (const chunk of this.getResponseStream(messages, options)) {
            switch (chunk.type) {
                case 'text':
                    assistantText += chunk.text;
                    break;
                case 'toolCalls':
                    toolCalls = chunk.calls;
                    break;
                case 'usage':
                    usage = chunk.usage;
                    break;
            }
        }

        const msg: ChatMessage = {
            role: 'assistant',
            content: assistantText || null,
            ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        };
        assistantMessages.push(msg);

        return {
            messages: assistantMessages,
            finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
            usage,
            modelId: this.modelId,
        };
    }

    /**
     * Streaming: delegates to the inner client's streamChat() generator,
     * mapping its chunk types to the framework's ChatStreamChunk union.
     */
    async *getResponseStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const tools = options?.tools ?? [];
        const streamOptions = {
            reasoningMode: options?.reasoningMode,
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            stop: options?.stop,
        };

        const stream = this.inner.streamChat(
            messages,
            tools,
            options?.signal,
            streamOptions
        );

        // The inner streamChat already yields the same chunk shape
        // as ChatStreamChunk, so we can pass through directly.
        for await (const chunk of stream) {
            yield chunk;
        }
    }
}
