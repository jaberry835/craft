/**
 * Session Manager — persists chat sessions to VS Code's global storage.
 */
import * as vscode from 'vscode';
import { ChatSession, ChatMessage } from './types';

export class SessionManager {
    private static STORAGE_KEY = 'securechat.sessions';
    private currentSession: ChatSession;
    private sessions: Map<string, ChatSession> = new Map();

    constructor(private globalState: vscode.Memento) {
        this.loadSessions();
        this.currentSession = this.createNewSession();
    }

    private loadSessions() {
        const raw = this.globalState.get<Record<string, ChatSession>>(SessionManager.STORAGE_KEY, {});
        for (const [id, session] of Object.entries(raw)) {
            this.sessions.set(id, session);
        }
    }

    private saveSessions() {
        const obj: Record<string, ChatSession> = {};
        for (const [id, session] of this.sessions) {
            obj[id] = session;
        }
        this.globalState.update(SessionManager.STORAGE_KEY, obj);
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
        this.currentSession.messages = messages;
        this.currentSession.updatedAt = Date.now();

        // Auto-title from first user message
        if (this.currentSession.title === 'New Chat') {
            const firstUser = messages.find(m => m.role === 'user');
            if (firstUser?.content) {
                this.currentSession.title = firstUser.content.slice(0, 60) + (firstUser.content.length > 60 ? '...' : '');
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
