import { ToolEntry, ToolContext } from './types';

export function createTranscriptTools(ctx: ToolContext): ToolEntry[] {
    return [{
        definition: {
            type: 'function',
            function: {
                name: 'read_session_transcript',
                description: 'Read a bounded range of exact older records from the current chat session transcript.',
                parameters: {
                    type: 'object',
                    properties: {
                        start_record: {
                            type: 'number',
                            description: 'One-based record number to start reading. Defaults to 1.',
                        },
                        max_records: {
                            type: 'number',
                            description: 'Maximum records to return, from 1 to 200. Defaults to 50.',
                        },
                    },
                },
            },
        },
        handler: async args => {
            if (!ctx.callbacks.readTranscript) {
                return { success: false, result: 'The current session transcript is unavailable.' };
            }
            const startRecord = args.start_record === undefined ? 1 : Number(args.start_record);
            const maxRecords = args.max_records === undefined ? 50 : Number(args.max_records);
            if (!Number.isInteger(startRecord) || startRecord < 1 ||
                !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200) {
                return { success: false, result: 'start_record must be at least 1 and max_records must be between 1 and 200.' };
            }
            return ctx.callbacks.readTranscript(startRecord, maxRecords);
        },
    }, {
        definition: {
            type: 'function',
            function: {
                name: 'summarize_session_telemetry',
                description: 'Summarize current-session token usage, provider request reliability, and compaction activity without returning transcript content.',
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
        },
        handler: async () => {
            if (!ctx.callbacks.summarizeTelemetry) {
                return { success: false, result: 'The current session telemetry is unavailable.' };
            }
            return ctx.callbacks.summarizeTelemetry();
        },
    }];
}