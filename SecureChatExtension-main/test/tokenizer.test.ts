import { describe, expect, it } from 'vitest';
import { countModelTextTokens, resolveTokenEncoding } from '../src/tokenizer';

describe('model tokenizer selection', () => {
    it.each([
        ['gpt-5.4', 'o200k_base'],
        ['gpt-4o-mini', 'o200k_base'],
        ['gpt-4.1', 'o200k_base'],
        ['o3-mini', 'o200k_base'],
        ['codex-mini-latest', 'o200k_base'],
        ['gpt-4-0613', 'cl100k_base'],
        ['gpt-3.5-turbo', 'cl100k_base'],
    ] as const)('selects %s as %s', (modelId, expected) => {
        expect(resolveTokenEncoding(modelId)).toBe(expected);
    });

    it('uses fallback estimation for unknown deployment names', () => {
        expect(resolveTokenEncoding('production-coding')).toBeUndefined();
        expect(countModelTextTokens('hello world', 'production-coding')).toBeUndefined();
    });

    it('counts known model text without rejecting special-token-like user content', () => {
        expect(countModelTextTokens('hello world', 'gpt-5')).toBe(2);
        expect(countModelTextTokens('<|endoftext|>', 'gpt-4')).toBeGreaterThan(0);
    });
});