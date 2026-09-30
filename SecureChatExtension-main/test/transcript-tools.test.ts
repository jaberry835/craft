import { describe, expect, it, vi } from 'vitest';
import { createTranscriptTools } from '../src/tools/transcriptTools';
import { ToolContext } from '../src/tools/types';

describe('read_session_transcript tool', () => {
    it('reads only a bounded current-session record range', async () => {
        const readTranscript = vi.fn(() => ({ success: true, result: 'records' }));
        const [tool] = createTranscriptTools({ callbacks: { readTranscript } } as ToolContext);

        await expect(tool.handler({ start_record: 10, max_records: 25 })).resolves.toEqual({
            success: true,
            result: 'records',
        });
        expect(readTranscript).toHaveBeenCalledWith(10, 25);
    });

    it('rejects invalid or unbounded ranges', async () => {
        const readTranscript = vi.fn(() => ({ success: true, result: 'records' }));
        const [tool] = createTranscriptTools({ callbacks: { readTranscript } } as ToolContext);

        await expect(tool.handler({ start_record: 0, max_records: 201 })).resolves.toMatchObject({ success: false });
        expect(readTranscript).not.toHaveBeenCalled();
    });

    it('returns aggregate telemetry without reading raw transcript ranges', async () => {
        const readTranscript = vi.fn(() => ({ success: true, result: 'records' }));
        const summarizeTelemetry = vi.fn(() => ({ success: true, result: '{"usage":{}}' }));
        const [, telemetryTool] = createTranscriptTools({
            callbacks: { readTranscript, summarizeTelemetry },
        } as ToolContext);

        await expect(telemetryTool.handler({})).resolves.toEqual({
            success: true,
            result: '{"usage":{}}',
        });
        expect(summarizeTelemetry).toHaveBeenCalledOnce();
        expect(readTranscript).not.toHaveBeenCalled();
    });
});