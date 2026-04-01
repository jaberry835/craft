/**
 * Session and history management.
 *
 * Provides an abstraction over how conversation history is stored,
 * allowing in-memory, file-based, or remote storage backends.
 */

import type { ChatMessage } from './types';

// ── Session ──

/** Represents a conversation session with an agent. */
export interface AgentSession {
    /** Unique session identifier. */
    readonly sessionId: string;
    /** Optional provider-managed session ID (e.g., for stateful APIs). */
    serviceSessionId?: string;
    /** Arbitrary state bag for session-scoped data. */
    state: Map<string, unknown>;
}

// ── History Provider ──

/**
 * Protocol for storing and retrieving conversation history.
 * The default implementation is in-memory, but this can be
 * swapped for persistent storage.
 */
export interface IHistoryProvider {
    /** Get all messages for a session. */
    getMessages(sessionId: string): Promise<ChatMessage[]>;
    /** Append messages to a session. */
    addMessages(sessionId: string, messages: ChatMessage[]): Promise<void>;
    /** Replace all messages for a session. */
    setMessages(sessionId: string, messages: ChatMessage[]): Promise<void>;
    /** Clear all messages for a session. */
    clearMessages(sessionId: string): Promise<void>;
}

// ── In-Memory Implementation ──

/** Simple in-memory history provider (default). */
export class InMemoryHistoryProvider implements IHistoryProvider {
    private store = new Map<string, ChatMessage[]>();

    async getMessages(sessionId: string): Promise<ChatMessage[]> {
        return [...(this.store.get(sessionId) ?? [])];
    }

    async addMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
        const existing = this.store.get(sessionId) ?? [];
        existing.push(...messages);
        this.store.set(sessionId, existing);
    }

    async setMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
        this.store.set(sessionId, [...messages]);
    }

    async clearMessages(sessionId: string): Promise<void> {
        this.store.delete(sessionId);
    }
}
