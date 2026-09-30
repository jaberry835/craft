import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extensionMessageToRawEvent, RawTranscriptStore } from '../src/rawTranscript';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-transcript-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('RawTranscriptStore', () => {
    it('appends versioned records and supports bounded ranges', () => {
        const store = new RawTranscriptStore(tmpDir);
        store.append('session-1', 'user', { text: 'hello' });
        const reference = store.append('session-1', 'assistant', { text: 'world' });

        expect(reference.throughRecord).toBe(2);
        expect(store.read('session-1', 2, 500)).toMatchObject({
            totalRecords: 2,
            startRecord: 2,
            endRecord: 2,
            records: [{ version: 1, sequence: 2, sessionId: 'session-1', kind: 'assistant' }],
        });
    });

    it('redacts secrets, secret fields, and base64 payloads before writing', () => {
        const store = new RawTranscriptStore(tmpDir);
        store.append('session-1', 'tool-result', {
            apiKey: 'plain-value',
            text: 'Bearer abcdefghijklmnopqrstuvwxyz data:image/png;base64,AAAA',
        });

        const serialized = JSON.stringify(store.read('session-1').records[0]);
        expect(serialized).toContain('«redacted:field»');
        expect(serialized).toContain('«redacted:bearer»');
        expect(serialized).toContain('«redacted:base64-payload»');
        expect(serialized).not.toContain('plain-value');
        expect(serialized).not.toContain('AAAA');
    });

    it('confines malicious session ids and deletes their artifacts', () => {
        const store = new RawTranscriptStore(tmpDir);
        store.append('../../outside', 'user', { text: 'safe' });

        expect(fs.existsSync(path.join(tmpDir, 'outside.jsonl'))).toBe(false);
        expect(store.read('../../outside').records).toHaveLength(1);

        store.delete('../../outside');
        expect(store.read('../../outside').records).toHaveLength(0);
    });

    it('maps tool and usage extension messages to durable event kinds', () => {
        expect(extensionMessageToRawEvent({
            type: 'toolCall', id: 'call-1', name: 'read_file', args: '{}',
        })).toMatchObject({ kind: 'tool-call' });
        expect(extensionMessageToRawEvent({
            type: 'tokenUsage',
            totalTokens: '1', chatTokens: '1', inlineTokens: '0', chatPct: '100', inlinePct: '0',
            requests: 1, chatPrompt: '1', chatCompletion: '0', inlinePrompt: '0', inlineCompletion: '0',
            chatPromptPct: '100', chatCompletionPct: '0', inlinePromptPct: '0', inlineCompletionPct: '0',
            chatRequests: 1, inlineRequests: 0, windowPct: 1, contextWindow: '100',
        })).toMatchObject({ kind: 'provider-usage' });
    });

    it('summarizes authoritative usage, request reliability, and compaction without UI double-counting', () => {
        const store = new RawTranscriptStore(tmpDir);
        store.append('session-1', 'provider-usage', {
            nativeCompactionEnabled: true,
            compactThreshold: 125,
            usage: {
                prompt_tokens: 100,
                uncached_prompt_tokens: 40,
                cached_prompt_tokens: 60,
                cache_write_tokens: 10,
                completion_tokens: 20,
                reasoning_tokens: 8,
            },
        });
        store.append('session-1', 'provider-usage', { type: 'tokenUsage', totalTokens: '120' });
        store.append('session-1', 'provider-request', {
            requestId: 'request-1', status: 'successful', durationMs: 200,
        });
        store.append('session-1', 'provider-request', {
            requestId: 'request-2', status: 'retried', durationMs: 100,
        });
        store.append('session-1', 'provider-request', { status: 'stalled', reason: 'stream-stall-retry' });
        store.append('session-1', 'status', {
            operation: 'conversation-compaction', source: 'provider-native',
            fallbackReason: 'unsupported-provider-field',
        });

        expect(store.summarizeTelemetry('session-1')).toEqual({
            totalRecords: 6,
            usage: {
                events: 1,
                inputTokens: 100,
                latestInputTokens: 100,
                maxInputTokens: 100,
                uncachedInputTokens: 40,
                cachedInputTokens: 60,
                cacheWriteTokens: 10,
                outputTokens: 20,
                reasoningTokens: 8,
                cacheHitRate: 0.6,
            },
            requests: {
                successful: 1,
                failed: 0,
                retried: 1,
                stalled: 0,
                canceled: 0,
                retrySignals: 1,
                successRate: 1,
                averageDurationMs: 150,
            },
            compactions: {
                total: 1,
                fallbacks: 1,
                bySource: { 'provider-native': 1 },
                nativeUsageEvents: 1,
                thresholdTokens: 125,
                peakThresholdUtilization: 0.8,
            },
        });
    });

    it.skipIf(process.platform === 'win32')('restricts transcript files to the current user on POSIX', () => {
        const store = new RawTranscriptStore(tmpDir);
        store.append('session-1', 'user', { text: 'hello' });
        const [fileName] = fs.readdirSync(path.join(tmpDir, 'transcripts'));
        const mode = fs.statSync(path.join(tmpDir, 'transcripts', fileName)).mode & 0o777;
        expect(mode).toBe(0o600);
    });
});