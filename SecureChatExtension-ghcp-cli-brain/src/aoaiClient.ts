/**
 * Azure OpenAI client - makes raw HTTPS calls (no SDK dependency for offline use).
 * Supports streaming responses with tool/function calling.
 */
import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { AoaiConfig, ChatMessage, ToolDefinition, AoaiStreamChunk, ToolCall, TokenUsage } from './types';
import { getSetting } from './config';

export class AzureOpenAIClient {
    private secrets?: vscode.SecretStorage;
    private cachedSecretKey?: string;
    /** Temporary deployment override — set by the agent loop for fallback recovery. */
    private deploymentOverride?: string;

    /** Temporarily override the active deployment (e.g. for model fallback). Pass undefined to clear. */
    setDeploymentOverride(deploymentId: string | undefined) {
        this.deploymentOverride = deploymentId;
    }

    /** Returns the current effective deployment ID (override or configured). */
    getEffectiveDeployment(): string {
        return this.deploymentOverride || getSetting<string>('api.activeModel') || '';
    }

    setSecretStorage(secrets: vscode.SecretStorage) {
        this.secrets = secrets;
        // Invalidate cache when secrets change
        secrets.onDidChange(e => {
            if (e.key === 'juniorgh.apiKey') { this.cachedSecretKey = undefined; }
        });
    }

    async storeApiKey(key: string): Promise<void> {
        if (!this.secrets) { return; }
        await this.secrets.store('juniorgh.apiKey', key);
        this.cachedSecretKey = key;
    }

    async getApiKey(): Promise<string> {
        // 1. Cached secret
        if (this.cachedSecretKey) { return this.cachedSecretKey; }
        // 2. SecretStorage
        if (this.secrets) {
            const stored = await this.secrets.get('juniorgh.apiKey');
            if (stored) {
                this.cachedSecretKey = stored;
                return stored;
            }
        }
        // 3. Fallback to settings.json
        return getSetting<string>('api.apiKey') || '';
    }

    getConfig(): AoaiConfig {
        const provider = (getSetting<string>('api.provider') || 'azure') as 'azure' | 'apim' | 'openai';
        const endpoint = getSetting<string>('azure.endpoint') || '';
        const apimBaseUrl = getSetting<string>('apim.baseUrl') || '';
        // apiKey is resolved async via getApiKey() — callers that need it should call getConfigAsync()
        const apiKey = this.cachedSecretKey || getSetting<string>('api.apiKey') || '';
        const deploymentId = this.getEffectiveDeployment();
        const apiVersion = getSetting<string>('azure.apiVersion') || '2024-06-01';
        const maxTokens = getSetting<number>('maxTokens') || 16384;
        const temperature = getSetting<number>('temperature') || 0.3;

        return { provider, endpoint, apimBaseUrl, apiKey, deploymentId, apiVersion, maxTokens, temperature };
    }

    async getConfigAsync(): Promise<AoaiConfig> {
        const provider = (getSetting<string>('api.provider') || 'azure') as 'azure' | 'apim' | 'openai';
        const endpoint = getSetting<string>('azure.endpoint') || '';
        const apimBaseUrl = getSetting<string>('apim.baseUrl') || '';
        const apiKey = await this.getApiKey();
        const deploymentId = this.getEffectiveDeployment();
        const apiVersion = getSetting<string>('azure.apiVersion') || '2024-06-01';
        const maxTokens = getSetting<number>('maxTokens') || 16384;
        const temperature = getSetting<number>('temperature') || 0.3;

        return { provider, endpoint, apimBaseUrl, apiKey, deploymentId, apiVersion, maxTokens, temperature };
    }

