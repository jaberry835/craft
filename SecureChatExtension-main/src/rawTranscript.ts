import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets } from './security';
import { AgentProvider, ExtensionMessage, TranscriptReference } from './types';

export const RAW_TRANSCRIPT_VERSION = 1 as const;
const MAX_READ_RECORDS = 200;
const DATA_URI_PATTERN = /data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi;
const SECRET_FIELD_PATTERN = /^(?:api[-_]?key|key|token|authToken|bearerToken|secret|password|authorization|cookie)$/i;

export type RawTranscriptEventKind =
    | 'user'
    | 'assistant'
    | 'tool-call'
    | 'tool-result'
    | 'validation'
    | 'cancellation'
    | 'provider-usage'
    | 'provider-request'
    | 'error'
    | 'status';

export interface RawTranscriptRecord {
    version: typeof RAW_TRANSCRIPT_VERSION;
    sequence: number;
    timestamp: string;
    sessionId: string;
    kind: RawTranscriptEventKind;
    payload: unknown;
}

export interface TranscriptReadResult {
    records: RawTranscriptRecord[];
    totalRecords: number;
    startRecord: number;
    endRecord: number;
}

export interface SessionTelemetrySummary {
    totalRecords: number;
    usage: {
        events: number;
        inputTokens: number;
        latestInputTokens: number;
        maxInputTokens: number;
        uncachedInputTokens: number;
        cachedInputTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        cacheHitRate: number;
    };
    requests: {
        successful: number;
        failed: number;
        retried: number;
        stalled: number;
        canceled: number;
        retrySignals: number;
        successRate: number;
        averageDurationMs: number;
    };
    compactions: {
        total: number;
        fallbacks: number;
        bySource: Record<string, number>;
        nativeUsageEvents: number;
        thresholdTokens?: number;
        peakThresholdUtilization?: number;
    };
}

export class RawTranscriptStore {
    private readonly root: string;
    private readonly nextSequences = new Map<string, number>();

    constructor(storageDir: string) {
        this.root = path.resolve(storageDir, 'transcripts');
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }

    append(sessionId: string, kind: RawTranscriptEventKind, payload: unknown): TranscriptReference {
        const filePath = this.getSessionPath(sessionId);
        const sequence = this.getNextSequence(sessionId, filePath);
        const record: RawTranscriptRecord = {
            version: RAW_TRANSCRIPT_VERSION,
            sequence,
            timestamp: new Date().toISOString(),
            sessionId,
            kind,
            payload: sanitizeTranscriptValue(payload),
        };
        fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') {
            fs.chmodSync(filePath, 0o600);
        }
        this.nextSequences.set(sessionId, sequence + 1);
        return { version: RAW_TRANSCRIPT_VERSION, sessionId, throughRecord: sequence };
    }

    getReference(sessionId: string): TranscriptReference | undefined {
        const filePath = this.getSessionPath(sessionId);
        const totalRecords = this.countRecords(filePath);
        return totalRecords > 0
            ? { version: RAW_TRANSCRIPT_VERSION, sessionId, throughRecord: totalRecords }
            : undefined;
    }

    read(sessionId: string, startRecord = 1, maxRecords = 50): TranscriptReadResult {
        const filePath = this.getSessionPath(sessionId);
        const safeStart = Math.max(1, Math.floor(startRecord));
        const safeLimit = Math.min(MAX_READ_RECORDS, Math.max(1, Math.floor(maxRecords)));
        const lines = this.readLines(filePath);
        const records = lines
            .slice(safeStart - 1, safeStart - 1 + safeLimit)
            .map(line => JSON.parse(line) as RawTranscriptRecord);
        return {
            records,
            totalRecords: lines.length,
            startRecord: safeStart,
            endRecord: records.length > 0 ? safeStart + records.length - 1 : safeStart - 1,
        };
    }

    summarizeTelemetry(sessionId: string): SessionTelemetrySummary {
        const records = this.readLines(this.getSessionPath(sessionId))
            .map(line => JSON.parse(line) as RawTranscriptRecord);
        return summarizeTranscriptTelemetry(records);
    }

    delete(sessionId: string): void {
        const filePath = this.getSessionPath(sessionId);
        this.nextSequences.delete(sessionId);
        try {
            fs.rmSync(filePath, { force: true });
        } catch {
            // Session deletion should continue even if the artifact is already unavailable.
        }
    }

    private getSessionPath(sessionId: string): string {
        const fileName = `${crypto.createHash('sha256').update(sessionId).digest('hex')}.jsonl`;
        const filePath = path.resolve(this.root, fileName);
        if (path.dirname(filePath) !== this.root) {
            throw new Error('Transcript path escaped the storage root.');
        }
        return filePath;
    }

    private getNextSequence(sessionId: string, filePath: string): number {
        const cached = this.nextSequences.get(sessionId);
        if (cached) { return cached; }
        return this.countRecords(filePath) + 1;
    }

    private countRecords(filePath: string): number {
        return this.readLines(filePath).length;
    }

    private readLines(filePath: string): string[] {
        if (!fs.existsSync(filePath)) { return []; }
        return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    }
}

