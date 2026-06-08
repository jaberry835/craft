import { describe, it, expect } from 'vitest';
import * as http from 'http';
import { classifyA2AEvent, parseSseEventData, callConnectedAgent } from '../src/tools/a2aAgent';
import type { ConnectedAgentDef } from '../src/connectedAgents';
import type { ToolProgressUpdate } from '../src/types';

describe('parseSseEventData', () => {
    it('extracts a single data line', () => {
        expect(parseSseEventData('data: {"a":1}')).toBe('{"a":1}');
    });

    it('strips only one leading space after the colon', () => {
        expect(parseSseEventData('data:  spaced')).toBe(' spaced');
    });

    it('joins multiple data lines with newlines', () => {
        expect(parseSseEventData('data: line1\ndata: line2')).toBe('line1\nline2');
    });

    it('ignores comment and event/id fields', () => {
        expect(parseSseEventData(': keep-alive\nevent: update\nid: 7\ndata: payload')).toBe('payload');
    });

    it('returns undefined when there is no data field', () => {
        expect(parseSseEventData(': comment only')).toBeUndefined();
        expect(parseSseEventData('event: ping')).toBeUndefined();
    });
});

describe('classifyA2AEvent', () => {
    it('treats a status-update message as narration by default', () => {
        const { pieces, final } = classifyA2AEvent({
            kind: 'status-update',
            status: { state: 'working', message: { parts: [{ kind: 'text', text: 'Searching the catalog…' }] } },
            final: false,
        });
        expect(pieces).toEqual([{ channel: 'narration', text: 'Searching the catalog…' }]);
        expect(final).toBe(false);
    });

    it('routes status messages tagged reasoning to the reasoning channel', () => {
        const { pieces } = classifyA2AEvent({
            kind: 'status-update',
            status: {
                state: 'working',
                message: { metadata: { type: 'reasoning' }, parts: [{ kind: 'text', text: 'The user wants book titles.' }] },
            },
        });
        expect(pieces).toEqual([{ channel: 'reasoning', text: 'The user wants book titles.' }]);
    });

    it('marks the stream final on a terminal task state', () => {
        const { final } = classifyA2AEvent({
            kind: 'status-update',
            status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'done' }] } },
        });
        expect(final).toBe(true);
    });

    it('honours an explicit final flag', () => {
        const { final } = classifyA2AEvent({
            kind: 'status-update',
            status: { state: 'working' },
            final: true,
        });
        expect(final).toBe(true);
    });

    it('collects artifact-update parts as answer content', () => {
        const { pieces } = classifyA2AEvent({
            kind: 'artifact-update',
            artifact: { parts: [{ kind: 'text', text: 'Dune, 1984, Hyperion' }] },
        });
        expect(pieces).toEqual([{ channel: 'answer', text: 'Dune, 1984, Hyperion' }]);
    });

    it('treats a direct Message as the final answer', () => {
        const { pieces, final } = classifyA2AEvent({
            kind: 'message',
            parts: [{ kind: 'text', text: 'Here are the books.' }],
        });
        expect(pieces).toEqual([{ channel: 'answer', text: 'Here are the books.' }]);
        expect(final).toBe(true);
    });

    it('returns no pieces for an empty/invalid result', () => {
        expect(classifyA2AEvent(undefined).pieces).toEqual([]);
        expect(classifyA2AEvent({}).pieces).toEqual([]);
    });
});

describe('callConnectedAgent (streaming over SSE)', () => {
    // Spin up a loopback HTTP server that serves an agent card advertising
    // streaming, then replies to message/stream with an SSE sequence.
    function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
        return new Promise((resolve) => {
            const server = http.createServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
            });
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                const port = typeof addr === 'object' && addr ? addr.port : 0;
                resolve({
                    url: `http://127.0.0.1:${port}`,
                    close: () => new Promise<void>((r) => server.close(() => r())),
                });
            });
        });
    }

    const deps = { getApiKey: async () => undefined };

    it('streams progress pieces and returns the aggregated answer', async () => {
        const server = await startServer((req, res, _body) => {
            if (req.url?.includes('/.well-known/')) {
                if (req.url.includes('agent-card.json')) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ url: `http://127.0.0.1:${new URL('http://' + req.headers.host).port}/rpc`, capabilities: { streaming: true } }));
                } else {
                    res.writeHead(404); res.end();
                }
                return;
            }
            // RPC endpoint — emit an SSE stream.
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
            send({ jsonrpc: '2.0', result: { kind: 'status-update', status: { state: 'working', message: { metadata: { type: 'reasoning' }, parts: [{ kind: 'text', text: 'Figuring out the catalog' }] } } } });
            send({ jsonrpc: '2.0', result: { kind: 'status-update', status: { state: 'working', message: { parts: [{ kind: 'text', text: 'Searching books' }] } } } });
            send({ jsonrpc: '2.0', result: { kind: 'status-update', status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'Dune; 1984' }] } }, final: true } });
            res.end();
        });

        const agent: ConnectedAgentDef = { id: 'lib', name: 'Library', endpoint: server.url, auth: 'none' };
        const progress: ToolProgressUpdate[] = [];
        const reply = await callConnectedAgent(agent, deps, 'list books', (u) => progress.push(u));
        await server.close();

        expect(progress).toEqual([
            { channel: 'reasoning', text: 'Figuring out the catalog' },
            { channel: 'narration', text: 'Searching books' },
            { channel: 'narration', text: 'Dune; 1984' },
        ]);
        expect(reply).toContain('[Remote agent progress]');
        expect(reply).toContain('(reasoning) Figuring out the catalog');
        expect(reply).toContain('Searching books');
    });

    it('falls back to message/send when the stream errors', async () => {
        let sawStream = false;
        const server = await startServer((req, res, body) => {
            if (req.url?.includes('/.well-known/')) {
                if (req.url.includes('agent-card.json')) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ url: `http://127.0.0.1:${new URL('http://' + req.headers.host).port}/rpc`, capabilities: { streaming: true } }));
                } else { res.writeHead(404); res.end(); }
                return;
            }
            const parsed = JSON.parse(body || '{}');
            if (parsed.method === 'message/stream') {
                sawStream = true;
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('boom');
                return;
            }
            // message/send fallback
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', result: { kind: 'message', parts: [{ kind: 'text', text: 'fallback answer' }] } }));
        });

        const agent: ConnectedAgentDef = { id: 'lib', name: 'Library', endpoint: server.url, auth: 'none' };
        const reply = await callConnectedAgent(agent, deps, 'list books');
        await server.close();

        expect(sawStream).toBe(true);
        expect(reply).toBe('fallback answer');
    });
});
