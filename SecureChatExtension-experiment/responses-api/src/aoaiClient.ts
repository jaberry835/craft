/**
 * Azure OpenAI client - makes raw HTTPS calls (no SDK dependency for offline use).
 * Supports streaming responses with tool/function calling.
 */
import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { AoaiConfig, ChatMessage, ToolDefinition, AoaiStreamChunk, ToolCall, TokenUsage } from './types';
import { getSetting } from './config';

export interface AzureOpenAIBearerAuthSessionConfig {
    providerId: string;
    scopes: string[];
}

type AzureOpenAIAuthMode = 'api-key' | 'bearer-token' | 'vscode-auth-session';

export class AzureOpenAIClient {
    private static readonly REQUEST_TIMEOUT_MS = 120_000;
    private static readonly STREAM_STALL_TIMEOUT_MS = 90_000;
    private static readonly MAX_RETRY_DELAY_SECONDS = 120;
    private static readonly MAX_TOTAL_RETRY_WINDOW_MS = 180_000;

    private secrets?: vscode.SecretStorage;
    private cachedSecretKey?: string;
    /** Temporary deployment override — set by the agent loop for fallback recovery. */
    private deploymentOverride?: string;
    private retryCallback?: (waitSec: number, attempt: number, maxRetries: number) => void;

    /** Temporarily override the active deployment (e.g. for model fallback). Pass undefined to clear. */
    setDeploymentOverride(deploymentId: string | undefined) {
        this.deploymentOverride = deploymentId;
    }

    /** Returns the current effective deployment ID (override or configured). */
    getEffectiveDeployment(): string {
        return this.deploymentOverride || getSetting<string>('azureOpenAI.activeDeployment') || '';
    }

    /** Look up the deployment entry from the deployments array for the active deployment. */
    private getDeploymentEntry(): { name: string; deploymentId: string; apiVersion?: string } | undefined {
        const deployments = getSetting<Array<{ name: string; deploymentId: string; apiVersion?: string }>>('azureOpenAI.deployments') || [];
        const active = this.getEffectiveDeployment();
        return deployments.find(d => d.deploymentId === active);
    }

    setSecretStorage(secrets: vscode.SecretStorage) {
        this.secrets = secrets;
        // Invalidate cache when secrets change
        secrets.onDidChange(e => {
            if (e.key === 'junior.apiKey' || e.key === 'securechat.apiKey') { this.cachedSecretKey = undefined; }
        });
    }

    async storeApiKey(key: string): Promise<void> {
        if (!this.secrets) { return; }
        await this.secrets.store('junior.apiKey', key);
        // Keep legacy key updated for compatibility with older builds.
        await this.secrets.store('securechat.apiKey', key);
        this.cachedSecretKey = key;
    }

    async getApiKey(): Promise<string> {
        // 1. Cached secret
        if (this.cachedSecretKey) { return this.cachedSecretKey; }
        // 2. SecretStorage
        if (this.secrets) {
            const stored = await this.secrets.get('junior.apiKey') || await this.secrets.get('securechat.apiKey');
            if (stored) {
                this.cachedSecretKey = stored;
                return stored;
            }
        }
        // 3. Fallback to settings.json
        return getSetting<string>('azureOpenAI.apiKey') || '';
    }

    getBearerToken(): string {
        return (getSetting<string>('azureOpenAI.bearerToken') || '').trim();
    }

    getAuthMode(provider: 'direct' | 'apim' | 'openai'): AzureOpenAIAuthMode {
        if (provider === 'openai') {
            return 'api-key';
        }

        const configured = (getSetting<string>('azureOpenAI.authMode') || 'api-key').trim().toLowerCase();
        if (configured === 'bearer-token' || configured === 'vscode-auth-session') {
            return configured;
        }

        return 'api-key';
    }

