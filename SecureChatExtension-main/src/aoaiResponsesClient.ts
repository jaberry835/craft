/**
 * Azure OpenAI / OpenAI-compatible client for the v1 "responses" wire API.
 *
 * Endpoint: POST {base}/openai/v1/responses
 *
 * Differences vs. the classic chat-completions client (see aoaiClient.ts):
 *   - Model lives in the body (`"model": "gpt-5.4"`), not in the URL path.
 *   - No `?api-version=` query string.
 *   - Server-Sent Events use named event types (response.output_text.delta,
 *     response.reasoning_summary_text.delta, response.function_call_arguments.delta,
 *     response.completed, response.failed, …) instead of opaque `delta` blobs.
 *   - First-class reasoning summary surface and optional server-side conversation
 *     state via `previous_response_id`.
 *
 * This file is intentionally additive — the legacy AzureOpenAIClient is unchanged
 * and remains the default. The agent loop chooses between the two based on the
 * `junior.azureOpenAI.wireApi` setting.
 */
import * as https from 'https';
import * as http from 'http';
import type { AzureOpenAIClient } from './aoaiClient';
import type { IChatClient } from './framework/chatClient';
import type {
    ChatMessage,
    ChatOptions,
    ChatResponse,
    ChatStreamChunk,
    ToolCall,
    ToolDefinition,
} from './framework/types';
import { getSetting } from './config';

// ── Request shaping ────────────────────────────────────────────────────────

/** The /v1/responses request body shape that this client emits. */
export interface ResponsesRequestBody {
    model: string;
    input: ResponsesInputItem[];
    instructions?: string;
    tools?: ResponsesToolDef[];
    tool_choice?: 'auto' | 'required' | 'none';
    stream: boolean;
    store: boolean;
    previous_response_id?: string;
    reasoning?: {
        effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
        summary?: 'auto' | 'detailed';
    };
    text?: { verbosity?: 'low' | 'medium' | 'high' };
    max_output_tokens?: number;
    temperature?: number;
    include?: string[];
}

/** /v1/responses input item — a turn or tool result. */
export type ResponsesInputItem =
    | { type: 'message'; role: 'system' | 'developer' | 'user' | 'assistant'; content: ResponsesContentPart[] }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };

export type ResponsesContentPart =
    | { type: 'input_text'; text: string }
    | { type: 'output_text'; text: string }
    | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' };

export interface ResponsesToolDef {
    type: 'function';
    name: string;
    description?: string;
    parameters: object;
}

/**
 * Convert framework-shape ChatMessage[] + ToolDefinition[] into a /v1/responses body.
 *
 * Notes:
 *  - System messages are coalesced into the top-level `instructions` field
 *    (Responses API best practice; reduces token churn on multi-turn).
 *  - Tool calls and tool results are flattened into the `input` array as
 *    `function_call` / `function_call_output` items (Responses API does not
 *    nest tool_calls inside an assistant message the way chat-completions does).
 */
export function buildResponsesRequest(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: {
        stream: boolean;
        store: boolean;
        previousResponseId?: string;
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
        reasoningSummary?: 'auto' | 'detailed' | 'none';
        maxTokens?: number;
        temperature?: number;
        reasoningMode?: boolean;
    }
): ResponsesRequestBody {
    const instructionsParts: string[] = [];
    const input: ResponsesInputItem[] = [];

    for (const m of messages) {
        if (m.role === 'system' || m.role === 'developer') {
            const txt = stringifyContent(m.content);
            if (txt) { instructionsParts.push(txt); }
            continue;
        }
        if (m.role === 'tool') {
            // tool result → function_call_output
            input.push({
                type: 'function_call_output',
                call_id: m.tool_call_id || '',
                output: stringifyContent(m.content) ?? '',
            });
            continue;
        }
        if (m.role === 'assistant') {
            // Emit tool_calls as separate function_call items (responses-api shape).
            if (m.tool_calls?.length) {
                for (const tc of m.tool_calls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    });
                }
            }
            const txt = stringifyContent(m.content);
            if (txt) {
                input.push({
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: txt }],
                });
            }
            continue;
        }
        // user
        input.push({
            role: 'user',
            type: 'message',
            content: toUserContentParts(m.content),
        });
    }

    const body: ResponsesRequestBody = {
        model,
        input,
        stream: opts.stream,
        store: opts.store,
    };
    if (instructionsParts.length) {
        body.instructions = instructionsParts.join('\n\n');
    }
    if (opts.previousResponseId) {
        body.previous_response_id = opts.previousResponseId;
    }
    if (tools.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        }));
        body.tool_choice = 'auto';
    }
    if (opts.reasoningEffort || (opts.reasoningSummary && opts.reasoningSummary !== 'none')) {
        body.reasoning = {};
        if (opts.reasoningEffort) { body.reasoning.effort = opts.reasoningEffort; }
        if (opts.reasoningSummary && opts.reasoningSummary !== 'none') {
            body.reasoning.summary = opts.reasoningSummary;
        }
    }
    if (opts.maxTokens !== undefined) { body.max_output_tokens = opts.maxTokens; }
    // Responses API rejects `temperature` for reasoning models; only send when not in reasoning mode.
    if (!opts.reasoningMode && opts.temperature !== undefined) { body.temperature = opts.temperature; }
    return body;
}

