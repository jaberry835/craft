import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { maskMcpAuth, mergeMcpAuth, resolveMcpAuth, validateMcpAuth } from '../mcpAuth.js';
import { ProjectCustomizationService } from '../projectCustomizationService.js';
import { ProjectWorkflowService } from '../projectWorkflowService.js';
import { McpHttpClient, resetMcpServerHealth, setMcpCredentialFactory } from '../services/mcpHttpClient.js';
import { maskedSecretValue } from '../../src/types/api.js';

interface RpcBody { id?: number; method: string }

/** Minimal MCP endpoint that records Authorization headers and can reject stale tokens. */
function mcpFetch(options: {
  seen: Array<{ url: string; headers: Record<string, string>; body: string }>;
  token?: { endpoint: string; issue: () => string };
  rejectToken?: (authorization: string | undefined) => boolean;
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    options.seen.push({ url, headers, body: String(init?.body ?? '') });
    if (options.token && url === options.token.endpoint) {
      return Response.json({ access_token: options.token.issue(), expires_in: 3600, token_type: 'Bearer' });
    }
    if (options.rejectToken?.(headers.authorization)) return new Response('unauthorized', { status: 401 });
    const body = JSON.parse(String(init?.body)) as RpcBody;
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ping' }] } });
  }) as typeof fetch;
}

test('auth validation requires the fields for each method and normalizes none', () => {
  assert.equal(validateMcpAuth(undefined), undefined);
  assert.equal(validateMcpAuth({ type: 'none', token: 'ignored' }), undefined);
  assert.deepEqual(validateMcpAuth({ type: 'bearer', token: ' ${env:T} ', headerName: 'dropped' }), { type: 'bearer', token: '${env:T}' });
  assert.throws(() => validateMcpAuth({ type: 'bearer' }), /requires: token/);
  assert.throws(() => validateMcpAuth({ type: 'header', headerName: 'bad header', value: 'x' }), /header name/);
  assert.throws(() => validateMcpAuth({ type: 'oauth', tokenUrl: 'https://idp/token', clientId: 'c' }), /requires: clientSecret/);
  assert.throws(() => validateMcpAuth({ type: 'oauth', tokenUrl: 'ftp://idp', clientId: 'c', clientSecret: 's' }), /tokenUrl must be/);
  assert.throws(() => validateMcpAuth({ type: 'entra' }), /requires: scope/);
  assert.throws(() => validateMcpAuth({ type: 'entra', scope: 'api://x/.default', authorityHost: 'http://login' }), /authorityHost must be a valid HTTPS URL/);
  assert.throws(() => validateMcpAuth({ type: 'kerberos' }), /must be one of/);
  assert.deepEqual(validateMcpAuth({ type: 'entra', scope: 'api://x/.default', authorityHost: 'https://login.microsoftonline.us' }), {
    type: 'entra',
    scope: 'api://x/.default',
    authorityHost: 'https://login.microsoftonline.us'
  });
});

test('literal secrets are masked for the editor and kept when saved back unchanged', () => {
  const stored = { type: 'oauth' as const, tokenUrl: 'https://idp/token', clientId: 'aaa', clientSecret: 'literal-secret' };
  const masked = maskMcpAuth(stored)!;
  assert.equal(masked.clientSecret, maskedSecretValue);
  assert.equal(maskMcpAuth({ type: 'bearer', token: '${env:TOKEN}' })!.token, '${env:TOKEN}');
  assert.equal(mergeMcpAuth(stored, masked)!.clientSecret, 'literal-secret');
  assert.throws(() => mergeMcpAuth(undefined, { type: 'bearer', token: maskedSecretValue }), /Enter a value for token/);
});

