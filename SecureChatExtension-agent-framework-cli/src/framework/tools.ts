/**
 * Tool abstractions — IFunctionTool, ToolRegistry, ToolExecutor.
 *
 * Inspired by Microsoft Agent Framework's FunctionTool, but adapted
 * for our existing BuiltinTools + MCP tool registration patterns.
 */

import type { ToolDefinition, ToolResult, ToolHandler } from '../types';
import type { FunctionMiddleware, FunctionContext } from './middleware';
import { MiddlewarePipeline } from './middleware';
import { validateToolArgs, type ValidationResult } from '../toolValidator';

// ── Tool Interface ──

/**
 * A single executable tool. Wraps a tool definition (JSON Schema)
 * with execution logic and metadata.
 */
export interface IFunctionTool {
    /** Tool name (must be unique within a registry). */
    readonly name: string;
    /** OpenAI-compatible tool definition. */
    readonly definition: ToolDefinition;
    /** Whether this tool only reads (no side effects). */
    readonly isReadOnly: boolean;
    /** Whether this tool requires user confirmation before execution. */
    readonly requiresConfirmation: boolean;
    /** The category for grouping confirmations (e.g., 'file-edit', 'terminal'). */
    readonly confirmationCategory?: string;

    /**
     * Execute the tool with the given arguments.
     * Arguments should already be validated.
     */
    execute(args: Record<string, unknown>): Promise<ToolResult>;

    /**
     * Validate arguments against the tool's JSON Schema.
     * Returns a ValidationResult with any errors.
     */
    validate(args: Record<string, unknown>): ValidationResult;
}

// ── Concrete FunctionTool ──

/** Configuration for creating a FunctionTool. */
export interface FunctionToolConfig {
    definition: ToolDefinition;
    handler: ToolHandler;
    isReadOnly?: boolean;
    requiresConfirmation?: boolean;
    confirmationCategory?: string;
}

/**
 * Default implementation of IFunctionTool that wraps an existing
 * ToolHandler function.
 */
export class FunctionTool implements IFunctionTool {
    readonly name: string;
    readonly definition: ToolDefinition;
    readonly isReadOnly: boolean;
    readonly requiresConfirmation: boolean;
    readonly confirmationCategory?: string;
    private handler: ToolHandler;

    constructor(config: FunctionToolConfig) {
        this.name = config.definition.function.name;
        this.definition = config.definition;
        this.handler = config.handler;
        this.isReadOnly = config.isReadOnly ?? false;
        this.requiresConfirmation = config.requiresConfirmation ?? false;
        this.confirmationCategory = config.confirmationCategory;
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        return this.handler(args);
    }

    validate(args: Record<string, unknown>): ValidationResult {
        return validateToolArgs(this.definition, args);
    }
}

// ── Tool Registry ──

/**
 * Registry that holds all available tools and provides lookup.
 * Merges built-in tools and dynamically discovered MCP tools.
 */
export class ToolRegistry {
    private tools = new Map<string, IFunctionTool>();

    /** Register a tool. Replaces any existing tool with the same name. */
    register(tool: IFunctionTool): void {
        this.tools.set(tool.name, tool);
    }

    /** Register multiple tools at once. */
    registerAll(tools: IFunctionTool[]): void {
        for (const tool of tools) {
            this.register(tool);
        }
    }

    /** Unregister a tool by name. */
    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    /** Look up a tool by name. */
    get(name: string): IFunctionTool | undefined {
        return this.tools.get(name);
    }

    /** Check if a tool is registered. */
    has(name: string): boolean {
        return this.tools.has(name);
    }

    /** Get all registered tools. */
    getAll(): IFunctionTool[] {
        return Array.from(this.tools.values());
    }

    /** Get all tool definitions (for sending to the model). */
    getDefinitions(): ToolDefinition[] {
        return this.getAll().map(t => t.definition);
    }

    /** Get only read-only tools. */
    getReadOnlyTools(): IFunctionTool[] {
        return this.getAll().filter(t => t.isReadOnly);
    }

    /** Number of registered tools. */
    get size(): number {
        return this.tools.size;
    }

    /** Clear all tools. */
    clear(): void {
        this.tools.clear();
    }
}

// ── Tool Executor ──

/**
 * Executes tools through a FunctionMiddleware pipeline.
 * This is the single point through which all tool calls flow,
 * enabling consistent retry, validation, logging, and confirmation.
 */
export class ToolExecutor {
    constructor(
        private registry: ToolRegistry,
        private middleware: FunctionMiddleware[] = []
    ) {}

    /**
     * Execute a tool by name with the given arguments.
     * Runs through the FunctionMiddleware pipeline.
     */
    async execute(
        name: string,
        args: Record<string, unknown>,
        callId: string,
        state?: Map<string, unknown>
    ): Promise<ToolResult> {
        const tool = this.registry.get(name);
        if (!tool) {
            return { success: false, result: `Unknown tool: ${name}` };
        }

        // Validate arguments
        const validation = tool.validate(args);
        if (!validation.valid) {
            return {
                success: false,
                result: `Invalid arguments: ${validation.errors.join('; ')}`,
            };
        }

        const context: FunctionContext = {
            tool,
            args,
            callId,
            state: state ?? new Map(),
        };

        return MiddlewarePipeline.runFunction(
            this.middleware,
            context,
            () => tool.execute(args)
        );
    }

    /** Check whether a set of tool calls are all read-only. */
    areAllReadOnly(toolNames: string[]): boolean {
        return toolNames.every(name => {
            const tool = this.registry.get(name);
            return tool?.isReadOnly ?? false;
        });
    }
}
