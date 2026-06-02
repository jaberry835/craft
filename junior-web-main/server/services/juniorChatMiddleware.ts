import type { AgentModelConnection } from '../types.js';
import type { ChatMiddleware, ChatMiddlewareContext } from './agentLoopFramework.js';
import type { ChatMessageInput } from './azureOpenAiChatClient.js';
import { JuniorLoopContextManager } from './juniorLoopContextManager.js';
import type { LoopChatMessage } from './tools/types.js';

export interface RecoveryChatMiddlewareOptions {
  maxAttempts?: number;
  findFallbackDeployment?: (connection: AgentModelConnection) => string | undefined;
  onRecoveryAttempt?: (attempt: number, strategy: string) => void;
}

export class RecoveryChatMiddleware implements ChatMiddleware {
  readonly name = 'recovery';

  private readonly contextManager = new JuniorLoopContextManager();
  private readonly maxAttempts: number;

  constructor(private readonly options: RecoveryChatMiddlewareOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async run(context: ChatMiddlewareContext, next: () => Promise<import('./azureOpenAiChatClient.js').ChatCompletionResult>) {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await next();
      } catch (error) {
        if (!this.isRecoverable(error) || attempt >= this.maxAttempts) {
          throw error;
        }

        lastError = error;
        const strategy = this.applyRecoveryStrategy(attempt + 1, context);
        const attemptCount = Number(context.state.get('chatRecoveryAttemptCount') ?? 0);
        context.state.set('chatRecoveryAttemptCount', attemptCount + 1);
        const strategies = Array.isArray(context.state.get('chatRecoveryStrategies'))
          ? context.state.get('chatRecoveryStrategies') as string[]
          : [];
        strategies.push(strategy);
        context.state.set('chatRecoveryStrategies', strategies);
        this.options.onRecoveryAttempt?.(attempt + 1, strategy);
      }
    }

    throw lastError;
  }

  private applyRecoveryStrategy(attempt: number, context: ChatMiddlewareContext): string {
    switch (attempt) {
      case 1:
        context.messages = this.toChatMessages(this.contextManager.emergencyTrim(this.toLoopMessages(context.messages)));
        return 'emergency-trim';
      case 2:
        context.options = { ...context.options, reasoningMode: true };
        context.messages = context.messages.map((message) => (
          message.role === 'system'
            ? { ...message, role: 'developer' as const }
            : message
        ));
        return 'reasoning-mode';
      case 3: {
        const fallback = this.options.findFallbackDeployment?.(context.connection);
        if (fallback) {
          context.options = { ...context.options, deploymentOverride: fallback };
          context.messages = this.toChatMessages(this.contextManager.emergencyTrim(this.toLoopMessages(context.messages)));
          return 'fallback-deployment';
        }

        context.messages = this.toChatMessages(this.contextManager.emergencyTrim(this.toLoopMessages(context.messages)), true);
        return 'extra-trim';
      }
      default:
        return 'unknown';
    }
  }

  private toLoopMessages(messages: ChatMessageInput[]): LoopChatMessage[] {
    return messages.map((message) => ({
      role: message.role === 'developer' ? 'system' : message.role,
      content: message.content,
      ...(message.tool_calls ? { toolCalls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
      ...(message.name ? { name: message.name } : {})
    }));
  }

  private toChatMessages(messages: LoopChatMessage[], preferDeveloper = false): ChatMessageInput[] {
    return messages.map((message) => ({
      role: preferDeveloper && message.role === 'system' ? 'developer' : message.role,
      content: message.content,
      ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.name ? { name: message.name } : {})
    }));
  }

  private isRecoverable(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const message = String((error as { message?: string }).message ?? '').toLowerCase();
    return message.includes('invalid_prompt') ||
      message.includes('context_length_exceeded') ||
      message.includes('maximum context length') ||
      message.includes('token limit') ||
      message.includes('unknown parameter') ||
      message.includes('unsupported parameter') ||
      message.includes('unrecognized request argument') ||
      message.includes('context') ||
      message.includes('token') ||
      message.includes('prompt') ||
      message.includes('400');
  }
}