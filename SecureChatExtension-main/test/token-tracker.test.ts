import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { TokenTracker } from '../src/tokenTracker';
import { ExtensionMessage } from '../src/types';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string, def?: unknown) => values[path] ?? def,
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }));
}

describe('TokenTracker.record', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
    });

    it('accumulates prompt + completion tokens across calls', () => {
        const t = new TokenTracker();
        t.record('chat', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
        t.record('chat', { prompt_tokens: 200, completion_tokens: 75, total_tokens: 275 });

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        expect(last.type).toBe('tokenUsage');
        if (last.type === 'tokenUsage') {
            // 100+50+200+75 = 425 -> "425" (under 1k)
            expect(last.totalTokens).toBe('425');
            // chat sub-total 425
            expect(last.chatTokens).toBe('425');
            expect(last.inlineTokens).toBe('0');
            expect(last.requests).toBe(2);
            expect(last.chatRequests).toBe(2);
            expect(last.inlineRequests).toBe(0);
        }
        t.dispose();
    });

    it('keeps chat and inline counters separate', () => {
        const t = new TokenTracker();
        t.record('chat', { prompt_tokens: 1500, completion_tokens: 0, total_tokens: 1500 });
        t.record('inline', { prompt_tokens: 0, completion_tokens: 2500, total_tokens: 2500 });

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        if (last.type === 'tokenUsage') {
            expect(last.chatTokens).toBe('1.5K');
            expect(last.inlineTokens).toBe('2.5K');
            expect(last.totalTokens).toBe('4.0K');
            expect(last.chatRequests).toBe(1);
            expect(last.inlineRequests).toBe(1);
        }
        t.dispose();
    });

    it('reset() zeros all counters', () => {
        const t = new TokenTracker();
        t.record('chat', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
        t.record('inline', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
        t.reset();

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        if (last.type === 'tokenUsage') {
            expect(last.totalTokens).toBe('0');
            expect(last.requests).toBe(0);
        }
        t.dispose();
    });

    it('formats large counts with K and M suffixes', () => {
        const t = new TokenTracker();
        t.record('chat', { prompt_tokens: 1_500_000, completion_tokens: 0, total_tokens: 1_500_000 });

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        if (last.type === 'tokenUsage') {
            expect(last.totalTokens).toBe('1.5M');
        }
        t.dispose();
    });

    it('reports percentage of context window', () => {
        setConfiguration({ 'agent.contextWindow': 1000 });
        const t = new TokenTracker();
        // 250 tokens / 1000 window = 25%
        t.record('chat', { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 });

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        if (last.type === 'tokenUsage') {
            expect(last.windowPct).toBe(25);
        }
        t.dispose();
    });

    it('caps windowPct at 100 when context exceeds window', () => {
        setConfiguration({ 'agent.contextWindow': 100 });
        const t = new TokenTracker();
        t.setContextSize(500);

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        if (last.type === 'tokenUsage') {
            expect(last.windowPct).toBe(100);
        }
        t.dispose();
    });

    it('uses dynamic context window override when provided', () => {
        setConfiguration({ 'agent.contextWindow': 1000 });
        const t = new TokenTracker();
        // Override the window to 100; 50 tokens / 100 = 50%
        t.setContextSize(50, 100);

        const sent: ExtensionMessage[] = [];
        t.setWebviewSender(m => sent.push(m));
        const last = sent[sent.length - 1];
        if (last.type === 'tokenUsage') {
            expect(last.windowPct).toBe(50);
            expect(last.contextWindow).toBe('100');
        }
        t.dispose();
    });
});
