const { countTokens: countCl100kTokens } = require('gpt-tokenizer/encoding/cl100k_base') as
    typeof import('gpt-tokenizer/cjs/encoding/cl100k_base');
const { countTokens: countO200kTokens } = require('gpt-tokenizer/encoding/o200k_base') as
    typeof import('gpt-tokenizer/cjs/encoding/o200k_base');

export type SupportedTokenEncoding = 'cl100k_base' | 'o200k_base';

const NO_DISALLOWED_SPECIAL = { disallowedSpecial: new Set<string>() };

/** Resolve only model families whose OpenAI encoding is known. */
export function resolveTokenEncoding(modelId: string | undefined): SupportedTokenEncoding | undefined {
    const model = modelId?.trim().toLowerCase();
    if (!model) { return undefined; }

    if (/gpt[-_. ]?5|gpt[-_. ]?4o|gpt[-_. ]?4\.1|gpt[-_. ]?4[-_. ]?1|(?:^|[-_. ])o[134](?:[-_. ]|$)|codex/.test(model)) {
        return 'o200k_base';
    }

    if (/gpt[-_. ]?3\.5|gpt[-_. ]?35|gpt[-_. ]?4(?:[-_. ]|$)/.test(model)) {
        return 'cl100k_base';
    }

    return undefined;
}

/** Count text using a known model encoding, or return undefined for fallback. */
export function countModelTextTokens(text: string, modelId: string | undefined): number | undefined {
    const encoding = resolveTokenEncoding(modelId);
    if (!encoding) { return undefined; }

    try {
        return encoding === 'o200k_base'
            ? countO200kTokens(text, NO_DISALLOWED_SPECIAL)
            : countCl100kTokens(text, NO_DISALLOWED_SPECIAL);
    } catch {
        return undefined;
    }
}