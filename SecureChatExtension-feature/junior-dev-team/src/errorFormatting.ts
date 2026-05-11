function summarizeProviderFailure(rawError: string): {
    providerHint: string;
    retryAdvice: string;
    includeLastError: boolean;
} {
    const message = (rawError || '').trim();
    const lower = message.toLowerCase();

    if (!message || /^unknown error$/i.test(message)) {
        return {
            providerHint: 'This is usually a transient provider issue such as rate limiting or backend overload.',
            retryAdvice: 'Try again in a moment.',
            includeLastError: false,
        };
    }

    if (/\b(429|rate limit|too many requests)\b/i.test(message)) {
        return {
            providerHint: 'The provider appears to have rate limited this request.',
            retryAdvice: 'Try again after the rate limit window resets.',
            includeLastError: true,
        };
    }

    if (lower.includes('timed out') || lower.includes('timeout')) {
        return {
            providerHint: 'The provider did not respond before the request timeout elapsed.',
            retryAdvice: 'Try again in a moment or reduce the request size if this keeps happening.',
            includeLastError: true,
        };
    }

    if (lower.includes('stream stalled') || lower.includes('no data received')) {
        return {
            providerHint: 'The provider stopped sending data before the response completed.',
            retryAdvice: 'Try again in a moment. This is usually a transient upstream issue.',
            includeLastError: true,
        };
    }

    if (/\b(500|502|503|504|service unavailable|bad gateway|gateway)\b/i.test(message)) {
        return {
            providerHint: 'This appears to be an upstream model or gateway failure.',
            retryAdvice: 'Try again in a moment.',
            includeLastError: true,
        };
    }

    return {
        providerHint: 'This appears to be an upstream model/provider failure.',
        retryAdvice: 'Try again in a moment.',
        includeLastError: true,
    };
}

export function formatLocalAgentError(rawMessage: string): string {
    const message = (rawMessage || '').trim();
    if (!message) {
        return 'Local agent error: Unknown error.';
    }

    const retryBudgetMatch = message.match(
        /^Request exhausted its retry budget after (\d+) of (\d+) retries and (\d+)s without a successful response\.(?: The next retry required waiting (\d+)s, but only (\d+)s remained in the retry window\.)?(?: Last error: (.+))?$/i
    );
    if (retryBudgetMatch) {
        const retriesUsed = retryBudgetMatch[1];
        const maxRetries = retryBudgetMatch[2];
        const elapsedSeconds = retryBudgetMatch[3];
        const nextWaitSeconds = retryBudgetMatch[4];
        const remainingWindowSeconds = retryBudgetMatch[5];
        const lastError = (retryBudgetMatch[6] || '').trim();
        const { providerHint, retryAdvice, includeLastError } = summarizeProviderFailure(lastError);

        const lines = [
            `Local model request failed after ${retriesUsed} of ${maxRetries} retries over ${elapsedSeconds}s.`,
            providerHint,
            'Junior stopped retrying so the chat would not stay stuck waiting indefinitely.',
        ];

        if (nextWaitSeconds && remainingWindowSeconds) {
            lines.push(`The next retry required waiting ${nextWaitSeconds}s, but only ${remainingWindowSeconds}s remained in the retry window.`);
        }
        if (lastError && includeLastError) {
            lines.push(`Last error: ${lastError}`);
        }

        lines.push(retryAdvice);
        return lines.join('\n');
    }

    if (/\bAPI returned 429\b/i.test(message) || /\brate limit\b/i.test(message)) {
        return [
            'The provider rate limited this local-agent request.',
            'Junior did not complete the turn.',
            'Try again after the rate limit window resets.',
            `Last error: ${message}`,
        ].join('\n');
    }

    if (/Request timed out after \d+s/i.test(message) || /timed out/i.test(message)) {
        return [
            'The local-agent request timed out before the provider responded.',
            'This usually means the model backend is overloaded or not responding normally.',
            `Last error: ${message}`,
        ].join('\n');
    }

    if (/Stream stalled/i.test(message) || /no data received/i.test(message)) {
        return [
            'The local-agent stream stopped producing data before the response finished.',
            'This usually means the provider stalled mid-response.',
            `Last error: ${message}`,
        ].join('\n');
    }

    return `Local agent error: ${message}`;
}

export function formatCopilotCliRunError(rawMessage: string): string {
    const message = (rawMessage || '').trim();
    if (!message) {
        return 'Copilot CLI error: Unknown error.';
    }

    const retryMatch = message.match(/Failed to get response from the AI model; retried (\d+) times \(total retry wait time: ([^)]+) seconds\)(?: \(Request-ID ([^)]+)\))? Last error: (.+)$/i);
    if (retryMatch) {
        const retries = retryMatch[1];
        const waitSeconds = retryMatch[2];
        const requestId = retryMatch[3];
        const lastError = retryMatch[4].trim();
        const { providerHint, retryAdvice, includeLastError } = summarizeProviderFailure(lastError);

        const lines = [
            `Copilot CLI model request failed after ${retries} retries (${waitSeconds}s total backoff).`,
            providerHint,
            retryAdvice,
        ];

        if (lastError && includeLastError) {
            lines.push(`Last error: ${lastError}`);
        }
        if (requestId) {
            lines.push(`Request ID: ${requestId}`);
        }

        return lines.join('\n');
    }

    if (/\b(429|rate limit|too many requests)\b/i.test(message)) {
        return [
            'Copilot CLI appears to have hit a provider rate limit.',
            'Try again after the rate limit window resets.',
            `Last error: ${message}`,
        ].join('\n');
    }

    return `Copilot CLI error: ${message}`;
}