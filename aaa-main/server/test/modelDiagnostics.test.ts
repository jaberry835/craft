import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createAaaApp } from '../app.js';
import { ProjectRegistry } from '../projectRegistry.js';
import { schemaParameters } from '../projectWorkflowService.js';
import { ModelConnectionConfig } from '../services/modelConnectionConfig.js';
import type { ModelDiagnosticsReport } from '../../src/types/api.js';

const root = path.join(process.cwd(), '.test-data', 'model-diagnostics');

const sse = (lines: string[]) => new Response(lines.map((line) => `data: ${line}\n\n`).join(''), {
  status: 200,
  headers: { 'Content-Type': 'text/event-stream' }
});

async function startApp(environment: Record<string, string>, modelFetch: typeof fetch) {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'project'), { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Diagnostics', rootPath: path.join(root, 'project') }]
  }));
  await writeFile(path.join(root, 'agent-connections.json'), JSON.stringify([{
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    authMode: 'api-key',
    endpointEnv: 'MODEL_ENDPOINT',
    apiKeyEnv: 'MODEL_KEY',
    deploymentEnv: 'MODEL_DEPLOYMENT',
    defaultApiVersion: '2025-01-01-preview'
  }]));
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(root, 'projects.json')),
    dataRoot: path.join(root, 'data'),
    modelConfig: await ModelConnectionConfig.load(path.join(root, 'agent-connections.json'), environment),
    modelClient: { async *stream() { yield { type: 'completed' }; } },
    modelFetch
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  };
}

test('model diagnostics report per-API URLs, check details, and a recommendation without credentials', async (t) => {
  t.mock.method(console, 'error', () => {});
  const modelFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string }> };
    if (String(input).endsWith('/chat/completions')) {
      return body.messages?.some((message) => message.role === 'tool')
        ? new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Invalid messages[3].' } }), { status: 400 })
        : sse(['{"choices":[{"delta":{"content":"OK"}}]}', '[DONE]']);
    }
    return sse(['{"type":"response.output_text.delta","delta":"OK"}', '{"type":"response.completed"}']);
  }) as typeof fetch;
  const app = await startApp({
    MODEL_ENDPOINT: 'https://example.openai.azure.com/openai/v1',
    MODEL_KEY: 'super-secret-key',
    MODEL_DEPLOYMENT: 'chat'
  }, modelFetch);
  t.after(app.close);

  const response = await fetch(`${app.url}/api/model/diagnostics`, { method: 'POST' });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /super-secret-key/);
  const report = JSON.parse(text) as ModelDiagnosticsReport;
  assert.equal(report.status.endpointHost, 'example.openai.azure.com');
  const [chat, responses] = report.results;
  assert.equal(chat!.url, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(chat!.ok, false);
  assert.deepEqual(chat!.checks.map((check) => check.ok), [true, true, false]);
  assert.match(chat!.checks[2]!.detail, /status 400 \(invalid_request_error\)\. Invalid messages\[3\]/);
  assert.ok(chat!.checks.every((check) => typeof check.durationMs === 'number'));
  assert.equal(responses!.url, 'https://example.openai.azure.com/openai/v1/responses');
  assert.equal(responses!.ok, true);
  assert.equal(report.recommended?.api, 'responses');
});

test('model diagnostics refuse to run when the connection is not ready', async (t) => {
  const app = await startApp({ MODEL_ENDPOINT: 'https://example.openai.azure.com' }, globalThis.fetch);
  t.after(app.close);
  const response = await fetch(`${app.url}/api/model/diagnostics`, { method: 'POST' });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /Missing: MODEL_DEPLOYMENT, MODEL_KEY/);
});

test('MCP tool schemas are summarized into readable parameters', () => {
  assert.deepEqual(schemaParameters({
    type: 'object',
    properties: {
      siteId: { type: 'string', description: 'Draft site id.' },
      files: { type: 'array', items: { type: 'object' } },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['draft', 'publish'] },
      limit: { type: ['integer', 'null'] },
      payload: { anyOf: [{ type: 'string' }, { type: 'object' }] }
    },
    required: ['siteId', 'files']
  }), [
    { name: 'siteId', type: 'string', required: true, description: 'Draft site id.' },
    { name: 'files', type: 'object[]', required: true },
    { name: 'tags', type: 'string[]', required: false },
    { name: 'mode', type: 'enum', required: false, description: '(one of: draft, publish)' },
    { name: 'limit', type: 'integer | null', required: false },
    { name: 'payload', type: 'union', required: false }
  ]);
  assert.deepEqual(schemaParameters(undefined), []);
});
