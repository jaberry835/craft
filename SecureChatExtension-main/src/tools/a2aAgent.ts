/**
 * a2aAgent — Agent2Agent (A2A) delegation tool for Connected Agents.
 *
 * Each enabled connected agent is surfaced to the active persona as a
 * `delegate_to_<agent>` tool. The persona can call it to hand a task or
 * question to the remote A2A agent (Google's open Agent2Agent protocol). The
 * remote reply is returned as untrusted data (wrapped with the
 * JUNIOR_UNTRUSTED_TOOL_OUTPUT delimiters by agentLoop) so persona
 * prompt-injection rules apply.
 *
 * Transport:
 *   - JSON-RPC 2.0 over HTTP(S) POST.
 *   - When the agent card advertises `capabilities.streaming`, we use
 *     `message/stream` (Server-Sent Events) so intermediate `working` status
 *     updates (narration / reasoning) are delivered, and fall back to the
 *     blocking `message/send` on any streaming failure.
 *   - The configured endpoint may be the JSON-RPC service URL OR an Agent Card
 *     URL. We attempt Agent Card discovery (`/.well-known/agent-card.json`,
 *     then `/.well-known/agent.json`) and use the card's `url` when present,
 *     otherwise fall back to the configured endpoint as the RPC URL.
 *
 * Auth modes:
 *   - 'none':   no auth header.
 *   - 'bearer': per-agent secret sent as `Authorization: Bearer <secret>`.
 *   - 'apiKey': per-agent secret sent under a configurable header (default
 *               `x-api-key`).
 *   - 'entra':  a bearer token acquired interactively from a VS Code auth
 *               session (Microsoft Entra ID), sent as `Authorization: Bearer
 *               <token>`. No secret is stored; VS Code handles sign-in.
 *
 * Endpoint allow-listing: enforced by `isValidConnectedAgentEndpoint` in
 * customAgents.ts; re-checked at call time so a hand-edited agent JSON cannot
 * trick us into sending bearer tokens to a disallowed host. https is required
 * for any real network host; plain http is permitted only for loopback
 * (`localhost`, `127.0.0.0/8`, `::1`) so local dev agents work without TLS.
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { ToolEntry } from './types';
import { isValidConnectedAgentEndpoint, isLoopbackHostname } from '../customAgents';
import { ConnectedAgentDef, connectedAgentToolName } from '../connectedAgents';
import { getConfiguredTlsOptions, withCaRefreshRetry } from '../network';
import { ToolProgressUpdate } from '../types';

export interface A2AAgentDeps {
    /** Resolves the bearer token / api key secret for this agent (bearer/apiKey auth). */
    getApiKey(): Promise<string | undefined>;
    /** Resolves a bearer token via an interactive VS Code auth session (entra auth). */
    getEntraToken?(): Promise<string | undefined>;
}

/** Build the delegation tool entry for one connected agent. */
export function createConnectedAgentTool(
    agent: ConnectedAgentDef,
    deps: A2AAgentDeps,
): ToolEntry {
    const capability = agent.description ? ` It specializes in: ${agent.description}.` : '';

    return {
        definition: {
            type: 'function',
            function: {
                name: connectedAgentToolName(agent.id),
                description:
                    `Delegate a task or question to "${agent.name}", a remote agent reachable via the ` +
                    `Agent2Agent (A2A) protocol.${capability} Pass a clear, self-contained message; the remote ` +
                    `agent does not see this conversation's history. Returns the remote agent's reply as untrusted data.`,
                parameters: {
                    type: 'object',
                    properties: {
                        message: {
                            type: 'string',
                            description: 'The task or question to send to the remote agent. Make it self-contained.',
                        },
                    },
                    required: ['message'],
                },
            },
        },
        handler: async (args, ctx) => {
            const message = String(args.message ?? '').trim();
            if (!message) { return { success: false, result: 'message is required.' }; }
            try {
                const reply = await callConnectedAgent(agent, deps, message, ctx?.onProgress);
                // agentLoop wraps successful tool results with the
                // JUNIOR_UNTRUSTED_TOOL_OUTPUT markers, so we return raw text here.
                return { success: true, result: reply || 'The remote agent returned an empty response.' };
            } catch (err: any) {
                const msg = err?.message || String(err);
                return { success: false, result: `${connectedAgentToolName(agent.id)} failed: ${msg}` };
            }
        },
    };
}

