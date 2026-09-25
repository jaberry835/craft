import assert from 'node:assert/strict';
import { readdir, readFile, rm, cp, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { AaaAgentLoop } from '../aaaAgentLoop.js';
import type { ModelChatClient, ResolvedModelConnection } from '../modelTypes.js';
import { ProjectFileService } from '../projectFileService.js';
import { markMcpServerHealthy, McpHttpClient, McpToolbox, resetMcpServerHealth } from '../services/mcpHttpClient.js';

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

async function startFakeMcpServer() {
  const calls: Array<{ name?: string; arguments?: Record<string, unknown>; sessionId?: string }> = [];
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.post('/mcp', (request, response) => {
    const body = request.body as RpcRequest;
    if (body.id === undefined) {
      response.status(202).end();
      return;
    }
    const reply = (result: unknown, sse: boolean) => {
      const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (sse) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.write(`event: message\ndata: ${message}\n\n`);
        response.end();
      } else {
        response.json(JSON.parse(message));
      }
    };
    if (body.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'session-1');
      reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } }, true);
    } else if (body.method === 'tools/list') {
      reply({
        tools: [
          {
            name: 'upsert_site_files',
            description: 'Add files to a draft.',
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: { siteId: { type: 'string' }, files: { type: 'array' } },
              required: ['siteId', 'files']
            }
          },
          { name: 'delete_site', description: 'Delete a site.', inputSchema: { type: 'object', properties: {} } }
        ]
      }, false);
    } else if (body.method === 'tools/call') {
      calls.push({ ...body.params, sessionId: request.header('mcp-session-id') });
      reply({ content: [{ type: 'text', text: `ok ${body.params?.name}` }] }, true);
    } else {
      response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('MCP HTTP client lists tools and calls them over JSON and SSE responses', async (t) => {
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const client = new McpHttpClient({ name: 'publisher', url: fake.url });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['upsert_site_files', 'delete_site']);
  const result = await client.callTool('upsert_site_files', { siteId: 'demo', files: [] });
  assert.deepEqual(result, { text: 'ok upsert_site_files', isError: false, structured: undefined });
  assert.equal(fake.calls[0]?.sessionId, 'session-1');
});

test('agent loop exposes filtered MCP tools and expands aaa-file references', async (t) => {
  const fake = await startFakeMcpServer();
  const root = path.join(process.cwd(), '.test-data', 'mcp-agent');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await cp(path.join(process.cwd(), 'templates', 'default-project', '.github', 'skills', 'initialize-security-package',
    'assets', 'security-package-template', 'README.md'), path.join(root, 'docs', 'README.md'));
  t.after(async () => {
    await fake.close();
    await rm(root, { recursive: true, force: true });
  });

  let exposed: string[] = [];
  let round = 0;
  const client: ModelChatClient = {
    async *stream(_connection, _messages, _signal, tools) {
      exposed = (tools ?? []).map((tool) => tool.function.name).filter((name) => name.startsWith('mcp_'));
      round += 1;
      if (round === 1) {
        yield {
          type: 'tool_calls',
          calls: [{
            id: '1',
            type: 'function',
            function: {
              name: 'mcp_publisher_upsert_site_files',
              arguments: JSON.stringify({ siteId: 'demo', files: [{ path: 'README.md', content: 'aaa-file:docs/README.md' }] })
            }
          }]
        };
      } else {
        yield { type: 'assistant_text', text: 'Published.' };
      }
      yield { type: 'completed' };
    }
  };
  const connection = { definition: {}, endpoint: '', deployment: '', apiVersion: '' } as ResolvedModelConnection;
  const events: string[] = [];
  const result = await new AaaAgentLoop(client, new ProjectFileService(root), {
    mcp: new McpToolbox([new McpHttpClient({ name: 'publisher', url: fake.url })]),
    mcpFilter: (_server, tool) => tool !== 'delete_site'
  }).run(connection, [{ role: 'user', content: 'publish' }], new AbortController().signal, {
    onToolEvent: (event) => { events.push(`${event.type}:${event.detail}`); }
  });

  assert.deepEqual(exposed, ['mcp_publisher_upsert_site_files']);
  assert.equal(result.content, 'Published.');
  assert.deepEqual(events, ['mcp:publisher · upsert_site_files · 1 project file sent']);
  const sent = fake.calls[0]?.arguments as { files: Array<{ content: string }> };
  assert.match(sent.files[0]!.content, /^# Security Package/);
});

async function markdownFiles(directory: string, prefix = ''): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await markdownFiles(path.join(directory, entry.name), relative));
    else if (entry.name.toLowerCase().endsWith('.md')) {
      files.push({ path: relative, content: await readFile(path.join(directory, entry.name), 'utf8') });
    }
  }
  return files;
}

