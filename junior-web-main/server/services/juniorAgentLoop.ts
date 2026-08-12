import { randomUUID } from 'node:crypto';
import type {
  AgentAiSettings,
  AgentDefinition,
  AgentResponse,
  AgentRunOptions,
  ChatMessage,
  ChatMessageDisplayPart
} from '../types.js';
import type { RuntimeAgentConfigStore } from './agentConfigStore.js';
import { AgentToolExecutor, AgentToolRegistry, MiddlewarePipeline, type AgentContextProvider } from './agentLoopFramework.js';
import { AzureOpenAiChatClient } from './azureOpenAiChatClient.js';
import { ChangeManager } from './changeManager.js';
import { GroundingService } from './groundingService.js';
import { GroundingContextProvider, PackageDocumentsContextProvider, WorkspaceSkillsContextProvider } from './juniorAgentLoopContextProviders.js';
import { JuniorChatRuntime } from './juniorChatRuntime.js';
import { RecoveryChatMiddleware } from './juniorChatMiddleware.js';
import { AutoApplyChangesMiddleware, LoopStepTrackingMiddleware } from './juniorAgentLoopMiddleware.js';
import { JuniorAgentPlanner } from './juniorAgentPlanner.js';
import { JuniorLoopContextManager } from './juniorLoopContextManager.js';
import { McpHttpRuntime, type DiscoveredMcpTool } from './mcpHttpRuntime.js';
import { createMcpTool, createPackageTools, createWorkspaceTools, type LoopToolContext } from './tools/index.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export type LoopStep =
  | 'inspect-workspace'
  | 'create_directory'
  | 'list_directory'
  | 'read_file'
  | 'read_files'
  | 'replace_lines'
  | 'search_files'
  | 'grep_search'
  | 'search_workspace'
  | 'write_file'
  | 'edit_file'
  | 'call_mcp_tool'
  | 'identify-open-questions'
  | 'draft-package-updates';

export type LoopContext = LoopToolContext;

export interface JuniorAgentLoopProgressHandlers {
  onReasoning?: (text: string) => void | Promise<void>;
  onAssistantText?: (text: string) => void | Promise<void>;
}

export class JuniorAgentLoop {
  private static readonly maxPlannerRounds = 8;
  private static readonly maxToolCalls = 40;
  private static readonly maxToolCallsPerRound = 20;
  private static readonly directAnswerSystemMessage = 'When replying directly to the user, write plain text for an in-app chat surface. Avoid markdown headings, tables, fenced code blocks, and long bullet lists unless the user explicitly asks for them. Keep the answer brief and focused on the main result.';
  private static readonly workspaceCapabilitySystemMessage = 'You are operating inside Junior Workbench with direct workspace write capability. You can create directories and files, and edit existing files by using workspace tools. When the user asks to create a folder, call create_directory first, then write files under it if requested. Prefer taking concrete file actions instead of only describing what to do when the request is clear.';
  private static readonly noReasoningMessage = 'No reasoning was emitted for this turn.';

  private readonly registry = new AgentToolRegistry();
  private readonly executor = new AgentToolExecutor(this.registry, [new LoopStepTrackingMiddleware()]);
  private readonly agentMiddleware: AutoApplyChangesMiddleware[];
  private readonly contextProviders: AgentContextProvider<LoopContext, AgentResponse>[];
  private readonly planner: JuniorAgentPlanner;
  private readonly chatRuntime: JuniorChatRuntime;
  private readonly contextManager = new JuniorLoopContextManager();

  constructor(
    private readonly storage: WorkspaceStorage,
    private readonly changeManager: ChangeManager,
    private readonly workspaceIndexer: WorkspaceIndexer,
    private readonly agentConfigStore: RuntimeAgentConfigStore,
    private readonly groundingService: GroundingService,
    private readonly chatClient: AzureOpenAiChatClient
  ) {
    this.chatRuntime = new JuniorChatRuntime(this.chatClient, [new RecoveryChatMiddleware()]);
    this.planner = new JuniorAgentPlanner(this.chatRuntime);
    this.agentMiddleware = [new AutoApplyChangesMiddleware(this.changeManager, this.workspaceIndexer)];
    this.contextProviders = [
      new GroundingContextProvider(this.workspaceIndexer, this.groundingService),
      new WorkspaceSkillsContextProvider(this.storage),
      new PackageDocumentsContextProvider(this.storage)
    ];
    this.registry.registerAll(createWorkspaceTools({
      changeManager: this.changeManager,
      storage: this.storage,
      workspaceIndexer: this.workspaceIndexer
    }));
    this.registry.register(createMcpTool(this.storage));
    this.registry.registerAll(createPackageTools({
      changeManager: this.changeManager,
      chatRuntime: this.chatRuntime
    }));
  }

