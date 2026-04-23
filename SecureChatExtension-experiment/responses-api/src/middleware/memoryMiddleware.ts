/**
 * MemoryMiddleware — AgentMiddleware that manages task memory
 * and repo pattern injection/recording.
 *
 * Before run: injects memory as system messages when changed.
 * After run: records tool results into task memory and repo patterns.
 */

import type { AgentMiddleware, AgentContext } from '../framework/middleware';
import type { AgentResponse, ChatMessage } from '../framework/types';
import type { AgentTaskMemory } from '../taskMemory';
import type { RepoPatternStore } from '../repoPatternStore';

export interface MemoryMiddlewareOptions {
    taskMemory: AgentTaskMemory;
    repoPatternStore: RepoPatternStore;
}

export class MemoryMiddleware implements AgentMiddleware {
    readonly name = 'memory';
    private taskMemory: AgentTaskMemory;
    private repoPatternStore: RepoPatternStore;
    private lastInjectedTaskMemoryVersion = -1;
    private lastInjectedRepoMemoryVersion = -1;

    constructor(options: MemoryMiddlewareOptions) {
        this.taskMemory = options.taskMemory;
        this.repoPatternStore = options.repoPatternStore;
    }

    async process(context: AgentContext, next: () => Promise<AgentResponse>): Promise<AgentResponse> {
        // Reset version tracking at the start of a new agent run
        // (individual per-iteration injection is done via injectMemory())
        const response = await next();
        return response;
    }

    /**
     * Inject task memory and repo patterns into the context for a single iteration.
     * Called by the agent loop kernel before each LLM call.
     */
    injectMemory(context: AgentContext): void {
        this.injectMemoryInternal(context);
    }

    private injectMemoryInternal(context: AgentContext): void {
        // Inject task memory if changed
        const taskMemVersion = this.taskMemory.getVersion();
        if (taskMemVersion > this.lastInjectedTaskMemoryVersion) {
            const memoryMsg = this.taskMemory.buildSystemMessage(
                context.iteration <= 2
                    ? undefined // Full memory for early iterations
                    : { maxRelevantFiles: 4, maxDiagnostics: 4, maxFindings: 4, maxSearches: 3, maxFailures: 3 }
            );
            if (memoryMsg) {
                const existing = context.messages.findIndex(
                    m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Task Memory]')
                );
                const msg: ChatMessage = { role: 'system', content: memoryMsg };
                if (existing >= 0) {
                    context.messages[existing] = msg;
                } else {
                    // Insert after the system prompt (index 0)
                    context.messages.splice(1, 0, msg);
                }
                this.lastInjectedTaskMemoryVersion = taskMemVersion;
            }
        }

        // Inject repo patterns if changed
        const repoVersion = this.repoPatternStore.getVersion();
        if (repoVersion > this.lastInjectedRepoMemoryVersion) {
            const repoMsg = this.repoPatternStore.buildSystemMessage();
            if (repoMsg) {
                const existing = context.messages.findIndex(
                    m => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Repo Patterns]')
                );
                const msg: ChatMessage = { role: 'system', content: repoMsg };
                if (existing >= 0) {
                    context.messages[existing] = msg;
                } else {
                    context.messages.splice(1, 0, msg);
                }
                this.lastInjectedRepoMemoryVersion = repoVersion;
            }
        }
    }

    /** Reset version tracking (e.g., on new session). */
    reset(): void {
        this.lastInjectedTaskMemoryVersion = -1;
        this.lastInjectedRepoMemoryVersion = -1;
    }
}