// Live check against a real publisher, for example: $env:AAA_MCP_LIVE_URL='http://localhost:3000/mcp'; npm run test:mcp-live
test('live MCP publisher receives every Markdown file and publishes a site', {
  skip: process.env.AAA_MCP_LIVE_URL ? false : 'Set AAA_MCP_LIVE_URL to run against a live MCP publisher.',
  timeout: 180_000
}, async () => {
  const sourceRoot = path.resolve(process.env.AAA_MCP_LIVE_SOURCE ?? path.join(
    'templates', 'default-project', '.github', 'skills', 'initialize-security-package', 'assets', 'security-package-template'
  ));
  const files = await markdownFiles(sourceRoot);
  assert.ok(files.length > 0, `No Markdown files found under ${sourceRoot}`);
  const client = new McpHttpClient({ name: 'mcp-publisher', url: process.env.AAA_MCP_LIVE_URL! });
  const toolNames = (await client.listTools()).map((tool) => tool.name);
  for (const required of ['create_site_draft', 'upsert_site_files', 'publish_site_draft', 'get_publish_status']) {
    assert.ok(toolNames.includes(required), `Publisher is missing ${required}; found ${toolNames.join(', ')}`);
  }

  const siteId = `aaa-live-${Date.now().toString(36)}`;
  const check = (result: { text: string; isError: boolean }, step: string) => {
    assert.equal(result.isError, false, `${step} failed: ${result.text}`);
    return result.text;
  };
  check(await client.callTool('create_site_draft', {
    siteId,
    displayName: 'AAA live MCP test',
    description: 'Markdown sent by the AAA MCP live test.'
  }), 'create_site_draft');
  check(await client.callTool('upsert_site_files', { siteId, files }), 'upsert_site_files');
  const draft = check(await client.callTool('get_site_draft', { siteId }), 'get_site_draft');
  for (const file of files) assert.ok(draft.includes(file.path), `Draft is missing ${file.path}`);

  const queued = check(await client.callTool('publish_site_draft', { siteId }), 'publish_site_draft');
  const operationId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(queued)?.[0];
  assert.ok(operationId, `publish_site_draft did not return an operation id: ${queued}`);
  let status = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    status = check(await client.callTool('get_publish_status', { operationId }), 'get_publish_status');
    if (/succeeded|failed/i.test(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.match(status, /succeeded/i, `Publish did not succeed: ${status}`);
  console.log(`[mcp-live] Published ${files.length} Markdown files as ${siteId}: ${status}`);
});

/** A fetch that never answers until aborted, like a host that drops packets. */
const blackhole: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
});

test('down MCP servers time out quickly in parallel and never block healthy servers', async (t) => {
  resetMcpServerHealth();
  const fake = await startFakeMcpServer();
  t.after(() => fake.close());
  const started = Date.now();
  const toolbox = new McpToolbox([
    new McpHttpClient({ name: 'down-a', url: 'http://10.255.255.1/mcp' }, blackhole, 120_000, 300),
    new McpHttpClient({ name: 'down-b', url: 'http://10.255.255.2/mcp' }, blackhole, 120_000, 300),
    new McpHttpClient({ name: 'publisher', url: fake.url })
  ]);
  t.mock.method(console, 'error', () => {});
  const loaded = await toolbox.load();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 900, `load took ${elapsed} ms; down servers should time out in parallel`);
  assert.ok(loaded.definitions.some((definition) => definition.function.name === 'mcp_publisher_upsert_site_files'));
  assert.equal(loaded.errors.length, 2);
  assert.match(loaded.errors[0]!, /^MCP server down-a did not respond within 300 ms at 10\.255\.255\.1\./);
  assert.match(loaded.errors[0]!, /Continuing without its tools/);
});