  private toolDefinitionsForAgent(activeAgent: AgentDefinition, hasMcpTools: boolean) {
    const internalTools = new Set<LoopStep>(['inspect-workspace', 'create_directory', 'read_files', 'write_file']);
    if (hasMcpTools) {
      internalTools.add('call_mcp_tool');
    }
    const allowedToolNames = new Set(activeAgent.tools);

    return this.registry.getDefinitions().filter((definition) => {
      const toolName = definition.name as LoopStep;
      return internalTools.has(toolName) || allowedToolNames.has(definition.name);
    });
  }

  async run(
    content: string,
    agentId?: string,
    options: AgentRunOptions = {},
    chatHistory: ChatMessage[] = [],
    progressHandlers: JuniorAgentLoopProgressHandlers = {}
  ): Promise<AgentResponse> {
    const activeAgent = await this.agentConfigStore.getAgent(agentId);
    const connection = await this.agentConfigStore.getConnection(activeAgent.modelConnectionId);
    const modelConnection = await this.agentConfigStore.getConnectionStatus(activeAgent.modelConnectionId);
    const mcpSetup = await this.createMcpRuntime(activeAgent);
    const mcpRuntime = mcpSetup.runtime;
    const runtimeDiscovery = mcpRuntime ? await mcpRuntime.discoverTools() : { tools: [] as DiscoveredMcpTool[], warnings: [] as string[] };
    const mcpDiscovery = {
      tools: runtimeDiscovery.tools,
      warnings: [...mcpSetup.warnings, ...runtimeDiscovery.warnings]
    };
    const availableTools = this.toolDefinitionsForAgent(activeAgent, mcpDiscovery.tools.length > 0);
    const mcpSystemMessage = this.createMcpSystemMessage(mcpDiscovery.tools, mcpDiscovery.warnings);
    const normalizedChatHistory = this.normalizeChatHistory(chatHistory, content);
    const groundingQuery = this.buildGroundingQuery(content, normalizedChatHistory);
    const context: LoopContext = {
      content,
      options,
      chatHistory: normalizedChatHistory,
      groundingQuery,
      activeAgent,
      connection,
      modelConnection,
      toolEvents: [],
      grounding: [],
      packageFiles: [],
      staged: [],
      stop: false,
      appliedChangeCount: 0,
      plannerRound: 0,
      toolCallCount: 0,
      loopMessages: this.contextManager.trimIfNeeded([
        { role: 'system', content: JuniorAgentLoop.directAnswerSystemMessage },
        { role: 'system', content: JuniorAgentLoop.workspaceCapabilitySystemMessage },
        { role: 'system', content: activeAgent.instructions },
        ...(mcpSystemMessage ? [{ role: 'system' as const, content: mcpSystemMessage }] : []),
        ...normalizedChatHistory.map((message) => ({
          role: message.role,
          content: message.content
        })),
        { role: 'user', content }
      ]),
      availableTools,
      state: new Map()
    };
    context.state.set('progressHandlers', progressHandlers);
    context.state.set('mcpRuntime', mcpRuntime);
    context.state.set('mcpDiscoveredTools', mcpDiscovery.tools);
    if ((activeAgent.mcpServerIds?.length ?? 0) > 0) {
      context.toolEvents.push({
        id: randomUUID(),
        type: 'read',
        label: 'Resolved attached MCP servers',
        detail: `${mcpDiscovery.tools.length} tool${mcpDiscovery.tools.length === 1 ? '' : 's'} available from ${activeAgent.mcpServerIds?.length ?? 0} attachment${activeAgent.mcpServerIds?.length === 1 ? '' : 's'}${mcpDiscovery.warnings.length > 0 ? `; ${mcpDiscovery.warnings.join('; ')}` : ''}`,
        createdAt: new Date().toISOString()
      });
    }

    if (!modelConnection.configured) {
      const assistant = this.createMessage(
        'assistant',
        `Agent "${activeAgent.name}" is using model connection "${modelConnection.name}", but it is not fully configured yet. Missing: ${modelConnection.missing.join(', ')}.`
      );

      return {
        message: assistant,
        sessionId: '',
        toolEvents: [],
        pendingChanges: [],
        activeAgent,
        modelConnection,
        grounding: [],
        changeHandling: options.autoApproveChanges ? 'auto-apply' : 'review',
        appliedChangeCount: 0
      };
    }

    for (const provider of this.contextProviders) {
      await provider.beforeRun?.(context);
    }

    const response: AgentResponse = await MiddlewarePipeline.runAgent(this.agentMiddleware, context, async () => {
      while (context.plannerRound < JuniorAgentLoop.maxPlannerRounds && context.toolCallCount < JuniorAgentLoop.maxToolCalls) {
        context.plannerRound += 1;
        context.loopMessages = this.contextManager.trimIfNeeded(context.loopMessages);
        const decision = await this.planner.nextStep(context, context.availableTools, connection);

        if (decision.assistantMessage && !context.assistantContent) {
          if (!decision.nextStep) {
            context.assistantContent = decision.assistantMessage;
          }
        }

        const plannerDecisions = context.state.get('plannerDecisions');
        const history = Array.isArray(plannerDecisions) ? plannerDecisions as Array<{ iteration: number; nextStep: LoopStep | null; assistantMessage?: string }> : [];
        history.push({ iteration: context.plannerRound, nextStep: decision.nextStep, assistantMessage: decision.assistantMessage });
        context.state.set('plannerDecisions', history);

        const remainingToolBudget = JuniorAgentLoop.maxToolCalls - context.toolCallCount;
        const requestedToolCalls = decision.toolCalls ?? [];
        const toolCalls = requestedToolCalls.slice(0, Math.min(JuniorAgentLoop.maxToolCallsPerRound, remainingToolBudget));

        if (toolCalls.length === 0) {
          break;
        }

        if (toolCalls.length < requestedToolCalls.length) {
          context.toolEvents.push({
            id: randomUUID(),
            type: 'read',
            label: 'Limited tool batch',
            detail: `Executed ${toolCalls.length} of ${requestedToolCalls.length} requested calls to stay within the ${JuniorAgentLoop.maxToolCalls}-call run budget.`,
            createdAt: new Date().toISOString()
          });
        }

        context.loopMessages.push({
          role: 'assistant',
          content: decision.assistantMessage ?? null,
          ...(toolCalls.length > 0 ? { toolCalls } : undefined)
        });

        for (const toolCall of toolCalls) {
          context.state.set('currentToolCallId', toolCall.id ?? randomUUID());
          const toolArgs = this.tryParseToolArgs(toolCall.function.arguments);

          await this.executor.execute(toolCall.function.name as LoopStep, toolArgs, context);

          if (context.stop) {
            break;
          }
        }

        if (context.stop) {
          break;
        }
      }

      if (!context.assistantContent) {
        context.assistantContent = await this.tryGenerateAssistantReply(context);
      }

      const assistant = this.createMessage('assistant', this.finalAssistantMessage(context), this.buildAssistantDisplay(context));

      return {
        message: assistant,
        sessionId: '',
        toolEvents: context.toolEvents,
        pendingChanges: await this.changeManager.list(),
        activeAgent,
        modelConnection,
        grounding: context.grounding,
        changeHandling: options.autoApproveChanges ? 'auto-apply' : 'review',
        appliedChangeCount: context.appliedChangeCount
      };
    });

    for (let index = this.contextProviders.length - 1; index >= 0; index -= 1) {
      await this.contextProviders[index].afterRun?.(context, response);
    }

    return response;
  }

