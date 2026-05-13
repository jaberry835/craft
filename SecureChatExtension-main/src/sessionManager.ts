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
import { AgentPermissionLevel, AgentProvider, ChatSession, ChatMessage, ChatMode, ExtensionMessage, RuntimeSessionState } from './types';
import { DEFAULT_PERMISSION_LEVEL } from './permissions';
import { applyTranscriptMessage, createEmptyTranscript } from './chatTranscript';

const MAX_SESSIONS = 20;
const MAX_MESSAGE_LENGTH = 8000;
const SESSIONS_FILE = 'sessions.json';

function isInternalDevTeamUserMessage(text: string): boolean {
    return /^Junior Dev Team member execution pass\./i.test(text.trim());
}

interface SessionsOnDisk {
    activeId?: string;
    sessions: Record<string, ChatSession>;
}

export class SessionManager {
    private currentSession: ChatSession;
    private sessions: Map<string, ChatSession> = new Map();
    private filePath: string;
    private pendingSaveTimer?: NodeJS.Timeout;

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
            transcript: createEmptyTranscript(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            activeMode: 'agent',
            activePermissionLevel: DEFAULT_PERMISSION_LEVEL,
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
                this.sessions.set(id, this.hydrateSession(session));
            }
        } catch {
            // File doesn't exist yet or is corrupt — start fresh
        }
    }

    private hydrateSession(session: ChatSession): ChatSession {
        const rawPermissionLevel = session.activePermissionLevel as string | undefined;
        const permissionLevel = rawPermissionLevel === 'yolo'
            ? 'bypass'
            : (session.activePermissionLevel ?? DEFAULT_PERMISSION_LEVEL);

        return {
            ...session,
            transcript: session.transcript ?? createEmptyTranscript(),
            activePermissionLevel: permissionLevel,
        };
    }

    private saveSessions() {
        if (this.pendingSaveTimer) {
            clearTimeout(this.pendingSaveTimer);
            this.pendingSaveTimer = undefined;
        }
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

    createNewSession(
        activeMode: ChatMode = this.currentSession?.activeMode || 'agent',
        activePermissionLevel: AgentPermissionLevel = DEFAULT_PERMISSION_LEVEL
    ): ChatSession {
        const session: ChatSession = {
            id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: 'New Chat',
            messages: [],
            transcript: createEmptyTranscript(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            activeMode,
            activePermissionLevel,
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

    updateMessages(
        messages: ChatMessage[],
        runtimeState?: RuntimeSessionState,
        activeMode?: ChatMode,
        activePermissionLevel?: AgentPermissionLevel
    ) {
        this.currentSession.messages = this.trimForStorage(messages);
        this.currentSession.updatedAt = Date.now();
        this.currentSession.runtimeState = runtimeState;
        this.currentSession.activeMode = activeMode ?? this.currentSession.activeMode ?? 'agent';
        this.currentSession.activePermissionLevel = activePermissionLevel ?? this.currentSession.activePermissionLevel ?? DEFAULT_PERMISSION_LEVEL;

        // Auto-title from first visible user message. Dev Team worker passes add
        // internal user messages to AgentLoop; those should not name the chat.
        if (this.currentSession.title === 'New Chat') {
            const text = this.getFirstVisibleUserText(messages);
            if (text) {
                this.currentSession.title = text.slice(0, 60) + (text.length > 60 ? '...' : '');
            }
        }

        this.sessions.set(this.currentSession.id, this.currentSession);
        this.saveSessions();
    }

    private getFirstVisibleUserText(messages: ChatMessage[]): string {
        const transcriptUser = this.currentSession.transcript?.items.find(item => item.kind === 'user');
        if (transcriptUser && transcriptUser.kind === 'user' && transcriptUser.text.trim()) {
            return transcriptUser.text.trim();
        }

        for (const message of messages) {
            if (message.role !== 'user') { continue; }
            const text = this.extractUserMessageText(message).trim();
            if (!text || isInternalDevTeamUserMessage(text)) { continue; }
            return text;
        }
        return '';
    }

    private extractUserMessageText(message: ChatMessage): string {
        if (typeof message.displayText === 'string' && message.displayText.trim()) { return message.displayText; }
        if (typeof message.content === 'string') { return message.content; }
        if (Array.isArray(message.content)) {
            return (message.content.find((part: any) => part.type === 'text') as any)?.text || '';
        }
        return '';
    }

    recordTranscriptMessage(
        message: ExtensionMessage,
        options?: { provider?: AgentProvider; immediate?: boolean }
    ) {
        this.currentSession.transcript = applyTranscriptMessage(this.currentSession.transcript, message, {
            provider: options?.provider,
        });
        this.currentSession.updatedAt = Date.now();
        this.sessions.set(this.currentSession.id, this.currentSession);

        if (options?.immediate === false) {
            this.scheduleSave();
            return;
        }

        this.saveSessions();
    }

    flushPendingSave() {
        this.saveSessions();
    }

    private scheduleSave(delayMs: number = 200) {
        if (this.pendingSaveTimer) {
            clearTimeout(this.pendingSaveTimer);
        }
        this.pendingSaveTimer = setTimeout(() => {
            this.pendingSaveTimer = undefined;
            this.saveSessions();
        }, delayMs);
    }

    setActiveMode(mode: ChatMode) {
        this.currentSession.activeMode = mode;
        this.currentSession.updatedAt = Date.now();
        this.sessions.set(this.currentSession.id, this.currentSession);
        this.saveSessions();
    }

    setActivePermissionLevel(level: AgentPermissionLevel) {
        this.currentSession.activePermissionLevel = level;
        this.currentSession.updatedAt = Date.now();
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
            this.currentSession = this.createNewSession(this.currentSession.activeMode || 'agent');
        }
        this.saveSessions();
    }
}
