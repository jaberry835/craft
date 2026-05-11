import { describe, it, expect, vi } from 'vitest';
import { ChatClientWithMiddleware } from '../src/framework/chatClient';
import type { IChatClient } from '../src/framework/chatClient';
import type { ChatMiddleware, ChatContext } from '../src/framework/middleware';
import type { ChatMessage, ChatResponse, ChatStreamChunk } from '../src/framework/types';

function makeMockClient(overrides?: Partial<IChatClient>): IChatClient {
    return {
        modelId: 'test-model',
        getResponse: vi.fn().mockResolvedValue({
            messages: [{ role: 'assistant', content: 'hi' }],
            finishReason: 'stop',
        } satisfies ChatResponse),
        getResponseStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
            yield { type: 'text', text: 'hello' };
            yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5 } };
            yield { type: 'done' };
        }),
        ...overrides,
    };
}

describe('ChatClientWithMiddleware', () => {
    describe('getResponse()', () => {
        it('delegates to inner client with no middleware', async () => {
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, []);
            const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

            const result = await wrapped.getResponse(messages);

            expect(result.finishReason).toBe('stop');
            expect(inner.getResponse).toHaveBeenCalled();
        });

        it('exposes modelId from inner client', () => {
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, []);
            expect(wrapped.modelId).toBe('test-model');
        });

        it('runs ChatMiddleware.process() around getResponse', async () => {
            const order: string[] = [];
            const mw: ChatMiddleware = {
                name: 'test',
                async process(ctx, next) {
                    order.push('before');
                    ctx.messages.push({ role: 'system', content: 'injected' });
                    const r = await next();
                    order.push('after');
                    return r;
                },
            };
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, [mw]);

            await wrapped.getResponse([{ role: 'user', content: 'hi' }]);

            expect(order).toEqual(['before', 'after']);
        });

        it('allows middleware to modify messages', async () => {
            const mw: ChatMiddleware = {
                name: 'prepend',
                async process(ctx, next) {
                    ctx.messages = [{ role: 'system', content: 'prepended' }, ...ctx.messages];
                    return next();
                },
            };
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, [mw]);

            await wrapped.getResponse([{ role: 'user', content: 'hi' }]);

            // The inner client should receive the modified messages
            const callArgs = (inner.getResponse as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(callArgs[0]).toHaveLength(2);
            expect(callArgs[0][0].content).toBe('prepended');
        });
    });

    describe('getResponseStream()', () => {
        it('yields all chunks with no middleware', async () => {
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, []);
            const chunks: ChatStreamChunk[] = [];

            for await (const chunk of wrapped.getResponseStream([{ role: 'user', content: 'hi' }])) {
                chunks.push(chunk);
            }

            expect(chunks).toHaveLength(3);
            expect(chunks[0]).toEqual({ type: 'text', text: 'hello' });
            expect(chunks[1].type).toBe('usage');
            expect(chunks[2]).toEqual({ type: 'done' });
        });

        it('runs processStream middleware around the stream', async () => {
            const mw: ChatMiddleware = {
                name: 'logger',
                async process(ctx, next) { return next(); },
                async *processStream(ctx, next) {
                    yield { type: 'text', text: '[start] ' };
                    yield* next();
                    yield { type: 'text', text: ' [end]' };
                },
            };
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, [mw]);
            const texts: string[] = [];

            for await (const chunk of wrapped.getResponseStream([{ role: 'user', content: 'hi' }])) {
                if (chunk.type === 'text') { texts.push(chunk.text); }
            }

            expect(texts).toEqual(['[start] ', 'hello', ' [end]']);
        });

        it('skips middleware without processStream', async () => {
            const mwWithout: ChatMiddleware = {
                name: 'no-stream',
                async process(ctx, next) { return next(); },
                // no processStream
            };
            const inner = makeMockClient();
            const wrapped = new ChatClientWithMiddleware(inner, [mwWithout]);
            const chunks: ChatStreamChunk[] = [];

            for await (const chunk of wrapped.getResponseStream([{ role: 'user', content: 'hi' }])) {
                chunks.push(chunk);
            }

            expect(chunks).toHaveLength(3); // passes through unchanged
        });

        it('chains multiple processStream middleware correctly', async () => {
            const outer: ChatMiddleware = {
                name: 'outer',
                async process(ctx, next) { return next(); },
                async *processStream(ctx, next) {
                    yield { type: 'text', text: 'A' };
                    yield* next();
                    yield { type: 'text', text: 'D' };
                },
            };
            const inner: ChatMiddleware = {
                name: 'inner',
                async process(ctx, next) { return next(); },
                async *processStream(ctx, next) {
                    yield { type: 'text', text: 'B' };
                    yield* next();
                    yield { type: 'text', text: 'C' };
                },
            };

            const client = makeMockClient({
                getResponseStream: vi.fn(async function* () {
                    yield { type: 'text' as const, text: '*' };
                }),
            });
            const wrapped = new ChatClientWithMiddleware(client, [outer, inner]);
            const texts: string[] = [];

            for await (const chunk of wrapped.getResponseStream([{ role: 'user', content: '' }])) {
                if (chunk.type === 'text') { texts.push(chunk.text); }
            }

            expect(texts).toEqual(['A', 'B', '*', 'C', 'D']);
        });
    });
});
