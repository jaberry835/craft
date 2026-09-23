import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError, NotFoundError } from './httpErrors.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import type {
  AppendMessageRequest,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  CreateSessionRequest
} from '../src/types/api.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JsonSessionStore implements ChatSessionStore {
  private readonly sessionsRoot: string;

  constructor(dataRoot: string, private readonly projectId: string) {
    this.sessionsRoot = path.join(dataRoot, 'projects', projectId, 'sessions');
  }

  async list(): Promise<ChatSessionSummary[]> {
    await this.ensureStore();
    const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    const sessions = await Promise.all(entries
      .filter((entry) => entry.isFile() && sessionIdPattern.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json'))
      .map((entry) => this.read(path.join(this.sessionsRoot, entry.name))));
    return sessions.map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
      messages: []
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
    const session = await this.get(sessionId);
    const updated = { ...session, title: cleanTitle, updatedAt: new Date().toISOString() };
    await this.save(updated);
    return updated;
  }

  async delete(sessionId: string): Promise<void> {
    await this.get(sessionId);
    await rm(this.filePath(sessionId));
  }

  async append(sessionId: string, request: AppendMessageRequest): Promise<ChatSession> {
    if (!['user', 'assistant', 'system'].includes(request.role)) {
      throw new BadRequestError('role must be user, assistant, or system.', 'invalid_role');
    }
    const content = typeof request.content === 'string' ? request.content.trim() : '';
    if (!content) {
      throw new BadRequestError('A non-empty message is required.', 'content_required');
    }
    const session = await this.get(sessionId);
    const message: ChatMessage = {
      id: randomUUID(),
      role: request.role,
      content,
      createdAt: new Date().toISOString()
    };
    const messages = [...session.messages, message];
    const updated: ChatSession = {
      ...session,
      title: session.title === 'New session' && request.role === 'user'
        ? this.titleFromMessage(content)
        : session.title,
      updatedAt: message.createdAt,
      messageCount: messages.length,
      messages
    };
    await this.save(updated);
    return updated;
  }

  private cleanTitle(value?: string): string {
    return typeof value === 'string' ? value.trim().slice(0, 120) : '';
  }

  private titleFromMessage(content: string): string {
    return content.length > 60 ? `${content.slice(0, 57)}...` : content;
  }

  private async save(session: ChatSession): Promise<void> {
    await this.ensureStore();
    const destination = this.filePath(session.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  }

  private async read(filePath: string): Promise<ChatSession> {
    return JSON.parse(await readFile(filePath, 'utf8')) as ChatSession;
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
}
