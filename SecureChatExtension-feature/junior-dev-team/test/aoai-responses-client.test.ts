import { describe, expect, it } from 'vitest';
import {
    parseResponsesEvent,
    buildResponsesRequest,
    buildResponsesUrl,
} from '../src/aoaiResponsesClient';
import type { ChatMessage, ToolDefinition } from '../src/types';

describe('parseResponsesEvent', () => {
    it('returns null for keepalives, [DONE], or unparseable JSON', () => {
        expect(parseResponsesEvent('')).toBeNull();
        expect(parseResponsesEvent('[DONE]')).toBeNull();
        expect(parseResponsesEvent('not-json')).toBeNull();
        expect(parseResponsesEvent('{}')).toBeNull(); // missing type
    });

    it('decodes response.created/response.in_progress as response_id', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_abc' },
        }));
        expect(evt).toEqual({ kind: 'response_id', id: 'resp_abc' });
    });

    it('decodes output_text.delta', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'Hello',
        }));
        expect(evt).toEqual({ kind: 'output_text_delta', text: 'Hello' });
    });

    it('decodes both reasoning_text.delta and reasoning.delta', () => {
        for (const t of ['response.reasoning.delta', 'response.reasoning_text.delta']) {
            const evt = parseResponsesEvent(JSON.stringify({ type: t, delta: 'thinking' }));
            expect(evt).toEqual({ kind: 'reasoning_delta', text: 'thinking' });
        }
    });

    it('decodes both reasoning_summary.delta and reasoning_summary_text.delta', () => {
        for (const t of ['response.reasoning_summary.delta', 'response.reasoning_summary_text.delta']) {
            const evt = parseResponsesEvent(JSON.stringify({ type: t, delta: 'I will...' }));
            expect(evt).toEqual({ kind: 'reasoning_summary_delta', text: 'I will...' });
        }
    });

    it('decodes function_call output_item.added', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.output_item.added',
            item: { type: 'function_call', id: 'item_1', call_id: 'call_xyz', name: 'readFile' },
        }));
        expect(evt).toEqual({
            kind: 'function_call_started',
            itemId: 'item_1',
            callId: 'call_xyz',
            name: 'readFile',
        });
    });

    it('ignores non-function output_item.added', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.output_item.added',
            item: { type: 'message', id: 'm1' },
        }));
        expect(evt).toBeNull();
    });

    it('decodes function_call_arguments.delta', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.function_call_arguments.delta',
            item_id: 'item_1',
            delta: '{"path":',
        }));
        expect(evt).toEqual({
            kind: 'function_call_arguments_delta',
            itemId: 'item_1',
            delta: '{"path":',
        });
    });

    it('decodes response.completed and normalizes usage fields', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.completed',
            response: {
                id: 'resp_done',
                usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
            },
        }));
        expect(evt).toEqual({
            kind: 'response_completed',
            responseId: 'resp_done',
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        });
    });

    it('handles response.completed when usage is missing', () => {
        const evt = parseResponsesEvent(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_done' },
        }));
        expect(evt).toEqual({ kind: 'response_completed', responseId: 'resp_done', usage: undefined });
    });

    it('decodes response.failed and `error` events with message extraction', () => {
        for (const payload of [
            { type: 'response.failed', response: { error: { message: 'boom' } } },
            { type: 'error', error: { message: 'boom' } },
            { type: 'error', message: 'boom' },
        ]) {
            const evt = parseResponsesEvent(JSON.stringify(payload));
            expect(evt).toEqual({ kind: 'response_failed', message: 'boom' });
        }
    });

    it('returns null for unknown event types', () => {
        const evt = parseResponsesEvent(JSON.stringify({ type: 'response.future_event' }));
        expect(evt).toBeNull();
    });
});

describe('buildResponsesRequest', () => {
    const tool: ToolDefinition = {
        type: 'function',
        function: {
            name: 'readFile',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
    };

    it('coalesces system messages into instructions and emits user input', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'you are helpful' },
            { role: 'user', content: 'hi' },
        ];
        const body = buildResponsesRequest('gpt-5.4', messages, [], {
            stream: true, store: false,
        });
        expect(body.model).toBe('gpt-5.4');
        expect(body.instructions).toBe('you are helpful');
        expect(body.input).toEqual([
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ]);
        expect(body.stream).toBe(true);
        expect(body.store).toBe(false);
        expect(body.tools).toBeUndefined();
    });

    it('flattens assistant tool_calls into function_call items', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'read x' },
            {
                role: 'assistant',
                content: 'sure',
                tool_calls: [{
                    id: 'call_1', type: 'function',
                    function: { name: 'readFile', arguments: '{"path":"x"}' },
                }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
        ];
        const body = buildResponsesRequest('gpt-5.4', messages, [tool], {
            stream: false, store: false,
        });
        // Order: user, function_call, assistant text, function_call_output
        expect(body.input.map(i => i.type)).toEqual([
            'message', 'function_call', 'message', 'function_call_output',
        ]);
        const fc = body.input[1] as any;
        expect(fc.call_id).toBe('call_1');
        expect(fc.name).toBe('readFile');
        expect(fc.arguments).toBe('{"path":"x"}');
        const fco = body.input[3] as any;
        expect(fco.call_id).toBe('call_1');
        expect(fco.output).toBe('file contents');
        expect(body.tools?.[0]).toEqual({
            type: 'function', name: 'readFile', description: 'Read a file',
            parameters: tool.function.parameters,
        });
        expect(body.tool_choice).toBe('auto');
    });

    it('includes reasoning block when effort or summary set; omits when summary=none', () => {
        const messages: ChatMessage[] = [{ role: 'user', content: 'x' }];
        expect(buildResponsesRequest('m', messages, [], {
            stream: true, store: false, reasoningEffort: 'high', reasoningSummary: 'auto',
        }).reasoning).toEqual({ effort: 'high', summary: 'auto' });

        expect(buildResponsesRequest('m', messages, [], {
            stream: true, store: false, reasoningSummary: 'none',
        }).reasoning).toBeUndefined();
    });

    it('omits temperature in reasoningMode and includes max_output_tokens', () => {
        const body = buildResponsesRequest('m', [{ role: 'user', content: 'x' }], [], {
            stream: true, store: false, reasoningMode: true, temperature: 0.7, maxTokens: 4096,
        });
        expect(body.temperature).toBeUndefined();
        expect(body.max_output_tokens).toBe(4096);
    });

    it('passes previous_response_id when provided', () => {
        const body = buildResponsesRequest('m', [{ role: 'user', content: 'x' }], [], {
            stream: true, store: true, previousResponseId: 'resp_prev',
        });
        expect(body.previous_response_id).toBe('resp_prev');
        expect(body.store).toBe(true);
    });
});

describe('buildResponsesUrl', () => {
    it('builds direct Azure OpenAI URL', () => {
        const url = buildResponsesUrl('direct', 'https://my-aoai.openai.azure.com/', '');
        expect(url.toString()).toBe('https://my-aoai.openai.azure.com/openai/v1/responses');
    });

    it('builds APIM URL stripping trailing slashes', () => {
        const url = buildResponsesUrl('apim', '', 'https://my-apim.azure-api.net///');
        expect(url.toString()).toBe('https://my-apim.azure-api.net/openai/v1/responses');
    });
});
