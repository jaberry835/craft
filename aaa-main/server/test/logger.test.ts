import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createAaaApp } from '../app.js';
import type { ChatSessionStore } from '../chatSessionStore.js';
import { errorDetail, log, redactSecrets } from '../logger.js';
import { ProjectRegistry } from '../projectRegistry.js';

function captureConsole(t: test.TestContext) {
  const lines: Array<{ stream: string; line: string }> = [];
  for (const stream of ['error', 'warn', 'log'] as const) {
    t.mock.method(console, stream, (line: string) => { lines.push({ stream, line }); });
  }
  return lines;
}

function withEnvironment(t: test.TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('the logger honors AAA_LOG_LEVEL and writes errors to stderr with context', (t) => {
  withEnvironment(t, { AAA_LOG_LEVEL: undefined, AAA_LOG_FORMAT: undefined });
  const lines = captureConsole(t);
  log.error('agent-run', 'Run failed.', { run: 'r1', error: new Error('model timeout') });
  log.warn('mcp', 'Server skipped.');
  log.info('startup', 'Hidden at the default warn level.');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.stream, 'error');
  assert.match(lines[0]!.line, /^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR \[agent-run\] Run failed\. run=r1 error="model timeout"$/);
  assert.equal(lines[1]!.stream, 'warn');

  process.env.AAA_LOG_LEVEL = 'error';
  log.warn('mcp', 'Now hidden.');
  assert.equal(lines.length, 2);

  process.env.AAA_LOG_LEVEL = 'info';
  log.info('startup', 'Shown at info.', { api: 'auto' });
  assert.equal(lines.at(-1)!.stream, 'log');
});

test('JSON log format emits one parseable object per line', (t) => {
  withEnvironment(t, { AAA_LOG_LEVEL: 'warn', AAA_LOG_FORMAT: 'json' });
  const lines = captureConsole(t);
  log.error('storage', 'Cosmos DB save failed.', { code: '403', error: new Error('Forbidden') });
  const entry = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.equal(entry.level, 'error');
  assert.equal(entry.area, 'storage');
  assert.equal(entry.code, '403');
  assert.equal(entry.error, 'Forbidden');
});

test('logs never contain secret environment values or bearer tokens', (t) => {
  withEnvironment(t, { AAA_LOG_LEVEL: 'warn', AAA_LOG_FORMAT: undefined, AZURE_OPENAI_API_KEY: 'sk-live-0123456789', MCP_TOKEN: 'mcp-token-abcdef' });
  const lines = captureConsole(t);
  log.error('model', 'Request failed with key sk-live-0123456789.', { header: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload', token: 'mcp-token-abcdef' });
  assert.doesNotMatch(lines[0]!.line, /sk-live|eyJhbGci|mcp-token-abcdef/);
  assert.match(lines[0]!.line, /\[redacted\]/);
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijkl'), 'Authorization: Bearer [redacted]');
});

test('error details include the cause chain', () => {
  const root = new Error('connect ECONNREFUSED 10.0.0.4:443');
  const wrapped = new Error('fetch failed', { cause: root });
  assert.equal(errorDetail(new Error('MCP server evidence could not be reached.', { cause: wrapped })),
    'MCP server evidence could not be reached. <- fetch failed <- connect ECONNREFUSED 10.0.0.4:443');
});

test('unexpected API failures are logged with the method and route', async (t) => {
  withEnvironment(t, { AAA_LOG_LEVEL: 'warn', AAA_LOG_FORMAT: undefined });
  const root = path.join(process.cwd(), '.test-data', 'logger-app');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'project'), { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Logging', rootPath: path.join(root, 'project') }]
  }));
  const failing = { list: async () => { throw new Error('disk exploded'); } } as unknown as ChatSessionStore;
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(root, 'projects.json')),
    dataRoot: path.join(root, 'data'),
    sessionStoreFactory: () => failing,
    storageStatus: {
      sessions: { backend: 'local', configured: true, ready: true, active: true, missing: [], invalid: [] },
      workspaceFiles: { backend: 'local', configured: true, ready: true, active: true, missing: [], invalid: [] }
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const lines = captureConsole(t);

  const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/project/sessions`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error.', code: 'internal_error' });
  assert.ok(lines.some(({ stream, line }) =>
    stream === 'error' && /ERROR \[api\] GET \/api\/projects\/project\/sessions failed with an unexpected error\. error="disk exploded"/.test(line)));
});