test('environment references resolve and missing variables are reported by name', () => {
  assert.deepEqual(resolveMcpAuth({ type: 'bearer', token: '${env:MCP_TOKEN}' }, { MCP_TOKEN: 'abc' }), {
    auth: { type: 'bearer', token: 'abc' },
    missing: []
  });
  assert.deepEqual(resolveMcpAuth({ type: 'header', headerName: 'x-api-key', value: '${env:NOPE}' }, {}).missing, ['NOPE']);
});

test('bearer and header auth are sent on every MCP request and override static headers', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  await new McpHttpClient(
    { name: 'a', url: 'https://mcp.test/mcp', headers: { Authorization: 'stale', 'x-trace': '1' }, auth: { type: 'bearer', token: 'tok-1' } },
    mcpFetch({ seen })
  ).listTools();
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((request) => request.headers.authorization === 'Bearer tok-1' && request.headers['x-trace'] === '1'));

  seen.length = 0;
  await new McpHttpClient(
    { name: 'b', url: 'https://mcp.test/mcp', auth: { type: 'header', headerName: 'x-api-key', value: 'key-1' } },
    mcpFetch({ seen })
  ).listTools();
  assert.ok(seen.every((request) => request.headers['x-api-key'] === 'key-1'));
});

test('OAuth client-credentials tokens are cached, and a 401 refreshes the token once', async () => {
  setMcpCredentialFactory();
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let issued = 0;
  let revoked = '';
  const fetchImpl = mcpFetch({
    seen,
    token: { endpoint: 'https://idp.test/token', issue: () => `oauth-${++issued}` },
    rejectToken: (authorization) => authorization === `Bearer ${revoked}`
  });
  const server = {
    name: 'oauth',
    url: 'https://mcp.test/mcp',
    auth: { type: 'oauth' as const, tokenUrl: 'https://idp.test/token', clientId: 'aaa', clientSecret: 's3cret', scope: 'mcp.read' }
  };
  await new McpHttpClient(server, fetchImpl).listTools();
  await new McpHttpClient(server, fetchImpl).listTools();
  assert.equal(issued, 1, 'the second client reuses the cached token');
  const tokenRequest = seen.find((request) => request.url === 'https://idp.test/token')!;
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenRequest.body)), {
    grant_type: 'client_credentials',
    client_id: 'aaa',
    client_secret: 's3cret',
    scope: 'mcp.read'
  });

  revoked = 'oauth-1';
  await new McpHttpClient(server, fetchImpl).listTools();
  assert.equal(issued, 2);
  assert.equal(seen.at(-1)!.headers.authorization, 'Bearer oauth-2');

  const failing = (async () => Response.json({ error: 'invalid_client', error_description: 'Client authentication failed.' }, { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => new McpHttpClient({ ...server, auth: { ...server.auth, clientId: 'other' } }, failing).listTools(),
    /could not obtain an OAuth token \(HTTP 401, invalid_client: Client authentication failed\.\)/
  );
});

