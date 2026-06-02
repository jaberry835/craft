import type { LoopChatMessage } from './tools/types.js';

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

export class JuniorLoopContextManager {
  estimateMessageTokens(message: LoopChatMessage): number {
    let chars = message.content?.length ?? 0;

    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        chars += toolCall.function.name.length + toolCall.function.arguments.length;
      }
    }

    if (message.name) {
      chars += message.name.length;
    }

    return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;
  }

  estimateTotalTokens(messages: LoopChatMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateMessageTokens(message), 0);
  }

  normalizeMessageSequence(messages: LoopChatMessage[]): LoopChatMessage[] {
    let changed = false;
    const normalized: LoopChatMessage[] = [];
    let pendingToolCallIds: Set<string> | null = null;
    let pendingAssistantIndex = -1;

    const discardPendingTransaction = () => {
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

    for (const message of messages) {
      if (message.role === 'tool') {
        if (!pendingToolCallIds || !message.toolCallId || !pendingToolCallIds.has(message.toolCallId)) {
          changed = true;
          continue;
        }

        normalized.push(message);
        pendingToolCallIds.delete(message.toolCallId);
        finalizePendingIfComplete();
        continue;
      }

      if (pendingToolCallIds) {
        discardPendingTransaction();
      }

      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        const validToolCalls = message.toolCalls.filter((toolCall) => typeof toolCall.id === 'string' && toolCall.id.length > 0);
        if (validToolCalls.length === 0) {
          normalized.push({ ...message, toolCalls: undefined });
          changed = true;
          continue;
        }

        const normalizedAssistant = validToolCalls.length === message.toolCalls.length
          ? message
          : { ...message, toolCalls: validToolCalls };
        if (normalizedAssistant !== message) {
          changed = true;
        }

        pendingAssistantIndex = normalized.length;
        pendingToolCallIds = new Set(validToolCalls.map((toolCall) => toolCall.id));
        normalized.push(normalizedAssistant);
        finalizePendingIfComplete();
        continue;
      }

      normalized.push(message);
    }

    if (pendingToolCallIds) {
      discardPendingTransaction();
    }

    return changed ? normalized : messages;
  }

  trimIfNeeded(messages: LoopChatMessage[], maxTokens = 6000): LoopChatMessage[] {
    const normalized = this.normalizeMessageSequence(messages);
    if (this.estimateTotalTokens(normalized) <= maxTokens) {
      return normalized;
    }

    return this.trimMessages(normalized, maxTokens);
  }

  emergencyTrim(messages: LoopChatMessage[], targetFraction = 0.35): LoopChatMessage[] {
    const budget = Math.max(1200, Math.floor(this.estimateTotalTokens(messages) * targetFraction));
    return this.trimMessages(this.normalizeMessageSequence(messages), budget);
  }

  private trimMessages(messages: LoopChatMessage[], budget: number): LoopChatMessage[] {
    if (messages.length <= 4) {
      return messages;
    }

    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const tailStart = this.findTailStart(messages);
    const tail = messages.slice(tailStart);
    const middle = system ? messages.slice(1, tailStart) : messages.slice(0, tailStart);
    const summary = this.summarizeMiddle(middle);

    const candidate: LoopChatMessage[] = [
      ...(system ? [system] : []),
      { role: 'system', content: summary },
      ...tail
    ];

    if (this.estimateTotalTokens(candidate) <= budget) {
      return this.normalizeMessageSequence(candidate);
    }

    const truncatedSummary = summary.length > 1600 ? `${summary.slice(0, 1600)}\n... [older loop context truncated]` : summary;
    return this.normalizeMessageSequence([
      ...(system ? [system] : []),
      { role: 'system', content: truncatedSummary },
      ...tail
    ]);
  }

  private findTailStart(messages: LoopChatMessage[]): number {
    const minTail = Math.min(6, messages.length);
    const earliest = messages.length - minTail;

    for (let index = messages.length - 1; index >= earliest; index -= 1) {
      if (messages[index].role === 'user') {
        return this.alignTailStart(messages, index);
      }
    }

    return this.alignTailStart(messages, earliest);
  }

  private alignTailStart(messages: LoopChatMessage[], start: number): number {
    let aligned = start;
    while (aligned > 0 && messages[aligned].role === 'tool') {
      aligned -= 1;
    }
    return aligned;
  }

  private summarizeMiddle(messages: LoopChatMessage[]): string {
    if (messages.length === 0) {
      return '[No prior loop context]';
    }

    const lines = ['[Loop Summary: older tool interactions were condensed]'];
    let index = 0;

    while (index < messages.length) {
      const message = messages[index];

      if (message.role === 'user') {
        lines.push(`- User: ${this.truncate(message.content ?? '', 160)}`);
        index += 1;
        continue;
      }

      if (message.role === 'assistant') {
        if (message.toolCalls && message.toolCalls.length > 0) {
          const callSummary = message.toolCalls
            .map((toolCall) => `${toolCall.function.name}(${this.truncate(toolCall.function.arguments, 80)})`)
            .join(', ');
          lines.push(`- Assistant tools: ${callSummary}`);
          index += 1;
          while (index < messages.length && messages[index].role === 'tool') {
            lines.push(`  -> ${this.truncate(messages[index].content ?? '', 120)}`);
            index += 1;
          }
          continue;
        }

        lines.push(`- Assistant: ${this.truncate(message.content ?? '', 180)}`);
        index += 1;
        continue;
      }

      if (message.role === 'tool') {
        lines.push(`- Tool: ${this.truncate(message.content ?? '', 120)}`);
        index += 1;
        continue;
      }

      lines.push(`- Context: ${this.truncate(message.content ?? '', 120)}`);
      index += 1;
    }

    return lines.join('\n');
  }

  private truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }
}