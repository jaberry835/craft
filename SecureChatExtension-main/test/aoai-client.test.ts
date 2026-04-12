import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AzureOpenAIClient } from '../src/aoaiClient';

function rateLimitError(retryAfter: number): Error & { statusCode: number; retryAfter: number } {
    const error = new Error(`API returned 429: rate limited`) as Error & { statusCode: number; retryAfter: number };
    error.statusCode = 429;
    error.retryAfter = retryAfter;
    return error;
}

function emptyStream(): AsyncIterable<string> {
    return {
        async *[Symbol.asyncIterator]() {
            yield 'data: [DONE]\n';
        },
    };
}

describe('AzureOpenAIClient retry budget', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('fails fast when the next retry delay exceeds the remaining retry budget', async () => {
        const client = new AzureOpenAIClient();
        const httpRequest = vi.fn().mockRejectedValue(rateLimitError(5));
        (client as any).httpRequest = httpRequest;

        const promise = (client as any).httpRequestWithRetry(
            new URL('https://example.com'),
            '{}',
            'key',
            undefined,
            3,
            'direct',
            2000
        );

        await expect(promise).rejects.toThrow(/retry budget/i);
        expect(httpRequest).toHaveBeenCalledTimes(1);
    });

    it('emits a reconnecting callback after the countdown reaches zero', async () => {
        const client = new AzureOpenAIClient();
        const httpRequest = vi.fn()
            .mockRejectedValueOnce(rateLimitError(2))
            .mockResolvedValueOnce(emptyStream());
        (client as any).httpRequest = httpRequest;

        const onRetry = vi.fn();
        client.setRetryCallback(onRetry);

        const promise = (client as any).httpRequestWithRetry(
            new URL('https://example.com'),
            '{}',
            'key',
            undefined,
            3,
            'direct',
            10_000
        );

        await vi.advanceTimersByTimeAsync(2_000);
        await promise;

        expect(onRetry).toHaveBeenCalledWith(2, 1, 3);
        expect(onRetry).toHaveBeenCalledWith(1, 1, 3);
        expect(onRetry).toHaveBeenCalledWith(0, 1, 3);
        expect(httpRequest).toHaveBeenCalledTimes(2);
    });
});