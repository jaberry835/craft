import { randomUUID } from 'node:crypto';
import type {
  AppendMessageRequest,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  CreateSessionRequest
} from '../src/types/api.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import type { CosmosContainerBinding } from './cosmosContainerFactory.js';
import { logCosmosError } from './cosmosContainerFactory.js';
import { BadRequestError, NotFoundError, StorageUnavailableError } from './httpErrors.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ChatSessionDocument extends ChatSession {
  type: 'chatSession';
}

export class CosmosChatSessionStore implements ChatSessionStore {
  constructor(
    private readonly binding: CosmosContainerBinding,
    private readonly projectId: string
  ) {}

  async list(): Promise<ChatSessionSummary[]> {
    return this.withCosmos('list sessions', async () => {
      const { resources } = await this.binding.container.items.query<ChatSessionDocument>({
        query: 'SELECT * FROM c WHERE c.projectId = @projectId AND c.type = @type ORDER BY c.updatedAt DESC',
        parameters: [
          { name: '@projectId', value: this.projectId },
          { name: '@type', value: 'chatSession' }
        ]
      }, { partitionKey: this.projectId }).fetchAll();
      return resources.map(({ messages, type: _type, ...summary }) => {
        void _type;
        return { ...summary, messageCount: messages.length };
      });
    });
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
      const { resource } = await this.binding.container.item(sessionId, this.projectId)
        .read<ChatSessionDocument>();
      if (!resource) {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      return this.fromDocument(resource);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (cosmosErrorCode(error) === 404) {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      return this.fail('get session', error);
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
    this.assertSessionId(sessionId);
    try {
      await this.binding.container.item(sessionId, this.projectId).delete();
    } catch (error) {
      if (cosmosErrorCode(error) === 404) {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      this.fail('delete session', error);
    }
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

  private async save(session: ChatSession): Promise<void> {
    await this.withCosmos('save session', async () => {
      await this.binding.container.items.upsert<ChatSessionDocument>({
        ...session,
        type: 'chatSession'
      });
    });
  }

  private fromDocument({ type: _type, ...session }: ChatSessionDocument): ChatSession {
    void _type;
    return { ...session, messageCount: session.messages.length };
  }

  private cleanTitle(value?: string): string {
    return typeof value === 'string' ? value.trim().slice(0, 120) : '';
  }

  private titleFromMessage(content: string): string {
    return content.length > 60 ? `${content.slice(0, 57)}...` : content;
  }

  private assertSessionId(sessionId: string): void {
    if (!sessionIdPattern.test(sessionId)) {
      throw new BadRequestError('Invalid session id.', 'invalid_session_id');
    }
  }

  private async withCosmos<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      return this.fail(operation, error);
    }
  }

  private fail(operation: string, error: unknown): never {
    logCosmosError(operation, this.binding.settings, error);
    throw new StorageUnavailableError(
      'Cosmos DB chat session storage is unavailable. Check its configuration and service connectivity.'
    );
  }
}

function cosmosErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  return Number(error.code);
}
