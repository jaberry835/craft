import { describe, expect, it, vi } from 'vitest';
import { CopilotSdkRuntime } from '../src/copilotSdkRuntime';
import { BuiltinTools } from '../src/builtinTools';

function makeRuntime() {
    return new CopilotSdkRuntime({ sendToWebview: vi.fn() });
}

describe('CopilotSdkRuntime long-wait status', () => {
    it('shows provider-wait language when there is no more specific pending work', () => {
        const runtime = makeRuntime();

        const message = (runtime as any).describeLongWaitStatus(19000, 64000);

        expect(message).toContain('Waiting on Copilot CLI / model provider');
        expect(message).toContain('19s since the last update');
        expect(message).toContain('64s total');
        expect(message).toContain('rate limiting');
    });

    it('keeps specific pending-work messages when tools are still active', () => {
        const runtime = makeRuntime();
        (runtime as any).toolEntryIds.set('call_1', 'entry_1');

        const message = (runtime as any).describeLongWaitStatus(22000, 22000);

        expect(message).toContain('Tool execution is still in progress inside Copilot CLI');
        expect(message).toContain('22s since the last update');
    });

    it('prefers background task summaries when available', () => {
        const runtime = makeRuntime();
        (runtime as any).lastBackgroundTaskSummary = 'Background task still running: npm test';

        const message = (runtime as any).describeLongWaitStatus(31000, 40000);

        expect(message).toContain('Background task still running: npm test');
        expect(message).toContain('31s since the last update');
    });
});

describe('CopilotSdkRuntime browser tools', () => {
    it('bridges Junior web and browser tools into Copilot CLI sessions', async () => {
        const handler = vi.fn().mockResolvedValue({ success: true, result: 'Title: Example\nPage text:\nHello' });
        const builtinTools = {
            getDefinitions: () => [{
                type: 'function',
                function: {
                    name: 'browser_open',
                    description: 'Open and inspect a URL.',
                    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
                },
            }, {
                type: 'function',
                function: {
                    name: 'web_search',
                    description: 'Search the web.',
                    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
                },
            }],
            getHandler: () => handler,
        } as unknown as BuiltinTools;
        const runtime = new CopilotSdkRuntime({ sendToWebview: vi.fn() }, undefined, undefined, undefined, builtinTools);

        const tools = (runtime as any).buildBrowserTools();
        const result = await tools[0].handler({ url: 'https://example.test' });

        expect(tools).toHaveLength(2);
        expect(tools[0].name).toBe('browser_open');
        expect(tools[1].name).toBe('web_search');
        expect(tools[0].skipPermission).toBe(true);
        expect(handler).toHaveBeenCalledWith({ url: 'https://example.test' });
        expect(result).toContain('Page text:');
    });

    it('reports browser handler failures to the Copilot CLI', async () => {
        const builtinTools = {
            getDefinitions: () => [{
                type: 'function',
                function: { name: 'browser_open', description: 'Open URL.', parameters: { type: 'object', properties: {} } },
            }],
            getHandler: () => vi.fn().mockResolvedValue({ success: false, result: 'Navigation failed.' }),
        } as unknown as BuiltinTools;
        const runtime = new CopilotSdkRuntime({ sendToWebview: vi.fn() }, undefined, undefined, undefined, builtinTools);
        const tools = (runtime as any).buildBrowserTools();

        await expect(tools[0].handler({})).rejects.toThrow('Navigation failed.');
    });
});