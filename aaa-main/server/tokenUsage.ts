import type { ModelChatMessage, ModelToolDefinition, ModelUsage } from './modelTypes.js';
import type { RunUsage } from '../src/types/api.js';

// Deliberately conservative (overestimates English prose, close for JSON and code) so
// budget checks trigger before the provider rejects a request.
const charactersPerToken = 3.5;
const perMessageOverhead = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / charactersPerToken);
}

export function estimateMessageTokens(messages: ModelChatMessage[]): number {
  return messages.reduce((total, message) => total
    + perMessageOverhead
    + estimateTextTokens(message.content)
    + (message.toolCalls ?? []).reduce(
      (sum, call) => sum + estimateTextTokens(call.function.name) + estimateTextTokens(call.function.arguments),
      0
    ), 0);
}

export function estimateToolTokens(tools: ModelToolDefinition[] | undefined): number {
  return tools?.length ? estimateTextTokens(JSON.stringify(tools)) : 0;
}

export function emptyRunUsage(): RunUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
    promptTokens: 0,
    peakInputTokens: 0,
    estimated: false
  };
}

/**
 * Adds one request's usage to a running total (mutates and returns `total`). Auxiliary
 * requests, such as compaction summaries, count toward totals but not toward the
 * prompt or peak context measurements of the agent conversation.
 */
export function addRequestUsage(
  total: RunUsage,
  usage: ModelUsage,
  options: { estimated?: boolean; auxiliary?: boolean } = {}
): RunUsage {
  if (!options.auxiliary) {
    if (total.promptTokens === 0) total.promptTokens = usage.inputTokens;
    total.peakInputTokens = Math.max(total.peakInputTokens, usage.inputTokens);
  }
  total.requests += 1;
  total.inputTokens += usage.inputTokens;
  total.cachedInputTokens += usage.cachedInputTokens;
  total.outputTokens += usage.outputTokens;
  total.reasoningTokens += usage.reasoningTokens;
  total.totalTokens += usage.totalTokens;
  total.estimated ||= Boolean(options.estimated);
  return total;
}

export function estimatedUsage(inputTokens: number, outputTokens: number): ModelUsage {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}