test('Entra auth requests a token for the configured scope and identity', async (t) => {
  t.after(() => setMcpCredentialFactory());
  const requested: Array<{ scope: string | string[]; identity?: string; authority?: string }> = [];
  setMcpCredentialFactory((auth) => ({
    async getToken(scope) {
      requested.push({ scope, identity: auth.managedIdentityClientId, authority: auth.authorityHost });
      return { token: 'entra-token', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }));
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  await new McpHttpClient({
    name: 'entra',
    url: 'https://mcp.test/mcp',
    auth: { type: 'entra', scope: 'api://mcp/.default', managedIdentityClientId: 'mi-1', authorityHost: 'https://login.microsoftonline.us' }
  }, mcpFetch({ seen })).listTools();
  assert.deepEqual(requested, [{ scope: 'api://mcp/.default', identity: 'mi-1', authority: 'https://login.microsoftonline.us' }]);
  assert.ok(seen.every((request) => request.headers.authorization === 'Bearer entra-token'));

  setMcpCredentialFactory(() => ({ async getToken() { throw new Error('ManagedIdentityCredential: no identity endpoint\nstack'); } }));
  await assert.rejects(
    () => new McpHttpClient({ name: 'entra', url: 'https://mcp.test/mcp', auth: { type: 'entra', scope: 'api://mcp/.default' } }, mcpFetch({ seen })).listTools(),
    /could not obtain a Microsoft Entra token for api:\/\/mcp\/\.default: ManagedIdentityCredential: no identity endpoint$/
  );
});

test('the MCP editor stores auth, masks secrets, preserves headers, and the workflow resolves it', async (t) => {
  resetMcpServerHealth();
  const root = path.join(process.cwd(), '.test-data', 'mcp-auth');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.vscode', 'mcp.json'), JSON.stringify({
    servers: {
      evidence: { type: 'http', url: 'https://mcp.test/mcp', headers: { 'x-tenant': 'demo' }, auth: { type: 'bearer', token: 'literal-token' } }
    }
  }), 'utf8');
  const customizations = new ProjectCustomizationService('demo', root);

  const editor = await customizations.getEditor('mcp-server:evidence');
  assert.deepEqual(editor.auth, { type: 'bearer', token: maskedSecretValue });
  assert.doesNotMatch(JSON.stringify(editor), /literal-token/);
  assert.match((await customizations.list()).items.find((item) => item.id === 'mcp-server:evidence')!.detail ?? '', /Bearer token authentication/);

  await customizations.update('mcp-server:evidence', {
    kind: 'mcp-server',
    name: 'Evidence',
    description: 'Evidence server',
    enabled: true,
    transport: 'http',
    url: 'https://mcp.test/v2/mcp',
    auth: editor.auth
  });
  let stored = JSON.parse(await readFile(path.join(root, '.vscode', 'mcp.json'), 'utf8')) as {
    servers: Record<string, { url: string; headers?: Record<string, string>; auth?: Record<string, string> }>;
  };
  assert.equal(stored.servers.evidence!.url, 'https://mcp.test/v2/mcp');
  assert.deepEqual(stored.servers.evidence!.headers, { 'x-tenant': 'demo' });
  assert.deepEqual(stored.servers.evidence!.auth, { type: 'bearer', token: 'literal-token' });

  await customizations.update('mcp-server:evidence', {
    kind: 'mcp-server',
    name: 'Evidence',
    description: 'Evidence server',
    enabled: true,
    transport: 'http',
    url: 'https://mcp.test/v2/mcp',
    auth: { type: 'header', headerName: 'x-api-key', value: '${env:EVIDENCE_KEY}' }
  });
  stored = JSON.parse(await readFile(path.join(root, '.vscode', 'mcp.json'), 'utf8')) as typeof stored;
  assert.deepEqual(stored.servers.evidence!.auth, { type: 'header', headerName: 'x-api-key', value: '${env:EVIDENCE_KEY}' });

  const missing = await new ProjectWorkflowService('demo', root, {}).load();
  assert.equal(missing.mcpServers[0]!.available, false);
  assert.match(missing.mcpServers[0]!.reason ?? '', /environment variable EVIDENCE_KEY/);

  const resolved = await new ProjectWorkflowService('demo', root, { EVIDENCE_KEY: 'k-123' }).load();
  assert.equal(resolved.mcpServers[0]!.available, true);
  assert.deepEqual(resolved.mcpServers[0]!.auth, { type: 'header', headerName: 'x-api-key', value: 'k-123' });

  await customizations.update('mcp-server:evidence', {
    kind: 'mcp-server',
    name: 'Evidence',
    description: 'Evidence server',
    enabled: true,
    transport: 'http',
    url: 'https://mcp.test/v2/mcp',
    auth: { type: 'none' }
  });
  stored = JSON.parse(await readFile(path.join(root, '.vscode', 'mcp.json'), 'utf8')) as typeof stored;
  assert.equal(stored.servers.evidence!.auth, undefined);
  assert.deepEqual(stored.servers.evidence!.headers, { 'x-tenant': 'demo' });
});
