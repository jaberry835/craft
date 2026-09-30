import { describe, expect, it } from 'vitest';
import { hydrateHistoryMetadata } from '../src/conversationHistory';
import { ChatMessage } from '../src/types';

describe('conversation history metadata', () => {
    it('hydrates legacy turns and complete parallel tool rounds deterministically', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'System' },
            { role: 'user', content: 'Inspect both files' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                    { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                ],
            },
            { role: 'tool', content: 'A', tool_call_id: 'call-a' },
            { role: 'tool', content: 'B', tool_call_id: 'call-b' },
            { role: 'assistant', content: 'Done' },
        ];

        const hydrated = hydrateHistoryMetadata(messages, 'session-1');

        expect(hydrated[0].turnId).toBeUndefined();
        expect(hydrated.slice(1).map(message => message.turnId)).toEqual([
            'turn_session-1_1',
            'turn_session-1_1',
            'turn_session-1_1',
            'turn_session-1_1',
            'turn_session-1_1',
        ]);
        expect(hydrated.slice(2, 5).map(message => message.roundId)).toEqual([
            'round_session-1_1_1',
            'round_session-1_1_1',
            'round_session-1_1_1',
        ]);
        expect(hydrated[5].roundId).toBe('round_session-1_1_2');
        expect(hydrateHistoryMetadata(hydrated, 'session-1')).toBe(hydrated);
    });

    it('preserves existing stable identifiers', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Continue', turnId: 'turn-existing' },
            { role: 'assistant', content: 'Ready', turnId: 'turn-existing', roundId: 'round-existing' },
        ];

        expect(hydrateHistoryMetadata(messages, 'ignored')).toBe(messages);
    });
});