import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProbeReport, probeModelConnection } from '../services/modelProbe.js';
import type { ResolvedModelConnection } from '../modelTypes.js';

const connection: ResolvedModelConnection = {
  definition: {
    id: 'model',
    name: 'Test',
    type: 'azure-openai',
    authMode: 'api-key',
    endpointEnv: 'ENDPOINT',
    deploymentEnv: 'DEPLOYMENT'
  },
  endpoint: 'https://example.openai.azure.com/openai/v1',
  deployment: 'gpt-test',
  apiVersion: '2025-01-01-preview',
  apiKey: 'test-key'
};

const sse = (lines: string[]) => new Response(lines.map((line) => `data: ${line}\n\n`).join(''), {
  status: 200,
  headers: { 'Content-Type': 'text/event-stream' }
});

test('model probe recommends the API that accepts tool-result replay', async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string }> };
    if (String(input).endsWith('/chat/completions')) {
      return body.messages?.some((message) => message.role === 'tool')
        ? new Response(JSON.stringify({ error: { message: 'Invalid messages[3].' } }), { status: 400 })
        : sse(['{"choices":[{"delta":{"content":"OK"}}]}', '[DONE]']);
    }
    return sse(['{"type":"response.output_text.delta","delta":"OK"}', '{"type":"response.completed"}']);
  }) as typeof globalThis.fetch;

  const report = await probeModelConnection(connection, { fetchImpl });
  const [chat, responses] = report.results;
  assert.equal(chat!.ok, false);
  assert.deepEqual(chat!.checks.map((check) => check.ok), [true, true, false]);
  assert.equal(responses!.ok, true);
  assert.equal(report.recommended?.api, 'responses');
  assert.match(formatProbeReport(report), /FAIL {2}chat-completions[\s\S]*PASS {2}responses/);
  assert.doesNotMatch(formatProbeReport(report), /test-key/);
});
