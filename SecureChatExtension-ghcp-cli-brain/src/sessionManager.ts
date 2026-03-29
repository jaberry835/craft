/**
 * Session Manager — persists chat sessions to a JSON file on disk.
 *
 * Uses synchronous file writes (writeFileSync) so that data survives
 * even if the extension host process is terminated immediately after
 * deactivate() — unlike Memento which relies on async IPC that can
 * be cut short when VS Code closes.
 *
 * Sessions are scoped per workspace via the storageDir path.
 *
 * Limits:
 *  - MAX_SESSIONS (20): oldest sessions are pruned when exceeded.
 *  - MAX_MESSAGE_LENGTH (8000): individual tool results / message content
 *    are trimmed before persistence to stay within storage budget.
 *  - Base64 image data is stripped from persisted messages.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatSession, ChatMessage, RuntimeSessionState } from './types';

const MAX_SESSIONS = 20;
const MAX_MESSAGE_LENGTH = 8000;
const SESSIONS_FILE = 'sessions.json';

interface SessionsOnDisk {
    activeId?: string;
    sessions: Record<string, ChatSession>;
}

export class SessionManager {
    private currentSession: ChatSession;
    private sessions: Map<string, ChatSession> = new Map();
    private filePath: string;

    constructor(private storageDir: string, legacyState?: vscode.Memento) {
        // Ensure the storage directory exists
        fs.mkdirSync(this.storageDir, { recursive: true });
        this.filePath = path.join(this.storageDir, SESSIONS_FILE);

        // One-time migration: if no file on disk yet, pull from legacy Memento
        if (legacyState && !fs.existsSync(this.filePath)) {
            this.migrateFromMemento(legacyState);
        }

        this.loadSessions();
        // Restore the last active session, or create a new one
        const activeId = this.loadActiveId();
        if (activeId && this.sessions.has(activeId)) {
            this.currentSession = this.sessions.get(activeId)!;
        } else {
            this.currentSession = this.initBlankSession();
        }
    }

    /** Synchronous in-memory session init (no persistence) — used only by constructor. */
    private initBlankSession(): ChatSession {
        const session: ChatSession = {
            id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: 'New Chat',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.sessions.set(session.id, session);
        return session;
    }

    private loadActiveId(): string | undefined {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const data: SessionsOnDisk = JSON.parse(raw);
            return data.activeId;
        } catch {
            return undefined;
        }
    }

    /** One-time migration: seed file from legacy workspaceState Memento. */
    private migrateFromMemento(state: vscode.Memento) {
        const raw = state.get<Record<string, ChatSession>>('securechat.sessions', {});
        const activeId = state.get<string>('securechat.activeSession');
        if (Object.keys(raw).length === 0) { return; }
        const data: SessionsOnDisk = { activeId, sessions: raw };
        fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
    }

    private loadSessions() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const data: SessionsOnDisk = JSON.parse(raw);
            for (const [id, session] of Object.entries(data.sessions || {})) {
                this.sessions.set(id, session);
            }
        } catch {
            // File doesn't exist yet or is corrupt — start fresh
        }
    }

    private saveSessions() {
        this.pruneOldSessions();
        const data: SessionsOnDisk = {
            activeId: this.currentSession.id,
            sessions: {}
        };
        for (const [id, session] of this.sessions) {
            data.sessions[id] = session;
        }
        fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
    }

    /** Drop oldest sessions beyond MAX_SESSIONS. */
    private pruneOldSessions() {
        if (this.sessions.size <= MAX_SESSIONS) { return; }
        const sorted = [...this.sessions.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
        const keep = new Set(sorted.slice(0, MAX_SESSIONS).map(e => e[0]));
        for (const id of [...this.sessions.keys()]) {
            if (!keep.has(id)) { this.sessions.delete(id); }
        }
    }

    /**
     * Trim a message for persistence: cap string lengths, strip base64 images.
     */
    private trimForStorage(messages: ChatMessage[]): ChatMessage[] {
        return messages.map(m => {
            const clone = { ...m };
            // Trim text content
            if (typeof clone.content === 'string' && clone.content.length > MAX_MESSAGE_LENGTH) {
                clone.content = clone.content.slice(0, MAX_MESSAGE_LENGTH) + '\n... [trimmed for storage]';
            }
            // Strip base64 images from multimodal content arrays
            if (Array.isArray(clone.content)) {
                clone.content = clone.content.filter(
                    (part: any) => !(part.type === 'image_url' && part.image_url?.url?.startsWith('data:'))
                );
            }
            return clone;
        });
    }

    createNewSession(): ChatSession {
        const session: ChatSession = {
            id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: 'New Chat',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            runtimeState: undefined
        };
        this.sessions.set(session.id, session);
        this.currentSession = session;
        this.saveSessions();
        return session;
    }

    getCurrentSession(): ChatSession {
        return this.currentSession;
    }

    updateMessages(messages: ChatMessage[], runtimeState?: RuntimeSessionState) {
        this.currentSession.messages = this.trimForStorage(messages);
        this.currentSession.updatedAt = Date.now();
        this.currentSession.runtimeState = runtimeState;

        // Auto-title from first user message
        if (this.currentSession.title === 'New Chat') {
            const firstUser = messages.find(m => m.role === 'user');
            if (firstUser?.content) {
                const text = typeof firstUser.content === 'string'
                    ? firstUser.content
                    : (firstUser.content.find((p: any) => p.type === 'text') as any)?.text || '';
                this.currentSession.title = text.slice(0, 60) + (text.length > 60 ? '...' : '');
            }
        }

        this.sessions.set(this.currentSession.id, this.currentSession);
        this.saveSessions();
    }

    getSessions(): ChatSession[] {
        return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    switchSession(id: string): ChatSession | undefined {
        const session = this.sessions.get(id);
        if (session) {
            this.currentSession = session;
        }
        return session;
    }

    deleteSession(id: string) {
        this.sessions.delete(id);
        if (this.currentSession.id === id) {
            this.currentSession = this.createNewSession();
        }
        this.saveSessions();
    }
}
