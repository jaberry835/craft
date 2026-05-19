import type { ChatMessage, ChatSession, ChatSessionSummary } from '../types.js';

export interface CreateChatSessionOptions {
  title?: string;
  agentId?: string;
}

export interface ChatSessionStore {
  listSessions(): Promise<ChatSessionSummary[]>;
  createSession(options?: CreateChatSessionOptions): Promise<ChatSession>;
  getSession(sessionId: string): Promise<ChatSession>;
  getLatestSession(): Promise<ChatSession | null>;
  appendMessages(sessionId: string, messages: ChatMessage[], options?: CreateChatSessionOptions): Promise<ChatSession>;
}