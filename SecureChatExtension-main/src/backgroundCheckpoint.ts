import { ChatMessage, ConversationCheckpointMetadata, TranscriptReference } from './types';

export interface StructuredCheckpointData {
    version: 1;
    objective: string;
    constraints: string[];
    decisions: string[];
    files: string[];
    edits: string[];
    validations: string[];
    failures: string[];
    outstandingWork: string[];
    recentOperations: string[];
}

export interface BackgroundCheckpointRequest {
    messages: ChatMessage[];
    promptTokens: number;
    contextWindow: number;
    modelId: string;
    transcriptReference?: TranscriptReference;
    generate: (messagesThroughBoundary: ChatMessage[], signal: AbortSignal) => Promise<string>;
}

interface CompleteRound {
    turnId: string;
    roundId: string;
    endIndex: number;
}

interface ReadyCheckpoint {
    data: StructuredCheckpointData;
    modelId: string;
    contextWindow: number;
    boundary: CompleteRound;
    transcriptReference?: TranscriptReference;
}

export class BackgroundCheckpointManager {
    private pendingKey: string | undefined;
    private ready: ReadyCheckpoint | undefined;
    private epoch = 0;
    private abortController: AbortController | undefined;
    private pendingModelId: string | undefined;
    private pendingContextWindow: number | undefined;

    get isPending(): boolean { return this.pendingKey !== undefined; }

    maybeStart(request: BackgroundCheckpointRequest): boolean {
        const utilization = request.promptTokens / request.contextWindow;
        if (utilization < 0.80 || utilization >= 0.90) { return false; }

        const exactRoundCount = utilization >= 0.88 ? 2 : utilization >= 0.84 ? 3 : 4;
        const rounds = findCompleteRounds(request.messages);
        if (rounds.length <= exactRoundCount) { return false; }

        const boundary = rounds[rounds.length - exactRoundCount - 1];
        const key = `${request.modelId}|${request.contextWindow}|${boundary.roundId}`;
        if (this.pendingKey === key || (this.ready && checkpointKey(this.ready) === key)) {
            return false;
        }
        if (this.pendingKey && this.pendingKey !== key) {
            this.invalidate();
        }

        const epoch = this.epoch;
        this.abortController = new AbortController();
        this.pendingKey = key;
        this.pendingModelId = request.modelId;
        this.pendingContextWindow = request.contextWindow;
        const source = request.messages.slice(0, boundary.endIndex + 1).map(message => ({ ...message }));
        void request.generate(source, this.abortController.signal).then(raw => {
            if (this.epoch !== epoch || this.pendingKey !== key) { return; }
            const data = parseStructuredCheckpoint(raw);
            if (data) {
                this.ready = {
                    data,
                    modelId: request.modelId,
                    contextWindow: request.contextWindow,
                    boundary,
                    transcriptReference: request.transcriptReference,
                };
            }
        }).catch(() => {
            // Deterministic foreground compaction remains available at 90%.
        }).finally(() => {
            if (this.epoch === epoch && this.pendingKey === key) {
                this.pendingKey = undefined;
                this.pendingModelId = undefined;
                this.pendingContextWindow = undefined;
                this.abortController = undefined;
            }
        });
        return true;
    }

    applyReady(messages: ChatMessage[], modelId: string, contextWindow: number): ChatMessage[] | undefined {
        const ready = this.ready;
        this.ready = undefined;
        if (!ready || ready.modelId !== modelId || ready.contextWindow !== contextWindow) {
            return undefined;
        }

        const boundaryIndex = findRoundEnd(messages, ready.boundary.roundId);
        if (boundaryIndex < 0) { return undefined; }

        const systemMessage = messages[0]?.role === 'system' ? messages[0] : undefined;
        const metadata: ConversationCheckpointMetadata = {
            version: 1,
            throughTurnId: ready.boundary.turnId,
            throughRoundId: ready.boundary.roundId,
            ...(ready.transcriptReference ? { transcript: ready.transcriptReference } : {}),
        };
        const checkpoint: ChatMessage = {
            role: 'system',
            content: formatStructuredCheckpoint(ready.data, ready.transcriptReference),
            checkpoint: metadata,
        };
        return [
            ...(systemMessage ? [systemMessage] : []),
            checkpoint,
            ...messages.slice(boundaryIndex + 1),
        ];
    }

