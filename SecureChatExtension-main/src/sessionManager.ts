/**
 * Session Manager — persists chat sessions to VS Code's workspace-scoped storage.
 *
 * Sessions are scoped per workspace so opening a different project starts fresh.
 *
 * Limits:
 *  - MAX_SESSIONS (20): oldest sessions are pruned when exceeded.
 *  - MAX_MESSAGE_LENGTH (8000): individual tool results / message content
 *    are trimmed before persistence to stay within storage budget.
 *  - Base64 image data is stripped from persisted messages.
 */
import * as vscode from 'vscode';
import { ChatSession, ChatMessage } from './types';

const MAX_SESSIONS = 20;
const MAX_MESSAGE_LENGTH = 8000;

export class SessionManager {
    private static STORAGE_KEY = 'securechat.sessions';
    private static ACTIVE_KEY = 'securechat.activeSession';
    private currentSession: ChatSession;
    private sessions: Map<string, ChatSession> = new Map();

    constructor(private globalState: vscode.Memento) {
        this.loadSessions();
        // Restore the last active session, or create a new one
        const activeId = this.globalState.get<string>(SessionManager.ACTIVE_KEY);
        if (activeId && this.sessions.has(activeId)) {
            this.currentSession = this.sessions.get(activeId)!;
        } else {
            this.currentSession = this.createNewSession();
        }
    }

    private loadSessions() {
        const raw = this.globalState.get<Record<string, ChatSession>>(SessionManager.STORAGE_KEY, {});
        for (const [id, session] of Object.entries(raw)) {
            this.sessions.set(id, session);
        }
    }

    private saveSessions() {
        this.pruneOldSessions();
        const obj: Record<string, ChatSession> = {};
        for (const [id, session] of this.sessions) {
            obj[id] = session;
        }
        this.globalState.update(SessionManager.STORAGE_KEY, obj);
        this.globalState.update(SessionManager.ACTIVE_KEY, this.currentSession.id);
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
            updatedAt: Date.now()
        };
        this.sessions.set(session.id, session);
        this.currentSession = session;
        this.saveSessions();
        return session;
    }

    getCurrentSession(): ChatSession {
        return this.currentSession;
    }

    updateMessages(messages: ChatMessage[]) {
        this.currentSession.messages = this.trimForStorage(messages);
        this.currentSession.updatedAt = Date.now();

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
