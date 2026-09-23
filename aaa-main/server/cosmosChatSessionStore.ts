import { PartitionKeyBuilder } from '@azure/cosmos';
import { randomUUID } from 'node:crypto';
import type {
  AppendMessageRequest,
  AgentRun,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  CreateSessionRequest
} from '../src/types/api.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import {
  CosmosSchemaMismatchError,
  logCosmosError,
  type CosmosContainerBinding
} from './cosmosContainerFactory.js';
import { BadRequestError, NotFoundError, StorageUnavailableError } from './httpErrors.js';
import type { CosmosChatSchemaMode } from './storageConfig.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NativeChatSessionDocument extends ChatSession {
  type: 'chatSession';
}

interface JuniorChatSessionDocument extends NativeChatSessionDocument {
  ownerId: string;
  workspaceId: string;
  partitionKey: string;
}

const legacyPartitionKey = new PartitionKeyBuilder().addNoneValue().build();

export class CosmosChatSessionStore implements ChatSessionStore {
  constructor(
    private readonly binding: CosmosContainerBinding,
    private readonly projectId: string,
    private readonly schemaMode: CosmosChatSchemaMode = 'native',
    private readonly ownerId = 'aaa'
  ) {}

  async list(): Promise<ChatSessionSummary[]> {
    return this.withCosmos('list sessions', async () => {
      if (this.schemaMode === 'native') {
        const { resources } =
          await this.binding.container.items.query<NativeChatSessionDocument>({
            query: `SELECT * FROM c
              WHERE c.projectId = @projectId AND c.type = @type
              ORDER BY c.updatedAt DESC`,
            parameters: [
              { name: '@projectId', value: this.projectId },
              { name: '@type', value: 'chatSession' }
            ]
          }, { partitionKey: this.projectId }).fetchAll();
        return resources.map((document) => this.toSummary(document));
      }

      const { resources } =
        await this.binding.container.items.query<JuniorChatSessionDocument>({
          query: `SELECT * FROM c
            WHERE c.partitionKey = @partitionKey
              AND c.ownerId = @ownerId
              AND c.workspaceId = @projectId
              AND c.projectId = @projectId
              AND c.type = @type
            ORDER BY c.updatedAt DESC`,
          parameters: [
            { name: '@partitionKey', value: this.juniorPartitionKey },
            { name: '@ownerId', value: this.ownerId },
            { name: '@projectId', value: this.projectId },
            { name: '@type', value: 'chatSession' }
          ]
        }, { partitionKey: this.juniorPartitionKey }).fetchAll();
      if (resources.length > 0) {
        return resources.map((document) => this.toSummary(document));
      }

      const { resources: legacyResources } =
        await this.binding.container.items.query<NativeChatSessionDocument>({
          query: `SELECT * FROM c
            WHERE c.projectId = @projectId
              AND c.type = @type
              AND NOT IS_DEFINED(c.partitionKey)
              AND NOT IS_DEFINED(c.ownerId)
              AND NOT IS_DEFINED(c.workspaceId)
            ORDER BY c.updatedAt DESC`,
          parameters: [
            { name: '@projectId', value: this.projectId },
            { name: '@type', value: 'chatSession' }
          ]
        }, { partitionKey: legacyPartitionKey }).fetchAll();
      return legacyResources
        .filter((document) => this.isLegacyJuniorDocument(document))
        .map((document) => this.toSummary(document));
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
      messages: [],
      runs: []
    };
    await this.save(session);
    return session;
  }

  async get(sessionId: string): Promise<ChatSession> {
    this.assertSessionId(sessionId);
    try {
      return await this.withCosmos('get session', async () => {
        const { resource } = await this.binding.container
          .item(sessionId, this.itemPartitionKey)
          .read<NativeChatSessionDocument | JuniorChatSessionDocument>();
        if (!resource || !this.isCurrentDocument(resource)) {
          throw new NotFoundError(`Session was not found: ${sessionId}`);
        }
        return this.fromDocument(resource);
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (this.schemaMode === 'junior-compatible' && cosmosErrorCode(error) === 404) {
        return this.getLegacyJunior(sessionId);
      }
      if (cosmosErrorCode(error) === 404) {
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
    this.assertSessionId(sessionId);
    try {
      await this.withCosmos('delete session', async () => {
        const { resource } = await this.binding.container
          .item(sessionId, this.itemPartitionKey)
          .read<NativeChatSessionDocument | JuniorChatSessionDocument>();
        if (!resource || !this.isCurrentDocument(resource)) {
          throw new NotFoundError(`Session was not found: ${sessionId}`);
        }
        await this.binding.container.item(sessionId, this.itemPartitionKey).delete();
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (this.schemaMode === 'junior-compatible' && cosmosErrorCode(error) === 404) {
        return this.deleteLegacyJunior(sessionId);
      }
      if (cosmosErrorCode(error) === 404) {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      throw error;
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
      messages
    };
    await this.save(updated);
    return updated;
  }

  async saveRun(sessionId: string, run: AgentRun): Promise<ChatSession> {
    const session = await this.get(sessionId);
    const runs = [...(session.runs ?? []).filter((candidate) => candidate.id !== run.id), run];
    const updated = {
      ...session,
      runs,
      updatedAt: run.completedAt ?? run.startedAt
    };
    await this.save(updated);
    return updated;
  }

  private async save(session: ChatSession): Promise<void> {
    await this.withCosmos('save session', async () => {
      if (this.schemaMode === 'native') {
        await this.binding.container.items.upsert<NativeChatSessionDocument>({
          ...session,
          type: 'chatSession'
        });
        return;
      }
      await this.binding.container.items.upsert<JuniorChatSessionDocument>({
        ...session,
        ownerId: this.ownerId,
        workspaceId: this.projectId,
        partitionKey: this.juniorPartitionKey,
        type: 'chatSession'
      });
    });
  }

  private get itemPartitionKey(): string {
    return this.schemaMode === 'native' ? this.projectId : this.juniorPartitionKey;
  }

  private get juniorPartitionKey(): string {
    return `${this.ownerId}:${this.projectId}`;
  }

  private async getLegacyJunior(sessionId: string): Promise<ChatSession> {
    try {
      return await this.withCosmos('get legacy session', async () => {
        const { resource } = await this.binding.container.item(sessionId, legacyPartitionKey)
          .read<NativeChatSessionDocument>();
        if (!resource || !this.isLegacyJuniorDocument(resource)) {
          throw new NotFoundError(`Session was not found: ${sessionId}`);
        }
        const session = this.fromDocument(resource);
        await this.save(session);
        await this.binding.container.item(sessionId, legacyPartitionKey).delete();
        return session;
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (cosmosErrorCode(error) === 404) {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      throw error;
    }
  }

  private async deleteLegacyJunior(sessionId: string): Promise<void> {
    try {
      await this.withCosmos('delete legacy session', async () => {
        const { resource } = await this.binding.container.item(sessionId, legacyPartitionKey)
          .read<NativeChatSessionDocument>();
        if (!resource || !this.isLegacyJuniorDocument(resource)) {
          throw new NotFoundError(`Session was not found: ${sessionId}`);
        }
        await this.binding.container.item(sessionId, legacyPartitionKey).delete();
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (cosmosErrorCode(error) === 404) {
        throw new NotFoundError(`Session was not found: ${sessionId}`);
      }
      throw error;
    }
  }

  private isCurrentDocument(
    document: NativeChatSessionDocument | JuniorChatSessionDocument
  ): boolean {
    if (document.projectId !== this.projectId || document.type !== 'chatSession') {
      return false;
    }
    if (this.schemaMode === 'native') {
      return !('ownerId' in document)
        && !('workspaceId' in document)
        && !('partitionKey' in document);
    }
    const junior = document as JuniorChatSessionDocument;
    return junior.ownerId === this.ownerId
      && junior.workspaceId === this.projectId
      && junior.partitionKey === this.juniorPartitionKey;
  }

  private isLegacyJuniorDocument(document: NativeChatSessionDocument): boolean {
    return document.projectId === this.projectId
      && document.type === 'chatSession'
      && !('partitionKey' in document)
      && !('ownerId' in document)
      && !('workspaceId' in document);
  }

  private fromDocument(
    document: NativeChatSessionDocument | JuniorChatSessionDocument
  ): ChatSession {
    const {
      type: _type,
      ownerId: _ownerId,
      workspaceId: _workspaceId,
      partitionKey: _partitionKey,
      ...session
    } = document as JuniorChatSessionDocument;
    void _type;
    void _ownerId;
    void _workspaceId;
    void _partitionKey;
    return { ...session, runs: session.runs ?? [], messageCount: session.messages.length };
  }

  private toSummary(
    document: NativeChatSessionDocument | JuniorChatSessionDocument
  ): ChatSessionSummary {
    const { messages, runs, ...session } = this.fromDocument(document);
    void messages;
    void runs;
    return session;
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
      await this.binding.ensureReady?.();
      return await action();
    } catch (error) {
      if (error instanceof NotFoundError || cosmosErrorCode(error) === 404) {
        throw error;
      }
      logCosmosError(operation, this.binding.settings, error);
      throw new StorageUnavailableError(
        error instanceof CosmosSchemaMismatchError
          ? error.message
          : 'Cosmos DB chat session storage is unavailable. Check its configuration and service connectivity.'
      );
    }
  }
}

function cosmosErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  return Number(error.code);
}
