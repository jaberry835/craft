import {
    AgentProvider,
    ExtensionMessage,
    PersistedAssistantTranscriptItem,
    PersistedTranscript,
    PersistedTranscriptItem,
    WorkingBlock,
    WorkingBlockActionEntry,
    WorkingBlockEntry,
    WorkingBlockTerminalEntry,
} from './types';

export interface TranscriptCaptureOptions {
    provider?: AgentProvider;
}

const TRANSCRIPT_VERSION = 1 as const;

export function createEmptyTranscript(): PersistedTranscript {
    return {
        version: TRANSCRIPT_VERSION,
        items: [],
    };
}

export function shouldPersistTranscriptMessage(message: ExtensionMessage): boolean {
    switch (message.type) {
        case 'addUserMessage':
        case 'startAssistantMessage':
        case 'appendAssistantText':
        case 'endAssistantMessage':
        case 'narrationText':
        case 'devTeamRoomEvent':
        case 'reasoningStart':
        case 'reasoningAppend':
        case 'reasoningEnd':
        case 'workingBlockStarted':
        case 'workingTextAppended':
        case 'workingActionAdded':
        case 'workingActionUpdated':
        case 'workingActionProgress':
        case 'workingBlockCompleted':
        case 'terminalOutput':
        case 'error':
            return true;
        default:
            return false;
    }
}

export function applyTranscriptMessage(
    transcript: PersistedTranscript | undefined,
    message: ExtensionMessage,
    options?: TranscriptCaptureOptions,
): PersistedTranscript {
    const current = ensureTranscript(transcript);
    if (!shouldPersistTranscriptMessage(message)) {
        return current;
    }

    switch (message.type) {
        case 'addUserMessage': {
            current.items.push({
                id: nextId('user'),
                kind: 'user',
                text: message.text,
                fileNames: message.fileNames ? [...message.fileNames] : undefined,
                images: sanitizeImages(message.images),
            });
            return current;
        }
        case 'startAssistantMessage': {
            const assistant: PersistedAssistantTranscriptItem = {
                id: nextId('assistant'),
                kind: 'assistant',
                text: '',
                provider: options?.provider || 'local',
                team: message.team,
            };
            current.items.push(assistant);
            current.activeAssistantMessageId = assistant.id;
            return current;
        }
        case 'appendAssistantText': {
            const assistant = getOrCreateActiveAssistant(current, options?.provider || 'local');
            assistant.text += message.text;
            return current;
        }
        case 'endAssistantMessage': {
            current.activeAssistantMessageId = undefined;
            return current;
        }
        case 'narrationText': {
            current.items.push({
                id: nextId('narration'),
                kind: 'narration',
                text: message.text,
            });
            return current;
        }
        case 'devTeamRoomEvent': {
            current.items.push({
                id: nextId('dev-team-room-event'),
                kind: 'dev-team-room-event',
                event: { ...message.event },
            });
            return current;
        }
        case 'reasoningStart': {
            const reasoning = {
                id: nextId('reasoning'),
                kind: 'reasoning' as const,
                text: '',
            };
            current.items.push(reasoning);
            current.activeReasoningItemId = reasoning.id;
            return current;
        }
        case 'reasoningAppend': {
            const reasoning = current.activeReasoningItemId
                ? current.items.find((item): item is import('./types').PersistedReasoningTranscriptItem => item.kind === 'reasoning' && item.id === current.activeReasoningItemId)
                : undefined;
            if (reasoning) {
                reasoning.text += message.text;
            } else {
                const created = {
                    id: nextId('reasoning'),
                    kind: 'reasoning' as const,
                    text: message.text,
                };
                current.items.push(created);
                current.activeReasoningItemId = created.id;
            }
            return current;
        }
        case 'reasoningEnd': {
            current.activeReasoningItemId = undefined;
            return current;
        }
        case 'workingBlockStarted': {
            current.items.push({
                id: message.block.id,
                kind: 'working-block',
                block: cloneWorkingBlock({
                    ...message.block,
                    entries: [],
                }),
            });
            current.activeWorkingBlockId = message.block.id;
            return current;
        }
        case 'workingTextAppended': {
            const block = findWorkingBlock(current, message.blockId);
            if (!block) { return current; }
            block.entries.push(cloneEntry(message.entry));
            return current;
        }
        case 'workingActionAdded': {
            const block = findWorkingBlock(current, message.blockId);
            if (!block) { return current; }
            block.entries.push(cloneEntry(message.entry));
            return current;
        }
        case 'workingActionUpdated': {
            const block = findWorkingBlock(current, message.blockId);
            if (!block) { return current; }
            const entry = block.entries.find((candidate): candidate is WorkingBlockActionEntry => candidate.kind === 'action' && candidate.id === message.entryId);
            if (!entry) { return current; }
            entry.status = message.status;
            entry.text = typeof message.text === 'string' ? message.text : entry.text;
            entry.detail = typeof message.detail === 'string' ? message.detail : entry.detail;
            entry.filePath = typeof message.filePath === 'string' ? message.filePath : entry.filePath;
            entry.icon = typeof message.icon === 'string' ? message.icon : entry.icon;
            entry.repeatCount = typeof message.repeatCount === 'number' ? message.repeatCount : entry.repeatCount;
            return current;
        }
        case 'workingActionProgress': {
            const block = findWorkingBlock(current, message.blockId);
            if (!block) { return current; }
            const entry = block.entries.find((candidate): candidate is WorkingBlockActionEntry => candidate.kind === 'action' && candidate.id === message.entryId);
            if (!entry) { return current; }
            if (!entry.progressLog) { entry.progressLog = []; }
            entry.progressLog.push({ ...message.update });
            return current;
        }
        case 'workingBlockCompleted': {
            const block = findWorkingBlock(current, message.blockId);
            if (!block) { return current; }
            block.status = 'completed';
            block.summary = message.summary;
            block.completedAt = message.completedAt;
            if (current.activeWorkingBlockId === message.blockId) {
                current.activeWorkingBlockId = undefined;
            }
            return current;
        }
        case 'terminalOutput': {
            const blockId = current.activeWorkingBlockId;
            if (!blockId) { return current; }
            const block = findWorkingBlock(current, blockId);
            if (!block) { return current; }
            const lastEntry = block.entries[block.entries.length - 1];
            if (lastEntry?.kind === 'terminal') {
                lastEntry.text = `${lastEntry.text}${message.line}\n`;
                return current;
            }
            block.entries.push({
                id: nextId('terminal'),
                kind: 'terminal',
                text: `${message.line}\n`,
                createdAt: Date.now(),
            });
            return current;
        }
        case 'error': {
            current.items.push({
                id: nextId('error'),
                kind: 'error',
                message: message.message,
            });
            return current;
        }
        default:
            return current;
    }
}

