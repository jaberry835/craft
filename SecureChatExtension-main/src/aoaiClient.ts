/**
 * Azure OpenAI client - makes raw HTTPS calls (no SDK dependency for offline use).
 * Supports streaming responses with tool/function calling.
 */
import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { AoaiConfig, ChatMessage, ToolDefinition, AoaiStreamChunk, ToolCall } from './types';

export class AzureOpenAIClient {

    getConfig(): AoaiConfig {
        const cfg = vscode.workspace.getConfiguration('securechat');
        const aoai = vscode.workspace.getConfiguration('securechat.azureOpenAI');

        const endpoint = aoai.get<string>('endpoint') || '';
        const apiKey = aoai.get<string>('apiKey') || '';
        const deploymentId = aoai.get<string>('activeDeployment') || '';
        const apiVersion = aoai.get<string>('apiVersion') || '2024-06-01';
        const maxTokens = cfg.get<number>('maxTokens') || 4096;
        const temperature = cfg.get<number>('temperature') || 0.3;

        return { endpoint, apiKey, deploymentId, apiVersion, maxTokens, temperature };
    }

    validate(): string | null {
        const c = this.getConfig();
        if (!c.endpoint) { return 'Azure OpenAI endpoint is not configured.'; }
        if (!c.apiKey) { return 'Azure OpenAI API key is not configured.'; }
        if (!c.deploymentId) { return 'No model deployment selected. Run "SecureChat: Select Model".'; }
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
        const config = this.getConfig();
        const url = new URL(
            `/openai/deployments/${encodeURIComponent(config.deploymentId)}/chat/completions?api-version=${config.apiVersion}`,
            config.endpoint
        );

        const body = JSON.stringify({
            messages,
            max_tokens: config.maxTokens,
            temperature: config.temperature,
            stream: true,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
        });

        const response = await this.httpRequest(url, body, config.apiKey, abortSignal);

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
                            reject(new Error(`Azure OpenAI returned ${res.statusCode}: ${errBody}`));
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