// ── internals ──

/** Send a single message to the remote A2A agent and return its text reply. */
export async function callConnectedAgent(
    cfg: ConnectedAgentDef,
    deps: A2AAgentDeps,
    message: string,
    onProgress?: (update: ToolProgressUpdate) => void,
): Promise<string> {
    if (!isValidConnectedAgentEndpoint(cfg.endpoint)) {
        throw new Error('Refusing to call disallowed A2A endpoint (https required; http only for localhost).');
    }
    const headers = await buildAuthHeaders(cfg, deps);
    const target = await resolveRpcTarget(cfg, headers);
    const jsonHeaders = { ...headers, 'content-type': 'application/json' };

    // When the agent advertises streaming (capabilities.streaming), prefer
    // `message/stream` so we receive the intermediate `working` status updates
    // (narration / reasoning) that `message/send` drops. Fall back to the
    // blocking call on any streaming failure or empty stream.
    if (target.streaming) {
        try {
            const streamed = await streamConnectedAgent(target.url, jsonHeaders, message, onProgress);
            if (streamed) { return streamed; }
        } catch {
            // fall through to blocking message/send
        }
    }

    const request = {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/send',
        params: {
            message: {
                role: 'user',
                parts: [{ kind: 'text', text: message }],
                messageId: randomUUID(),
            },
        },
    };

    const json = await postJson(target.url, jsonHeaders, JSON.stringify(request));
    if (json?.error) {
        const e = json.error;
        throw new Error(`remote A2A error ${e?.code ?? ''}: ${e?.message ?? JSON.stringify(e)}`.trim());
    }
    const text = extractText(json?.result);
    if (!text) {
        // Surface the raw shape (truncated) so the model can still reason about it.
        return `The remote A2A agent returned a non-text result:\n${truncate(safeStringify(json?.result), 1500)}`;
    }
    return text;
}

/** Stream a message via `message/stream` (SSE), aggregating narration/reasoning
 *  progress and the final answer into a single reply. Returns '' if the stream
 *  yielded no usable text so the caller can fall back to `message/send`. */
