import { describe, expect, it } from 'vitest';
import { AgentLoop, buildNativeCompactionTail, classifyProviderRequestFailure, insertProviderMessages } from '../src/agentLoop';

describe('provider request outcome classification', () => {
  it('distinguishes cancellation, stream stalls, and provider failures', () => {
    expect(classifyProviderRequestFailure(Object.assign(new Error('stopped'), { name: 'AbortError' }), false))
      .toEqual({ status: 'canceled', reason: 'canceled' });
    expect(classifyProviderRequestFailure(new Error('Stream stalled - no data received'), false))
      .toEqual({ status: 'stalled', reason: 'stream-stall' });
    expect(classifyProviderRequestFailure(new Error('API returned 500'), false))
      .toEqual({ status: 'failed', reason: 'provider-error' });
  });
});

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

      it.each([
        'previous_response_id has expired',
        'invalid previous_response_id',
        'previous_response_id is missing',
      ])('recognizes stale provider state: %s', (message) => {
        const err = Object.assign(new Error(message), { statusCode: 400 });
        expect(AgentLoop.isPreviousResponseNotFoundError(err)).toBe(true);
      });

      it('recognizes rejected native compaction fields for session fallback', () => {
        const err = Object.assign(new Error('Unknown request parameter: context_management'), { statusCode: 400 });
        expect(AgentLoop.isNativeCompactionRejectedError(err)).toBe(true);
      });

      it('does not disable native compaction for unrelated provider failures', () => {
        const err = Object.assign(new Error('rate limit exceeded'), { statusCode: 429 });
        expect(AgentLoop.isNativeCompactionRejectedError(err)).toBe(false);
      });

      it('keeps only instructions and complete messages after a native compaction boundary', () => {
        const history = [
          { role: 'user' as const, content: 'old request' },
          { role: 'assistant' as const, content: 'old answer' },
          {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{
              id: 'call_1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{}' },
            }],
          },
          { role: 'tool' as const, tool_call_id: 'call_1', content: 'result' },
        ];
        const requestMessages = [
          { role: 'system' as const, content: 'instructions' },
          ...history,
        ];

        expect(buildNativeCompactionTail(requestMessages, history, 2)).toEqual([
          { role: 'system', content: 'instructions' },
          history[2],
          history[3],
        ]);
      });

      it('inserts frozen provider context into the stable leading system prefix', () => {
        const history = [
          { role: 'system' as const, content: 'base' },
          { role: 'user' as const, content: 'request' },
        ];

        insertProviderMessages(history, [
          { role: 'system', content: '[Context Snapshot]\nworkspace' },
        ]);

        expect(history.map(message => message.role)).toEqual(['system', 'system', 'user']);
        expect(history[1].content).toBe('[Context Snapshot]\nworkspace');
      });
});