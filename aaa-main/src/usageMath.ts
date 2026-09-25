import type { AgentRun, ChatSession, RunUsage, TokenUsage } from './types/api';

export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function usageTitle(usage: TokenUsage & Partial<RunUsage>): string {
  const lines = [
    `Input: ${usage.inputTokens.toLocaleString()} tokens`,
    `  Cached input: ${usage.cachedInputTokens.toLocaleString()}`,
    `Output: ${usage.outputTokens.toLocaleString()} tokens`,
    `  Reasoning: ${usage.reasoningTokens.toLocaleString()}`,
    `Total: ${usage.totalTokens.toLocaleString()} tokens`
  ];
  if (usage.requests !== undefined) lines.push(`Model requests: ${usage.requests}`);
  if (usage.peakInputTokens) lines.push(`Largest request: ${usage.peakInputTokens.toLocaleString()} input tokens`);
  if (usage.estimated) lines.push('Some requests did not report usage and were estimated.');
  return lines.join('\n');
}

export function sessionUsage(runs: AgentRun[]): RunUsage | undefined {
  const measured = runs.filter((run) => run.usage);
  if (measured.length === 0) return undefined;
  return measured.reduce<RunUsage>((total, run) => ({
    inputTokens: total.inputTokens + run.usage!.inputTokens,
    cachedInputTokens: total.cachedInputTokens + run.usage!.cachedInputTokens,
    outputTokens: total.outputTokens + run.usage!.outputTokens,
    reasoningTokens: total.reasoningTokens + run.usage!.reasoningTokens,
    totalTokens: total.totalTokens + run.usage!.totalTokens,
    requests: total.requests + run.usage!.requests,
    promptTokens: 0,
    peakInputTokens: Math.max(total.peakInputTokens, run.usage!.peakInputTokens),
    estimated: total.estimated || run.usage!.estimated
  }), {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
    promptTokens: 0,
    peakInputTokens: 0,
    estimated: false
  });
}

export function sessionUsageTitle(usage: RunUsage): string {
  return `Session usage\n${usageTitle(usage)}`;
}

/**
 * Current context size: the largest request of the newest measured run, adjusted
 * downward when the conversation was compacted after that run.
 */
export function contextEstimate(session: ChatSession | null): { tokens: number; approximate: boolean } | undefined {
  if (!session) return undefined;
  const run = [...session.runs].reverse().find((candidate) => candidate.usage && candidate.usage.peakInputTokens > 0);
  if (!run?.usage) return undefined;
  const measuredAt = run.completedAt ?? run.startedAt;
  const later = (session.compactions ?? []).filter((compaction) => compaction.createdAt > measuredAt).at(-1);
  if (!later) return { tokens: run.usage.peakInputTokens, approximate: run.usage.estimated };
  return {
    tokens: Math.max(0, run.usage.peakInputTokens - later.estimatedTokensBefore + later.estimatedTokensAfter),
    approximate: true
  };
}
