import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/contextManager';
import { ContextTrimMiddleware } from '../src/middleware/contextTrimMiddleware';
import type { ChatContext } from '../src/framework/middleware';
import type { ChatStreamChunk } from '../src/framework/types';
import type { ChatMessage } from '../src/types';

const compactableMessages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: 'first response' },
    { role: 'user', content: 'second request' },
    { role: 'assistant', content: 'second response' },
    { role: 'user', content: 'current request' },
];

describe('ContextManager context budgeting', () => {
    it('limits one oversized tool result and preserves both useful ends', () => {
        const manager = new ContextManager({ contextWindow: 1_000 });
        const content = `BEGIN-${'x'.repeat(4_000)}-END`;

        const limited = manager.limitToolResult(content, {
            maxFraction: 0.1,
            transcriptReference: { version: 1, sessionId: 'session-1', throughRecord: 17 },
        });

        expect(limited).toContain('Tool output truncated for prompt');
        expect(limited).toContain('session session-1, through record 17');
        expect(limited).toContain('BEGIN-');
        expect(limited).toContain('-END');
        expect(manager.estimateMessageTokens({ role: 'tool', content: limited }) - 4).toBeLessThanOrEqual(100);
    });

    it('returns an in-budget tool result byte-for-byte unchanged', () => {
        const manager = new ContextManager({ contextWindow: 1_000 });
        const content = 'small exact result';
        expect(manager.limitToolResult(content, { maxFraction: 0.1 })).toBe(content);
    });

    it('includes tool definitions when deciding whether to compact', () => {
        const manager = new ContextManager({ contextWindow: 1_000, contextThreshold: 0.7 });
        const tools = [{
            type: 'function' as const,
            function: {
                name: 'large_tool',
                description: 'x'.repeat(3_000),
                parameters: { type: 'object' as const, properties: {} },
            },
        }];

        expect(manager.trimIfNeeded(compactableMessages)).toBe(compactableMessages);
        expect(manager.trimIfNeeded(compactableMessages, { tools })).not.toBe(compactableMessages);
    });

    it('uses provider-reported prompt tokens as a floor', () => {
        const manager = new ContextManager({ contextWindow: 1_000, contextThreshold: 0.7 });

        expect(manager.trimIfNeeded(compactableMessages)).toBe(compactableMessages);
        expect(manager.trimIfNeeded(compactableMessages, { minimumPromptTokens: 800 })).not.toBe(compactableMessages);
    });

    it('reserves output capacity even when the threshold would allow more input', () => {
        const manager = new ContextManager({ contextWindow: 1_000, contextThreshold: 0.95 });

        expect(manager.trimIfNeeded(compactableMessages, {
            minimumPromptTokens: 850,
            reservedOutputTokens: 200,
        })).not.toBe(compactableMessages);
    });

    it('caps output reservation for small context windows', () => {
        const manager = new ContextManager({ contextWindow: 1_000, contextThreshold: 0.95 });

        expect(manager.trimIfNeeded(compactableMessages, {
            minimumPromptTokens: 700,
            reservedOutputTokens: 16_384,
        })).toBe(compactableMessages);
    });

    it('honors the 90 percent emergency threshold override', () => {
        const manager = new ContextManager({ contextWindow: 1_000, contextThreshold: 0.7 });

        expect(manager.trimIfNeeded(compactableMessages, {
            minimumPromptTokens: 899,
            threshold: 0.90,
        })).toBe(compactableMessages);
        expect(manager.trimIfNeeded(compactableMessages, {
            minimumPromptTokens: 901,
            threshold: 0.90,
        })).not.toBe(compactableMessages);
    });

    it('compacts prior turns into one checkpoint and preserves the complete active turn', () => {
        const manager = new ContextManager({ contextWindow: 300, contextThreshold: 0.5 });
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request', turnId: 'turn-old' },
            { role: 'assistant', content: 'old answer', turnId: 'turn-old', roundId: 'round-old' },
            { role: 'user', content: 'current request', turnId: 'turn-current' },
            {
                role: 'assistant', content: null, turnId: 'turn-current', roundId: 'round-current-1',
                tool_calls: Array.from({ length: 7 }, (_, index) => ({
                    id: `call-${index}`,
                    type: 'function' as const,
                    function: { name: 'read_file', arguments: '{}' },
                })),
            },
            ...Array.from({ length: 7 }, (_, index): ChatMessage => ({
                role: 'tool', content: `result ${index}`, tool_call_id: `call-${index}`,
                turnId: 'turn-current', roundId: 'round-current-1',
            })),
            { role: 'assistant', content: 'current answer', turnId: 'turn-current', roundId: 'round-current-2' },
        ];

        const compacted = manager.trimIfNeeded(messages, {
            minimumPromptTokens: 250,
            transcriptReference: { version: 1, sessionId: 'session-1', throughRecord: 42 },
        });
        const checkpoints = compacted.filter(message => message.checkpoint);

        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0].checkpoint).toEqual({
            version: 1,
            throughTurnId: 'turn-old',
            throughRoundId: 'round-old',
            transcript: { version: 1, sessionId: 'session-1', throughRecord: 42 },
        });
        expect(compacted.filter(message => message.turnId === 'turn-current')).toEqual(messages.slice(3));
    });

    it('keeps messages after the checkpoint boundary exact', () => {
        const manager = new ContextManager({ contextWindow: 300, contextThreshold: 0.5 });
        const interrupted: ChatMessage = {
            role: 'user', content: 'interrupted request', turnId: 'turn-interrupted',
        };
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'completed request', turnId: 'turn-complete' },
            { role: 'assistant', content: 'completed answer', turnId: 'turn-complete', roundId: 'round-complete' },
            interrupted,
            { role: 'user', content: 'current request', turnId: 'turn-current' },
            { role: 'assistant', content: 'current answer', turnId: 'turn-current', roundId: 'round-current' },
        ];

        const compacted = manager.trimIfNeeded(messages, { minimumPromptTokens: 250 });

        expect(compacted.find(message => message.checkpoint)?.checkpoint?.throughRoundId).toBe('round-complete');
        expect(compacted).toContainEqual(interrupted);
    });

    it('includes all matching tool results inside the checkpoint boundary', () => {
        const manager = new ContextManager({ contextWindow: 300, contextThreshold: 0.5 });
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request', turnId: 'turn-old' },
            {
                role: 'assistant', content: null, turnId: 'turn-old', roundId: 'round-tools',
                tool_calls: [
                    { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                ],
            },
            { role: 'tool', content: 'A', tool_call_id: 'call-a', turnId: 'turn-old', roundId: 'round-tools' },
            { role: 'tool', content: 'B', tool_call_id: 'call-b', turnId: 'turn-old', roundId: 'round-tools' },
            { role: 'user', content: 'current request', turnId: 'turn-current' },
            { role: 'assistant', content: 'answer', turnId: 'turn-current', roundId: 'round-current' },
        ];

        const compacted = manager.trimIfNeeded(messages, { minimumPromptTokens: 250 });

        expect(compacted.find(message => message.checkpoint)?.checkpoint?.throughRoundId).toBe('round-tools');
        expect(compacted.some(message => message.role === 'tool')).toBe(false);
    });
});