test('a recently failed MCP server is skipped on the next run until it recovers or is tested', async (t) => {
  resetMcpServerHealth();
  t.mock.method(console, 'error', () => {});
  let attempts = 0;
  const refused: typeof fetch = async () => {
    attempts += 1;
    throw new TypeError('fetch failed: ECONNREFUSED');
  };
  const server = { name: 'flaky', url: 'http://127.0.0.1:9/mcp' };
  const first = await new McpToolbox([new McpHttpClient(server, refused)]).load();
  assert.match(first.errors[0]!, /could not be reached/);
  assert.equal(attempts, 1);

  const second = await new McpToolbox([new McpHttpClient(server, refused)]).load();
  assert.equal(attempts, 1, 'the second run should not wait on the known-down server');
  assert.match(second.errors[0]!, /Skipped; AAA retries it in about \d+ s/);

  markMcpServerHealthy(server);
  await new McpToolbox([new McpHttpClient(server, refused)]).load();
  assert.equal(attempts, 2);

  resetMcpServerHealth();
  const shortMemory = new McpToolbox([new McpHttpClient(server, refused)], 1);
  await shortMemory.load();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await new McpToolbox([new McpHttpClient(server, refused)], 1).load();
  assert.equal(attempts, 4, 'retries once the remembered failure expires');
});

test('agent runs continue with a warning when an MCP server is down or a tool call fails', async (t) => {
  resetMcpServerHealth();
  t.mock.method(console, 'error', () => {});
  let callAttempts = 0;
  const failingCalls: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest;
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
    if (body.method === 'tools/list') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'fetch_json', inputSchema: { type: 'object', properties: {} } }] } });
    }
    callAttempts += 1;
    throw new TypeError('socket hang up');
  };
  const seenTools: string[][] = [];
  const toolResults: string[] = [];
  let round = 0;
  const client: ModelChatClient = {
    async *stream(_connection, messages, _signal, tools) {
      round += 1;
      seenTools.push((tools ?? []).map((tool) => tool.function.name));
      if (round === 1) {
        yield { type: 'tool_calls', calls: [{ id: 'c1', type: 'function', function: { name: 'mcp_evidence_fetch_json', arguments: '{}' } }] };
        yield { type: 'completed' };
        return;
      }
      toolResults.push(messages.at(-1)?.content ?? '');
      yield { type: 'assistant_text', text: 'Continued without MCP.' };
      yield { type: 'completed' };
    }
  };
  const events: string[] = [];
  const result = await new AaaAgentLoop(client, new ProjectFileService(process.cwd()), {
    tools: [],
    mcp: new McpToolbox([
      new McpHttpClient({ name: 'down', url: 'http://10.255.255.1/mcp' }, blackhole, 120_000, 200),
      new McpHttpClient({ name: 'evidence', url: 'http://evidence.test/mcp' }, failingCalls)
    ])
  }).run(
    { definition: {}, endpoint: '', deployment: '', apiVersion: '' } as ResolvedModelConnection,
    [{ role: 'user', content: 'Fetch the evidence JSON.' }],
    new AbortController().signal,
    { onToolEvent: (event) => { events.push(`${event.type}:${event.label}`); } }
  );

  assert.equal(result.content, 'Continued without MCP.');
  assert.deepEqual(seenTools[0], ['mcp_evidence_fetch_json']);
  assert.equal(callAttempts, 1);
  assert.match(toolResults[0]!, /failed: MCP server evidence could not be reached[\s\S]*Continue without it/);
  assert.deepEqual(events, ['mcp:MCP server unavailable', 'mcp:MCP tool failed: mcp_evidence_fetch_json']);
});
