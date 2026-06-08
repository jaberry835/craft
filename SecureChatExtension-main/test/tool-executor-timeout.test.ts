import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FunctionTool, ToolRegistry, ToolExecutor } from '../src/framework/tools';
import type { ToolDefinition } from '../src/types';

function makeTool(name: string, run: () => Promise<{ success: boolean; result: string }>): FunctionTool {
    const definition: ToolDefinition = {
        type: 'function',
        function: {
            name,
            description: 'test tool',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    };
    return new FunctionTool({ definition, handler: async () => run() });
}

describe('ToolExecutor timeout budgets', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('applies the default 60s wrapper to a generic tool', async () => {
        const registry = new ToolRegistry();
        registry.register(makeTool('slow_tool', () => new Promise(() => { /* never resolves */ })));
        const executor = new ToolExecutor(registry);

        const promise = executor.execute('slow_tool', {}, 'call-1');
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.result).toContain('timed out after 60s');
    });

    it('does NOT apply the 60s wrapper to delegate_to_* tools (A2A self-timed)', async () => {
        const registry = new ToolRegistry();
        let settled = false;
        registry.register(makeTool('delegate_to_library_agent', async () => {
            // Simulate a remote agent that streams well past 60s.
            await new Promise((r) => setTimeout(r, 90_000));
            settled = true;
            return { success: true, result: 'remote answer' };
        }));
        const executor = new ToolExecutor(registry);

        const promise = executor.execute('delegate_to_library_agent', {}, 'call-2');

        // After 60s the generic wrapper would have fired — confirm it did not.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(30_000);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.result).toBe('remote answer');
    });

    it('honors the abort signal for delegate_to_* tools', async () => {
        const registry = new ToolRegistry();
        registry.register(makeTool('delegate_to_library_agent', () => new Promise(() => { /* never resolves */ })));
        const executor = new ToolExecutor(registry);
        const controller = new AbortController();

        const promise = executor.execute('delegate_to_library_agent', {}, 'call-3', undefined, controller.signal);
        controller.abort();
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.result).toContain('Cancelled by user');
    });
});
