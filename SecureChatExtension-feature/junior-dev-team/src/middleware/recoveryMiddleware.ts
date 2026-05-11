/**
 * RecoveryMiddleware — ChatMiddleware that handles context overflow
 * and API rejection errors with a multi-tier recovery strategy.
 *
 * Extracted from AgentLoop context recovery logic:
 *   Attempt 1: Emergency trim (35% of window)
 *   Attempt 2: Reasoning-compatible params (system→developer, no temp)
 *   Attempt 3: Fallback to a different deployment
 */

import type { ChatMiddleware, ChatContext } from '../framework/middleware';
import type { ChatResponse, ChatStreamChunk } from '../framework/types';
import { ContextManager } from '../contextManager';

export interface RecoveryMiddlewareOptions {
    /** Maximum recovery attempts for context overflow. Default: 3. */
    maxAttempts?: number;
    /** Maximum retry attempts for stream stalls. Default: 2. */
    maxStallRetries?: number;
    /** Function to find a fallback deployment ID. */
    findFallbackDeployment?: () => string | undefined;
    /** Callback to apply a fallback deployment (e.g., setDeploymentOverride). */
    applyFallbackDeployment?: (deploymentId: string) => void;
    /** Callback when a recovery strategy is attempted. */
    onRecoveryAttempt?: (attempt: number, strategy: string) => void;
}

export class RecoveryMiddleware implements ChatMiddleware {
    readonly name = 'recovery';
    private maxAttempts: number;
    private maxStallRetries: number;
    private findFallbackDeployment?: () => string | undefined;
    private applyFallbackDeployment?: (deploymentId: string) => void;
    private onRecoveryAttempt?: (attempt: number, strategy: string) => void;
    private contextManager = new ContextManager();

    /** Set when recovery switches to reasoning-compatible parameters. */
    public activeReasoningMode = false;

    constructor(options?: RecoveryMiddlewareOptions) {
        this.maxAttempts = options?.maxAttempts ?? 3;
        this.maxStallRetries = options?.maxStallRetries ?? 2;
        this.findFallbackDeployment = options?.findFallbackDeployment;
        this.applyFallbackDeployment = options?.applyFallbackDeployment;
        this.onRecoveryAttempt = options?.onRecoveryAttempt;
    }

    async process(context: ChatContext, next: () => Promise<ChatResponse>): Promise<ChatResponse> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= this.maxAttempts; attempt++) {
            try {
                return await next();
            } catch (err: unknown) {
                if (!this.isContextOverflowError(err)) { throw err; }
                lastError = err;

                if (attempt >= this.maxAttempts) { break; }

                const strategy = this.applyRecoveryStrategy(attempt + 1, context);
                this.onRecoveryAttempt?.(attempt + 1, strategy);
            }
        }

        throw lastError;
    }

    private applyRecoveryStrategy(attempt: number, context: ChatContext): string {
        switch (attempt) {
            case 1: {
                // Emergency trim — aggressively reduce context
                context.messages = this.contextManager.emergencyTrim(context.messages);
                return 'emergency-trim';
            }
            case 2: {
                // Switch to reasoning-compatible params
                context.options = {
                    ...context.options,
                    reasoningMode: true,
                };
                // Also convert system messages to developer role
                context.messages = context.messages.map(m =>
                    m.role === 'system' ? { ...m, role: 'developer' as const } : m
                );
                return 'reasoning-mode';
            }
            case 3: {
                // Fallback deployment
                const fallback = this.findFallbackDeployment?.();
                if (fallback) {
                    // Store fallback in context state for the client to pick up
                    (context as unknown as { fallbackDeployment?: string }).fallbackDeployment = fallback;
                }
                return 'fallback-deployment';
            }
            default:
                return 'unknown';
        }
    }

    private isContextOverflowError(err: unknown): boolean {
        if (typeof err !== 'object' || err === null) { return false; }
        const e = err as Record<string, unknown>;
        if (e.statusCode === 400 || e.status === 400) {
            const msg = String(e.message ?? e.errorCode ?? '').toLowerCase();
            return msg.includes('invalid_prompt')
                || msg.includes('context_length_exceeded')
                || msg.includes('maximum context length')
                || msg.includes('token limit')
                || msg.includes('unknown parameter')
                || msg.includes('unsupported parameter')
                || msg.includes('unrecognized request argument');
        }
        return false;
    }

    // ── Streaming middleware (processStream) ──

    /**
     * Streaming variant — wraps getResponseStream() with error recovery.
     * Handles both context overflow (tiered strategy) and stream stalls (simple retry).
     * Yields { type: 'retry' } chunks to signal consumers to reset partial state.
     */
    async *processStream(
        context: ChatContext,
        next: () => AsyncGenerator<ChatStreamChunk>
    ): AsyncGenerator<ChatStreamChunk> {
        let contextAttempts = 0;
        let stallRetries = 0;

        while (true) {
            try {
                yield* next();
                return;
            } catch (err: unknown) {
                if (this.isStreamStall(err) && stallRetries < this.maxStallRetries) {
                    stallRetries++;
                    this.onRecoveryAttempt?.(stallRetries, 'stream-stall-retry');
                    yield { type: 'retry' as const, reason: 'stream-stall-retry' };
                    continue;
                }

                if (this.isRecoverableStreamingError(err) && contextAttempts < this.maxAttempts) {
                    contextAttempts++;
                    const strategy = this.applyStreamRecoveryStrategy(contextAttempts, context);
                    this.onRecoveryAttempt?.(contextAttempts, strategy);
                    stallRetries = 0;
                    yield { type: 'retry' as const, reason: strategy };
                    continue;
                }

                throw err;
            }
        }
    }

    private applyStreamRecoveryStrategy(attempt: number, context: ChatContext): string {
        switch (attempt) {
            case 1: {
                context.messages = this.contextManager.emergencyTrim(context.messages);
                return 'emergency-trim';
            }
            case 2: {
                context.options = { ...context.options, reasoningMode: true };
                context.messages = context.messages.map(m =>
                    m.role === 'system' ? { ...m, role: 'developer' as const } : m
                );
                this.activeReasoningMode = true;
                return 'reasoning-mode';
            }
            case 3: {
                const fallback = this.findFallbackDeployment?.();
                if (fallback) {
                    this.applyFallbackDeployment?.(fallback);
                }
                context.messages = this.contextManager.emergencyTrim(context.messages);
                return 'fallback-deployment';
            }
            default:
                return 'unknown';
        }
    }

    /** Check if an error is a stream stall (no data from server). */
    private isStreamStall(err: unknown): boolean {
        if (typeof err !== 'object' || err === null) { return false; }
        const msg = String((err as Record<string, unknown>).message ?? '').toLowerCase();
        return msg.includes('stream stalled') || msg.includes('no data received');
    }

    /**
     * Broader check for recoverable streaming errors: context overflow,
     * parameter rejection, and stream stalls.
     */
    private isRecoverableStreamingError(err: unknown): boolean {
        return this.isContextOverflowError(err);
    }
}
