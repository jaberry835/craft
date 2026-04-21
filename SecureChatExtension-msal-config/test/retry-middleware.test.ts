import { describe, it, expect, vi } from 'vitest';
import { RetryMiddleware } from '../src/middleware/retryMiddleware';
import type { FunctionContext } from '../src/framework/middleware';
import type { ToolResult } from '../src/framework/types';

function makeContext(toolName = 'grep_search'): FunctionContext {
    return {
        tool: { name: toolName, definition: {} as any, isReadOnly: true, requiresConfirmation: false, execute: vi.fn(), validate: vi.fn() },
        args: { pattern: 'foo' },
        callId: 'call_1',
        state: new Map(),
    };
}

describe('RetryMiddleware', () => {
    it('passes through on success', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: true, result: 'ok' });

        const result = await mw.process(makeContext(), next);

        expect(result.success).toBe(true);
        expect(next).toHaveBeenCalledOnce();
    });

    it('retries once on failure then succeeds', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0 });
        const next = vi.fn()
            .mockResolvedValueOnce({ success: false, result: 'timeout' })
            .mockResolvedValueOnce({ success: true, result: 'ok' });

        const result = await mw.process(makeContext(), next);

        expect(result.success).toBe(true);
        expect(result.result).toBe('ok');
        expect(next).toHaveBeenCalledTimes(2);
    });

    it('returns failure with marker after all retries exhausted', async () => {
        const mw = new RetryMiddleware({ maxRetries: 2, retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'broken' });

        const result = await mw.process(makeContext(), next);

        expect(result.success).toBe(false);
        expect(result.result).toContain('[Retry also failed]');
        expect(next).toHaveBeenCalledTimes(3); // 1 original + 2 retries
    });

    it('does not retry write tools', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'write failed' });

        const result = await mw.process(makeContext('edit_file'), next);

        expect(result.success).toBe(false);
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not retry run_terminal_command', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'cmd failed' });

        const result = await mw.process(makeContext('run_terminal_command'), next);

        expect(next).toHaveBeenCalledOnce();
    });

    it('does not retry user-declined errors', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'User declined the edit' });

        const result = await mw.process(makeContext(), next);

        expect(next).toHaveBeenCalledOnce();
        expect(result.result).toBe('User declined the edit');
    });

    it('does not retry invalid path errors', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'Invalid path: /etc/passwd' });

        const result = await mw.process(makeContext(), next);

        expect(next).toHaveBeenCalledOnce();
    });

    it('respects custom maxRetries', async () => {
        const mw = new RetryMiddleware({ maxRetries: 3, retryDelayMs: 0 });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'fail' });

        await mw.process(makeContext(), next);

        expect(next).toHaveBeenCalledTimes(4); // 1 original + 3 retries
    });

    it('respects additionalNoRetryTools', async () => {
        const mw = new RetryMiddleware({ retryDelayMs: 0, additionalNoRetryTools: ['my_tool'] });
        const next = vi.fn().mockResolvedValue({ success: false, result: 'fail' });

        const result = await mw.process(makeContext('my_tool'), next);

        expect(next).toHaveBeenCalledOnce();
    });
});