    getConfig(): AoaiConfig {
        const provider = (getSetting<string>('azureOpenAI.provider') || 'direct') as 'direct' | 'apim' | 'openai';
        const endpoint = getSetting<string>('azureOpenAI.endpoint') || '';
        const apimBaseUrl = getSetting<string>('azureOpenAI.apimBaseUrl') || '';
        const authMode = this.getAuthMode(provider);
        const authHeader = provider === 'openai' || authMode !== 'api-key' ? 'bearer' : 'api-key';
        const authToken = provider === 'openai'
            ? (this.cachedSecretKey || getSetting<string>('azureOpenAI.apiKey') || '')
            : authMode === 'api-key'
                ? (this.cachedSecretKey || getSetting<string>('azureOpenAI.apiKey') || '')
                : this.getBearerToken();
        const deploymentId = this.getEffectiveDeployment();
        const entry = this.getDeploymentEntry();
        const apiVersion = entry?.apiVersion || getSetting<string>('azureOpenAI.apiVersion') || '2024-06-01';
        const maxTokens = getSetting<number>('maxTokens') || 16384;
        const temperature = getSetting<number>('temperature') || 0.3;

        return {
            provider,
            endpoint,
            apimBaseUrl,
            authHeader,
            authToken,
            deploymentId,
            apiVersion,
            maxTokens,
            temperature,
            ...(authMode === 'vscode-auth-session' ? { authSession: getAzureOpenAIBearerAuthSessionConfig() } : {}),
        };
    }

    async getConfigAsync(): Promise<AoaiConfig> {
        const provider = (getSetting<string>('azureOpenAI.provider') || 'direct') as 'direct' | 'apim' | 'openai';
        const endpoint = getSetting<string>('azureOpenAI.endpoint') || '';
        const apimBaseUrl = getSetting<string>('azureOpenAI.apimBaseUrl') || '';
        const authMode = this.getAuthMode(provider);
        const authSession = authMode === 'vscode-auth-session'
            ? getAzureOpenAIBearerAuthSessionConfig()
            : undefined;
        const authToken = provider === 'openai'
            ? await this.getApiKey()
            : authMode === 'api-key'
                ? await this.getApiKey()
                : authMode === 'bearer-token'
                    ? this.getBearerToken()
                    : await this.getBearerTokenFromSession(authSession);
        const authHeader = provider === 'openai' || authMode !== 'api-key' ? 'bearer' : 'api-key';
        const deploymentId = this.getEffectiveDeployment();
        const entry = this.getDeploymentEntry();
        const apiVersion = entry?.apiVersion || getSetting<string>('azureOpenAI.apiVersion') || '2024-06-01';
        const maxTokens = getSetting<number>('maxTokens') || 16384;
        const temperature = getSetting<number>('temperature') || 0.3;

        return { provider, endpoint, apimBaseUrl, authHeader, authToken, deploymentId, apiVersion, maxTokens, temperature, ...(authSession ? { authSession } : {}) };
    }

    async validate(): Promise<string | null> {
        const c = await this.getConfigAsync();
        if (c.provider === 'openai') {
            if (!c.authToken) { return 'OpenAI API key is not configured. Run "Junior: Set API Key" to store it securely.'; }
            if (!c.deploymentId) { return 'No model selected. Run "Junior: Select Model" or add models to the deployments list.'; }
        } else if (c.provider === 'apim') {
            if (!c.apimBaseUrl) { return 'APIM base URL is not configured. Set junior.azureOpenAI.apimBaseUrl in settings.'; }
            if (!c.authToken) {
                return c.authHeader === 'api-key'
                    ? 'Azure OpenAI API key is not configured. Run "Junior: Set API Key" to store it securely.'
                    : 'Azure/APIM bearer token is not configured. Set junior.azureOpenAI.bearerToken or use junior.azureOpenAI.authMode = vscode-auth-session.';
            }
            if (!c.deploymentId) { return 'No model deployment selected. Run "Junior: Select Model".'; }
        } else {
            if (!c.endpoint) { return 'Azure OpenAI endpoint is not configured.'; }
            if (!c.authToken) {
                return c.authHeader === 'api-key'
                    ? 'Azure OpenAI API key is not configured. Run "Junior: Set API Key" to store it securely.'
                    : 'Azure bearer token is not configured. Set junior.azureOpenAI.bearerToken or use junior.azureOpenAI.authMode = vscode-auth-session.';
            }
            if (!c.deploymentId) { return 'No model deployment selected. Run "Junior: Select Model".'; }
        }
        return null;
    }

