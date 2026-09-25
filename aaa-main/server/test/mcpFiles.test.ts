import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { AaaAgentLoop } from '../aaaAgentLoop.js';
import type { ModelChatClient, ModelToolCall, ResolvedModelConnection } from '../modelTypes.js';
import { ProjectFileService } from '../projectFileService.js';
import { httpDownload, McpHttpClient, McpToolbox, resetMcpServerHealth } from '../services/mcpHttpClient.js';

const root = path.join(process.cwd(), '.test-data', 'mcp-files');
const connection = { definition: {}, endpoint: '', deployment: '', apiVersion: '' } as ResolvedModelConnection;
const pdfBytes = Buffer.from('%PDF-1.4 fake report');
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function startEvidenceServer() {
  const app = express();
  app.use(express.json());
  const authorizations: Array<string | undefined> = [];
  app.post('/mcp', (request, response) => {
    const body = request.body as { id?: number; method: string; params?: { uri?: string } };
    if (body.id === undefined) {
      response.status(202).end();
      return;
    }
    const reply = (result: unknown) => response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18' });
    if (body.method === 'tools/list') {
      return reply({ tools: [{ name: 'export_report', inputSchema: { type: 'object', properties: {} } }] });
    }
    if (body.method === 'tools/call') {
      return reply({
        content: [
          { type: 'text', text: 'Report exported.' },
          { type: 'resource', resource: { uri: 'evidence://reports/42.pdf', mimeType: 'application/pdf', blob: pdfBytes.toString('base64') } },
          { type: 'image', mimeType: 'image/png', data: pngBytes.toString('base64') },
          { type: 'resource_link', uri: 'evidence://reports/42.json', name: 'Report 42 data', mimeType: 'application/json' }
        ]
      });
    }
    if (body.method === 'resources/read' && body.params?.uri === 'evidence://reports/42.json') {
      return reply({ contents: [{ uri: 'evidence://reports/42.json', mimeType: 'application/json', text: '{"control":"AC-2","status":"implemented"}' }] });
    }
    return response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  });
  app.get('/files/config.json', (request, response) => {
    authorizations.push(request.header('authorization'));
    if (request.header('authorization') !== 'Bearer evidence-token') {
      response.status(401).end();
      return;
    }
    response.type('application/json').send('{"boundary":{"name":"Falcon","zones":2}}');
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, authorizations, close: () => new Promise((resolve) => server.close(resolve)) };
}

function scripted(rounds: ModelToolCall[][], toolOutputs: string[]): ModelChatClient {
  let round = 0;
  return {
    async *stream(_connection, messages) {
      if (round > 0) toolOutputs.push(messages.filter((message) => message.role === 'tool').at(-1)?.content ?? '');
      const calls = rounds[round];
      round += 1;
      if (calls) {
        yield { type: 'tool_calls', calls };
      } else {
        yield { type: 'assistant_text', text: 'Done.' };
      }
      yield { type: 'completed' };
    }
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): ModelToolCall =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('MCP file results are saved, resource links and same-origin URLs download with the server auth', async (t) => {
  resetMcpServerHealth();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const evidence = await startEvidenceServer();
  t.after(async () => {
    await evidence.close();
    await rm(root, { recursive: true, force: true });
  });

  const outputs: string[] = [];
  const client = scripted([
    [call('1', 'mcp_evidence_export_report', {})],
    [call('2', 'download_file', { url: 'evidence://reports/42.json', server: 'evidence' })],
    [call('3', 'download_file', { url: `${evidence.base}/files/config.json` })],
    [call('4', 'download_file', { url: 'https://elsewhere.test/secrets.json' })]
  ], outputs);
  const labels: string[] = [];
  const result = await new AaaAgentLoop(client, new ProjectFileService(root), {
    mcp: new McpToolbox([new McpHttpClient({
      name: 'evidence',
      url: `${evidence.base}/mcp`,
      auth: { type: 'bearer', token: 'evidence-token' }
    })])
  }).run(connection, [{ role: 'user', content: 'Export report 42.' }], new AbortController().signal, {
    onToolEvent: (event) => { labels.push(`${event.label}: ${event.detail}`); }
  });

  assert.equal(result.content, 'Done.');
  assert.deepEqual(await readFile(path.join(root, 'downloads', 'evidence', '42.pdf')), pdfBytes);
  assert.deepEqual(await readFile(path.join(root, 'downloads', 'evidence', 'export_report-result-2.png')), pngBytes);
  assert.match(outputs[0]!, /Report exported\.[\s\S]*Saved downloads\/evidence\/42\.pdf \(20 B\)[\s\S]*Resource link: evidence:\/\/reports\/42\.json \(Report 42 data\)[\s\S]*download_file/);

  assert.equal(
    await readFile(path.join(root, 'downloads', 'evidence', '42.json'), 'utf8'),
    '{\n  "control": "AC-2",\n  "status": "implemented"\n}\n'
  );
  assert.match(outputs[1]!, /Saved downloads\/evidence\/42\.json[\s\S]*Preview:[\s\S]*"control": "AC-2"/);

  assert.deepEqual(evidence.authorizations, ['Bearer evidence-token']);
  assert.match(await readFile(path.join(root, 'downloads', 'evidence', 'config.json'), 'utf8'), /"name": "Falcon"/);

  assert.match(outputs[3]!, /download_file only fetches from enabled MCP server hosts \(127\.0\.0\.1:\d+\) or hosts listed in AAA_DOWNLOAD_ALLOWED_HOSTS/);
  assert.deepEqual(result.changedFiles.sort(), [
    'downloads/evidence/42.json',
    'downloads/evidence/42.pdf',
    'downloads/evidence/config.json',
    'downloads/evidence/export_report-result-2.png'
  ]);
  assert.ok(labels.some((label) => /Called MCP tool: evidence · export_report · 2 files saved · 1 resource link/.test(label)));
});

test('allow-listed hosts download without MCP credentials and never overwrite existing files', async (t) => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const httpFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return new Response('control,status\nAC-2,implemented\n', { headers: { 'Content-Type': 'text/csv' } });
  }) as typeof fetch;
  const outputs: string[] = [];
  const client = scripted([
    [call('1', 'download_file', { url: 'https://files.example.gov/exports/controls.csv', path: 'evidence/' })],
    [call('2', 'download_file', { url: 'https://files.example.gov/exports/controls.csv', path: 'evidence/' })],
    [call('3', 'download_file', { url: 'https://example.gov.attacker.test/x.csv' })]
  ], outputs);
  await new AaaAgentLoop(client, new ProjectFileService(root), {
    downloadAllowedHosts: ['*.example.gov'],
    httpFetch
  }).run(connection, [{ role: 'user', content: 'Get the export.' }], new AbortController().signal);

  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.authorization === null));
  assert.match(outputs[0]!, /Saved evidence\/controls\.csv/);
  assert.match(outputs[1]!, /Saved evidence\/controls-2\.csv/);
  assert.match(await readFile(path.join(root, 'evidence', 'controls-2.csv'), 'utf8'), /AC-2,implemented/);
  assert.match(outputs[2]!, /only fetches from enabled MCP server hosts \(none connected\)/);
});

test('downloads enforce the size limit and report unsupported file types', async (t) => {
  const tooLarge = (async () => new Response('small body', {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(20 * 1024 * 1024) }
  })) as typeof fetch;
  await assert.rejects(
    () => httpDownload(new URL('https://files.example.gov/big.bin'), tooLarge, {}, 5_000),
    /is 20 MB; the limit is 10 MB/
  );

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputs: string[] = [];
  const zip = (async () => new Response('PK', { headers: { 'Content-Type': 'application/zip' } })) as typeof fetch;
  await new AaaAgentLoop(scripted([[call('1', 'download_file', { url: 'https://files.example.gov/bundle.zip' })]], outputs),
    new ProjectFileService(root), { downloadAllowedHosts: ['files.example.gov'], httpFetch: zip })
    .run(connection, [{ role: 'user', content: 'Get the bundle.' }], new AbortController().signal);
  assert.match(outputs[0]!, /Files of type application\/zip \(bundle\.zip\) cannot be saved in the project/);
});