function stringifyContent(content: ChatMessage['content']): string | undefined {
    if (content == null) { return undefined; }
    if (typeof content === 'string') { return content || undefined; }
    return content
        .map(p => (p.type === 'text' ? p.text : ''))
        .filter(Boolean)
        .join('') || undefined;
}

function toUserContentParts(content: ChatMessage['content']): ResponsesContentPart[] {
    if (content == null) { return [{ type: 'input_text', text: '' }]; }
    if (typeof content === 'string') { return [{ type: 'input_text', text: content }]; }
    return content.map(p => p.type === 'image_url'
        ? { type: 'input_image' as const, image_url: p.image_url.url, ...(p.image_url.detail ? { detail: p.image_url.detail } : {}) }
        : { type: 'input_text' as const, text: p.text }
    );
}

// ── SSE event parsing ─────────────────────────────────────────────────────

/**
 * Pure parser for one decoded SSE `data:` line from /v1/responses.
 *
 * Returns `null` for keepalives, `[DONE]` sentinels, unknown event types,
 * or unparseable JSON. Returns a typed event for the cases we care about.
 *
 * Exported separately so it can be unit-tested without spinning up an HTTP
 * server. See test/aoai-responses-client.test.ts.
 */
export type ResponsesEvent =
    | { kind: 'output_text_delta'; text: string }
    | { kind: 'reasoning_delta'; text: string }
    | { kind: 'reasoning_summary_delta'; text: string }
    | { kind: 'function_call_arguments_delta'; itemId: string; delta: string }
    | { kind: 'function_call_started'; itemId: string; callId: string; name: string }
    | { kind: 'response_completed'; responseId?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
    | { kind: 'response_failed'; message: string }
    | { kind: 'response_id'; id: string };

export function parseResponsesEvent(rawJson: string): ResponsesEvent | null {
    if (!rawJson || rawJson === '[DONE]') { return null; }
    let evt: any;
    try { evt = JSON.parse(rawJson); } catch { return null; }
    const t = evt?.type;
    if (typeof t !== 'string') { return null; }

    switch (t) {
        case 'response.created':
        case 'response.in_progress': {
            const id = evt?.response?.id;
            return id ? { kind: 'response_id', id } : null;
        }
        case 'response.output_text.delta': {
            const text = typeof evt.delta === 'string' ? evt.delta : '';
            return text ? { kind: 'output_text_delta', text } : null;
        }
        case 'response.reasoning.delta':
        case 'response.reasoning_text.delta': {
            const text = typeof evt.delta === 'string' ? evt.delta : '';
            return text ? { kind: 'reasoning_delta', text } : null;
        }
        case 'response.reasoning_summary.delta':
        case 'response.reasoning_summary_text.delta': {
            const text = typeof evt.delta === 'string' ? evt.delta : '';
            return text ? { kind: 'reasoning_summary_delta', text } : null;
        }
        case 'response.output_item.added': {
            const item = evt?.item;
            if (item?.type === 'function_call') {
                return {
                    kind: 'function_call_started',
                    itemId: item.id ?? '',
                    callId: item.call_id ?? item.id ?? '',
                    name: item.name ?? '',
                };
            }
            return null;
        }
        case 'response.function_call_arguments.delta': {
            return {
                kind: 'function_call_arguments_delta',
                itemId: evt.item_id ?? '',
                delta: typeof evt.delta === 'string' ? evt.delta : '',
            };
        }
        case 'response.completed': {
            const r = evt?.response ?? {};
            const u = r.usage;
            return {
                kind: 'response_completed',
                responseId: r.id,
                usage: u ? {
                    prompt_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
                    completion_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
                    total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
                } : undefined,
            };
        }
        case 'response.failed':
        case 'error': {
            const msg = evt?.response?.error?.message
                ?? evt?.error?.message
                ?? evt?.message
                ?? 'response failed';
            return { kind: 'response_failed', message: String(msg) };
        }
        default:
            return null;
    }
}

// ── Client ────────────────────────────────────────────────────────────────

/** IChatClient implementation that talks /openai/v1/responses. */
export class AoaiResponsesClient implements IChatClient {
    private static readonly REQUEST_TIMEOUT_MS = 120_000;
    private static readonly STREAM_STALL_TIMEOUT_MS = 90_000;

    constructor(private readonly inner: AzureOpenAIClient) {}

    get modelId(): string {
        return this.inner.getEffectiveDeployment();
    }

    async getResponse(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
        let assistantText = '';
        let reasoningSummary = '';
        let toolCalls: ToolCall[] | undefined;
        let usage: ChatResponse['usage'];
        let responseId: string | undefined;

        for await (const chunk of this.getResponseStream(messages, options)) {
            switch (chunk.type) {
                case 'text': assistantText += chunk.text; break;
                case 'reasoningSummary': reasoningSummary += chunk.text; break;
                case 'toolCalls': toolCalls = chunk.calls; break;
                case 'usage': usage = chunk.usage; break;
                case 'responseId': responseId = chunk.id; break;
            }
        }

        const msg: ChatMessage = {
            role: 'assistant',
            content: assistantText || null,
            ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        };
        return {
            messages: [msg],
            finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
            usage,
            modelId: this.modelId,
            ...(responseId ? { responseId } : {}),
            ...(reasoningSummary ? { reasoningSummary } : {}),
        };
    }

    async *getResponseStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const config = await this.inner.getConfigAsync();
        const url = buildResponsesUrl(config.provider, config.endpoint, config.apimBaseUrl);

        const reasoningEffort = options?.reasoningEffort
            ?? (getSetting<string>('azureOpenAI.reasoningEffort') as any)
            ?? 'high';
        const reasoningSummary = options?.reasoningSummary
            ?? (getSetting<string>('azureOpenAI.reasoningSummary') as any)
            ?? 'auto';
        const useServerState = !!getSetting<boolean>('azureOpenAI.useServerSideState');

        const body = buildResponsesRequest(this.modelId, messages, options?.tools ?? [], {
            stream: true,
            store: useServerState,
            previousResponseId: options?.previousResponseId,
            reasoningEffort,
            reasoningSummary,
            maxTokens: options?.maxTokens ?? config.maxTokens,
            temperature: options?.temperature ?? config.temperature,
            reasoningMode: options?.reasoningMode,
        });

        const stream = await postSseRequest(
            url,
            JSON.stringify(body),
            config.authHeader,
            config.authToken,
            options?.signal,
        );

        // Per-item arguments accumulator for function_call streaming.
        const calls = new Map<string, { callId: string; name: string; args: string }>();
        let toolCallStartedYielded = false;
        let buffer = '';

        for await (const chunk of stream) {
            if (options?.signal?.aborted) { return; }
            buffer += chunk;
            // SSE frames are separated by blank lines; events may span several `data:` lines.
            // For /v1/responses every event is a single JSON object on one `data:` line, but
            // we still split on \n to handle line-buffered chunks.
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) { continue; }
                const payload = trimmed.slice(5).trim();
                const parsed = parseResponsesEvent(payload);
                if (!parsed) { continue; }
                switch (parsed.kind) {
                    case 'response_id':
                        yield { type: 'responseId', id: parsed.id };
                        break;
                    case 'output_text_delta':
                        yield { type: 'text', text: parsed.text };
                        break;
                    case 'reasoning_delta':
                        yield { type: 'reasoning', text: parsed.text };
                        break;
                    case 'reasoning_summary_delta':
                        yield { type: 'reasoningSummary', text: parsed.text };
                        break;
                    case 'function_call_started':
                        if (!toolCallStartedYielded) {
                            toolCallStartedYielded = true;
                            yield { type: 'toolCallStarted' };
                        }
                        calls.set(parsed.itemId, {
                            callId: parsed.callId || parsed.itemId,
                            name: parsed.name,
                            args: '',
                        });
                        break;
                    case 'function_call_arguments_delta': {
                        const existing = calls.get(parsed.itemId)
                            ?? { callId: parsed.itemId, name: '', args: '' };
                        existing.args += parsed.delta;
                        calls.set(parsed.itemId, existing);
                        if (!toolCallStartedYielded) {
                            toolCallStartedYielded = true;
                            yield { type: 'toolCallStarted' };
                        }
                        break;
                    }
                    case 'response_completed':
                        if (parsed.responseId) {
                            yield { type: 'responseId', id: parsed.responseId };
                        }
                        if (parsed.usage) {
                            yield { type: 'usage', usage: parsed.usage };
                        }
                        if (calls.size) {
                            const flushed: ToolCall[] = [];
                            for (const c of calls.values()) {
                                flushed.push({
                                    id: c.callId,
                                    type: 'function',
                                    function: { name: c.name, arguments: c.args },
                                });
                            }
                            yield { type: 'toolCalls', calls: flushed };
                        }
                        yield { type: 'done' };
                        return;
                    case 'response_failed':
                        throw new Error(`responses API failed: ${parsed.message}`);
                }
            }
        }

        // Stream ended without a response.completed event — flush whatever we have.
        if (calls.size) {
            const flushed: ToolCall[] = [];
            for (const c of calls.values()) {
                flushed.push({
                    id: c.callId,
                    type: 'function',
                    function: { name: c.name, arguments: c.args },
                });
            }
            yield { type: 'toolCalls', calls: flushed };
        }
        yield { type: 'done' };
    }
}