async function streamConnectedAgent(
    rpcUrl: string,
    jsonHeaders: Record<string, string>,
    message: string,
    onProgress?: (update: ToolProgressUpdate) => void,
): Promise<string> {
    const request = {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'message/stream',
        params: {
            message: {
                role: 'user',
                parts: [{ kind: 'text', text: message }],
                messageId: randomUUID(),
            },
        },
    };

    const buckets: Record<A2AStreamPiece['channel'], string[]> = { reasoning: [], narration: [], answer: [] };
    const seen = new Set<string>();
    await postStream(rpcUrl, jsonHeaders, JSON.stringify(request), (result) => {
        if (result?.error) {
            const e = result.error;
            throw new Error(`remote A2A error ${e?.code ?? ''}: ${e?.message ?? JSON.stringify(e)}`.trim());
        }
        const { pieces, final } = classifyA2AEvent(result);
        for (const p of pieces) {
            const key = `${p.channel}\u0000${p.text}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            buckets[p.channel].push(p.text);
            onProgress?.({ channel: p.channel, text: p.text });
        }
        return final;
    });

    return formatStreamedReply(buckets.reasoning, buckets.narration, buckets.answer);
}


/** Build the auth headers for the configured auth mode. */
async function buildAuthHeaders(cfg: ConnectedAgentDef, deps: A2AAgentDeps): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (cfg.auth === 'bearer') {
        const key = await deps.getApiKey();
        if (!key) { throw new Error('No bearer token configured for this A2A agent. Set it in the agent editor.'); }
        headers['authorization'] = `Bearer ${key}`;
    } else if (cfg.auth === 'apiKey') {
        const key = await deps.getApiKey();
        if (!key) { throw new Error('No API key configured for this A2A agent. Set it in the agent editor.'); }
        headers[(cfg.headerName || 'x-api-key').toLowerCase()] = key;
    } else if (cfg.auth === 'entra') {
        const token = deps.getEntraToken ? await deps.getEntraToken() : undefined;
        if (!token) { throw new Error('Could not acquire a sign-in token for this A2A agent. Sign in when prompted, or check the configured Entra scope.'); }
        headers['authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/** Resolve the JSON-RPC service URL (and streaming capability) via Agent Card
 *  discovery, falling back to the configured endpoint when no card is found. */
async function resolveRpcTarget(cfg: ConnectedAgentDef, headers: Record<string, string>): Promise<{ url: string; streaming: boolean }> {
    // If the endpoint itself points at a card document, fetch it directly.
    if (/\.json($|\?)/i.test(cfg.endpoint) || /\/\.well-known\//i.test(cfg.endpoint)) {
        const card = await tryFetchCard(cfg.endpoint, headers);
        const url = pickCardUrl(card);
        if (url) { return { url, streaming: pickStreaming(card) }; }
        // Card had no usable url — fall back to the configured endpoint.
        return { url: cfg.endpoint, streaming: false };
    }

    for (const suffix of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
        const card = await tryFetchCard(cfg.endpoint + suffix, headers);
        const url = pickCardUrl(card);
        if (url) { return { url, streaming: pickStreaming(card) }; }
    }

    // No discoverable card — treat the configured endpoint as the RPC URL.
    return { url: cfg.endpoint, streaming: false };
}

function pickCardUrl(card: any): string | undefined {
    const url = card?.url;
    if (typeof url === 'string' && isValidConnectedAgentEndpoint(url)) { return url.replace(/\/+$/, ''); }
    return undefined;
}

/** A2A agent cards advertise SSE support via `capabilities.streaming`. */
function pickStreaming(card: any): boolean {
    return card?.capabilities?.streaming === true;
}

async function tryFetchCard(urlStr: string, headers: Record<string, string>): Promise<any | undefined> {
    try {
        if (!isValidConnectedAgentEndpoint(urlStr)) { return undefined; }
        return await getJson(urlStr, headers);
    } catch {
        return undefined;
    }
}

/** Extract human-readable text from an A2A `result` (Message or Task). */
function extractText(result: any): string {
    if (!result || typeof result !== 'object') { return ''; }
    const chunks: string[] = [];

    // Direct Message result.
    collectParts(result.parts, chunks);

    // Task result: latest status message + artifacts.
    collectParts(result.status?.message?.parts, chunks);
    if (Array.isArray(result.artifacts)) {
        for (const artifact of result.artifacts) {
            collectParts(artifact?.parts, chunks);
        }
    }

    // Some agents nest the message under `message`.
    collectParts(result.message?.parts, chunks);

    const text = chunks.map(s => s.trim()).filter(Boolean).join('\n\n').trim();
    return text;
}

function collectParts(parts: unknown, out: string[]): void {
    if (!Array.isArray(parts)) { return; }
    for (const part of parts) {
        if (!part || typeof part !== 'object') { continue; }
        const p = part as Record<string, unknown>;
        // A2A text parts use `kind: 'text'` (newer) or `type: 'text'` (drafts).
        if (typeof p.text === 'string' && (p.kind === 'text' || p.type === 'text' || (!p.kind && !p.type))) {
            out.push(p.text);
        } else if (p.kind === 'data' || p.type === 'data') {
            if (p.data != null) { out.push(safeStringify(p.data)); }
        }
    }
}

// ── streaming (message/stream over SSE) ──

export interface A2AStreamPiece {
    channel: 'reasoning' | 'narration' | 'answer';
    text: string;
}

// A2A TaskState values that end a stream.
const TERMINAL_TASK_STATES = new Set([
    'completed', 'failed', 'canceled', 'cancelled', 'rejected', 'input-required', 'auth-required',
]);

function isTerminalState(state: unknown): boolean {
    return typeof state === 'string' && TERMINAL_TASK_STATES.has(state.toLowerCase());
}

/** Map a Message's `metadata.type` / `metadata.kind` to a render channel.
 *  A2A has no first-class reasoning concept, so agents tag intent via metadata. */
function channelFromMetadata(meta: any, fallback: A2AStreamPiece['channel']): A2AStreamPiece['channel'] {
    const t = typeof meta?.type === 'string' ? meta.type.toLowerCase()
        : typeof meta?.kind === 'string' ? meta.kind.toLowerCase() : '';
    if (t === 'reasoning' || t === 'thought' || t === 'thinking') { return 'reasoning'; }
    if (t === 'tool_call' || t === 'tool' || t === 'progress' || t === 'narration' || t === 'status') { return 'narration'; }
    if (t === 'answer' || t === 'final' || t === 'result' || t === 'message') { return 'answer'; }
    return fallback;
}

function pushTextParts(parts: unknown, channel: A2AStreamPiece['channel'], out: A2AStreamPiece[]): void {
    const tmp: string[] = [];
    collectParts(parts, tmp);
    for (const text of tmp) {
        if (text.trim()) { out.push({ channel, text }); }
    }
}

/** Classify a single A2A streamed `result` (Message / Task / status-update /
 *  artifact-update event) into render pieces and whether the stream is done. */
export function classifyA2AEvent(result: any): { pieces: A2AStreamPiece[]; final: boolean } {
    const pieces: A2AStreamPiece[] = [];
    let final = false;
    if (!result || typeof result !== 'object') { return { pieces, final }; }
    const kind = result.kind;

    // status-update event, or a Task snapshot carrying a status.
    if (kind === 'status-update' || result.status) {
        const msg = result.status?.message;
        const channel = channelFromMetadata(msg?.metadata, 'narration');
        pushTextParts(msg?.parts, channel, pieces);
        if (typeof result.final === 'boolean') { final = final || result.final; }
        if (isTerminalState(result.status?.state)) { final = true; }
    }

    // artifact-update event, or a Task snapshot carrying artifacts.
    if (kind === 'artifact-update') {
        pushTextParts(result.artifact?.parts, 'answer', pieces);
    }
    if (Array.isArray(result.artifacts)) {
        for (const a of result.artifacts) { pushTextParts(a?.parts, 'answer', pieces); }
    }

    // Direct Message result/event.
    if (Array.isArray(result.parts)) {
        const channel = channelFromMetadata(result.metadata, 'answer');
        pushTextParts(result.parts, channel, pieces);
        if (kind === 'message' || !kind) { final = true; }
    }

    return { pieces, final };
}

/** Combine the aggregated stream buckets into a single reply. The answer is the
 *  primary content; reasoning/narration are surfaced as a compact progress log. */
function formatStreamedReply(reasoning: string[], narration: string[], answer: string[]): string {
    const answerText = answer.map(s => s.trim()).filter(Boolean).join('\n\n').trim();
    const progress = [
        ...reasoning.map(t => `- (reasoning) ${t.trim()}`),
        ...narration.map(t => `- ${t.trim()}`),
    ].filter(line => line.replace(/^- (\(reasoning\) )?/, '').trim());

    if (!answerText && !progress.length) { return ''; }
    if (!progress.length) { return answerText; }
    const head = `[Remote agent progress]\n${progress.join('\n')}`;
    return answerText ? `${head}\n\n[Remote agent answer]\n${answerText}` : head;
}

/** Extract the concatenated `data:` payload from one raw SSE event block.
 *  Returns undefined when the block carries no data field (comments/heartbeats). */
export function parseSseEventData(rawEvent: string): string | undefined {
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
        if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
        }
    }
    return dataLines.length ? dataLines.join('\n') : undefined;
}

/** POST a JSON-RPC request expecting an SSE stream. `onResult` is invoked for
 *  each JSON-RPC `result`; return true from it to stop the stream early. */
function postStream(
    urlStr: string,
    headers: Record<string, string>,
    body: string,
    onResult: (result: any) => boolean,
): Promise<void> {
    const TIMEOUT_MS = 120_000;
    const MAX_BYTES = 8 * 1024 * 1024; // 8 MB cap on a single stream
    const send = () => new Promise<void>((resolve, reject) => {
        const u = new URL(urlStr);
        const t = transportFor(u);
        const req = t.mod.request({
            method: 'POST',
            hostname: u.hostname,
            port: t.port,
            path: u.pathname + u.search,
            headers: {
                ...headers,
                'accept': 'text/event-stream',
                'content-length': Buffer.byteLength(body).toString(),
            },
            timeout: TIMEOUT_MS,
            ...t.tls,
        }, (res) => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
                let errText = '';
                res.on('data', (c: Buffer) => { if (errText.length < 500) { errText += c.toString('utf8'); } });
                res.on('end', () => reject(new Error(`HTTP ${status}: ${errText.slice(0, 500)}`)));
                res.on('error', reject);
                return;
            }
            let buffer = '';
            let total = 0;
            let done = false;
            const finish = (err?: Error) => {
                if (done) { return; }
                done = true;
                res.destroy();
                if (err) { reject(err); } else { resolve(); }
            };
            const dispatch = (rawEvent: string): boolean => {
                const data = parseSseEventData(rawEvent);
                if (data === undefined || data === '[DONE]') { return false; }
                let parsed: any;
                try { parsed = JSON.parse(data); }
                catch { return false; } // ignore non-JSON keep-alives
                const result = parsed?.result !== undefined ? parsed.result : parsed;
                return onResult(result);
            };
            res.on('data', (c: Buffer) => {
                if (done) { return; }
                total += c.length;
                if (total > MAX_BYTES) { finish(new Error(`Stream exceeded ${MAX_BYTES} bytes; aborting.`)); return; }
                buffer += c.toString('utf8').replace(/\r\n/g, '\n');
                const events = buffer.split('\n\n');
                buffer = events.pop() ?? '';
                for (const ev of events) {
                    try {
                        if (dispatch(ev)) { finish(); return; }
                    } catch (e: any) {
                        finish(e instanceof Error ? e : new Error(String(e)));
                        return;
                    }
                }
            });
            res.on('end', () => {
                if (done) { return; }
                if (buffer.trim()) {
                    try { dispatch(buffer); } catch { /* ignore trailing parse errors */ }
                }
                finish();
            });
            res.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
        });
        req.on('timeout', () => req.destroy(new Error(`Stream timed out after ${TIMEOUT_MS}ms`)));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
    return withCaRefreshRetry(send, 'streaming from A2A agent');
}

/** Choose the right transport for an A2A URL. Plain http is used only for
 *  loopback hosts (validated earlier); https everywhere else with TLS options. */
function transportFor(u: URL): { mod: typeof http | typeof https; port: number; tls: Record<string, unknown> } {
    if (u.protocol === 'http:' && isLoopbackHostname(u.hostname)) {
        return { mod: http, port: Number(u.port) || 80, tls: {} };
    }
    return { mod: https, port: Number(u.port) || 443, tls: getConfiguredTlsOptions() };
}

function getJson(urlStr: string, headers: Record<string, string>): Promise<any> {
    const TIMEOUT_MS = 20_000;
    const MAX_BYTES = 1 * 1024 * 1024; // 1 MB cap on agent card body
    const send = () => new Promise<any>((resolve, reject) => {
        const u = new URL(urlStr);
        const t = transportFor(u);
        const req = t.mod.request({
            method: 'GET',
            hostname: u.hostname,
            port: t.port,
            path: u.pathname + u.search,
            headers,
            timeout: TIMEOUT_MS,
            ...t.tls,
        }, (res) => collectResponse(res, reject, resolve, MAX_BYTES));
        req.on('timeout', () => req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)));
        req.on('error', reject);
        req.end();
    });
    return withCaRefreshRetry(send, 'fetching A2A agent card');
}

function postJson(urlStr: string, headers: Record<string, string>, body: string): Promise<any> {
    const TIMEOUT_MS = 60_000;
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on response body
    const send = () => new Promise<any>((resolve, reject) => {
        const u = new URL(urlStr);
        const t = transportFor(u);
        const req = t.mod.request({
            method: 'POST',
            hostname: u.hostname,
            port: t.port,
            path: u.pathname + u.search,
            headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
            timeout: TIMEOUT_MS,
            ...t.tls,
        }, (res) => collectResponse(res, reject, resolve, MAX_BYTES));
        req.on('timeout', () => req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
    return withCaRefreshRetry(send, 'calling A2A agent');
}

function collectResponse(
    res: NodeJS.ReadableStream & { statusCode?: number; destroy: (e?: Error) => void },
    reject: (e: Error) => void,
    resolve: (v: any) => void,
    maxBytes: number,
): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    res.on('data', (c: Buffer) => {
        if (aborted) { return; }
        total += c.length;
        if (total > maxBytes) {
            aborted = true;
            res.destroy();
            reject(new Error(`Response exceeded ${maxBytes} bytes; aborting.`));
            return;
        }
        chunks.push(c);
    });
    res.on('end', () => {
        if (aborted) { return; }
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}: ${text.slice(0, 500)}`));
            return;
        }
        try { resolve(text ? JSON.parse(text) : {}); }
        catch (e: any) { reject(new Error(`Invalid JSON from A2A agent: ${e?.message || e}`)); }
    });
    res.on('error', reject);
}

function safeStringify(v: unknown): string {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
