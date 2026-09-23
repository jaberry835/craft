import type {
  AppendMessageRequest,
  ChatSession,
  ChatSessionSummary,
  CreateSessionRequest
} from '../src/types/api.js';

export interface ChatSessionStore {
  list(): Promise<ChatSessionSummary[]>;
  create(request?: CreateSessionRequest): Promise<ChatSession>;
  get(sessionId: string): Promise<ChatSession>;
  rename(sessionId: string, title: string): Promise<ChatSession>;
  delete(sessionId: string): Promise<void>;
  append(sessionId: string, request: AppendMessageRequest): Promise<ChatSession>;
}

export type ChatSessionStoreFactory = (projectId: string) => ChatSessionStore;