// ── URL building ──────────────────────────────────────────────────────────

/**
 * Build the /v1/responses URL for each provider variant.
 *
 *   direct (Azure OpenAI): {endpoint}/openai/v1/responses
 *   apim:                  {apimBaseUrl}/openai/v1/responses
 *   openai (compatible):   {openaiBaseUrl}/responses     (base typically ends in /v1)
 *
 * For APIM, baseUrl must resolve so that appending `/openai/v1/responses` lands on a
 * real route (e.g. APIM API URL suffix `openai/v1` over an operation `POST /responses`).
 */
export function buildResponsesUrl(
    provider: 'direct' | 'apim' | 'openai',
    endpoint: string,
    apimBaseUrl: string,
): URL {
    if (provider === 'openai') {
        const base = (getSetting<string>('azureOpenAI.openaiBaseUrl') || 'https://api.openai.com/v1').replace(/\/+$/, '');
        try { return new URL(`${base}/responses`); }
        catch { throw new Error(`Invalid openaiBaseUrl for /v1/responses: "${base}". Set junior.azureOpenAI.openaiBaseUrl to a full https:// URL.`); }
    }
    const rawBase = provider === 'apim' ? apimBaseUrl : endpoint;
    if (!rawBase) {
        throw new Error(provider === 'apim'
            ? 'junior.azureOpenAI.apimBaseUrl is not set — required when wireApi=responses with provider=apim.'
            : 'junior.azureOpenAI.endpoint is not set — required when wireApi=responses with provider=direct.');
    }
    const base = rawBase.replace(/\/+$/, '');
    try { return new URL(`${base}/openai/v1/responses`); }
    catch { throw new Error(`Invalid base URL for /v1/responses: "${base}". Must include the https:// scheme.`); }
}