    synchronizeContext(modelId: string, contextWindow: number): void {
        if (this.pendingKey &&
            (this.pendingModelId !== modelId || this.pendingContextWindow !== contextWindow)) {
            this.invalidate();
            return;
        }
        if (this.ready && (this.ready.modelId !== modelId || this.ready.contextWindow !== contextWindow)) {
            this.ready = undefined;
        }
    }

    invalidate(): void {
        this.abortController?.abort();
        this.abortController = undefined;
        this.epoch++;
        this.pendingKey = undefined;
        this.pendingModelId = undefined;
        this.pendingContextWindow = undefined;
        this.ready = undefined;
    }
}

export function buildCheckpointPrompt(messages: ChatMessage[]): ChatMessage[] {
    return [
        {
            role: 'system',
            content: 'Create a compact continuation checkpoint from the supplied conversation. Return JSON only with version=1 and these fields: objective, constraints, decisions, files, edits, validations, failures, outstandingWork, recentOperations. Preserve concrete names, paths, commands, outcomes, and unresolved work. Every field except objective is an array of strings.',
        },
        {
            role: 'user',
            content: JSON.stringify(messages.map(message => ({
                role: message.role,
                content: message.content,
                tool_calls: message.tool_calls,
                tool_call_id: message.tool_call_id,
                name: message.name,
                turnId: message.turnId,
                roundId: message.roundId,
                checkpoint: message.checkpoint,
            }))),
        },
    ];
}

function findCompleteRounds(messages: ChatMessage[]): CompleteRound[] {
    const rounds: CompleteRound[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role !== 'assistant' || !message.turnId || !message.roundId) { continue; }
        const expected = new Set((message.tool_calls ?? []).map(toolCall => toolCall.id));
        let endIndex = index;
        while (endIndex + 1 < messages.length && messages[endIndex + 1].role === 'tool') {
            endIndex++;
            const callId = messages[endIndex].tool_call_id;
            if (callId) { expected.delete(callId); }
        }
        if (expected.size === 0) {
            rounds.push({ turnId: message.turnId, roundId: message.roundId, endIndex });
        }
        index = endIndex;
    }
    return rounds;
}

function findRoundEnd(messages: ChatMessage[], roundId: string): number {
    let endIndex = -1;
    for (let index = 0; index < messages.length; index++) {
        if (messages[index].roundId === roundId) { endIndex = index; }
    }
    return endIndex;
}

function checkpointKey(checkpoint: ReadyCheckpoint): string {
    return `${checkpoint.modelId}|${checkpoint.contextWindow}|${checkpoint.boundary.roundId}`;
}

function parseStructuredCheckpoint(raw: string): StructuredCheckpointData | undefined {
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) { return undefined; }
        const value = JSON.parse(match[0]) as Record<string, unknown>;
        const arrayFields = [
            'constraints', 'decisions', 'files', 'edits', 'validations',
            'failures', 'outstandingWork', 'recentOperations',
        ] as const;
        if (value.version !== 1 || typeof value.objective !== 'string' || !value.objective.trim()) {
            return undefined;
        }
        if (arrayFields.some(field => !Array.isArray(value[field]) ||
            !(value[field] as unknown[]).every(item => typeof item === 'string'))) {
            return undefined;
        }
        return value as unknown as StructuredCheckpointData;
    } catch {
        return undefined;
    }
}

function formatStructuredCheckpoint(
    data: StructuredCheckpointData,
    transcriptReference?: TranscriptReference
): string {
    return `[Structured Conversation Checkpoint v1]\n${JSON.stringify({
        ...data,
        ...(transcriptReference ? { transcriptReference } : {}),
    }, null, 2)}`;
}