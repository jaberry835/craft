/**
 * Azure OpenAI client - makes raw HTTPS calls (no SDK dependency for offline use).
 * Supports streaming responses with tool/function calling.
 */
import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { AoaiConfig, ChatMessage, ToolDefinition, AoaiStreamChunk, ToolCall } from './types';
import { getSetting } from './config';

export class AzureOpenAIClient {
    private secrets?: vscode.SecretStorage;
    private cachedSecretKey?: string;

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

    getConfig(): AoaiConfig {
        const provider = (getSetting<string>('azureOpenAI.provider') || 'direct') as 'direct' | 'apim';
        const endpoint = getSetting<string>('azureOpenAI.endpoint') || '';
        const apimBaseUrl = getSetting<string>('azureOpenAI.apimBaseUrl') || '';
        // apiKey is resolved async via getApiKey() — callers that need it should call getConfigAsync()
        const apiKey = this.cachedSecretKey || getSetting<string>('azureOpenAI.apiKey') || '';
        const deploymentId = getSetting<string>('azureOpenAI.activeDeployment') || '';
        const apiVersion = getSetting<string>('azureOpenAI.apiVersion') || '2024-06-01';
        const maxTokens = getSetting<number>('maxTokens') || 16384;
        const temperature = getSetting<number>('temperature') || 0.3;

        return { provider, endpoint, apimBaseUrl, apiKey, deploymentId, apiVersion, maxTokens, temperature };
    }

    async getConfigAsync(): Promise<AoaiConfig> {
        const provider = (getSetting<string>('azureOpenAI.provider') || 'direct') as 'direct' | 'apim';
        const endpoint = getSetting<string>('azureOpenAI.endpoint') || '';
        const apimBaseUrl = getSetting<string>('azureOpenAI.apimBaseUrl') || '';
        const apiKey = await this.getApiKey();
        const deploymentId = getSetting<string>('azureOpenAI.activeDeployment') || '';
        const apiVersion = getSetting<string>('azureOpenAI.apiVersion') || '2024-06-01';
        const maxTokens = getSetting<number>('maxTokens') || 16384;
        const temperature = getSetting<number>('temperature') || 0.3;

        return { provider, endpoint, apimBaseUrl, apiKey, deploymentId, apiVersion, maxTokens, temperature };
    }

    async validate(): Promise<string | null> {
        const c = await this.getConfigAsync();
        if (c.provider === 'apim') {
            if (!c.apimBaseUrl) { return 'APIM base URL is not configured. Set junior.azureOpenAI.apimBaseUrl in settings.'; }
        } else {
            if (!c.endpoint) { return 'Azure OpenAI endpoint is not configured.'; }
        }
        if (!c.apiKey) { return 'Azure OpenAI API key is not configured. Run "Junior: Set API Key" to store it securely.'; }
        if (!c.deploymentId) { return 'No model deployment selected. Run "Junior: Select Model".'; }
        return null;
    }

    /**
     * Stream a chat completion with tool definitions.
     * Yields partial text content and returns the final accumulated tool_calls (if any).
     */
    async *streamChat(
        messages: ChatMessage[],
        tools: ToolDefinition[],
        abortSignal?: AbortSignal
    ): AsyncGenerator<{ type: 'text'; text: string } | { type: 'toolCalls'; calls: ToolCall[] } | { type: 'done' }> {
        const config = await this.getConfigAsync();
        const base = (config.provider === 'apim' ? config.apimBaseUrl : config.endpoint).replace(/\/+$/, '');
        const url = new URL(
            `${base}/openai/deployments/${encodeURIComponent(config.deploymentId)}/chat/completions?api-version=${config.apiVersion}`
        );

        const body = JSON.stringify({
            messages,
            max_completion_tokens: config.maxTokens,
            temperature: config.temperature,
            stream: true,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
        });

        const response = await this.httpRequestWithRetry(url, body, config.apiKey, abortSignal);

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

                const choice = parsed.choices?.[0];
                if (!choice) { continue; }

                if (choice.delta.content) {
                    yield { type: 'text', text: choice.delta.content };
                }

                if (choice.delta.tool_calls) {
                    hasToolCalls = true;
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
        maxRetries: number = 3
    ): Promise<AsyncIterable<string>> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.httpRequest(url, body, apiKey, abortSignal);
            } catch (err: any) {
                const retryable = err.statusCode === 429 || err.statusCode === 503;
                if (!retryable || attempt === maxRetries) { throw err; }
                const waitSec = err.retryAfter && err.retryAfter > 0
                    ? Math.min(err.retryAfter, 120)
                    : Math.min(10 * Math.pow(2, attempt), 120);
                // Notify via a custom event so the UI can show the wait
                if ((this as any)._onRetry) { (this as any)._onRetry(waitSec, attempt + 1, maxRetries); }
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, waitSec * 1000);
                    if (abortSignal) {
                        const onAbort = () => { clearTimeout(timer); resolve(); };
                        abortSignal.addEventListener('abort', onAbort, { once: true });
                    }
                });
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
        abortSignal?: AbortSignal
    ): Promise<AsyncIterable<string>> {
        return new Promise((resolve, reject) => {
            if (abortSignal?.aborted) {
                reject(new Error('Aborted'));
                return;
            }

            const isHttps = url.protocol === 'https:';
            const mod = isHttps ? https : http;

            const req = mod.request(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'api-key': apiKey
                    }
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 400) {
                        let errBody = '';
                        res.on('data', (d: Buffer) => { errBody += d.toString(); });
                        res.on('end', () => {
                            const err = new Error(`Azure OpenAI returned ${res.statusCode}: ${errBody}`) as any;
                            err.statusCode = res.statusCode;
                            err.retryAfter = res.headers['retry-after']
                                ? parseInt(res.headers['retry-after'] as string, 10) : undefined;
                            reject(err);
                        });
                        return;
                    }

                    res.setEncoding('utf8');
                    const iterable: AsyncIterable<string> = {
                        [Symbol.asyncIterator]() {
                            return {
                                next() {
                                    return new Promise((innerResolve) => {
                                        const onData = (chunk: string) => {
                                            res.removeListener('data', onData);
                                            res.removeListener('end', onEnd);
                                            res.removeListener('error', onError);
                                            innerResolve({ value: chunk, done: false });
                                        };
                                        const onEnd = () => {
                                            res.removeListener('data', onData);
                                            res.removeListener('error', onError);
                                            innerResolve({ value: '', done: true });
                                        };
                                        const onError = (err: Error) => {
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

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}


