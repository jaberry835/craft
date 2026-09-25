import assert from 'node:assert/strict';
import test from 'node:test';
import { FoundryAgentClient } from '../services/foundryAgentClient.js';

test('Foundry Responses agents use env-referenced API keys and normalize output and usage', async () => {
  let request: Request | undefined;
  const client = new FoundryAgentClient(
    {
      FOUNDRY_AGENT_ENDPOINT: 'https://agents.example.test/responses',
      FOUNDRY_AGENT_API_KEY: 'secret'
    },
    async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        output_text: 'Remote assessment complete.',
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 2 }
        }
      });
    }
  );
  const texts: string[] = [];
  const result = await client.invoke(
    {
      endpointEnv: 'FOUNDRY_AGENT_ENDPOINT',
      authMode: 'api-key',
      apiKeyEnv: 'FOUNDRY_AGENT_API_KEY'
    },
    [{ role: 'user', content: 'Assess AU-2' }],
    new AbortController().signal,
    { onAssistantText: (text) => { texts.push(text); } }
  );

  assert.equal(request?.headers.get('api-key'), 'secret');
  assert.deepEqual(JSON.parse(await request!.text()), {
    input: [{ role: 'user', content: 'Assess AU-2' }]
  });
  assert.equal(result.content, 'Remote assessment complete.');
  assert.deepEqual(texts, ['Remote assessment complete.']);
  assert.deepEqual(result.usage, {
    inputTokens: 20,
    cachedInputTokens: 5,
    outputTokens: 8,
    reasoningTokens: 2,
    totalTokens: 28,
    requests: 1,
    promptTokens: 20,
    peakInputTokens: 20,
    estimated: false
  });
});

test('Foundry connection status reports missing environment variables without leaking values', () => {
  const client = new FoundryAgentClient({});
  assert.deepEqual(client.status({
    endpointEnv: 'FOUNDRY_AGENT_ENDPOINT',
    authMode: 'api-key',
    apiKeyEnv: 'FOUNDRY_AGENT_API_KEY'
  }), {
    ready: false,
    missing: ['FOUNDRY_AGENT_ENDPOINT', 'FOUNDRY_AGENT_API_KEY']
  });
});
