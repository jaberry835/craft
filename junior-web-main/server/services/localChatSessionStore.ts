import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSession, ChatSessionSummary } from '../types.js';
import type { ChatSessionStore, CreateChatSessionOptions } from './chatSessionStore.js';

export class LocalChatSessionStore implements ChatSessionStore {
  private readonly sessionsRoot: string;

  constructor(workspaceRoot: string) {
    this.sessionsRoot = path.join(workspaceRoot, '.junior', 'sessions');
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    await this.ensureStore();
    const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    const sessionFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(this.sessionsRoot, entry.name));

    const sessions = await Promise.all(sessionFiles.map((filePath) => this.readSessionFile(filePath)));
    return sessions
      .map((session) => this.toSummary(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createSession(options: CreateChatSessionOptions = {}): Promise<ChatSession> {
    const createdAt = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      title: options.title?.trim() || 'New session',
      agentId: options.agentId,
      createdAt,
      updatedAt: createdAt,
      messageCount: 0,
      messages: []
    };

    await this.saveSession(session);
    return session;
  }

  async getSession(sessionId: string): Promise<ChatSession> {
    await this.ensureStore();
    return this.readSessionFile(this.sessionFilePath(sessionId));
  }

  async getLatestSession(): Promise<ChatSession | null> {
    const [latest] = await this.listSessions();
    if (!latest) {
      return null;
    }

    return this.getSession(latest.id);
  }

  async appendMessages(sessionId: string, messages: ChatMessage[], options: { title?: string; agentId?: string } = {}): Promise<ChatSession> {
    const session = await this.getSession(sessionId);
    const nextMessages = [...session.messages, ...messages];
    const nextTitle = this.resolveTitle(session.title, nextMessages, options.title);
    const nextSession: ChatSession = {
      ...session,
      title: nextTitle,
      agentId: options.agentId ?? session.agentId,
      updatedAt: messages[messages.length - 1]?.createdAt ?? new Date().toISOString(),
      messageCount: nextMessages.length,
      messages: nextMessages
    };

    await this.saveSession(nextSession);
    return nextSession;
  }

  private resolveTitle(currentTitle: string, messages: ChatMessage[], requestedTitle?: string): string {
    if (requestedTitle?.trim()) {
      return requestedTitle.trim();
    }

    if (currentTitle !== 'New session') {
      return currentTitle;
    }

    const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim();
    if (!firstUserMessage) {
      return currentTitle;
    }

    return firstUserMessage.length > 60 ? `${firstUserMessage.slice(0, 57)}...` : firstUserMessage;
  }

  private toSummary(session: ChatSession): ChatSessionSummary {
    return {
      id: session.id,
      title: session.title,
      agentId: session.agentId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length
    };
  }

  private async saveSession(session: ChatSession): Promise<void> {
    await this.ensureStore();
    await writeFile(this.sessionFilePath(session.id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  }

  private async readSessionFile(filePath: string): Promise<ChatSession> {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as ChatSession;
  }

  private sessionFilePath(sessionId: string): string {
    return path.join(this.sessionsRoot, `${sessionId}.json`);
  }

  private async ensureStore(): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true });
  }
}