    /**
     * Stream a chat completion with tool definitions.
     * Yields partial text content and returns the final accumulated tool_calls (if any).
     */
    async *streamChat(
        messages: ChatMessage[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal,
        options?: { reasoningMode?: boolean; maxTokens?: number; temperature?: number; stop?: string[] }
    ): AsyncGenerator<{ type: 'text'; text: string } | { type: 'toolCallStarted' } | { type: 'toolCalls'; calls: ToolCall[] } | { type: 'usage'; usage: TokenUsage } | { type: 'done' }> {
        const config = await this.getConfigAsync();

        let url: URL;
        if (config.provider === 'openai') {
            const openaiBase = (getSetting<string>('azureOpenAI.openaiBaseUrl') || 'https://api.openai.com/v1').replace(/\/+$/, '');
            url = new URL(`${openaiBase}/chat/completions`);
        } else {
            const base = (config.provider === 'apim' ? config.apimBaseUrl : config.endpoint).replace(/\/+$/, '');
            url = new URL(
                `${base}/openai/deployments/${encodeURIComponent(config.deploymentId)}/chat/completions?api-version=${config.apiVersion}`
            );
        }

        // In reasoning mode, convert system→developer role and drop temperature
        // to be compatible with reasoning models (o-series, some GPT-5.x variants)
        const effectiveMessages = options?.reasoningMode
            ? messages.map(m => m.role === 'system' ? { ...m, role: 'developer' as const } : m)
            : messages;

        const effectiveMaxTokens = options?.maxTokens ?? config.maxTokens;
        const effectiveTemperature = options?.temperature ?? config.temperature;

        // stream_options requires API version >= 2024-08-01-preview
        const supportsStreamOptions = config.apiVersion >= '2024-08-01';

        // stream_options is supported by OpenAI, Azure OpenAI, and APIM-proxied Azure OpenAI;
        // many OAI-compatible endpoints (vLLM, LiteLLM, etc.) reject it with 400.
        const isNativeProvider = config.provider === 'openai' || config.provider === 'direct' || config.provider === 'apim';

        const body = JSON.stringify({
            messages: effectiveMessages,
            max_completion_tokens: effectiveMaxTokens,
            ...(options?.reasoningMode ? {} : { temperature: effectiveTemperature }),
            stream: true,
            ...(supportsStreamOptions && isNativeProvider ? { stream_options: { include_usage: true } } : {}),
            ...(options?.stop ? { stop: options.stop } : {}),
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
            // OpenAI requires the model in the body; Azure OpenAI uses the deployment in the URL
            ...(config.provider === 'openai' ? { model: config.deploymentId } : {})
        });

        const response = await this.httpRequestWithRetry(url, body, config.authHeader, config.authToken, abortSignal, 3, config.provider);

        const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();
        let hasToolCalls = false;
        let buffer = '';

        for await (const chunk of response) {
            if (abortSignal?.aborted) { return; }

            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
                const data = trimmed.slice(6);
                if (data === '[DONE]') {
                    if (hasToolCalls) {
                        const calls: ToolCall[] = [];
                        for (const [, tc] of toolCallAccumulator) {
                            calls.push({
                                id: tc.id,
                                type: 'function',
                                function: { name: tc.name, arguments: tc.arguments }
                            });
                        }
                        yield { type: 'toolCalls', calls };
                    }
                    yield { type: 'done' };
                    return;
                }

                let parsed: AoaiStreamChunk;
                try { parsed = JSON.parse(data); } catch { continue; }

                // Usage arrives on the final chunk (choices may be empty)
                if (parsed.usage) {
                    yield { type: 'usage', usage: parsed.usage };
                }

                const choice = parsed.choices?.[0];
                if (!choice) { continue; }

                if (choice.delta.content) {
                    yield { type: 'text', text: choice.delta.content };
                }

                if (choice.delta.tool_calls) {
                    if (!hasToolCalls) {
                        hasToolCalls = true;
                        yield { type: 'toolCallStarted' };
                    }
                    for (const tc of choice.delta.tool_calls) {
                        const existing = toolCallAccumulator.get(tc.index);
                        if (!existing) {
                            toolCallAccumulator.set(tc.index, {
                                id: tc.id || '',
                                name: tc.function?.name || '',
                                arguments: tc.function?.arguments || ''
                            });
                        } else {
                            if (tc.id) { existing.id = tc.id; }
                            if (tc.function?.name) { existing.name += tc.function.name; }
                            if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
                        }
                    }
                }
            }
        }

        // If stream ended without [DONE]
        if (hasToolCalls) {
            const calls: ToolCall[] = [];
            for (const [, tc] of toolCallAccumulator) {
                calls.push({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments }
                });
            }
            yield { type: 'toolCalls', calls };
        }
        yield { type: 'done' };
    }

    /**
     * Retry wrapper for httpRequest — retries on 429 (rate limit) and 503 (service unavailable)
     * using the Retry-After header or exponential backoff, up to 3 attempts.
     */
    private async httpRequestWithRetry(
        url: URL,
        body: string,
        authHeader: 'api-key' | 'bearer',
        authToken: string,
        abortSignal?: AbortSignal,
        maxRetries: number = 3,
        provider: 'direct' | 'apim' | 'openai' = 'direct',
        retryBudgetMs: number = AzureOpenAIClient.MAX_TOTAL_RETRY_WINDOW_MS
    ): Promise<AsyncIterable<string>> {
        let currentBody = body;
        let paramStripped = false;
        const startedAt = Date.now();
        const retryDeadline = startedAt + retryBudgetMs;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const remainingBudgetMs = retryDeadline - Date.now();
                if (remainingBudgetMs <= 0) {
                    throw this.buildRetryBudgetExceededError(attempt, maxRetries, startedAt);
                }
                return await this.httpRequest(url, currentBody, authHeader, authToken, abortSignal, provider, remainingBudgetMs);
            } catch (err: any) {
                const retryable = err.statusCode === 429 || err.statusCode === 500
                    || err.statusCode === 502 || err.statusCode === 503;

                // Strip unsupported parameters (stream_options, max_completion_tokens, tool_choice)
                // and retry — needed for OAI-compatible endpoints that reject newer API params.
                if (err.statusCode === 400 && !paramStripped) {
                    const msg = String(err.message ?? '').toLowerCase();
                    const isParamError = msg.includes('unknown parameter')
                        || msg.includes('unsupported parameter')
                        || msg.includes('unrecognized request argument')
                        || msg.includes('stream_options')
                        || msg.includes('max_completion_tokens')
                        || msg.includes('tool_choice');
                    if (isParamError) {
                        paramStripped = true;
                        try {
                            const parsed = JSON.parse(currentBody);
                            delete parsed.stream_options;
                            delete parsed.tool_choice;
                            if (parsed.max_completion_tokens !== undefined) {
                                parsed.max_tokens = parsed.max_completion_tokens;
                                delete parsed.max_completion_tokens;
                            }
                            currentBody = JSON.stringify(parsed);
                        } catch { /* body wasn't parseable — skip stripping */ }
                        continue; // retry immediately with stripped params
                    }
                }
                if (!retryable || attempt === maxRetries) { throw err; }
                const requestedWaitSec = err.retryAfter && err.retryAfter > 0
                    ? Math.min(err.retryAfter, AzureOpenAIClient.MAX_RETRY_DELAY_SECONDS)
                    : Math.min(10 * Math.pow(2, attempt), AzureOpenAIClient.MAX_RETRY_DELAY_SECONDS);
                const requestedWaitMs = requestedWaitSec * 1000;
                const remainingBudgetMs = retryDeadline - Date.now();
                if (remainingBudgetMs <= 0 || requestedWaitMs > remainingBudgetMs) {
                    throw this.buildRetryBudgetExceededError(attempt + 1, maxRetries, startedAt, err, requestedWaitMs, remainingBudgetMs);
                }

                // Countdown: notify the UI every second so it can show a live timer.
                for (let remainingMs = requestedWaitMs; remainingMs > 0; remainingMs -= 1000) {
                    if (abortSignal?.aborted) { throw new Error('Aborted'); }
                    this.retryCallback?.(Math.ceil(remainingMs / 1000), attempt + 1, maxRetries);
                    await this.delayWithAbort(Math.min(1000, remainingMs), abortSignal);
                }
                this.retryCallback?.(0, attempt + 1, maxRetries);
                if (abortSignal?.aborted) { throw new Error('Aborted'); }
            }
        }
        throw new Error('Unreachable');
    }

    /** Set a callback to be notified when a rate-limit retry is happening */
    setRetryCallback(cb?: (waitSec: number, attempt: number, maxRetries: number) => void) {
        this.retryCallback = cb;
    }

    private httpRequest(
        url: URL,
        body: string,
        authHeader: 'api-key' | 'bearer',
        authToken: string,
        abortSignal?: AbortSignal,
        provider: 'direct' | 'apim' | 'openai' = 'direct',
        timeoutBudgetMs: number = AzureOpenAIClient.REQUEST_TIMEOUT_MS
    ): Promise<AsyncIterable<string>> {
        return new Promise((resolve, reject) => {
            if (abortSignal?.aborted) {
                reject(new Error('Aborted'));
                return;
            }

            const requestTimeoutMs = Math.max(1_000, Math.min(AzureOpenAIClient.REQUEST_TIMEOUT_MS, timeoutBudgetMs));

            const isHttps = url.protocol === 'https:';
            const mod = isHttps ? https : http;

            const authHeaders = this.buildAuthHeaders(authHeader, authToken);

            const req = mod.request(
                url,
                {
                    method: 'POST',
                    timeout: requestTimeoutMs,
                    headers: {
                        'Content-Type': 'application/json',
                        ...authHeaders
                    }
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 400) {
                        let errBody = '';
                        res.on('data', (d: Buffer) => { errBody += d.toString(); });
                        res.on('end', () => {
                            const err = new Error(`API returned ${res.statusCode}: ${errBody}`) as any;
                            err.statusCode = res.statusCode;
                            err.retryAfter = res.headers['retry-after']
                                ? parseInt(res.headers['retry-after'] as string, 10) : undefined;
                            // Parse structured error fields when available
                            try {
                                const parsed = JSON.parse(errBody);
                                const inner = parsed?.error || parsed;
                                if (inner.code) { err.errorCode = inner.code; }
                                if (inner.param) { err.errorParam = inner.param; }
                            } catch { /* body wasn't JSON — leave fields unset */ }
                            reject(err);
                        });
                        return;
                    }

                    res.setEncoding('utf8');
                    const streamStallTimeoutMs = Math.max(1_000, Math.min(AzureOpenAIClient.STREAM_STALL_TIMEOUT_MS, timeoutBudgetMs));
                    const iterable: AsyncIterable<string> = {
                        [Symbol.asyncIterator]() {
                            return {
                                next() {
                                    return new Promise((innerResolve, innerReject) => {
                                        const stallTimer = setTimeout(() => {
                                            res.removeListener('data', onData);
                                            res.removeListener('end', onEnd);
                                            res.removeListener('error', onError);
                                            res.destroy();
                                            innerReject(new Error(`Stream stalled — no data received for ${Math.ceil(streamStallTimeoutMs / 1000)}s. The server may be overloaded.`));
                                        }, streamStallTimeoutMs);
                                        const onData = (chunk: string) => {
                                            clearTimeout(stallTimer);
                                            res.removeListener('data', onData);
                                            res.removeListener('end', onEnd);
                                            res.removeListener('error', onError);
                                            innerResolve({ value: chunk, done: false });
                                        };
                                        const onEnd = () => {
                                            clearTimeout(stallTimer);
                                            res.removeListener('data', onData);
                                            res.removeListener('error', onError);
                                            innerResolve({ value: '', done: true });
                                        };
                                        const onError = (err: Error) => {
                                            clearTimeout(stallTimer);
                                            res.removeListener('data', onData);
                                            res.removeListener('end', onEnd);
                                            innerResolve({ value: '', done: true });
                                        };
                                        res.once('data', onData);
                                        res.once('end', onEnd);
                                        res.once('error', onError);
                                    });
                                }
                            };
                        }
                    };
                    resolve(iterable);
                }
            );

            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    req.destroy();
                    reject(new Error('Aborted'));
                }, { once: true });
            }

            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Request timed out after ${Math.ceil(requestTimeoutMs / 1000)}s — the server may be overloaded.`));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    private buildAuthHeaders(authHeader: 'api-key' | 'bearer', authToken: string): Record<string, string> {
        return authHeader === 'bearer'
            ? { 'Authorization': `Bearer ${authToken}` }
            : { 'api-key': authToken };
    }

    private async getBearerTokenFromSession(authSession: AzureOpenAIBearerAuthSessionConfig | undefined): Promise<string> {
        if (!authSession) {
            return '';
        }

        const session = await vscode.authentication.getSession(
            authSession.providerId,
            authSession.scopes,
            { createIfNone: true }
        );

        return session?.accessToken || '';
    }

    private async delayWithAbort(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), delayMs);
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            }
        });
    }

    private buildRetryBudgetExceededError(
        attemptsUsed: number,
        maxRetries: number,
        startedAt: number,
        lastError?: Error,
        requestedWaitMs?: number,
        remainingBudgetMs?: number
    ): Error {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const requestedWaitSeconds = requestedWaitMs !== undefined ? Math.ceil(requestedWaitMs / 1000) : undefined;
        const remainingBudgetSeconds = remainingBudgetMs !== undefined ? Math.max(0, Math.ceil(remainingBudgetMs / 1000)) : undefined;
        const detail = lastError?.message ? ` Last error: ${lastError.message}` : '';
        const budgetDetail = requestedWaitSeconds !== undefined && remainingBudgetSeconds !== undefined
            ? ` The next retry required waiting ${requestedWaitSeconds}s, but only ${remainingBudgetSeconds}s remained in the retry window.`
            : '';
        return new Error(
            `Request exhausted its retry budget after ${attemptsUsed} of ${maxRetries} retries and ${elapsedSeconds}s without a successful response.${budgetDetail}${detail}`
        );
    }
}

export function getAzureOpenAIBearerAuthSessionConfig(): AzureOpenAIBearerAuthSessionConfig | undefined {
    const authMode = (getSetting<string>('azureOpenAI.authMode') || 'api-key').trim().toLowerCase();
    if (authMode !== 'vscode-auth-session') {
        return undefined;
    }

    const source = (getSetting<string>('azureOpenAI.bearerTokenSource') || 'vscode-auth-session').trim().toLowerCase();
    if (source !== 'vscode-auth-session') {
        return undefined;
    }

    const providerId = (getSetting<string>('azureOpenAI.authProviderId') || 'microsoft').trim() || 'microsoft';
    const scopes = normalizeStringArray(getSetting<string[]>('azureOpenAI.authScopes'));

    return {
        providerId,
        scopes,
    };
}

function normalizeStringArray(values: string[] | undefined): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return values
        .map(value => typeof value === 'string' ? value.trim() : '')
        .filter((value): value is string => value.length > 0);
}


