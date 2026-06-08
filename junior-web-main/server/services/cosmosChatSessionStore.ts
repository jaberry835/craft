import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSession, ChatSessionSummary } from '../types.js';
import type { WorkspaceSummary } from '../types.js';
import type { CosmosContainerBinding } from './cosmosContainerFactory.js';
import { logCosmosOperationError } from './cosmosContainerFactory.js';
import type { ChatSessionStore, CreateChatSessionOptions } from './chatSessionStore.js';

interface ChatSessionDocument extends ChatSession {
  partitionKey: string;
  workspaceId: string;
  ownerId: string;
  type: 'chatSession';
}

export class CosmosChatSessionStore implements ChatSessionStore {
  private readonly partitionKey: string;

  constructor(
    private readonly binding: CosmosContainerBinding,
    private readonly workspace: WorkspaceSummary
  ) {
    this.partitionKey = `${workspace.ownerId}:${workspace.id}`;
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    try {
      const { resources } = await this.binding.container.items.query<ChatSessionDocument>({
        query: 'SELECT * FROM c WHERE c.partitionKey = @partitionKey AND c.type = @type ORDER BY c.updatedAt DESC',
        parameters: [
          { name: '@partitionKey', value: this.partitionKey },
          { name: '@type', value: 'chatSession' }
        ]
      }, { partitionKey: this.partitionKey }).fetchAll();

      return resources.map((session) => this.toSummary(session));
    } catch (error) {
      logCosmosOperationError('chat-session-store', 'list chat sessions from Cosmos DB', this.binding.settings, error);
      throw error;
    }
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
    try {
      const { resource } = await this.binding.container.item(sessionId, this.partitionKey).read<ChatSessionDocument>();
      if (!resource) {
        throw new Error(`Chat session not found: ${sessionId}`);
      }

      return this.fromDocument(resource);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        throw new Error(`Chat session not found: ${sessionId}`, { cause: error });
      }

      logCosmosOperationError('chat-session-store', `read chat session ${sessionId} from Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  async getLatestSession(): Promise<ChatSession | null> {
    const [latest] = await this.listSessions();
    if (!latest) {
      return null;
    }

    return this.getSession(latest.id);
  }

  async appendMessages(sessionId: string, messages: ChatMessage[], options: CreateChatSessionOptions = {}): Promise<ChatSession> {
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

  private async saveSession(session: ChatSession): Promise<void> {
    try {
      await this.binding.container.items.upsert<ChatSessionDocument>({
        ...session,
        partitionKey: this.partitionKey,
        workspaceId: this.workspace.id,
        ownerId: this.workspace.ownerId,
        type: 'chatSession'
      });
    } catch (error) {
      logCosmosOperationError('chat-session-store', `save chat session ${session.id} to Cosmos DB`, this.binding.settings, error);
      throw error;
    }
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

  private fromDocument(document: ChatSessionDocument): ChatSession {
    return {
      id: document.id,
      title: document.title,
      agentId: document.agentId,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      messageCount: document.messageCount,
      messages: document.messages
    };
  }
}