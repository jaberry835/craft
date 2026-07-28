import { randomUUID } from 'node:crypto';
import type { AgentResponse, AgentRunOptions, ChatMessage, ChatSessionSummary, WorkspaceHistorySettings } from '../types.js';
import type { RuntimeAgentConfigStore } from './agentConfigStore.js';
import { AzureOpenAiChatClient } from './azureOpenAiChatClient.js';
import { ChangeManager } from './changeManager.js';
import type { ConversationHistoryArchiver } from './conversationHistoryArchiver.js';
import { GroundingService } from './groundingService.js';
import { JuniorAgentLoop } from './juniorAgentLoop.js';
import type { JuniorAgentLoopProgressHandlers } from './juniorAgentLoop.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';
import type { ChatSessionStore } from './chatSessionStore.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export type HistorySettingsProvider = () => WorkspaceHistorySettings;

export class SimpleJuniorAgent {
  private readonly loop: JuniorAgentLoop;
  private readonly sessionStore: ChatSessionStore;
  private readonly historyArchiver?: ConversationHistoryArchiver;
  private readonly getHistorySettings?: HistorySettingsProvider;

  constructor(
    storage: WorkspaceStorage,
    changeManager: ChangeManager,
    workspaceIndexer: WorkspaceIndexer,
    agentConfigStore: RuntimeAgentConfigStore,
    groundingService: GroundingService,
    chatClient: AzureOpenAiChatClient,
    sessionStore: ChatSessionStore,
    historyArchiver?: ConversationHistoryArchiver,
    getHistorySettings?: HistorySettingsProvider
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
    this.historyArchiver = historyArchiver;
    this.getHistorySettings = getHistorySettings;
  }

  async sendMessage(content: string, agentId?: string, options: AgentRunOptions = {}, sessionId?: string): Promise<AgentResponse> {
    const session = await this.resolveSession(sessionId, agentId);
    const userMessage = this.createMessage('user', content);
    const updatedSession = await this.sessionStore.appendMessages(session.id, [userMessage], { agentId });

    const response = await this.loop.run(content, agentId, options, updatedSession.messages.slice(0, -1));
    const assistant = response.message;
    await this.sessionStore.appendMessages(session.id, [assistant], { agentId });
    await this.archiveHistory(session.id);

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
    await this.archiveHistory(session.id);

    return {
      ...response,
      sessionId: session.id
    };
  }

  private async archiveHistory(sessionId: string): Promise<void> {
    if (!this.historyArchiver || !this.getHistorySettings) {
      return;
    }

    const settings = this.getHistorySettings();
    if (!settings.enabled) {
      return;
    }

    try {
      const session = await this.sessionStore.getSession(sessionId);
      if (session) {
        await this.historyArchiver.archiveSession(session, { includeReasoning: settings.includeReasoning });
      }
    } catch (error) {
      console.error('Failed to archive conversation history', error);
    }
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
