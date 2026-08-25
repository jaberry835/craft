import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/agentLoop';

describe('AgentLoop Responses API server-side state recovery', () => {
    it('recognizes stale previous_response_id errors returned by the Responses API', () => {
        const err = new Error(`responses API 400: {
  "error": {
    "message": "Previous response with id 'resp_0048e3340ae30031006a8dcb7fbfe88196bdc63e9276bde9ac' not found.",
    "type": "invalid_request_error",
    "param": "previous_response_id",
    "code": "previous_response_not_found"
  }
}`) as Error & { statusCode: number };
        err.statusCode = 400;

        expect(AgentLoop.isPreviousResponseNotFoundError(err)).toBe(true);
    });

    it('does not classify unrelated 400 errors as stale server-side state', () => {
        const err = new Error('responses API 400: context_length_exceeded') as Error & { statusCode: number };
        err.statusCode = 400;

        expect(AgentLoop.isPreviousResponseNotFoundError(err)).toBe(false);
    });
});