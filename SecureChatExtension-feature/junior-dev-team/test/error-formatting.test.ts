import { describe, expect, it } from 'vitest';
import { formatCopilotCliRunError, formatLocalAgentError } from '../src/errorFormatting';

describe('error formatting', () => {
    it('formats local retry-budget failures with a clear no-hang explanation', () => {
        const formatted = formatLocalAgentError(
            'Request exhausted its retry budget after 2 of 3 retries and 64s without a successful response. The next retry required waiting 30s, but only 12s remained in the retry window. Last error: API returned 429: {"error":"rate limited"}'
        );

        expect(formatted).toContain('Local model request failed after 2 of 3 retries over 64s.');
        expect(formatted).toContain('The provider appears to have rate limited this request.');
        expect(formatted).toContain('Junior stopped retrying so the chat would not stay stuck waiting indefinitely.');
        expect(formatted).toContain('The next retry required waiting 30s, but only 12s remained in the retry window.');
    });

    it('formats local timeout failures', () => {
        const formatted = formatLocalAgentError('Request timed out after 120s — the server may be overloaded.');

        expect(formatted).toContain('The local-agent request timed out before the provider responded.');
        expect(formatted).toContain('Last error: Request timed out after 120s — the server may be overloaded.');
    });

    it('formats copilot cli retry summaries', () => {
        const formatted = formatCopilotCliRunError(
            'Failed to get response from the AI model; retried 3 times (total retry wait time: 42 seconds) (Request-ID req-123) Last error: API returned 429: too many requests'
        );

        expect(formatted).toContain('Copilot CLI model request failed after 3 retries (42s total backoff).');
        expect(formatted).toContain('The provider appears to have rate limited this request.');
        expect(formatted).toContain('Request ID: req-123');
    });

    it('formats generic copilot cli rate-limit failures', () => {
        const formatted = formatCopilotCliRunError('429 Too Many Requests from upstream provider');

        expect(formatted).toContain('Copilot CLI appears to have hit a provider rate limit.');
        expect(formatted).toContain('Last error: 429 Too Many Requests from upstream provider');
    });
});