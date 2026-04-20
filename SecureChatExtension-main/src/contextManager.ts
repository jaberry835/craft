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

import { ChatMessage, ContentPart, ToolCall } from './types';
import { getSetting } from './config';

/** Average characters per token — a conservative heuristic for English + code. */
const CHARS_PER_TOKEN = 3.5;

/** Overhead tokens per message for role / framing (OpenAI charges ~4 per message). */
const MSG_OVERHEAD = 4;

export class ContextManager {

    /**
     * Estimate the number of tokens in a single message.
     */
    estimateMessageTokens(msg: ChatMessage): number {
        let chars = 0;

        if (typeof msg.content === 'string') {
            chars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content as ContentPart[]) {
                if (part.type === 'text') {
                    chars += part.text.length;
                } else if (part.type === 'image_url') {
                    // Vision images cost a fixed budget; approximate as 1024 tokens.
                    chars += 1024 * CHARS_PER_TOKEN;
                }
            }
        }

        // tool_calls JSON also counts toward context
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                chars += tc.function.name.length + tc.function.arguments.length;
            }
        }

        if (msg.name) { chars += msg.name.length; }

        return Math.ceil(chars / CHARS_PER_TOKEN) + MSG_OVERHEAD;
    }

    /**
     * Estimate total tokens across all messages.
     */
    estimateTotalTokens(messages: ChatMessage[]): number {
        let total = 0;
        for (const m of messages) {
            total += this.estimateMessageTokens(m);
        }
        return total;
    }

    /**
     * Return the configured context-window size (tokens).
     * Defaults to 128 000 which covers GPT-4o / GPT-4.1 deployments.
     */
    getContextWindow(): number {
        return getSetting<number>('agent.contextWindow') ?? 128000;
    }

    /**
     * Return the trim threshold as a fraction (0-1).
     * When estimated tokens exceed this fraction of the context window the
     * manager will start trimming.  Default: 0.70
     */
    getThreshold(): number {
        return getSetting<number>('agent.contextThreshold') ?? 0.70;
    }

    /**
     * If the conversation is over budget, trim it and return the trimmed array.
     * Otherwise, return the original array unchanged.
     *
     * The caller should replace its message array with the result:
     *   `this.messages = contextManager.trimIfNeeded(this.messages);`
     */
    trimIfNeeded(messages: ChatMessage[]): ChatMessage[] {
        const maxTokens = Math.floor(this.getContextWindow() * this.getThreshold());
        const currentTokens = this.estimateTotalTokens(messages);

        if (currentTokens <= maxTokens) {
            return messages;
        }

        return this.trimMessages(messages, maxTokens);
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
    private trimMessages(messages: ChatMessage[], budget: number): ChatMessage[] {
        if (messages.length <= 4) { return messages; }

        // Always keep the system prompt at index 0
        const systemMsg = messages[0].role === 'system' ? messages[0] : null;

        // Preserve the tail — the last user message + everything after it.
        // This keeps the current iteration's context intact.
        const tailStart = this.findTailStart(messages);
        const tail = messages.slice(tailStart);
        const middle = systemMsg
            ? messages.slice(1, tailStart)
            : messages.slice(0, tailStart);

        // Summarize the middle section
        const summary = this.summarizeMiddle(middle);

        // Build candidate message list
        const summaryMsg: ChatMessage = {
            role: 'system',
            content: summary,
        };

        const candidate = [
            ...(systemMsg ? [systemMsg] : []),
            summaryMsg,
            ...tail,
        ];

        // If the summary + tail still fits, we're done
        if (this.estimateTotalTokens(candidate) <= budget) {
            return this.normalizeMessageSequence(candidate);
        }

        // Still over budget — progressively truncate the summary
        const truncated = this.truncateSummary(summary, budget, systemMsg, tail);
        const truncMsg: ChatMessage = { role: 'system', content: truncated };

        return this.normalizeMessageSequence([
            ...(systemMsg ? [systemMsg] : []),
            truncMsg,
            ...tail,
        ]);
    }

    /**
     * Find where the "tail" starts — the most recent user message and everything
     * after it.  We protect at least the last 6 messages to keep one full
     * tool-call round-trip intact.
     */
    private findTailStart(messages: ChatMessage[]): number {
        const minTail = Math.min(6, messages.length);
        const earliest = messages.length - minTail;

        // Walk backwards to find the last user message
        for (let i = messages.length - 1; i >= earliest; i--) {
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
        while (aligned > 0 && messages[aligned].role === 'tool') {
            aligned--;
        }
        return aligned;
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
                // Context-snapshot system messages — condense
                const text = this.extractText(msg);
                lines.push(`• [Context]: ${this.truncate(text, 100)}`);
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
        tail: ChatMessage[]
    ): string {
        const fixedTokens = (systemMsg ? this.estimateMessageTokens(systemMsg) : 0) +
            this.estimateTotalTokens(tail) + MSG_OVERHEAD;
        const availableTokens = budget - fixedTokens;
        const availableChars = Math.max(200, Math.floor(availableTokens * CHARS_PER_TOKEN));

        if (summary.length <= availableChars) {
            return summary;
        }

        // Keep the header and as many lines as fit
        const lines = summary.split('\n');
        let result = lines[0]; // header line
        for (let i = 1; i < lines.length; i++) {
            if (result.length + lines[i].length + 1 > availableChars) { break; }
            result += '\n' + lines[i];
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

    /**
     * Emergency trim — aggressively reduce conversation to fit a smaller-than-expected
     * context window. Called when the API rejects the prompt (e.g. invalid_prompt).
     * Halves the effective context window and re-trims, repeating until the
     * conversation is substantially smaller.
     */
    emergencyTrim(messages: ChatMessage[]): ChatMessage[] {
        // Use half the configured window as the emergency budget
        const emergencyBudget = Math.floor(this.getContextWindow() * 0.35);
        const currentTokens = this.estimateTotalTokens(messages);
        if (currentTokens <= emergencyBudget) {
            // Already small — nothing more to trim
            return messages;
        }
        return this.trimMessages(messages, emergencyBudget);
    }

    /** Truncate a string to maxLen characters, appending "..." if cut. */
    private truncate(s: string, maxLen: number): string {
        if (s.length <= maxLen) { return s; }
        return s.slice(0, maxLen) + '...';
    }
}