describe('ContextTrimMiddleware', () => {
    const largeTool = {
        type: 'function' as const,
        function: {
            name: 'large_tool',
            description: 'x'.repeat(3_000),
            parameters: { type: 'object' as const, properties: {} },
        },
    };

    async function runMiddleware(context: ChatContext): Promise<void> {
        const middleware = new ContextTrimMiddleware({ contextWindow: 1_000, contextThreshold: 0.7 });
        const next = async function* (): AsyncGenerator<ChatStreamChunk> {
            yield { type: 'done' };
        };
        for await (const _ of middleware.processStream(context, next)) {
            // Consume the stream so middleware post-processing would also run.
        }
    }

    it('compacts a complete stateless prompt', async () => {
        const context = {
            client: {} as ChatContext['client'],
            messages: compactableMessages,
            options: { tools: [largeTool] },
            stream: true,
        } satisfies ChatContext;

        await runMiddleware(context);

        expect(context.messages).not.toBe(compactableMessages);
    });

    it('does not compact an incremental Responses tail', async () => {
        const context = {
            client: {} as ChatContext['client'],
            messages: compactableMessages,
            options: { tools: [largeTool], previousResponseId: 'resp_123' },
            stream: true,
        } satisfies ChatContext;

        await runMiddleware(context);

        expect(context.messages).toBe(compactableMessages);
    });
});

describe('ContextManager.normalizeMessageSequence', () => {
    it('drops orphan tool messages with no preceding assistant tool call', () => {
        const manager = new ContextManager();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'tool', content: 'tool output', tool_call_id: 'call_1', name: 'read_file' },
            { role: 'assistant', content: 'Recovered context.' },
        ];

        expect(manager.normalizeMessageSequence(messages)).toEqual([
            { role: 'system', content: 'system' },
            { role: 'assistant', content: 'Recovered context.' },
        ]);
    });

    it('drops incomplete tool-call turns when a non-tool message arrives first', () => {
        const manager = new ContextManager();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'Inspect the file.' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
                    { id: 'call_2', type: 'function', function: { name: 'grep_search', arguments: '{"pattern":"foo"}' } },
                ],
            },
            { role: 'tool', content: 'file text', tool_call_id: 'call_1', name: 'read_file' },
            { role: 'assistant', content: 'Here is the answer.' },
        ];

        expect(manager.normalizeMessageSequence(messages)).toEqual([
            { role: 'system', content: 'system' },
            { role: 'user', content: 'Inspect the file.' },
            { role: 'assistant', content: 'Here is the answer.' },
        ]);
    });

    it('preserves valid assistant tool-call transactions', () => {
        const manager = new ContextManager();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'Inspect the file.' },
            {
                role: 'assistant',
                content: 'Checking the file.',
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
                ],
            },
            { role: 'tool', content: 'file text', tool_call_id: 'call_1', name: 'read_file' },
            { role: 'assistant', content: 'Here is the answer.' },
        ];

        expect(manager.normalizeMessageSequence(messages)).toEqual(messages);
    });
});
