import { describe, expect, it } from 'vitest';
import { ContextManager } from '../src/contextManager';
import type { ChatMessage, ToolCall } from '../src/types';

type ToolPattern = 'sequential' | 'parallel';

function buildTurn(index: number, pattern: ToolPattern): ChatMessage[] {
    const turnId = `turn-${index}`;
    const toolCount = pattern === 'parallel' ? 3 : 1;
    const toolCalls: ToolCall[] = Array.from({ length: toolCount }, (_, toolIndex) => ({
        id: `call-${index}-${toolIndex}`,
        type: 'function',
        function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: `src/fixture-${index}-${toolIndex}.ts` }),
        },
    }));
    const toolRoundId = `round-${index}-tools`;
    const completionRoundId = `round-${index}-complete`;

    return [
        {
            role: 'user',
            content: `Inspect fixture ${index} and preserve its acceptance result.`,
            turnId,
        },
        {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls,
            turnId,
            roundId: toolRoundId,
        },
        ...toolCalls.map((toolCall, toolIndex): ChatMessage => ({
            role: 'tool',
            content: `fixture-${index}-${toolIndex}:BEGIN\n${'implementation evidence '.repeat(90)}\nfixture-${index}-${toolIndex}:END`,
            tool_call_id: toolCall.id,
            turnId,
            roundId: toolRoundId,
        })),
        {
            role: 'assistant',
            content: `TURN_${index}_TASK_COMPLETE`,
            turnId,
            roundId: completionRoundId,
        },
    ];
}

function buildLongSession(pattern: ToolPattern): ChatMessage[] {
    return [
        { role: 'system', content: 'Complete every fixture and preserve exact recent tool evidence.' },
        ...Array.from({ length: 14 }, (_, index) => buildTurn(index + 1, pattern)).flat(),
    ];
}

describe.each(['sequential', 'parallel'] as const)('long-session %s tool fixture', pattern => {
    it('reduces repeated input without losing completion or the active tool round', () => {
        const manager = new ContextManager({ contextWindow: 4_000, contextThreshold: 0.7 });
        const history = buildLongSession(pattern);
        const baselineTokens = manager.estimatePromptTokens(history, { modelId: 'gpt-5.4' });
        const activeTurn = history.filter(message => message.turnId === 'turn-14');

        const compacted = manager.trimIfNeeded(history, {
            modelId: 'gpt-5.4',
            transcriptReference: { version: 1, sessionId: `long-${pattern}`, throughRecord: 200 },
        });
        const compactedTokens = manager.estimatePromptTokens(compacted, { modelId: 'gpt-5.4' });

        expect(compacted).not.toBe(history);
        expect(compactedTokens).toBeLessThan(baselineTokens);
        expect(compactedTokens / baselineTokens).toBeLessThan(0.65);
        expect(compacted.filter(message => message.turnId === 'turn-14')).toEqual(activeTurn);
        expect(compacted.at(-1)?.content).toBe('TURN_14_TASK_COMPLETE');
        expect(compacted.some(message => message.checkpoint?.throughTurnId === 'turn-13')).toBe(true);
        expect(manager.normalizeMessageSequence(compacted)).toBe(compacted);
    });
});