  private async createMcpRuntime(activeAgent: AgentDefinition): Promise<{ runtime?: McpHttpRuntime; warnings: string[] }> {
    const serverIds = activeAgent.mcpServerIds ?? [];
    if (serverIds.length === 0) {
      return { warnings: [] };
    }

    const servers = [];
    const warnings: string[] = [];
    for (const serverId of serverIds) {
      try {
        servers.push(this.agentConfigStore.getResolvedMcpServer(serverId));
      } catch (error) {
        warnings.push(`${serverId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      runtime: servers.length > 0 ? new McpHttpRuntime(servers) : undefined,
      warnings
    };
  }

  private createMcpSystemMessage(tools: DiscoveredMcpTool[], warnings: string[]): string | undefined {
    if (tools.length === 0 && warnings.length === 0) {
      return undefined;
    }

    const sections: string[] = [];
    if (tools.length > 0) {
      sections.push([
        'Attached MCP tools are available through the call_mcp_tool function.',
        ...tools.map((tool) => `- serverId=${tool.serverId} | serverName=${tool.serverName} | toolName=${tool.toolName} | description=${tool.description || 'No description'} | inputSchema=${JSON.stringify(tool.inputSchema)}`)
      ].join('\n'));
    }
    if (warnings.length > 0) {
      sections.push(`Some MCP servers could not be used:\n${warnings.map((warning) => `- ${warning}`).join('\n')}`);
    }

    return sections.join('\n\n');
  }

  private finalAssistantMessage(context: LoopContext): string {
    if (context.assistantContent) {
      return context.assistantContent;
    }

    if (context.appliedChangeCount > 0) {
      return `I reviewed the workspace and applied ${context.appliedChangeCount} file change${context.appliedChangeCount === 1 ? '' : 's'} directly.`;
    }

    if (context.staged.length > 0) {
      return `I reviewed the workspace and staged ${context.staged.length} file change${context.staged.length === 1 ? '' : 's'}.`;
    }

    if (!context.availableTools.some((tool) => tool.name === 'draft-package-updates')) {
      return `I inspected the workspace for agent "${context.activeAgent.name}", but it did not produce a file action for that request.`;
    }

    return 'I reviewed the package workspace but did not find a markdown document to update yet.';
  }

  private async tryGenerateAssistantReply(context: LoopContext): Promise<string | undefined> {
    if (context.staged.length > 0 || context.appliedChangeCount > 0) {
      return undefined;
    }

    try {
      context.loopMessages = this.contextManager.trimIfNeeded(context.loopMessages);
      const progressHandlers = context.state.get('progressHandlers') as JuniorAgentLoopProgressHandlers | undefined;
      let reply = '';
      for await (const chunk of this.chatRuntime.completeWithToolsStream({
        connection: context.connection,
        messages: [
          ...context.loopMessages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
            ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
            ...(message.name ? { name: message.name } : {})
          })),
          {
            role: 'user',
            content: 'No file action was taken. If a direct answer is possible, answer the user now in plain text for an in-app chat surface. Avoid markdown headings, tables, fenced code blocks, and long bullet lists unless the user asked for them. Keep the answer brief and focused on the main result.'
          }
        ],
        options: JuniorAgentLoop.aiSettingsForAgent(context.activeAgent, context.modelConnection),
        state: context.state
      })) {
        if (chunk.type === 'text') {
          reply += chunk.text;
          await progressHandlers?.onAssistantText?.(chunk.text);
        } else if (chunk.type === 'reasoning') {
          this.appendReasoningChunk(context, chunk.text);
          await progressHandlers?.onReasoning?.(chunk.text);
        }
      }

      return reply.trim() || undefined;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `The connection to the LLM is not available right now. ${detail}`.trim();
    }
  }

  private tryParseToolArgs(rawArgs: string | undefined): Record<string, unknown> {
    try {
      return JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private appendReasoningChunk(context: LoopContext, reasoning: string): void {
    const trimmed = reasoning.trim();
    if (!trimmed) {
      return;
    }

    const existing = context.state.get('assistantReasoning');
    const reasoningParts = Array.isArray(existing) ? existing as string[] : [];
    reasoningParts.push(trimmed);
    context.state.set('assistantReasoning', reasoningParts);
  }

  private buildAssistantDisplay(context: LoopContext): ChatMessageDisplayPart[] | undefined {
    const display: ChatMessageDisplayPart[] = [];
    display.push({
      kind: 'reasoning',
      text: this.collectAssistantReasoning(context) ?? JuniorAgentLoop.noReasoningMessage
    });

    if (context.toolEvents.length > 0) {
      display.push({
        kind: 'working',
        title: this.workingTitle(context),
        events: [...context.toolEvents]
      });
    }

    return display.length > 0 ? display : undefined;
  }

  private collectAssistantReasoning(context: LoopContext): string | undefined {
    const stored = context.state.get('assistantReasoning');
    if (!Array.isArray(stored)) {
      return undefined;
    }

    const reasoning = stored
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n')
      .trim();

    return reasoning || undefined;
  }

  private workingTitle(context: LoopContext): string {
    if (context.appliedChangeCount > 0) {
      return 'Applied changes';
    }

    return 'Agent Steps';
  }

  static aiSettingsForAgent(agent: AgentDefinition, connection?: { temperature?: number; maxTokens?: number }): Required<AgentAiSettings> {
    return {
      temperature: agent.aiSettings?.temperature ?? connection?.temperature ?? 0.2,
      maxTokens: agent.aiSettings?.maxTokens ?? connection?.maxTokens ?? 1200,
      reasoningEffort: agent.aiSettings?.reasoningEffort ?? agent.reasoningEffort ?? 'medium'
    };
  }

  private createMessage(role: ChatMessage['role'], content: string, display?: ChatMessageDisplayPart[]): ChatMessage {
    return {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
      ...(display ? { display } : {})
    };
  }

  private normalizeChatHistory(messages: ChatMessage[], currentContent: string): ChatMessage[] {
    const history = messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ ...message }));

    const lastMessage = history.at(-1);
    if (lastMessage?.role === 'user' && lastMessage.content.trim() === currentContent.trim()) {
      history.pop();
    }

    return history;
  }

  private buildGroundingQuery(content: string, chatHistory: ChatMessage[]): string {
    const recentContext = chatHistory
      .slice(-4)
      .map((message) => `${message.role}: ${message.content.trim()}`)
      .filter((line) => line.length > 0);

    return recentContext.length > 0
      ? `${content}\n\nRecent conversation context:\n${recentContext.join('\n')}`
      : content;
  }
}