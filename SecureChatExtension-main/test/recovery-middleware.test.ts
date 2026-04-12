import { describe, it, expect, vi } from 'vitest';
import { RecoveryMiddleware } from '../src/middleware/recoveryMiddleware';
import type { ChatContext } from '../src/framework/middleware';
import type { ChatResponse, ChatStreamChunk } from '../src/framework/types';

function makeChatContext(messageCount = 3): ChatContext {
    const messages = Array.from({ length: messageCount }, (_, i) => ({
        role: (i === 0 ? 'system' : i % 2 === 1 ? 'user' : 'assistant') as 'system' | 'user' | 'assistant',
        content: `message ${i}`,
    }));
    return {
        client: { modelId: 'test', getResponse: vi.fn(), getResponseStream: vi.fn() } as any,
        messages,
        options: {},
        stream: false,
    };
}

function contextOverflowError(msg = 'context_length_exceeded'): Error & { statusCode: number } {
    const e = new Error(msg) as Error & { statusCode: number };
    e.statusCode = 400;
    return e;
}

function streamStallError(): Error {
    return new Error('stream stalled: no data received for 30s');
}

const chatResponse: ChatResponse = { messages: [], finishReason: 'stop' };

describe('RecoveryMiddleware', () => {
    describe('process() — non-streaming', () => {
        it('passes through when no error', async () => {
            const mw = new RecoveryMiddleware();
            const next = vi.fn().mockResolvedValue(chatResponse);

            const result = await mw.process(makeChatContext(), next);

            expect(result).toBe(chatResponse);
            expect(next).toHaveBeenCalledOnce();
        });

        it('retries on context overflow with emergency trim', async () => {
            const onRecovery = vi.fn();
            const mw = new RecoveryMiddleware({ onRecoveryAttempt: onRecovery });
            const next = vi.fn()
                .mockRejectedValueOnce(contextOverflowError())
                .mockResolvedValueOnce(chatResponse);

            const ctx = makeChatContext(10);
            const result = await mw.process(ctx, next);

            expect(result).toBe(chatResponse);
            expect(next).toHaveBeenCalledTimes(2);
            expect(onRecovery).toHaveBeenCalledWith(1, 'emergency-trim');
        });

        it('applies reasoning mode on second attempt', async () => {
            const onRecovery = vi.fn();
            const mw = new RecoveryMiddleware({ onRecoveryAttempt: onRecovery });
            const next = vi.fn()
                .mockRejectedValueOnce(contextOverflowError())
                .mockRejectedValueOnce(contextOverflowError())
                .mockResolvedValueOnce(chatResponse);

            const ctx = makeChatContext(10);
            await mw.process(ctx, next);

            expect(onRecovery).toHaveBeenCalledWith(2, 'reasoning-mode');
            expect(ctx.options.reasoningMode).toBe(true);
        });

        it('gives up after maxAttempts', async () => {
            const mw = new RecoveryMiddleware({ maxAttempts: 2 });
            const next = vi.fn().mockRejectedValue(contextOverflowError());

            await expect(mw.process(makeChatContext(), next)).rejects.toThrow('context_length_exceeded');
            expect(next).toHaveBeenCalledTimes(3); // 1 original + 2 recovery attempts
        });

        it('does not catch non-overflow errors', async () => {
            const mw = new RecoveryMiddleware();
            const next = vi.fn().mockRejectedValue(new Error('network error'));

            await expect(mw.process(makeChatContext(), next)).rejects.toThrow('network error');
            expect(next).toHaveBeenCalledOnce();
        });

        it('recognizes various overflow error messages', async () => {
            const mw = new RecoveryMiddleware();
            const variants = [
                'invalid_prompt',
                'maximum context length',
                'token limit exceeded',
                'unknown parameter: temperature',
                'unsupported parameter',
                'unrecognized request argument',
            ];

            for (const msg of variants) {
                const next = vi.fn()
                    .mockRejectedValueOnce(contextOverflowError(msg))
                    .mockResolvedValueOnce(chatResponse);

                await mw.process(makeChatContext(), next);
                expect(next).toHaveBeenCalledTimes(2);
            }
        });
    });

    describe('processStream() — streaming', () => {
        async function collectChunks(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
            const chunks: ChatStreamChunk[] = [];
            for await (const c of gen) { chunks.push(c); }
            return chunks;
        }

        it('yields chunks from next() on success', async () => {
            const mw = new RecoveryMiddleware();
            const ctx = makeChatContext();
            async function* fakeStream(): AsyncGenerator<ChatStreamChunk> {
                yield { type: 'text', text: 'hello' };
                yield { type: 'done' };
            }

            const chunks = await collectChunks(mw.processStream(ctx, fakeStream));

            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toEqual({ type: 'text', text: 'hello' });
        });

        it('yields retry chunk on stream stall then succeeds', async () => {
            const onRecovery = vi.fn();
            const mw = new RecoveryMiddleware({ maxStallRetries: 2, onRecoveryAttempt: onRecovery });
            const ctx = makeChatContext();

            let calls = 0;
            async function* fakeStream(): AsyncGenerator<ChatStreamChunk> {
                calls++;
                if (calls === 1) { throw streamStallError(); }
                yield { type: 'text', text: 'recovered' };
                yield { type: 'done' };
            }

            const chunks = await collectChunks(mw.processStream(ctx, fakeStream));

            const retryChunks = chunks.filter(c => c.type === 'retry');
            expect(retryChunks).toHaveLength(1);
            expect((retryChunks[0] as any).reason).toBe('stream-stall-retry');
            expect(chunks.some(c => c.type === 'text')).toBe(true);
        });

        it('yields retry chunk on context overflow then succeeds', async () => {
            const onRecovery = vi.fn();
            const mw = new RecoveryMiddleware({ onRecoveryAttempt: onRecovery });
            const ctx = makeChatContext(10);

            let calls = 0;
            async function* fakeStream(): AsyncGenerator<ChatStreamChunk> {
                calls++;
                if (calls === 1) { throw contextOverflowError(); }
                yield { type: 'text', text: 'ok' };
                yield { type: 'done' };
            }

            const chunks = await collectChunks(mw.processStream(ctx, fakeStream));

            expect(chunks.some(c => c.type === 'retry')).toBe(true);
            expect(chunks.some(c => c.type === 'text')).toBe(true);
            expect(onRecovery).toHaveBeenCalledWith(1, 'emergency-trim');
        });

        it('throws after exhausting all recovery attempts', async () => {
            const mw = new RecoveryMiddleware({ maxAttempts: 1, maxStallRetries: 0 });
            const ctx = makeChatContext();

            async function* fakeStream(): AsyncGenerator<ChatStreamChunk> {
                throw contextOverflowError();
            }

            await expect(collectChunks(mw.processStream(ctx, fakeStream))).rejects.toThrow();
        });

        it('sets activeReasoningMode on tier-2 recovery', async () => {
            const mw = new RecoveryMiddleware();
            const ctx = makeChatContext(10);

            let calls = 0;
            async function* fakeStream(): AsyncGenerator<ChatStreamChunk> {
                calls++;
                if (calls <= 2) { throw contextOverflowError(); }
                yield { type: 'done' };
            }

            expect(mw.activeReasoningMode).toBe(false);
            await collectChunks(mw.processStream(ctx, fakeStream));
            expect(mw.activeReasoningMode).toBe(true);
        });

        it('calls applyFallbackDeployment on tier-3 recovery', async () => {
            const applyFallback = vi.fn();
            const mw = new RecoveryMiddleware({
                findFallbackDeployment: () => 'gpt-4o-fallback',
                applyFallbackDeployment: applyFallback,
            });
            const ctx = makeChatContext(10);

            let calls = 0;
            async function* fakeStream(): AsyncGenerator<ChatStreamChunk> {
                calls++;
                if (calls <= 3) { throw contextOverflowError(); }
                yield { type: 'done' };
            }

            await collectChunks(mw.processStream(ctx, fakeStream));
            expect(applyFallback).toHaveBeenCalledWith('gpt-4o-fallback');
        });
    });
});
