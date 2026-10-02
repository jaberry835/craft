import type {
  AppendMessageRequest,
  AgentRun,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  CreateSessionRequest,
  SessionCompaction
} from '../src/types/api.js';

export interface ChatSessionStore {
  list(): Promise<ChatSessionSummary[]>;
  create(request?: CreateSessionRequest): Promise<ChatSession>;
  get(sessionId: string): Promise<ChatSession>;
  rename(sessionId: string, title: string): Promise<ChatSession>;
  delete(sessionId: string): Promise<void>;
  /**
   * Appends a message. When `run` is given, the run it builds from the new message is
   * saved in the same write, so a chat turn costs one read-modify-write instead of two.
   */
  append(
    sessionId: string,
    request: AppendMessageRequest,
    run?: (message: ChatMessage) => AgentRun
  ): Promise<ChatSession>;
  saveRun(sessionId: string, run: AgentRun): Promise<ChatSession>;
  saveCompaction(sessionId: string, compaction: SessionCompaction): Promise<ChatSession>;
}

export type ChatSessionStoreFactory = (projectId: string) => ChatSessionStore;

/** Replaces the run with the same id, or adds it. */
export function withRun(runs: AgentRun[] | undefined, run: AgentRun): AgentRun[] {
  return [...(runs ?? []).filter((candidate) => candidate.id !== run.id), run];
}

/**
 * A completed run's reasoning, tool events, and text are already persisted on its
 * assistant message (`display` and `content`), so storing them again on the run only
 * doubles the session document. Failed and aborted runs keep them because they have no
 * assistant message. Applied on every save, so older sessions shrink on their next write.
 */
export function storedRuns(runs: AgentRun[] | undefined): AgentRun[] {
  return (runs ?? []).map((run) => {
    if (run.status !== 'completed' || !run.assistantMessageId) return run;
    if (!run.reasoning && run.toolEvents.length === 0 && run.assistantText === undefined) return run;
    const { assistantText: _assistantText, ...rest } = run;
    void _assistantText;
    return { ...rest, reasoning: '', toolEvents: [] };
  });
}