    async validate(): Promise<string | null> {
        const c = await this.getConfigAsync();
        if (c.provider === 'openai') {
            if (!c.apiKey) { return 'OpenAI API key is not configured. Run "JuniorGH: Set API Key" to store it securely.'; }
            if (!c.deploymentId) { return 'No model selected. Run "JuniorGH: Select Model" or add models to the deployments list.'; }
        } else if (c.provider === 'apim') {
            if (!c.apimBaseUrl) { return 'APIM base URL is not configured. Set juniorgh.apim.baseUrl in settings.'; }
            if (!c.apiKey) { return 'Azure OpenAI API key is not configured. Run "JuniorGH: Set API Key" to store it securely.'; }
            if (!c.deploymentId) { return 'No model deployment selected. Run "JuniorGH: Select Model".'; }
        } else {
            if (!c.endpoint) { return 'Azure OpenAI endpoint is not configured.'; }
            if (!c.apiKey) { return 'Azure OpenAI API key is not configured. Run "JuniorGH: Set API Key" to store it securely.'; }
            if (!c.deploymentId) { return 'No model deployment selected. Run "JuniorGH: Select Model".'; }
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
            const openaiBase = (getSetting<string>('openai.baseUrl') || 'https://api.openai.com/v1').replace(/\/+$/, '');
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

        const body = JSON.stringify({
            messages: effectiveMessages,
            max_completion_tokens: effectiveMaxTokens,
            ...(options?.reasoningMode ? {} : { temperature: effectiveTemperature }),
            stream: true,
            ...(supportsStreamOptions ? { stream_options: { include_usage: true } } : {}),
            ...(options?.stop ? { stop: options.stop } : {}),
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
            // OpenAI requires the model in the body; Azure OpenAI uses the deployment in the URL
            ...(config.provider === 'openai' ? { model: config.deploymentId } : {})
        });

        const response = await this.httpRequestWithRetry(url, body, config.apiKey, abortSignal, 3, config.provider);

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
        apiKey: string,
        abortSignal?: AbortSignal,
        maxRetries: number = 3,
        provider: 'azure' | 'apim' | 'openai' = 'azure'
    ): Promise<AsyncIterable<string>> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.httpRequest(url, body, apiKey, abortSignal, provider);
            } catch (err: any) {
                const retryable = err.statusCode === 429 || err.statusCode === 503;
                if (!retryable || attempt === maxRetries) { throw err; }
                const waitSec = err.retryAfter && err.retryAfter > 0
                    ? Math.min(err.retryAfter, 120)
                    : Math.min(10 * Math.pow(2, attempt), 120);
                // Notify via a custom event so the UI can show the wait
                // Countdown: notify the UI every second so it can show a live timer
                for (let remaining = waitSec; remaining > 0; remaining--) {
                    if (abortSignal?.aborted) { throw new Error('Aborted'); }
                    if ((this as any)._onRetry) { (this as any)._onRetry(remaining, attempt + 1, maxRetries); }
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, 1000);
                        if (abortSignal) {
                            abortSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
                        }
                    });
                }
                if (abortSignal?.aborted) { throw new Error('Aborted'); }
            }
        }
        throw new Error('Unreachable');
    }

    /** Set a callback to be notified when a rate-limit retry is happening */
    setRetryCallback(cb: (waitSec: number, attempt: number, maxRetries: number) => void) {
        (this as any)._onRetry = cb;
    }

    private httpRequest(
        url: URL,
        body: string,
        apiKey: string,
        abortSignal?: AbortSignal,
        provider: 'azure' | 'apim' | 'openai' = 'azure'
    ): Promise<AsyncIterable<string>> {
        return new Promise((resolve, reject) => {
            if (abortSignal?.aborted) {
                reject(new Error('Aborted'));
                return;
            }

            const isHttps = url.protocol === 'https:';
            const mod = isHttps ? https : http;

            // OpenAI uses Bearer token auth; Azure uses api-key header
            const authHeaders = provider === 'openai'
                ? { 'Authorization': `Bearer ${apiKey}` }
                : { 'api-key': apiKey };

            const req = mod.request(
                url,
                {
                    method: 'POST',
                    timeout: 120_000, // 2-minute socket timeout to prevent indefinite hangs
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
                    const STREAM_STALL_TIMEOUT = 90_000; // 90s — if no SSE chunk arrives in this window, bail
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
                                            innerReject(new Error('Stream stalled — no data received for 90s. The server may be overloaded.'));
                                        }, STREAM_STALL_TIMEOUT);
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
                reject(new Error('Request timed out after 120s — the server may be overloaded.'));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}