function ensureTranscript(transcript: PersistedTranscript | undefined): PersistedTranscript {
    if (!transcript || !Array.isArray(transcript.items)) {
        return createEmptyTranscript();
    }

    transcript.version = TRANSCRIPT_VERSION;
    if (!Array.isArray(transcript.items)) {
        transcript.items = [];
    }
    return transcript;
}

function getOrCreateActiveAssistant(transcript: PersistedTranscript, provider: AgentProvider): PersistedAssistantTranscriptItem {
    const activeAssistant = transcript.activeAssistantMessageId
        ? transcript.items.find((item): item is PersistedAssistantTranscriptItem => item.kind === 'assistant' && item.id === transcript.activeAssistantMessageId)
        : undefined;

    if (activeAssistant) {
        return activeAssistant;
    }

    const assistant: PersistedAssistantTranscriptItem = {
        id: nextId('assistant'),
        kind: 'assistant',
        text: '',
        provider,
    };
    transcript.items.push(assistant);
    transcript.activeAssistantMessageId = assistant.id;
    return assistant;
}

function findWorkingBlock(transcript: PersistedTranscript, blockId: string): WorkingBlock | undefined {
    const item = transcript.items.find((candidate) => candidate.kind === 'working-block' && candidate.block.id === blockId);
    return item?.kind === 'working-block' ? item.block : undefined;
}

function sanitizeImages(images: string[] | undefined): string[] | undefined {
    if (!images || images.length === 0) {
        return undefined;
    }

    const persisted = images.filter((image) => typeof image === 'string' && !image.startsWith('data:'));
    return persisted.length > 0 ? persisted : undefined;
}

function cloneWorkingBlock(block: WorkingBlock): WorkingBlock {
    return {
        ...block,
        entries: block.entries.map(cloneEntry),
    };
}

function cloneEntry(entry: WorkingBlockEntry): WorkingBlockEntry {
    return { ...entry };
}

function nextId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}