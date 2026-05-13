import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTranscriptMessage, createEmptyTranscript } from '../src/chatTranscript';
import { SessionManager } from '../src/sessionManager';
import type { WorkingBlock } from '../src/types';

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-transcript-'));
    tempDirs.push(dir);
    return dir;
}

describe('chat transcript persistence', () => {
    it('preserves live ordering for narration, working blocks, terminal output, and assistant text', () => {
        const block: WorkingBlock = {
            id: 'block_1',
            status: 'in_progress',
            title: 'Inspect files',
            entries: [],
            startedAt: 100,
        };

        let transcript = createEmptyTranscript();
        transcript = applyTranscriptMessage(transcript, { type: 'addUserMessage', text: 'Inspect the restore bug' });
        transcript = applyTranscriptMessage(transcript, { type: 'narrationText', text: 'I am checking the session model first.' });
        transcript = applyTranscriptMessage(transcript, { type: 'workingBlockStarted', block });
        transcript = applyTranscriptMessage(transcript, {
            type: 'workingActionAdded',
            blockId: block.id,
            entry: {
                id: 'entry_1',
                kind: 'action',
                text: 'Read src/chatViewProvider.ts',
                createdAt: 101,
                actionType: 'read',
                status: 'done',
                icon: 'read',
                toolName: 'read_file',
            },
        });
        transcript = applyTranscriptMessage(transcript, { type: 'terminalOutput', line: 'npm test' });
        transcript = applyTranscriptMessage(transcript, {
            type: 'workingBlockCompleted',
            blockId: block.id,
            summary: 'Reviewed 1 file',
            completedAt: 110,
        });
        transcript = applyTranscriptMessage(transcript, { type: 'startAssistantMessage' }, { provider: 'copilot-cli' });
        transcript = applyTranscriptMessage(transcript, { type: 'appendAssistantText', text: 'The restore bug is in the replay layer.' }, { provider: 'copilot-cli' });
        transcript = applyTranscriptMessage(transcript, { type: 'endAssistantMessage' }, { provider: 'copilot-cli' });

        expect(transcript.items.map(item => item.kind)).toEqual([
            'user',
            'narration',
            'working-block',
            'assistant',
        ]);

        const workingItem = transcript.items[2];
        expect(workingItem.kind).toBe('working-block');
        if (workingItem.kind !== 'working-block') {
            throw new Error('Expected working block transcript item');
        }
        expect(workingItem.block.summary).toBe('Reviewed 1 file');
        expect(workingItem.block.entries.map(entry => entry.kind)).toEqual(['action', 'terminal']);
        expect(workingItem.block.entries[1]).toMatchObject({ kind: 'terminal', text: 'npm test\n' });

        const assistantItem = transcript.items[3];
        expect(assistantItem.kind).toBe('assistant');
        if (assistantItem.kind !== 'assistant') {
            throw new Error('Expected assistant transcript item');
        }
        expect(assistantItem.provider).toBe('copilot-cli');
        expect(assistantItem.text).toBe('The restore bug is in the replay layer.');
    });

    it('writes transcript state to disk and reloads it for the active session', () => {
        const storageDir = makeTempDir();
        const manager = new SessionManager(storageDir);

        manager.recordTranscriptMessage({ type: 'addUserMessage', text: 'Hello history' });
        manager.recordTranscriptMessage({ type: 'startAssistantMessage' }, { provider: 'copilot-cli' });
        manager.recordTranscriptMessage({ type: 'appendAssistantText', text: 'Restored exactly.' }, { provider: 'copilot-cli', immediate: false });
        manager.recordTranscriptMessage({ type: 'endAssistantMessage' }, { provider: 'copilot-cli' });
        manager.flushPendingSave();

        const reloaded = new SessionManager(storageDir);
        const transcript = reloaded.getCurrentSession().transcript;

        expect(transcript?.items).toHaveLength(2);
        expect(transcript?.items[0]).toMatchObject({ kind: 'user', text: 'Hello history' });
        expect(transcript?.items[1]).toMatchObject({ kind: 'assistant', provider: 'copilot-cli', text: 'Restored exactly.' });
    });

    it('persists Dev Team standup events as standalone transcript items', () => {
        let transcript = createEmptyTranscript();
        transcript = applyTranscriptMessage(transcript, {
            type: 'devTeamRoomEvent',
            event: {
                teamId: 'balanced',
                teamName: 'Balanced Dev Team',
                memberRole: 'HR SME',
                agentName: 'HR',
                permission: 'read',
                phase: 'consult',
                status: 'blocked',
                title: 'HR SME reported a blocker',
                detail: 'Need official policy text before implementation.',
            },
        });

        expect(transcript.items).toHaveLength(1);
        expect(transcript.items[0]).toMatchObject({
            kind: 'dev-team-room-event',
            event: {
                teamName: 'Balanced Dev Team',
                memberRole: 'HR SME',
                status: 'blocked',
            },
        });
    });
});