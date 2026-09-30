/**
 * Context Manager — keeps the conversation within the model's context window.
 *
 * Responsibilities:
 *  - Estimate token usage for a message array
 *  - Trim older messages when approaching the context limit
 *  - Summarize collapsed tool-call / tool-result pairs
 *
 * Strategy:
 *  The system prompt and the most recent messages are always preserved.
 *  When the estimated token count exceeds the configured threshold, older
 *  assistant + tool message groups are collapsed into a compact summary
 *  injected as a single system message.  This keeps the model informed of
 *  prior actions without blowing up the context window.
 */

import { ChatMessage, ContentPart, ConversationCheckpointMetadata, ToolCall, ToolDefinition, TranscriptReference } from './types';
import { getSetting } from './config';
import { getContextWindow } from './modelContextWindow';
import { countModelTextTokens } from './tokenizer';
import { hydrateHistoryMetadata } from './conversationHistory';

/** Average characters per token — a conservative heuristic for English + code. */
const CHARS_PER_TOKEN = 3.5;

/** Overhead tokens per message for role / framing (OpenAI charges ~4 per message). */
const MSG_OVERHEAD = 4;

/** Approximate framing overhead for each serialized function tool. */
const TOOL_OVERHEAD = 8;

export interface ContextManagerOptions {
    contextWindow?: number;
    contextThreshold?: number;
}

export interface ContextBudgetOptions {
    /** Function schemas sent alongside the messages. */
    tools?: readonly ToolDefinition[];
    /** Authoritative prompt usage from the latest provider response. */
    minimumPromptTokens?: number;
    /** Output tokens that must remain available within the model window. */
    reservedOutputTokens?: number;
    /** Active model or deployment identifier used to select a tokenizer. */
    modelId?: string;
    /** Durable raw-transcript position captured by a newly created checkpoint. */
    transcriptReference?: TranscriptReference;
    /** Per-request compaction threshold override. */
    threshold?: number;
}

export interface ToolResultBudgetOptions {
    maxFraction?: number;
    modelId?: string;
    transcriptReference?: TranscriptReference;
}

export class ContextManager {
    constructor(private readonly options: ContextManagerOptions = {}) {}

    /**
     * Estimate the number of tokens in a single message.
     */
    estimateMessageTokens(msg: ChatMessage, modelId?: string): number {
        let tokens = 0;

        if (typeof msg.content === 'string') {
            tokens += this.estimateTextTokens(msg.content, modelId);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content as ContentPart[]) {
                if (part.type === 'text') {
                    tokens += this.estimateTextTokens(part.text, modelId);
                } else if (part.type === 'image_url') {
                    tokens += 1024;
                }
            }
        }

