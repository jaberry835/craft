import type { AgentModelConnection, ToolEvent } from '../types.js';
import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatMessageInput,
  ChatToolDefinition
} from './azureOpenAiChatClient.js';
import type { LoopToolContext, LoopToolDefinition, LoopToolEntry, LoopToolResult, LoopToolValidationResult } from './tools/types.js';

export interface AgentMiddleware<TContext, TResult> {
  name: string;
  run(context: TContext, next: () => Promise<TResult>): Promise<TResult>;
}

export interface ToolMiddleware<TContext> {
  name: string;
  run(toolName: string, args: Record<string, unknown>, context: TContext, next: () => Promise<LoopToolResult>): Promise<LoopToolResult>;
}

export interface ChatMiddleware<TState = Map<string, unknown>> {
  name: string;
  run(context: ChatMiddlewareContext<TState>, next: () => Promise<ChatCompletionResult>): Promise<ChatCompletionResult>;
}

export interface ChatMiddlewareContext<TState = Map<string, unknown>> {
  connection: AgentModelConnection;
  messages: ChatMessageInput[];
  tools?: ChatToolDefinition[];
  options: ChatCompletionOptions;
  state: TState;
}

export interface AgentContextProvider<TContext, TResult> {
  name: string;
  beforeRun?(context: TContext): Promise<void>;
  afterRun?(context: TContext, result: TResult): Promise<void>;
}

export class MiddlewarePipeline {
  static async runAgent<TContext, TResult>(
    middleware: AgentMiddleware<TContext, TResult>[],
    context: TContext,
    handler: () => Promise<TResult>
  ): Promise<TResult> {
    let next = handler;

    for (let index = middleware.length - 1; index >= 0; index -= 1) {
      const current = middleware[index];
      const currentNext = next;
      next = () => current.run(context, currentNext);
    }

    return next();
  }

  static async runTool<TContext>(
    middleware: ToolMiddleware<TContext>[],
    toolName: string,
    args: Record<string, unknown>,
    context: TContext,
    handler: () => Promise<LoopToolResult>
  ): Promise<LoopToolResult> {
    let next = handler;

    for (let index = middleware.length - 1; index >= 0; index -= 1) {
      const current = middleware[index];
      const currentNext = next;
      next = () => current.run(toolName, args, context, currentNext);
    }

    return next();
  }

  static async runChat<TState>(
    middleware: ChatMiddleware<TState>[],
    context: ChatMiddlewareContext<TState>,
    handler: () => Promise<ChatCompletionResult>
  ): Promise<ChatCompletionResult> {
    let next = handler;

    for (let index = middleware.length - 1; index >= 0; index -= 1) {
      const current = middleware[index];
      const currentNext = next;
      next = () => current.run(context, currentNext);
    }

    return next();
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, LoopToolEntry>();

  register(tool: LoopToolEntry): void {
    this.tools.set(tool.definition.name, tool);
  }

  registerAll(tools: LoopToolEntry[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): LoopToolEntry | undefined {
    return this.tools.get(name);
  }

  getAll(): LoopToolEntry[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(): LoopToolDefinition[] {
    return this.getAll().map((tool) => tool.definition);
  }
}

export class AgentToolExecutor<TContext extends LoopToolContext & { toolEvents: ToolEvent[] }> {
  constructor(
    private readonly registry: AgentToolRegistry,
    private readonly middleware: ToolMiddleware<TContext>[] = []
  ) {}

  async execute(name: string, args: Record<string, unknown>, context: TContext): Promise<LoopToolResult> {
    const tool = this.registry.get(name);

    if (!tool) {
      throw new Error(`Unknown loop tool: ${name}`);
    }

    const validation = this.validateArgs(tool.definition, args);
    if (!validation.valid) {
      return {
        success: false,
        result: `Invalid arguments: ${validation.errors.join('; ')}`
      };
    }

    return MiddlewarePipeline.runTool(this.middleware, name, args, context, () => tool.execute(context, args));
  }

  areAllReadOnly(toolNames: string[]): boolean {
    return toolNames.every((toolName) => this.registry.get(toolName)?.definition.isReadOnly ?? false);
  }

  private validateArgs(definition: LoopToolDefinition, args: Record<string, unknown>): LoopToolValidationResult {
    const schema = definition.parameters;
    if (!schema) {
      return { valid: true, errors: [] };
    }

    const errors: string[] = [];
    for (const required of schema.required ?? []) {
      if (!(required in args) || args[required] === undefined || args[required] === null || args[required] === '') {
        errors.push(`${required} is required`);
      }
    }

    for (const [key, spec] of Object.entries(schema.properties)) {
      if (!(key in args) || args[key] === undefined || args[key] === null) {
        continue;
      }

      const value = args[key];
      const expectedType = typeof spec === 'object' && spec !== null && 'type' in spec ? String((spec as { type?: unknown }).type) : undefined;
      if (!expectedType) {
        continue;
      }

      if (expectedType === 'string' && typeof value !== 'string') {
        errors.push(`${key} must be a string`);
      }

      if (expectedType === 'number' && typeof value !== 'number') {
        errors.push(`${key} must be a number`);
      }

      if (expectedType === 'boolean' && typeof value !== 'boolean') {
        errors.push(`${key} must be a boolean`);
      }

      if (expectedType === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
        errors.push(`${key} must be an object`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}