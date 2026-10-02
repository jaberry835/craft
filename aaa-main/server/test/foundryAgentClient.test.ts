import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunError } from '../httpErrors.js';
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

test('native Foundry Agent Service invokes an agent reference through the project endpoint', async () => {
  let nativeRequest: {
    endpoint: string;
    agentName: string;
    messages: Array<{ role: string; content: string }>;
    signal: AbortSignal;
  } | undefined;
  const client = new FoundryAgentClient(
    { FOUNDRY_PROJECT_ENDPOINT: 'https://account.services.ai.azure.com/api/projects/security' },
    undefined,
    undefined,
    async (request) => {
      nativeRequest = request;
      return {
        output_text: 'Native assessment complete.',
        usage: { input_tokens: 14, output_tokens: 4 }
      };
    }
  );
  const events: string[] = [];
  const result = await client.invoke(
    {
      runtime: 'agent-service',
      endpointEnv: 'FOUNDRY_PROJECT_ENDPOINT',
      authMode: 'entra',
      agentName: 'security-assessor'
    },
    [{ role: 'user', content: 'Assess AU-2' }],
    new AbortController().signal,
    { onToolEvent: (event) => { events.push(event.label); } }
  );

  assert.equal(nativeRequest?.endpoint, 'https://account.services.ai.azure.com/api/projects/security');
  assert.equal(nativeRequest?.agentName, 'security-assessor');
  assert.deepEqual(nativeRequest?.messages, [{ role: 'user', content: 'Assess AU-2' }]);
  assert.equal(result.content, 'Native assessment complete.');
  assert.deepEqual(events, ['Invoked Foundry Agent Service agent']);
});

test('native Foundry Agent Service uses the SDK project route, Entra auth, and agent reference body', async () => {
  let request: Request | undefined;
  const client = new FoundryAgentClient(
    { FOUNDRY_PROJECT_ENDPOINT: 'https://account.services.ai.azure.com/api/projects/security' },
    async (input, init) => {
      request = new Request(input, init);
      return Response.json({ output_text: 'SDK invocation complete.' });
    },
    {
      getToken: async () => ({
        token: 'entra-token',
        expiresOnTimestamp: Date.now() + 60_000
      })
    }
  );

  await client.invoke(
    {
      runtime: 'agent-service',
      endpointEnv: 'FOUNDRY_PROJECT_ENDPOINT',
      authMode: 'entra',
      agentName: 'security-assessor'
    },
    [
      { role: 'system', content: 'Follow project policy.' },
      { role: 'user', content: 'Assess AU-2' },
      { role: 'tool', content: 'local-only tool output', toolCallId: 'call-1' }
    ],
    new AbortController().signal
  );

  assert.equal(request?.url, 'https://account.services.ai.azure.com/api/projects/security/openai/v1/responses');
  assert.equal(request?.headers.get('authorization'), 'Bearer entra-token');
  assert.deepEqual(JSON.parse(await request!.text()), {
    input: [
      { role: 'system', content: 'Follow project policy.' },
      { role: 'user', content: 'Assess AU-2' }
    ],
    agent: { name: 'security-assessor', type: 'agent_reference' }
  });
});

test('native Foundry Agent Service requires an agent name', () => {
  const client = new FoundryAgentClient({
    FOUNDRY_PROJECT_ENDPOINT: 'https://account.services.ai.azure.com/api/projects/security'
  });
  assert.deepEqual(client.status({
    runtime: 'agent-service',
    endpointEnv: 'FOUNDRY_PROJECT_ENDPOINT',
    authMode: 'entra',
    agentName: ''
  }), {
    ready: false,
    endpoint: 'https://account.services.ai.azure.com/api/projects/security',
    missing: ['Foundry agent name']
  });
});

test('native Foundry Agent Service sanitizes remote errors', async () => {
  const client = new FoundryAgentClient(
    { FOUNDRY_PROJECT_ENDPOINT: 'https://account.services.ai.azure.com/api/projects/security' },
    undefined,
    undefined,
    async () => { throw new Error('Bearer secret-token remote failure'); }
  );

  await assert.rejects(client.invoke(
    {
      runtime: 'agent-service',
      endpointEnv: 'FOUNDRY_PROJECT_ENDPOINT',
      authMode: 'entra',
      agentName: 'security-assessor'
    },
    [{ role: 'user', content: 'Assess AU-2' }],
    new AbortController().signal
  ), (error: unknown) => {
    assert.ok(error instanceof AgentRunError);
    assert.match(error.message, /Bearer \[REDACTED\] remote failure/);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

test('native Foundry Agent Service preserves abort cancellation', async () => {
  const abortController = new AbortController();
  const reason = new DOMException('Client disconnected.', 'AbortError');
  const client = new FoundryAgentClient(
    { FOUNDRY_PROJECT_ENDPOINT: 'https://account.services.ai.azure.com/api/projects/security' },
    undefined,
    undefined,
    async () => {
      abortController.abort(reason);
      throw reason;
    }
  );

  await assert.rejects(client.invoke(
    {
      runtime: 'agent-service',
      endpointEnv: 'FOUNDRY_PROJECT_ENDPOINT',
      authMode: 'entra',
      agentName: 'security-assessor'
    },
    [{ role: 'user', content: 'Assess AU-2' }],
    abortController.signal
  ), (error: unknown) => error === reason);
});
