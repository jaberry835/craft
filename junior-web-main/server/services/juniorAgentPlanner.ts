import { JuniorAgentLoop, type LoopContext, type LoopStep } from './juniorAgentLoop.js';
import type { ChatMessageInput, ChatToolCall, ChatToolDefinition } from './azureOpenAiChatClient.js';
import type { AgentConfigStore } from './agentConfigStore.js';
import type { JuniorChatRuntime } from './juniorChatRuntime.js';
import type { LoopToolDefinition } from './tools/index.js';

interface PlannerDecision {
  nextStep: LoopStep | null;
  assistantMessage?: string;
  toolCalls?: ChatToolCall[];
}

export class JuniorAgentPlanner {
  private static readonly directAnswerGuidance = 'When replying directly to the user, write plain text for an in-app chat surface. Avoid markdown headings, tables, fenced code blocks, and long bullet lists unless the user explicitly asks for them. Keep the answer brief and focused on the main result.';

  constructor(private readonly chatRuntime: JuniorChatRuntime) {}

  async nextStep(
    context: LoopContext,
    toolDefinitions: LoopToolDefinition[],
    connection: ReturnType<AgentConfigStore['getConnection']>
  ): Promise<PlannerDecision> {
    if (context.stop) {
      return { nextStep: null };
    }

    const completedSteps = this.completedSteps(context);
    const availableDefinitions = this.availableToolDefinitions(toolDefinitions, completedSteps);
    const availableSteps = availableDefinitions.map((definition) => definition.name);

    const modelDecision = await this.chooseWithModel(context, toolDefinitions, connection, completedSteps);
    if (modelDecision) {
      return modelDecision;
    }

    const lowerContent = context.content.toLowerCase();

    if (lowerContent.includes('question') || lowerContent.includes('ask')) {
      const nextStep = completedSteps.has('identify-open-questions') ? null : 'identify-open-questions';
      return nextStep && availableSteps.includes(nextStep)
        ? {
          nextStep,
          toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name: nextStep, arguments: '{}' } }]
        }
        : { nextStep: null };
    }

    if (availableSteps.includes('draft-package-updates') && !completedSteps.has('draft-package-updates')) {
      return {
        nextStep: 'draft-package-updates',
        toolCalls: [{
          id: crypto.randomUUID(),
          type: 'function',
          function: { name: 'draft-package-updates', arguments: '{}' }
        }]
      };
    }

    return { nextStep: null };
  }

  private completedSteps(context: LoopContext): Set<LoopStep> {
    const value = context.state.get('completedSteps');

    if (value instanceof Set) {
      return value as Set<LoopStep>;
    }

    const steps = new Set<LoopStep>();
    context.state.set('completedSteps', steps);
    return steps;
  }

  private async chooseWithModel(
    context: LoopContext,
    toolDefinitions: LoopToolDefinition[],
    connection: ReturnType<AgentConfigStore['getConnection']>,
    completedSteps: Set<LoopStep>
  ): Promise<PlannerDecision | null> {
    const availableDefinitions = this.availableToolDefinitions(toolDefinitions, completedSteps);
    const availableSteps = availableDefinitions.map((definition) => definition.name);

    if (availableSteps.length === 0) {
      return null;
    }

    const transcript = context.loopMessages
      .slice(-6)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    const recentConversation = context.chatHistory
      .slice(-4)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n');
    const groundingSummary = context.grounding.length > 0
      ? context.grounding
        .slice(0, 5)
        .map((snippet) => `- ${snippet.title}: ${snippet.content}`)
        .join('\n')
      : 'No grounding snippets were resolved.';
    const workspaceSummary = context.index
      ? `${context.index.indexedFileCount}/${context.index.fileCount} indexed files${context.index.packageSections.length > 0 ? `; package sections: ${context.index.packageSections.join(', ')}` : ''}`
      : 'Workspace index unavailable.';

    const prompt = [
      'You are the assistant in a web-based agent loop working over files.',
      'Answer the user directly when no tool is needed.',
      JuniorAgentPlanner.directAnswerGuidance,
      'Use a provided tool only when it is necessary to inspect the workspace, search, or make a change.',
      'If you choose tools, return the next needed tool call or small batch of tool calls.',
      'You may call the same tool more than once when the task needs multiple reads, searches, or file edits.',
      `Available tools: ${availableSteps.join(', ')}`,
      `Workspace summary: ${workspaceSummary}`,
      `User request: ${context.content}`,
      recentConversation ? `Recent session context:\n${recentConversation}` : 'Recent session context: none yet.',
      `Grounding snippets:\n${groundingSummary}`,
      transcript ? `Recent loop transcript:\n${transcript}` : 'Recent loop transcript: none yet.'
    ].join('\n\n');

    const tools = availableDefinitions.map((definition) => this.toChatTool(definition));
    const requestMessages: ChatMessageInput[] = [
      ...context.loopMessages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.name ? { name: message.name } : {})
      })),
      { role: 'user', content: prompt }
    ];

    try {
      const progressHandlers = context.state.get('progressHandlers') as { onReasoning?: (text: string) => void | Promise<void>; onAssistantText?: (text: string) => void | Promise<void> } | undefined;
      let streamedContent = '';
      let streamedReasoning = '';
      let streamedToolCalls: ChatToolCall[] = [];

      for await (const chunk of this.chatRuntime.completeWithToolsStream({
        connection,
        messages: requestMessages,
        tools,
        options: JuniorAgentLoop.aiSettingsForAgent(context.activeAgent, context.modelConnection),
        state: context.state
      })) {
        if (chunk.type === 'text') {
          streamedContent += chunk.text;
          await progressHandlers?.onAssistantText?.(chunk.text);
        } else if (chunk.type === 'reasoning') {
          streamedReasoning += chunk.text;
          await progressHandlers?.onReasoning?.(chunk.text);
        } else if (chunk.type === 'toolCalls') {
          streamedToolCalls = chunk.calls;
        }
      }

      const result = {
        content: streamedContent || null,
        reasoning: streamedReasoning || null,
        toolCalls: streamedToolCalls
      };
      const recoveryAttempts = Number(context.state.get('chatRecoveryAttemptCount') ?? 0);
      if (recoveryAttempts > 0) {
        const recoveryStrategies = Array.isArray(context.state.get('chatRecoveryStrategies'))
          ? context.state.get('chatRecoveryStrategies') as string[]
          : [];
        context.toolEvents.push({
          id: crypto.randomUUID(),
          type: 'read',
          label: 'Recovered planner context',
          detail: `${recoveryAttempts} planner recovery step${recoveryAttempts === 1 ? '' : 's'} applied${recoveryStrategies.length > 0 ? ` (${recoveryStrategies.join(', ')})` : ''} to keep the model call viable.`,
          createdAt: new Date().toISOString()
        });
        context.state.set('chatRecoveryAttemptCount', 0);
        context.state.set('chatRecoveryStrategies', []);
      }

      if (result.toolCalls.length > 0) {
        this.captureReasoning(context, result.reasoning);
        const toolCalls = result.toolCalls.filter((toolCall) => availableSteps.includes(toolCall.function.name as LoopStep));
        if (toolCalls.length === 0) {
          return null;
        }
        return {
          nextStep: toolCalls[0].function.name as LoopStep,
          assistantMessage: result.content ?? undefined,
          toolCalls
        };
      }

      const assistantMessage = result.content?.trim() ?? undefined;
      this.captureReasoning(context, result.reasoning);
      if (!assistantMessage) {
        return null;
      }

      return {
        nextStep: null,
        assistantMessage
      };
    } catch (error) {
      return {
        nextStep: null,
        assistantMessage: this.modelUnavailableMessage(error)
      };
    }
  }

  private modelUnavailableMessage(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return `The connection to the LLM is not available right now. ${detail}`.trim();
  }

  private availableToolDefinitions(toolDefinitions: LoopToolDefinition[], completedSteps: Set<LoopStep>): LoopToolDefinition[] {
    return toolDefinitions.filter((definition) => definition.allowRepeatedCalls !== false || !completedSteps.has(definition.name as LoopStep));
  }

  private captureReasoning(context: LoopContext, reasoning: string | null | undefined): void {
    const trimmed = reasoning?.trim();
    if (!trimmed) {
      return;
    }

    const existing = context.state.get('assistantReasoning');
    const reasoningParts = Array.isArray(existing) ? existing as string[] : [];
    reasoningParts.push(trimmed);
    context.state.set('assistantReasoning', reasoningParts);

    const progressHandlers = context.state.get('progressHandlers') as { onReasoning?: (text: string) => void | Promise<void> } | undefined;
    progressHandlers?.onReasoning?.(trimmed);
  }

  private toChatTool(definition: LoopToolDefinition): ChatToolDefinition {
    return {
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters ?? {
          type: 'object',
          properties: {}
        }
      }
    };
  }
}