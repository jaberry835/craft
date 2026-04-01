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
import type { ChatResponse, ChatMessage } from '../framework/types';
import { ContextManager } from '../contextManager';

export interface RecoveryMiddlewareOptions {
    /** Maximum recovery attempts. Default: 3. */
    maxAttempts?: number;
    /** Function to find a fallback deployment ID. */
    findFallbackDeployment?: () => string | undefined;
    /** Callback when a recovery strategy is attempted. */
    onRecoveryAttempt?: (attempt: number, strategy: string) => void;
}

export class RecoveryMiddleware implements ChatMiddleware {
    readonly name = 'recovery';
    private maxAttempts: number;
    private findFallbackDeployment?: () => string | undefined;
    private onRecoveryAttempt?: (attempt: number, strategy: string) => void;
    private contextManager = new ContextManager();

    constructor(options?: RecoveryMiddlewareOptions) {
        this.maxAttempts = options?.maxAttempts ?? 3;
        this.findFallbackDeployment = options?.findFallbackDeployment;
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
        // Check for 400 status with context-overflow or unknown-parameter indicators
        // TODO RUDE: remove if causing problems — revert to:
        //   const msg = String(e.message ?? e.errorCode ?? '');
        //   return msg.includes('invalid_prompt') || msg.includes('context_length_exceeded');
        // (i.e. remove .toLowerCase() and the extra 5 pattern matches below)
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
}
