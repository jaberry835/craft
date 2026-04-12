/**
 * RetryMiddleware — FunctionMiddleware that retries failed tool calls.
 *
 * Extracted from AgentLoop.executeToolWithRetry():
 * - Retries once on failure (MAX_TOOL_RETRIES = 1)
 * - 600ms delay between retries (RETRY_DELAY_MS)
 * - Never retries certain tools (NO_RETRY_TOOLS)
 * - Never retries user-declined or invalid-path errors
 */

import type { FunctionMiddleware, FunctionContext } from '../framework/middleware';
import type { ToolResult } from '../framework/types';

/** Tools that should never be retried (destructive, user-facing, or unique). */
const NO_RETRY_TOOLS = new Set([
    'run_terminal_command',
    'apply_code_action',
    'edit_file',
    'write_file',
    'replace_lines',
    'delete_file',
    'set_plan',
    'update_plan_step',
]);

/** Errors that indicate user intent — no point retrying. */
const NO_RETRY_PATTERNS = [
    'User declined',
    'Invalid path',
    'Cancelled by user',
];

export interface RetryMiddlewareOptions {
    /** Maximum number of automatic retries per tool call. Default: 1. */
    maxRetries?: number;
    /** Delay in ms before retrying a failed tool. Default: 600. */
    retryDelayMs?: number;
    /** Additional tool names that should never be retried. */
    additionalNoRetryTools?: string[];
}

export class RetryMiddleware implements FunctionMiddleware {
    readonly name = 'retry';
    private maxRetries: number;
    private retryDelayMs: number;
    private noRetryTools: Set<string>;

    constructor(options?: RetryMiddlewareOptions) {
        this.maxRetries = options?.maxRetries ?? 1;
        this.retryDelayMs = options?.retryDelayMs ?? 600;
        this.noRetryTools = new Set([
            ...NO_RETRY_TOOLS,
            ...(options?.additionalNoRetryTools ?? []),
        ]);
    }

    async process(context: FunctionContext, next: () => Promise<ToolResult>): Promise<ToolResult> {
        const result = await next();

        if (result.success) { return result; }

        // Don't retry certain tools
        if (this.noRetryTools.has(context.tool.name)) { return result; }

        // Don't retry user-intent errors
        if (NO_RETRY_PATTERNS.some(p => result.result.includes(p))) { return result; }

        // Retry up to maxRetries times
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            await this.delay(this.retryDelayMs);
            const retryResult = await next();
            if (retryResult.success) { return retryResult; }
        }

        // All retries failed — prepend marker to result
        return {
            success: false,
            result: `[Retry also failed] ${result.result}`,
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
