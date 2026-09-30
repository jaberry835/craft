import { describe, expect, it } from 'vitest';
import { BackgroundCheckpointManager } from '../src/backgroundCheckpoint';
import { ChatMessage } from '../src/types';

function history(roundCount: number): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: 'system' }];
    for (let index = 1; index <= roundCount; index++) {
        messages.push({
            role: 'assistant', content: `round ${index}`,
            turnId: 'turn-1', roundId: `round-${index}`,
        });
    }
    return messages;
}

const validCheckpoint = JSON.stringify({
    version: 1,
    objective: 'Finish the context work',
    constraints: ['Keep compatibility'],
    decisions: ['Use JSONL'],
    files: ['src/contextManager.ts'],
    edits: ['Added checkpoints'],
    validations: ['Tests passed'],
    failures: [],
    outstandingWork: ['Run full tests'],
    recentOperations: ['Compiled TypeScript'],
});

describe('BackgroundCheckpointManager', () => {
    it('starts without awaiting generation and keeps four recent rounds at 80%', async () => {
        let resolve!: (value: string) => void;
        const generation = new Promise<string>(done => { resolve = done; });
        const manager = new BackgroundCheckpointManager();
        const messages = history(6);

        expect(manager.maybeStart({
            messages, promptTokens: 800, contextWindow: 1_000, modelId: 'gpt-5',
            transcriptReference: { version: 1, sessionId: 'session-1', throughRecord: 20 },
            generate: () => generation,
        })).toBe(true);
        expect(manager.isPending).toBe(true);
        expect(manager.applyReady(messages, 'gpt-5', 1_000)).toBeUndefined();

        resolve(validCheckpoint);
        await generation;
        await Promise.resolve();
        const compacted = manager.applyReady(messages, 'gpt-5', 1_000)!;

        expect(compacted[1].checkpoint?.throughRoundId).toBe('round-2');
        expect(compacted[1].checkpoint?.transcript?.throughRecord).toBe(20);
        expect(compacted[1].content).toContain('Use JSONL');
        expect(compacted[1].content).toContain('Tests passed');
        expect(compacted[1].content).toContain('Run full tests');
        expect(compacted.slice(2).map(message => message.roundId)).toEqual([
            'round-3', 'round-4', 'round-5', 'round-6',
        ]);
    });

    it('discards malformed and stale model results without changing history', async () => {
        const malformed = new BackgroundCheckpointManager();
        const messages = history(6);
        malformed.maybeStart({
            messages, promptTokens: 850, contextWindow: 1_000, modelId: 'gpt-5',
            generate: async () => '{"version":1}',
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(malformed.applyReady(messages, 'gpt-5', 1_000)).toBeUndefined();

        const stale = new BackgroundCheckpointManager();
        stale.maybeStart({
            messages, promptTokens: 850, contextWindow: 1_000, modelId: 'gpt-5',
            generate: async () => validCheckpoint,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(stale.applyReady(messages, 'gpt-5', 2_000)).toBeUndefined();
    });

    it('never starts more than one request for the same boundary', () => {
        const manager = new BackgroundCheckpointManager();
        const messages = history(6);
        const never = new Promise<string>(() => undefined);
        const request = {
            messages, promptTokens: 800, contextWindow: 1_000, modelId: 'gpt-5',
            generate: () => never,
        };

        expect(manager.maybeStart(request)).toBe(true);
        expect(manager.maybeStart(request)).toBe(false);
    });

    it.each([
        [800, 'round-2', 4],
        [850, 'round-3', 3],
        [880, 'round-4', 2],
    ] as const)('keeps an adaptive exact tail at %s tokens', async (promptTokens, boundaryRound, exactRounds) => {
        const manager = new BackgroundCheckpointManager();
        const messages = history(6);
        manager.maybeStart({
            messages, promptTokens, contextWindow: 1_000, modelId: 'gpt-5',
            generate: async () => validCheckpoint,
        });
        await Promise.resolve();
        await Promise.resolve();

        const compacted = manager.applyReady(messages, 'gpt-5', 1_000)!;
        expect(compacted[1].checkpoint?.throughRoundId).toBe(boundaryRound);
        expect(compacted.slice(2)).toHaveLength(exactRounds);
    });

    it('defers to foreground compaction at 90 percent', () => {
        const manager = new BackgroundCheckpointManager();
        expect(manager.maybeStart({
            messages: history(6), promptTokens: 900, contextWindow: 1_000, modelId: 'gpt-5',
            generate: async () => validCheckpoint,
        })).toBe(false);
    });

    it('aborts in-flight generation when the model context changes', async () => {
        const manager = new BackgroundCheckpointManager();
        const messages = history(6);
        let signal: AbortSignal | undefined;
        manager.maybeStart({
            messages, promptTokens: 800, contextWindow: 1_000, modelId: 'gpt-5',
            generate: (_source, currentSignal) => {
                signal = currentSignal;
                return new Promise((_resolve, reject) => {
                    currentSignal.addEventListener('abort', () => reject(new Error('aborted')));
                });
            },
        });

        manager.synchronizeContext('gpt-5', 2_000);
        await Promise.resolve();

        expect(signal?.aborted).toBe(true);
        expect(manager.isPending).toBe(false);
        expect(manager.applyReady(messages, 'gpt-5', 2_000)).toBeUndefined();
    });
});