// ── Minimal SSE-friendly POST ────────────────────────────────────────────

function postSseRequest(
    url: URL,
    body: string,
    authHeader: 'api-key' | 'bearer',
    authToken: string,
    abortSignal?: AbortSignal,
): Promise<AsyncIterable<string>> {
    return new Promise((resolve, reject) => {
        if (abortSignal?.aborted) { reject(new Error('Aborted')); return; }
        const isHttps = url.protocol === 'https:';
        const mod = isHttps ? https : http;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
        };
        if (authHeader === 'bearer') {
            headers.Authorization = `Bearer ${authToken}`;
        } else {
            headers['api-key'] = authToken;
        }

        const req = mod.request(
            url,
            { method: 'POST', timeout: AoaiResponsesClient['REQUEST_TIMEOUT_MS'], headers },
            (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    let errBody = '';
                    res.on('data', (d: Buffer) => { errBody += d.toString(); });
                    res.on('end', () => {
                        const err = new Error(`responses API ${res.statusCode}: ${errBody.slice(0, 500)}`) as any;
                        err.statusCode = res.statusCode;
                        err.retryAfter = res.headers['retry-after']
                            ? parseInt(res.headers['retry-after'] as string, 10)
                            : undefined;
                        reject(err);
                    });
                    return;
                }
                res.setEncoding('utf8');
                const stallMs = AoaiResponsesClient['STREAM_STALL_TIMEOUT_MS'];
                const iterable: AsyncIterable<string> = {
                    [Symbol.asyncIterator]() {
                        return {
                            next() {
                                return new Promise<IteratorResult<string>>((innerResolve) => {
                                    const stallTimer = setTimeout(() => {
                                        cleanup();
                                        res.destroy();
                                        innerResolve({ value: '', done: true });
                                    }, stallMs);
                                    const onData = (chunk: string) => { cleanup(); innerResolve({ value: chunk, done: false }); };
                                    const onEnd = () => { cleanup(); innerResolve({ value: '', done: true }); };
                                    const onError = () => { cleanup(); innerResolve({ value: '', done: true }); };
                                    function cleanup() {
                                        clearTimeout(stallTimer);
                                        res.removeListener('data', onData);
                                        res.removeListener('end', onEnd);
                                        res.removeListener('error', onError);
                                    }
                                    res.once('data', onData);
                                    res.once('end', onEnd);
                                    res.once('error', onError);
                                });
                            },
                        };
                    },
                };
                resolve(iterable);
            },
        );
        if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
                req.destroy();
                reject(new Error('Aborted'));
            }, { once: true });
        }
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
