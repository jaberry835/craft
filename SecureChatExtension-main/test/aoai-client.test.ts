import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AzureOpenAIClient } from '../src/aoaiClient';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);
const getSessionMock = vi.mocked(vscode.authentication.getSession);

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string) => values[path],
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }));
}

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
        vi.clearAllMocks();
        setConfiguration({});
        getSessionMock.mockResolvedValue(undefined);
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
            'api-key',
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
            'api-key',
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

    it('uses bearer auth headers for APIM bearer-token mode', async () => {
        vi.useRealTimers();
        setConfiguration({
            'azureOpenAI.provider': 'apim',
            'azureOpenAI.apimBaseUrl': 'https://example-apim.contoso.net',
            'azureOpenAI.activeDeployment': 'gpt-5.4',
            'azureOpenAI.authMode': 'bearer-token',
            'azureOpenAI.bearerToken': 'manual-token',
        });

        const client = new AzureOpenAIClient();
        const config = await client.getConfigAsync();

        expect(config.authHeader).toBe('bearer');
        expect(config.authToken).toBe('manual-token');
        expect((client as any).buildAuthHeaders(config.authHeader, config.authToken)).toEqual({
            Authorization: 'Bearer manual-token',
        });
    });

    it('uses a VS Code auth session for APIM bearer mode', async () => {
        vi.useRealTimers();
        setConfiguration({
            'azureOpenAI.provider': 'apim',
            'azureOpenAI.apimBaseUrl': 'https://example-apim.contoso.net',
            'azureOpenAI.activeDeployment': 'gpt-5.4',
            'azureOpenAI.authMode': 'vscode-auth-session',
            'azureOpenAI.bearerTokenSource': 'vscode-auth-session',
            'azureOpenAI.authProviderId': 'microsoft',
            'azureOpenAI.authScopes': ['api://example/user_impersonation'],
        });
        getSessionMock.mockResolvedValue({
            accessToken: 'session-token',
            account: { label: 'user@example.com' },
        } as any);

        const client = new AzureOpenAIClient();
        const config = await client.getConfigAsync();

        expect(getSessionMock).toHaveBeenCalledWith('microsoft', ['api://example/user_impersonation'], { createIfNone: true });
        expect(config.authHeader).toBe('bearer');
        expect(config.authToken).toBe('session-token');
        expect(config.authSession).toEqual({
            providerId: 'microsoft',
            scopes: ['api://example/user_impersonation'],
        });
    });

    it('reports missing bearer configuration for direct Azure bearer mode', async () => {
        vi.useRealTimers();
        setConfiguration({
            'azureOpenAI.provider': 'direct',
            'azureOpenAI.endpoint': 'https://example-resource.openai.azure.com',
            'azureOpenAI.activeDeployment': 'gpt-5.4',
            'azureOpenAI.authMode': 'bearer-token',
        });

        const client = new AzureOpenAIClient();

        await expect(client.validate()).resolves.toMatch(/bearer token/i);
    });
});