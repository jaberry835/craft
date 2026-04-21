import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/contextManager';
import type { ChatMessage } from '../src/types';

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
