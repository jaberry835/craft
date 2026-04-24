import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../src/sessionManager';
import { ChatMessage } from '../src/types';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-sm-'));
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionManager — initial state', () => {
    it('creates a blank "New Chat" session when storage is empty', () => {
        const sm = new SessionManager(tmpDir);
        const cur = sm.getCurrentSession();
        expect(cur.title).toBe('New Chat');
        expect(cur.messages).toEqual([]);
        expect(cur.activeMode).toBe('agent');
    });

    it('persists sessions across instances', () => {
        const sm1 = new SessionManager(tmpDir);
        sm1.updateMessages([
            { role: 'user', content: 'hello world' },
            { role: 'assistant', content: 'hi' },
        ]);
        const id = sm1.getCurrentSession().id;

        const sm2 = new SessionManager(tmpDir);
        const restored = sm2.getCurrentSession();
        expect(restored.id).toBe(id);
        expect(restored.messages).toHaveLength(2);
    });
});

describe('SessionManager — auto-titling', () => {
    it('derives title from the first user message', () => {
        const sm = new SessionManager(tmpDir);
        sm.updateMessages([{ role: 'user', content: 'fix the login bug in auth.ts' }]);
        expect(sm.getCurrentSession().title).toBe('fix the login bug in auth.ts');
    });

    it('truncates long titles to 60 chars + ellipsis', () => {
        const sm = new SessionManager(tmpDir);
        const longText = 'a'.repeat(120);
        sm.updateMessages([{ role: 'user', content: longText }]);
        const title = sm.getCurrentSession().title;
        expect(title.length).toBe(63); // 60 + '...'
        expect(title.endsWith('...')).toBe(true);
    });

    it('does not re-title once the session has a title', () => {
        const sm = new SessionManager(tmpDir);
        sm.updateMessages([{ role: 'user', content: 'first message' }]);
        sm.updateMessages([
            { role: 'user', content: 'first message' },
            { role: 'user', content: 'second message' },
        ]);
        expect(sm.getCurrentSession().title).toBe('first message');
    });
});

describe('SessionManager — trimForStorage', () => {
    it('truncates very long string content', () => {
        const sm = new SessionManager(tmpDir);
        const huge = 'x'.repeat(20000);
        sm.updateMessages([{ role: 'assistant', content: huge }]);
        const stored = sm.getCurrentSession().messages[0];
        expect(typeof stored.content).toBe('string');
        if (typeof stored.content === 'string') {
            expect(stored.content.length).toBeLessThan(huge.length);
            expect(stored.content.endsWith('[trimmed for storage]')).toBe(true);
        }
    });

    it('strips base64 image parts from multimodal messages', () => {
        const sm = new SessionManager(tmpDir);
        const msg: ChatMessage = {
            role: 'user',
            content: [
                { type: 'text', text: 'look at this' } as any,
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } } as any,
                { type: 'image_url', image_url: { url: 'https://example.com/x.png' } } as any,
            ] as any,
        };
        sm.updateMessages([msg]);
        const stored = sm.getCurrentSession().messages[0].content as any[];
        expect(Array.isArray(stored)).toBe(true);
        // base64 stripped, https kept
        const hasBase64 = stored.some(p => p.type === 'image_url' && p.image_url?.url?.startsWith('data:'));
        const hasHttp = stored.some(p => p.type === 'image_url' && p.image_url?.url?.startsWith('https:'));
        expect(hasBase64).toBe(false);
        expect(hasHttp).toBe(true);
    });
});

describe('SessionManager — multiple sessions', () => {
    it('createNewSession switches the current session', () => {
        const sm = new SessionManager(tmpDir);
        const firstId = sm.getCurrentSession().id;
        const second = sm.createNewSession();
        expect(second.id).not.toBe(firstId);
        expect(sm.getCurrentSession().id).toBe(second.id);
    });

    it('getSessions returns sessions sorted by updatedAt desc', () => {
        const sm = new SessionManager(tmpDir);
        const a = sm.getCurrentSession();
        sm.createNewSession();
        // Force later updatedAt on a
        sm.switchSession(a.id);
        sm.updateMessages([{ role: 'user', content: 'touch' }]);
        const sorted = sm.getSessions();
        expect(sorted[0].id).toBe(a.id);
    });

    it('switchSession updates the current session', () => {
        const sm = new SessionManager(tmpDir);
        const first = sm.getCurrentSession().id;
        const second = sm.createNewSession();
        sm.switchSession(first);
        expect(sm.getCurrentSession().id).toBe(first);
        sm.switchSession(second.id);
        expect(sm.getCurrentSession().id).toBe(second.id);
    });

    it('deleteSession removes the session and creates a fresh one if it was active', () => {
        const sm = new SessionManager(tmpDir);
        const id = sm.getCurrentSession().id;
        sm.updateMessages([{ role: 'user', content: 'doomed' }]);
        sm.deleteSession(id);
        expect(sm.getSessions().some(s => s.id === id)).toBe(false);
        expect(sm.getCurrentSession().id).not.toBe(id);
        expect(sm.getCurrentSession().messages).toEqual([]);
    });
});

describe('SessionManager — hydration of legacy values', () => {
    it('migrates legacy "yolo" permission level to "bypass"', () => {
        // Hand-craft a sessions.json with an old permission level
        const filePath = path.join(tmpDir, 'sessions.json');
        const id = 'session_legacy';
        const data = {
            activeId: id,
            sessions: {
                [id]: {
                    id,
                    title: 'old session',
                    messages: [],
                    createdAt: 1,
                    updatedAt: 1,
                    activeMode: 'agent',
                    activePermissionLevel: 'yolo',
                },
            },
        };
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');

        const sm = new SessionManager(tmpDir);
        expect(sm.getCurrentSession().activePermissionLevel).toBe('bypass');
    });
});
