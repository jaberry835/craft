import { randomUUID } from 'node:crypto';
import type { AgentResponse, AgentRunOptions, ChatMessage, ChatSessionSummary } from '../types.js';
import type { RuntimeAgentConfigStore } from './agentConfigStore.js';
import { AzureOpenAiChatClient } from './azureOpenAiChatClient.js';
import { ChangeManager } from './changeManager.js';
import { GroundingService } from './groundingService.js';
import { JuniorAgentLoop } from './juniorAgentLoop.js';
import type { JuniorAgentLoopProgressHandlers } from './juniorAgentLoop.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export class SimpleJuniorAgent {
  private readonly loop: JuniorAgentLoop;
  private readonly sessionStore: ChatSessionStore;

  constructor(
    storage: WorkspaceStorage,
    changeManager: ChangeManager,
    workspaceIndexer: WorkspaceIndexer,
    agentConfigStore: RuntimeAgentConfigStore,
    groundingService: GroundingService,
    chatClient: AzureOpenAiChatClient,
    sessionStore: ChatSessionStore
  ) {
    this.loop = new JuniorAgentLoop(
      storage,
      changeManager,
      workspaceIndexer,
      agentConfigStore,
      groundingService,
      chatClient
    );
    this.sessionStore = sessionStore;
  }

  async sendMessage(content: string, agentId?: string, options: AgentRunOptions = {}, sessionId?: string): Promise<AgentResponse> {
    const session = await this.resolveSession(sessionId, agentId);
    const userMessage = this.createMessage('user', content);
    const updatedSession = await this.sessionStore.appendMessages(session.id, [userMessage], { agentId });

    const response = await this.loop.run(content, agentId, options, updatedSession.messages.slice(0, -1));
    const assistant = response.message;
    await this.sessionStore.appendMessages(session.id, [assistant], { agentId });

    return {
      ...response,
      sessionId: session.id
    };
  }

  async sendMessageStream(
    content: string,
    agentId?: string,
    options: AgentRunOptions = {},
    sessionId?: string,
    progressHandlers: JuniorAgentLoopProgressHandlers = {}
  ): Promise<AgentResponse> {
    const session = await this.resolveSession(sessionId, agentId);
    const userMessage = this.createMessage('user', content);
    const updatedSession = await this.sessionStore.appendMessages(session.id, [userMessage], { agentId });

    const response = await this.loop.run(content, agentId, options, updatedSession.messages.slice(0, -1), progressHandlers);
    const assistant = response.message;
    await this.sessionStore.appendMessages(session.id, [assistant], { agentId });

    return {
      ...response,
      sessionId: session.id
    };
  }

  async getMessages(sessionId?: string): Promise<ChatMessage[]> {
    const session = sessionId
      ? await this.sessionStore.getSession(sessionId)
      : await this.sessionStore.getLatestSession();

    return [...(session?.messages ?? [])];
  }

  async listSessions(): Promise<ChatSessionSummary[]> {
    return this.sessionStore.listSessions();
  }

  async createSession(agentId?: string): Promise<ChatSessionSummary> {
    const session = await this.sessionStore.createSession({ agentId });
    return {
      id: session.id,
      title: session.title,
      agentId: session.agentId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length
    };
  }

  private async resolveSession(sessionId?: string, agentId?: string) {
    if (sessionId) {
      return this.sessionStore.getSession(sessionId);
    }

    return this.sessionStore.createSession({ agentId });
  }

  private createMessage(role: ChatMessage['role'], content: string): ChatMessage {
    return {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString()
    };
  }
}
