import type { TokenUsage } from './types';

function nonNegativeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Normalize Chat Completions and Responses usage payloads into one provider-reported shape. */
export function normalizeProviderTokenUsage(raw: unknown): TokenUsage | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }

    const usage = raw as Record<string, any>;
    const promptTokens = nonNegativeNumber(usage.input_tokens ?? usage.prompt_tokens);
    const completionTokens = nonNegativeNumber(usage.output_tokens ?? usage.completion_tokens);
    const promptDetails = usage.input_tokens_details ?? usage.prompt_tokens_details ?? {};
    const completionDetails = usage.output_tokens_details ?? usage.completion_tokens_details ?? {};
    const cachedPromptTokens = Math.min(promptTokens, nonNegativeNumber(promptDetails.cached_tokens));
    const cacheWriteTokens = nonNegativeNumber(
        promptDetails.cache_creation_tokens
        ?? usage.cache_creation_input_tokens
        ?? usage.cache_write_tokens
    );

    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: nonNegativeNumber(usage.total_tokens) || promptTokens + completionTokens,
        uncached_prompt_tokens: Math.max(0, promptTokens - cachedPromptTokens),
        cached_prompt_tokens: cachedPromptTokens,
        cache_write_tokens: cacheWriteTokens,
        reasoning_tokens: nonNegativeNumber(completionDetails.reasoning_tokens),
        source: 'provider',
    };
}
