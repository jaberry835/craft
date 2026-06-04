import type { ChatMessage, ChatSession, ChatSessionSummary } from '../types.js';
import type { ChatSessionStore, CreateChatSessionOptions } from './chatSessionStore.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export class FallbackChatSessionStore implements ChatSessionStore {
  private degraded = false;
  private failureReason?: string;

  constructor(
    private readonly primary: ChatSessionStore,
    private readonly fallback: ChatSessionStore
  ) {
    updatePersistenceMode({ scope: 'chat-session-store', configured: 'cosmos', effective: 'cosmos', fallbackActive: false });
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    return this.run(() => this.primary.listSessions(), () => this.fallback.listSessions());
  }

  async createSession(options?: CreateChatSessionOptions): Promise<ChatSession> {
    return this.run(() => this.primary.createSession(options), () => this.fallback.createSession(options));
  }

  async getSession(sessionId: string): Promise<ChatSession> {
    return this.run(() => this.primary.getSession(sessionId), () => this.fallback.getSession(sessionId));
  }

  async getLatestSession(): Promise<ChatSession | null> {
    return this.run(() => this.primary.getLatestSession(), () => this.fallback.getLatestSession());
  }

  async appendMessages(sessionId: string, messages: ChatMessage[], options?: CreateChatSessionOptions): Promise<ChatSession> {
    return this.run(() => this.primary.appendMessages(sessionId, messages, options), () => this.fallback.appendMessages(sessionId, messages, options));
  }

  private async run<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.degraded) {
      return fallback();
    }

    try {
      return await primary();
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        throw error;
      }

      this.degraded = true;
      this.failureReason = error instanceof Error ? error.message : String(error);
      updatePersistenceMode({
        scope: 'chat-session-store',
        configured: 'cosmos',
        effective: 'local',
        fallbackActive: true,
        reason: this.failureReason
      });
      return fallback();
    }
  }
}

function isSessionNotFoundError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof Error && /chat session not found/i.test(error.message)) {
    return true;
  }

  if (typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === 404 || candidate.statusCode === 404;
}
