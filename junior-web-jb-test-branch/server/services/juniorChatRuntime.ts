import type { AgentModelConnection } from '../types.js';
import { MiddlewarePipeline, type ChatMiddleware, type ChatMiddlewareContext } from './agentLoopFramework.js';
import type {
  AzureOpenAiChatClient,
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatCompletionStreamChunk,
  ChatMessageInput,
  ChatToolDefinition
} from './azureOpenAiChatClient.js';

export interface ChatRunOptions {
  connection: AgentModelConnection;
  messages: ChatMessageInput[];
  tools?: ChatToolDefinition[];
  options?: ChatCompletionOptions;
  state?: Map<string, unknown>;
}

export class JuniorChatRuntime {
  constructor(
    private readonly client: AzureOpenAiChatClient,
    private readonly middleware: ChatMiddleware[] = []
  ) {}

  async complete(options: ChatRunOptions): Promise<string | null> {
    const result = await this.completeWithTools(options);
    return result.content?.trim() ?? null;
  }

  async completeWithTools(options: ChatRunOptions): Promise<ChatCompletionResult> {
    const state = options.state ?? new Map();
    state.set('chatRecoveryAttemptCount', 0);
    state.set('chatRecoveryStrategies', []);

    const context: ChatMiddlewareContext = {
      connection: options.connection,
      messages: options.messages,
      tools: options.tools,
      options: options.options ?? {},
      state
    };

    return MiddlewarePipeline.runChat(this.middleware, context, () => this.client.completeWithTools(
      context.connection,
      context.messages,
      context.tools,
      context.options
    ));
  }

  async *completeWithToolsStream(options: ChatRunOptions): AsyncGenerator<ChatCompletionStreamChunk> {
    const state = options.state ?? new Map();
    state.set('chatRecoveryAttemptCount', 0);
    state.set('chatRecoveryStrategies', []);

    const context: ChatMiddlewareContext = {
      connection: options.connection,
      messages: options.messages,
      tools: options.tools,
      options: options.options ?? {},
      state
    };

    yield* this.client.completeWithToolsStream(
      context.connection,
      context.messages,
      context.tools,
      context.options
    );
  }
}