import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError, NotFoundError } from './httpErrors.js';
import { storedRuns, withRun, type ChatSessionStore } from './chatSessionStore.js';
import type {
  AppendMessageRequest,
  AgentRun,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  CreateSessionRequest,
  SessionCompaction
} from '../src/types/api.js';
import { withCompaction } from './sessionCompaction.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Process-wide state keyed by absolute session file path. A store is created per request,
 * so per-instance locks would not serialize concurrent requests for the same session.
 */
const sessionWriteQueues = new Map<string, Promise<void>>();
/** Session summaries keyed by file path and validated against the file's mtime and size. */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: ChatSessionSummary }>();

function toSummary({ messages, runs, compactions, ...summary }: ChatSession): ChatSessionSummary {
  void runs;
  void compactions;
  return { ...summary, messageCount: messages.length };
}

export class JsonSessionStore implements ChatSessionStore {
  private readonly sessionsRoot: string;

  constructor(dataRoot: string, private readonly projectId: string) {
    this.sessionsRoot = path.join(dataRoot, 'projects', projectId, 'sessions');
  }

  async list(): Promise<ChatSessionSummary[]> {
    await this.ensureStore();
    const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isFile() && sessionIdPattern.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json'))
      .map((entry) => this.summary(path.join(this.sessionsRoot, entry.name))));
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Reads and parses a session file only when it changed since its summary was cached. */
  private async summary(filePath: string): Promise<ChatSessionSummary> {
    const fileStats = await stat(filePath);
    const cached = summaryCache.get(filePath);
    if (cached && cached.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) {
      return cached.summary;
    }
    const summary = toSummary(await this.read(filePath));
    summaryCache.set(filePath, { mtimeMs: fileStats.mtimeMs, size: fileStats.size, summary });
    return summary;
  }

  async create(request: CreateSessionRequest = {}): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      projectId: this.projectId,
      title: this.cleanTitle(request.title) || 'New session',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      runs: []
    };
    await this.save(session);
    return session;
  }

  async get(sessionId: string): Promise<ChatSession> {
    this.assertSessionId(sessionId);
    try {
      return await this.read(this.filePath(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      throw error;
    }
  }

  async rename(sessionId: string, title: string): Promise<ChatSession> {
    const cleanTitle = this.cleanTitle(title);
    if (!cleanTitle) {
      throw new BadRequestError('A non-empty title is required.', 'title_required');
    }
    return this.withSessionLock(sessionId, async () => {
      const session = await this.get(sessionId);
      return this.save({ ...session, title: cleanTitle, updatedAt: new Date().toISOString() });
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      await this.get(sessionId);
      await rm(this.filePath(sessionId));
      summaryCache.delete(this.filePath(sessionId));
    });
  }

  async append(
    sessionId: string,
    request: AppendMessageRequest,
    run?: (message: ChatMessage) => AgentRun
  ): Promise<ChatSession> {
    if (!['user', 'assistant', 'system'].includes(request.role)) {
      throw new BadRequestError('role must be user, assistant, or system.', 'invalid_role');
    }
    const content = typeof request.content === 'string' ? request.content.trim() : '';
    if (!content) {
      throw new BadRequestError('A non-empty message is required.', 'content_required');
    }
    return this.withSessionLock(sessionId, async () => {
      const session = await this.get(sessionId);
      const message: ChatMessage = {
        id: randomUUID(),
        role: request.role,
        content,
        createdAt: new Date().toISOString(),
        ...(request.display?.length ? { display: request.display } : {})
      };
      const messages = [...session.messages, message];
      const updated: ChatSession = {
        ...session,
        title: session.title === 'New session' && request.role === 'user'
          ? this.titleFromMessage(content)
          : session.title,
        updatedAt: message.createdAt,
        messageCount: messages.length,
        messages,
        ...(run ? { runs: withRun(session.runs, run(message)) } : {})
      };
      return this.save(updated);
    });
  }

  async saveRun(sessionId: string, run: AgentRun): Promise<ChatSession> {
    return this.withSessionLock(sessionId, async () => {
      const session = await this.get(sessionId);
      return this.save({
        ...session,
        runs: withRun(session.runs, run),
        updatedAt: run.completedAt ?? run.startedAt
      });
    });
  }

  async saveCompaction(sessionId: string, compaction: SessionCompaction): Promise<ChatSession> {
    return this.withSessionLock(sessionId, async () => {
      return this.save(withCompaction(await this.get(sessionId), compaction));
    });
  }

  private cleanTitle(value?: string): string {
    return typeof value === 'string' ? value.trim().slice(0, 120) : '';
  }

  private titleFromMessage(content: string): string {
    return content.length > 60 ? `${content.slice(0, 57)}...` : content;
  }

  /** Writes compact JSON atomically and returns the session exactly as stored. */
  private async save(session: ChatSession): Promise<ChatSession> {
    await this.ensureStore();
    const stored: ChatSession = { ...session, runs: storedRuns(session.runs) };
    const destination = this.filePath(stored.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, 'utf8');
    await rename(temporary, destination);
    // Refresh the summary here too, so filesystems with coarse mtimes never serve a stale one.
    const fileStats = await stat(destination);
    summaryCache.set(destination, { mtimeMs: fileStats.mtimeMs, size: fileStats.size, summary: toSummary(stored) });
    return stored;
  }

  private async read(filePath: string): Promise<ChatSession> {
    const session = JSON.parse(await readFile(filePath, 'utf8')) as ChatSession;
    return { ...session, runs: session.runs ?? [] };
  }

  private filePath(sessionId: string): string {
    this.assertSessionId(sessionId);
    return path.join(this.sessionsRoot, `${sessionId}.json`);
  }

  private assertSessionId(sessionId: string): void {
    if (!sessionIdPattern.test(sessionId)) {
      throw new BadRequestError('Invalid session id.', 'invalid_session_id');
    }
  }

  private async ensureStore(): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true });
  }

  private withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.filePath(sessionId);
    const previous = sessionWriteQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    sessionWriteQueues.set(key, tail);
    return result.finally(() => {
      if (sessionWriteQueues.get(key) === tail) {
        sessionWriteQueues.delete(key);
      }
    });
  }
}
