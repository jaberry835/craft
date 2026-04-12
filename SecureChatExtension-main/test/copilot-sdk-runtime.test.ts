import { describe, expect, it, vi } from 'vitest';
import { CopilotSdkRuntime } from '../src/copilotSdkRuntime';

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