        // tool_calls JSON also counts toward context
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                tokens += this.estimateTextTokens(tc.function.name, modelId);
                tokens += this.estimateTextTokens(tc.function.arguments, modelId);
            }
        }

        if (msg.name) { tokens += this.estimateTextTokens(msg.name, modelId); }

        return tokens + MSG_OVERHEAD;
    }

    /**
     * Estimate total tokens across all messages.
     */
    estimateTotalTokens(messages: ChatMessage[], modelId?: string): number {
        let total = 0;
        for (const m of messages) {
            total += this.estimateMessageTokens(m, modelId);
        }
        return total;
    }

    /** Estimate the token cost of function schemas sent outside the message array. */
    estimateToolTokens(tools: readonly ToolDefinition[] = [], modelId?: string): number {
        let total = 0;
        for (const tool of tools) {
            total += this.estimateTextTokens(JSON.stringify(tool), modelId) + TOOL_OVERHEAD;
        }
        return total;
    }

    /**
     * Estimate the complete logical prompt, including tool definitions, and
     * never report less than the provider's latest authoritative count.
     */
    estimatePromptTokens(messages: ChatMessage[], options: ContextBudgetOptions = {}): number {
        const localEstimate = this.estimateTotalTokens(messages, options.modelId) +
            this.estimateToolTokens(options.tools, options.modelId);
        return Math.max(localEstimate, options.minimumPromptTokens ?? 0);
    }

    /** Bound one model-visible tool result while preserving its full raw transcript record. */
    limitToolResult(content: string, options: ToolResultBudgetOptions = {}): string {
        const configuredFraction = options.maxFraction
            ?? getSetting<number>('agent.maxToolResultFraction')
            ?? 0.12;
        const fraction = Math.min(0.5, Math.max(0.01, configuredFraction));
        const maxTokens = Math.max(64, Math.floor(this.getContextWindow() * fraction));
        const originalTokens = this.estimateTextTokens(content, options.modelId);
        if (originalTokens <= maxTokens) { return content; }

        const transcript = options.transcriptReference;
        const recoveryHint = transcript
            ? ` Full output: transcript session ${transcript.sessionId}, through record ${transcript.throughRecord}.`
            : ' Full output remains in the session raw transcript.';
        const header = `[Tool output truncated for prompt: approximately ${originalTokens} tokens; limit ${maxTokens}.${recoveryHint}]`;
        const separator = '\n...[truncated]...\n';
        const framingTokens = this.estimateTextTokens(header + separator, options.modelId);
        const contentBudget = Math.max(0, maxTokens - framingTokens);
        const headBudget = Math.floor(contentBudget * 0.7);
        const tailBudget = contentBudget - headBudget;
        const head = this.fitTextToTokenBudget(content, headBudget, options.modelId, false);
        const tail = this.fitTextToTokenBudget(content, tailBudget, options.modelId, true);
        return `${header}\n${head}${separator}${tail}`;
    }

    /**
     * Return the effective context-window size (tokens).
     * Explicit settings win; otherwise this is inferred from the active model.
     */
    getContextWindow(): number {
        return this.options.contextWindow ?? getContextWindow();
    }

    /**
     * Return the trim threshold as a fraction (0-1).
     * When estimated tokens exceed this fraction of the context window the
     * manager will start trimming.  Default: 0.70
     */
    getThreshold(): number {
        return this.options.contextThreshold ?? getSetting<number>('agent.contextThreshold') ?? 0.70;
    }

    /**
     * If the conversation is over budget, trim it and return the trimmed array.
     * Otherwise, return the original array unchanged.
     *
     * The caller should replace its message array with the result:
     *   `this.messages = contextManager.trimIfNeeded(this.messages);`
     */
    trimIfNeeded(messages: ChatMessage[], options: ContextBudgetOptions = {}): ChatMessage[] {
        const contextWindow = this.getContextWindow();
        const threshold = Math.min(1, Math.max(0, options.threshold ?? this.getThreshold()));
        const thresholdBudget = Math.floor(contextWindow * threshold);
        // maxTokens is an upper bound, not expected output usage. Cap its
        // reservation so small-window models always retain a useful input budget.
        const outputReservation = Math.min(
            Math.max(0, options.reservedOutputTokens ?? 0),
            Math.floor(contextWindow * 0.25)
        );
        const outputAwareBudget = contextWindow - outputReservation;
        const maxTokens = Math.max(1, Math.min(thresholdBudget, outputAwareBudget));
        const currentTokens = this.estimatePromptTokens(messages, options);

        if (currentTokens <= maxTokens) {
            return messages;
        }

        const messageBudget = Math.max(1, maxTokens - this.estimateToolTokens(options.tools, options.modelId));
        return this.trimMessages(messages, messageBudget, options.modelId, options.transcriptReference);
    }

    /**
     * Repair invalid assistant/tool history before sending it to chat completions.
     *
     * The chat API requires every `tool` role message to directly answer the
     * immediately preceding assistant message that declared matching
     * `tool_calls`. If compaction or persisted history breaks that adjacency,
     * drop the incomplete transaction instead of sending an invalid payload.
     */
    normalizeMessageSequence(messages: ChatMessage[]): ChatMessage[] {
        let changed = false;
        const normalized: ChatMessage[] = [];
        let pendingToolCallIds: Set<string> | null = null;
        let pendingAssistantIndex = -1;

        const discardPendingToolTransaction = () => {
            if (pendingToolCallIds && pendingAssistantIndex >= 0) {
                normalized.splice(pendingAssistantIndex);
                changed = true;
            }
            pendingToolCallIds = null;
            pendingAssistantIndex = -1;
        };

        const finalizePendingIfComplete = () => {
            if (pendingToolCallIds && pendingToolCallIds.size === 0) {
                pendingToolCallIds = null;
                pendingAssistantIndex = -1;
            }
        };

        for (const msg of messages) {
            if (msg.role === 'tool') {
                if (!pendingToolCallIds || !msg.tool_call_id || !pendingToolCallIds.has(msg.tool_call_id)) {
                    changed = true;
                    continue;
                }
                normalized.push(msg);
                pendingToolCallIds.delete(msg.tool_call_id);
                finalizePendingIfComplete();
                continue;
            }

            if (pendingToolCallIds) {
                discardPendingToolTransaction();
            }

            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                const validToolCalls = msg.tool_calls.filter(
                    (toolCall): toolCall is ToolCall => typeof toolCall.id === 'string' && toolCall.id.trim().length > 0
                );

                if (validToolCalls.length === 0) {
                    normalized.push({ ...msg, tool_calls: undefined });
                    changed = true;
                    continue;
                }

                const normalizedAssistant = validToolCalls.length === msg.tool_calls.length
                    ? msg
                    : { ...msg, tool_calls: validToolCalls };

                if (normalizedAssistant !== msg) {
                    changed = true;
                }

                pendingAssistantIndex = normalized.length;
                pendingToolCallIds = new Set(validToolCalls.map(toolCall => toolCall.id));
                normalized.push(normalizedAssistant);
                finalizePendingIfComplete();
                continue;
            }

            normalized.push(msg);
        }

        if (pendingToolCallIds) {
            discardPendingToolTransaction();
        }

        return changed ? normalized : messages;
    }

    /**
     * Core trimming logic.
     *
     * Protected region (never trimmed):
     *   - The system prompt (index 0)
     *   - The most recent N messages (tail) — enough to keep the active
     *     tool-call loop intact
     *
     * Trimmable region (everything between system prompt and the tail):
     *   - Assistant messages with tool_calls + their matching tool-result messages
     *     are collapsed into a one-line summary.
     *   - Plain user/assistant turns are kept but their content is truncated.
     *   - If still over budget after summarizing, the oldest trimmable messages
     *     are dropped entirely.
     */
    private trimMessages(
        messages: ChatMessage[],
        budget: number,
        modelId?: string,
        transcriptReference?: TranscriptReference
    ): ChatMessage[] {
        if (messages.length <= 4) { return messages; }
        messages = hydrateHistoryMetadata(messages, 'context');

        // Always keep the system prompt at index 0
        const systemMsg = messages[0].role === 'system' ? messages[0] : null;

        // Preserve the tail — the last user message + everything after it.
        // This keeps the current iteration's context intact.
        const tailStart = this.findTailStart(messages);
        const tail = messages.slice(tailStart);
        const middle = systemMsg
            ? messages.slice(1, tailStart)
            : messages.slice(0, tailStart);

        const boundary = this.findCheckpointBoundary(middle);
        if (!boundary) {
            return this.normalizeMessageSequence(messages);
        }
        const checkpointSource = middle.slice(0, boundary.index + 1);
        const exactAfterCheckpoint = middle.slice(boundary.index + 1);
        const protectedTail = [...exactAfterCheckpoint, ...tail];
        const checkpointMetadata: ConversationCheckpointMetadata = {
            ...boundary.metadata,
            ...(transcriptReference ? { transcript: transcriptReference } : {}),
        };

        // Summarize the middle section
        const summary = this.summarizeMiddle(checkpointSource);

        // Build candidate message list
        const summaryMsg: ChatMessage = {
            role: 'system',
            content: summary,
            checkpoint: checkpointMetadata,
        };

        const candidate = [
            ...(systemMsg ? [systemMsg] : []),
            summaryMsg,
            ...protectedTail,
        ];

        // If the summary + tail still fits, we're done
        if (this.estimateTotalTokens(candidate, modelId) <= budget) {
            return this.normalizeMessageSequence(candidate);
        }

        // Still over budget — progressively truncate the summary
        const truncated = this.truncateSummary(summary, budget, systemMsg, protectedTail, modelId);
        const truncMsg: ChatMessage = {
            role: 'system',
            content: truncated,
            checkpoint: checkpointMetadata,
        };

        return this.normalizeMessageSequence([
            ...(systemMsg ? [systemMsg] : []),
            truncMsg,
            ...protectedTail,
        ]);
    }

    /**
     * Find where the exact recent tail starts. Metadata-aware histories retain
     * the entire active turn; legacy histories fall back to the latest user or
     * an aligned six-message tail.
     */
    private findTailStart(messages: ChatMessage[]): number {
        const activeTurnId = [...messages].reverse().find(message => message.turnId)?.turnId;
        if (activeTurnId) {
            const turnStart = messages.findIndex(message => message.turnId === activeTurnId);
            if (turnStart >= 0) {
                return this.alignTailStart(messages, turnStart);
            }
        }

        const minTail = Math.min(6, messages.length);
        const earliest = messages.length - minTail;

        // Walk backwards to find the last user message
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                return i;
            }
        }

        // No user message in the tail region — just protect the last minTail messages
        return this.alignTailStart(messages, earliest);
    }

    /**
     * Avoid starting a preserved tail in the middle of a tool-result block.
     */
    private alignTailStart(messages: ChatMessage[], start: number): number {
        let aligned = start;
        const roundId = messages[aligned]?.roundId;
        if (roundId) {
            while (aligned > 0 && messages[aligned - 1].roundId === roundId) {
                aligned--;
            }
        }
        while (aligned > 0 && messages[aligned].role === 'tool') {
            aligned--;
        }
        return aligned;
    }

    private findCheckpointBoundary(messages: ChatMessage[]): {
        metadata: ConversationCheckpointMetadata;
        index: number;
    } | undefined {
        let boundary: { metadata: ConversationCheckpointMetadata; index: number } | undefined;

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (message.checkpoint) {
                boundary = { metadata: message.checkpoint, index: i };
            }
            if (message.role !== 'assistant' || !message.turnId || !message.roundId) {
                continue;
            }

            const expectedToolIds = new Set((message.tool_calls ?? []).map(toolCall => toolCall.id));
            let completedIndex = i;
            if (expectedToolIds.size > 0) {
                let resultIndex = i + 1;
                while (resultIndex < messages.length && messages[resultIndex].role === 'tool') {
                    const toolCallId = messages[resultIndex].tool_call_id;
                    if (toolCallId) { expectedToolIds.delete(toolCallId); }
                    resultIndex++;
                }
                if (expectedToolIds.size > 0) {
                    continue;
                }
                completedIndex = resultIndex - 1;
            }

            boundary = {
                metadata: {
                    version: 1,
                    throughTurnId: message.turnId,
                    throughRoundId: message.roundId,
                },
                index: completedIndex,
            };
        }

        return boundary;
    }

    /**
     * Collapse a block of middle messages into a compact textual summary.
     *
     * Groups assistant (with tool_calls) + tool result messages into summaries like:
     *   "• read_file(src/foo.ts) → 42 lines of code"
     *   "• edit_file(src/bar.ts) → success"
     *   "• Assistant: Explained the auth flow and suggested refactoring."
     */
    private summarizeMiddle(messages: ChatMessage[]): string {
        if (messages.length === 0) { return '[No prior context]'; }

        const lines: string[] = ['[Conversation Summary — older messages were condensed to save context]'];
        let i = 0;

        while (i < messages.length) {
            const msg = messages[i];

            if (msg.role === 'user') {
                const text = this.extractText(msg);
                lines.push(`• User: ${this.truncate(text, 150)}`);
                i++;
                continue;
            }

            if (msg.role === 'assistant') {
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    // Summarize tool calls and collect their results
                    const toolSummaries: string[] = [];
                    for (const tc of msg.tool_calls) {
                        const argSnippet = this.summarizeArgs(tc.function.arguments);
                        toolSummaries.push(`${tc.function.name}(${argSnippet})`);
                    }

                    // Also note any text the assistant produced alongside tool calls
                    const assistantText = this.extractText(msg);
                    if (assistantText.length > 0) {
                        lines.push(`• Assistant: ${this.truncate(assistantText, 100)}`);
                    }

                    // Consume the matching tool-result messages
                    const toolCallIds = new Set(msg.tool_calls.map(tc => tc.id));
                    let j = i + 1;
                    const resultSnippets: string[] = [];
                    while (j < messages.length && messages[j].role === 'tool') {
                        const toolMsg = messages[j];
                        if (toolMsg.tool_call_id && toolCallIds.has(toolMsg.tool_call_id)) {
                            const resultText = typeof toolMsg.content === 'string' ? toolMsg.content : '';
                            const brief = resultText.length > 80
                                ? resultText.slice(0, 80) + '...'
                                : resultText;
                            resultSnippets.push(brief);
                        }
                        j++;
                    }

                    for (let k = 0; k < toolSummaries.length; k++) {
                        const result = resultSnippets[k] ? ` → ${resultSnippets[k]}` : '';
                        lines.push(`  - ${toolSummaries[k]}${result}`);
                    }

                    i = j;
                    continue;
                }

                // Plain assistant message (no tool calls)
                const text = this.extractText(msg);
                if (text.length > 0) {
                    lines.push(`• Assistant: ${this.truncate(text, 200)}`);
                }
                i++;
                continue;
            }

            if (msg.role === 'system' && i > 0) {
                const text = this.extractText(msg);
                if (msg.checkpoint) {
                    lines.push(`• Prior checkpoint: ${text}`);
                } else {
                    // Context-snapshot system messages — condense
                    lines.push(`• [Context]: ${this.truncate(text, 100)}`);
                }
                i++;
                continue;
            }

            // tool messages not matched to an assistant (shouldn't happen, but be safe)
            i++;
        }

        return lines.join('\n');
    }

    /**
     * If the summary is still too long, progressively chop it down.
     */
    private truncateSummary(
        summary: string,
        budget: number,
        systemMsg: ChatMessage | null,
        tail: ChatMessage[],
        modelId?: string
    ): string {
        const fixedTokens = (systemMsg ? this.estimateMessageTokens(systemMsg, modelId) : 0) +
            this.estimateTotalTokens(tail, modelId) + MSG_OVERHEAD;
        const availableTokens = budget - fixedTokens;

        if (this.estimateTextTokens(summary, modelId) <= availableTokens) {
            return summary;
        }

        // Keep the header and as many lines as fit
        const lines = summary.split('\n');
        let result = lines[0]; // header line
        for (let i = 1; i < lines.length; i++) {
            const candidate = `${result}\n${lines[i]}`;
            if (this.estimateTextTokens(candidate, modelId) > Math.max(50, availableTokens)) { break; }
            result = candidate;
        }

        return result + '\n[... earlier context truncated to fit context window]';
    }

    /** Extract plain text from a ChatMessage, handling string | ContentPart[] | null. */
    private extractText(msg: ChatMessage): string {
        if (typeof msg.content === 'string') { return msg.content; }
        if (Array.isArray(msg.content)) {
            return (msg.content as ContentPart[])
                .filter(p => p.type === 'text')
                .map(p => (p as { type: 'text'; text: string }).text)
                .join(' ');
        }
        return '';
    }

    /** Produce a short representation of tool-call arguments. */
    private summarizeArgs(argsJson: string): string {
        try {
            const obj = JSON.parse(argsJson);
            // Show the first string-valued arg (typically "path", "query", "command")
            for (const key of ['path', 'query', 'pattern', 'command', 'name', 'file_path']) {
                if (typeof obj[key] === 'string') {
                    return this.truncate(obj[key], 60);
                }
            }
            // Fallback: show keys
            return Object.keys(obj).join(', ');
        } catch {
            return argsJson.length > 40 ? argsJson.slice(0, 40) + '...' : argsJson;
        }
    }

    private estimateTextTokens(text: string, modelId?: string): number {
        return countModelTextTokens(text, modelId) ?? Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    /**
     * Emergency trim — aggressively reduce conversation to fit a smaller-than-expected
     * context window. Called when the API rejects the prompt (e.g. invalid_prompt).
     * Halves the effective context window and re-trims, repeating until the
     * conversation is substantially smaller.
     */
    emergencyTrim(messages: ChatMessage[], modelId?: string): ChatMessage[] {
        // Use half the configured window as the emergency budget
        const emergencyBudget = Math.floor(this.getContextWindow() * 0.35);
        const currentTokens = this.estimateTotalTokens(messages, modelId);
        if (currentTokens <= emergencyBudget) {
            // Already small — nothing more to trim
            return messages;
        }
        return this.trimMessages(messages, emergencyBudget, modelId);
    }

    /** Truncate a string to maxLen characters, appending "..." if cut. */
    private truncate(s: string, maxLen: number): string {
        if (s.length <= maxLen) { return s; }
        return s.slice(0, maxLen) + '...';
    }

    private fitTextToTokenBudget(text: string, budget: number, modelId: string | undefined, fromEnd: boolean): string {
        let low = 0;
        let high = text.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const candidate = fromEnd ? text.slice(-mid) : text.slice(0, mid);
            if (this.estimateTextTokens(candidate, modelId) <= budget) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return fromEnd ? text.slice(-low) : text.slice(0, low);
    }
}
