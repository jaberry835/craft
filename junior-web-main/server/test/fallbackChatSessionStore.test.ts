import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, ChatSession, ChatSessionSummary } from '../types.js';
import { FallbackChatSessionStore } from '../services/fallbackChatSessionStore.js';

class StubChatSessionStore {
  constructor(
    private readonly options: {
      getSessionError?: Error;
      fallbackSession?: ChatSession;
    } = {}
  ) {}

  async listSessions(): Promise<ChatSessionSummary[]> {
    return [];
  }

  async createSession(): Promise<ChatSession> {
    return this.options.fallbackSession ?? this.sampleSession();
  }

  async getSession(sessionId: string): Promise<ChatSession> {
    void sessionId;
    if (this.options.getSessionError) {
      throw this.options.getSessionError;
    }

    return this.options.fallbackSession ?? this.sampleSession();
  }

  async getLatestSession(): Promise<ChatSession | null> {
    return this.options.fallbackSession ?? this.sampleSession();
  }

  async appendMessages(_sessionId: string, messages: ChatMessage[]): Promise<ChatSession> {
    const base = this.options.fallbackSession ?? this.sampleSession();
    return {
      ...base,
      messages: [...base.messages, ...messages],
      messageCount: base.messages.length + messages.length
    };
  }

  private sampleSession(): ChatSession {
    return {
      id: 'stub-session',
      title: 'Stub Session',
      createdAt: new Date('2026-06-04T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-06-04T00:00:00.000Z').toISOString(),
      messageCount: 0,
      messages: []
    };
  }
}

test('fallback chat session store does not degrade on session-not-found errors', async () => {
  const primary = new StubChatSessionStore({ getSessionError: new Error('Chat session not found: missing-id') });
  const fallback = new StubChatSessionStore({
    fallbackSession: {
      id: 'fallback-session',
      title: 'Fallback',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      messages: []
    }
  });
  const store = new FallbackChatSessionStore(primary, fallback);

  await assert.rejects(() => store.getSession('missing-id'), /Chat session not found/);
});