export function summarizeTranscriptTelemetry(records: readonly RawTranscriptRecord[]): SessionTelemetrySummary {
    const summary: SessionTelemetrySummary = {
        totalRecords: records.length,
        usage: {
            events: 0,
            inputTokens: 0,
            latestInputTokens: 0,
            maxInputTokens: 0,
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheHitRate: 0,
        },
        requests: {
            successful: 0,
            failed: 0,
            retried: 0,
            stalled: 0,
            canceled: 0,
            retrySignals: 0,
            successRate: 0,
            averageDurationMs: 0,
        },
        compactions: { total: 0, fallbacks: 0, bySource: {}, nativeUsageEvents: 0 },
    };
    let durationTotal = 0;
    let durationCount = 0;

    for (const record of records) {
        const payload = asRecord(record.payload);
        if (record.kind === 'provider-usage') {
            const usage = asRecord(payload?.usage);
            if (!usage) { continue; }
            summary.usage.events++;
            const inputTokens = numeric(usage.prompt_tokens);
            summary.usage.inputTokens += inputTokens;
            summary.usage.latestInputTokens = inputTokens;
            summary.usage.maxInputTokens = Math.max(summary.usage.maxInputTokens, inputTokens);
            summary.usage.uncachedInputTokens += numeric(usage.uncached_prompt_tokens);
            summary.usage.cachedInputTokens += numeric(usage.cached_prompt_tokens);
            summary.usage.cacheWriteTokens += numeric(usage.cache_write_tokens);
            summary.usage.outputTokens += numeric(usage.completion_tokens);
            summary.usage.reasoningTokens += numeric(usage.reasoning_tokens);
            const compactThreshold = numeric(payload?.compactThreshold);
            if (payload?.nativeCompactionEnabled === true && compactThreshold > 0) {
                summary.compactions.nativeUsageEvents++;
                summary.compactions.thresholdTokens = compactThreshold;
                summary.compactions.peakThresholdUtilization = Math.max(
                    summary.compactions.peakThresholdUtilization ?? 0,
                    inputTokens / compactThreshold
                );
            }
            continue;
        }
        if (record.kind === 'provider-request') {
            const status = payload?.status;
            const hasRequestId = typeof payload?.requestId === 'string';
            if (!hasRequestId) {
                if (status === 'retried' || status === 'stalled') { summary.requests.retrySignals++; }
                continue;
            }
            switch (status) {
                case 'successful': summary.requests.successful++; break;
                case 'failed': summary.requests.failed++; break;
                case 'retried': summary.requests.retried++; break;
                case 'stalled': summary.requests.stalled++; break;
                case 'canceled': summary.requests.canceled++; break;
            }
            const durationMs = numeric(payload?.durationMs);
            if (durationMs > 0) {
                durationTotal += durationMs;
                durationCount++;
            }
            continue;
        }
        if (record.kind === 'status' && payload?.operation === 'conversation-compaction') {
            const source = typeof payload.source === 'string' ? payload.source : 'unknown';
            summary.compactions.total++;
            summary.compactions.bySource[source] = (summary.compactions.bySource[source] ?? 0) + 1;
            if (payload.fallbackReason !== undefined) { summary.compactions.fallbacks++; }
        }
    }

    summary.usage.cacheHitRate = summary.usage.inputTokens > 0
        ? summary.usage.cachedInputTokens / summary.usage.inputTokens
        : 0;
    const completedRequests = summary.requests.successful + summary.requests.failed +
        summary.requests.stalled + summary.requests.canceled;
    summary.requests.successRate = completedRequests > 0
        ? summary.requests.successful / completedRequests
        : 0;
    summary.requests.averageDurationMs = durationCount > 0 ? durationTotal / durationCount : 0;
    return summary;
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function numeric(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function sanitizeTranscriptValue(value: unknown, key?: string): unknown {
    if (key && SECRET_FIELD_PATTERN.test(key)) {
        return '«redacted:field»';
    }
    if (typeof value === 'string') {
        return redactSecrets(value).replace(DATA_URI_PATTERN, '«redacted:base64-payload»');
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeTranscriptValue(item));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                sanitizeTranscriptValue(entryValue, entryKey),
            ])
        );
    }
    return value;
}

export function extensionMessageToRawEvent(
    message: ExtensionMessage,
    provider?: AgentProvider
): { kind: RawTranscriptEventKind; payload: unknown } | undefined {
    switch (message.type) {
        case 'addUserMessage':
            return { kind: 'user', payload: message };
        case 'appendAssistantText':
        case 'narrationText':
        case 'reasoningAppend':
            return { kind: 'assistant', payload: { ...message, provider } };
        case 'toolCall':
            return { kind: 'tool-call', payload: message };
        case 'toolResult':
            return { kind: 'tool-result', payload: message };
        case 'tokenUsage':
            return { kind: 'provider-usage', payload: message };
        case 'error':
            return { kind: 'error', payload: message };
        case 'setStatus':
        case 'agentStarted':
        case 'agentDone':
            return { kind: 'status', payload: message };
        default:
            return undefined;
    }
}