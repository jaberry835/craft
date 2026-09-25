import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createAaaApp } from '../app.js';
import { createEntraTokenVerifier, loadAppAuthConfig, type AppAuthConfig } from '../appAuth.js';
import type { ModelChatClient } from '../modelTypes.js';
import { ProjectRegistry } from '../projectRegistry.js';
import { ModelConnectionConfig } from '../services/modelConnectionConfig.js';
import type { ChatSession } from '../../src/types/api.js';

const tenant = '11111111-2222-3333-4444-555555555555';
const clientId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const root = path.join(process.cwd(), '.test-data', 'app-auth');

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A local stand-in for the Entra discovery keys endpoint plus a token factory. */
async function startIdentityProvider() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const app = express();
  app.get(`/${tenant}/discovery/v2.0/keys`, (_request, response) => response.json({ keys: [jwk] }));
  const server = createServer(app);
  const authorityHost = await listen(server);
  const sign = (claims: Record<string, unknown>, options: { issuer?: string; audience?: string; expiresIn?: string } = {}) =>
    new SignJWT({ oid: 'user-1', tid: tenant, name: 'Ada Analyst', preferred_username: 'ada@agency.gov', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.issuer ?? `${authorityHost}/${tenant}/v2.0`)
      .setAudience(options.audience ?? `api://${clientId}`)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '1h')
      .sign(privateKey);
  const config = (overrides: Partial<AppAuthConfig> = {}): AppAuthConfig => ({
    ...loadAppAuthConfig({ AAA_AUTH_MODE: 'none', AAA_ENTRA_TENANT_ID: tenant, AAA_ENTRA_CLIENT_ID: clientId }),
    mode: 'entra',
    authorityHost,
    issuers: [`${authorityHost}/${tenant}/v2.0`, `https://sts.windows.net/${tenant}/`],
    ...overrides
  });
  return { authorityHost, sign, config, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('sign-in is off by default and entra mode requires tenant and client ids', () => {
  assert.equal(loadAppAuthConfig({}).mode, 'none');
  assert.throws(() => loadAppAuthConfig({ AAA_AUTH_MODE: 'saml' }), /AAA_AUTH_MODE must be "none" or "entra"/);
  assert.throws(() => loadAppAuthConfig({ AAA_AUTH_MODE: 'entra' }), /requires AAA_ENTRA_TENANT_ID and AAA_ENTRA_CLIENT_ID/);
  assert.throws(
    () => loadAppAuthConfig({ AAA_AUTH_MODE: 'entra', AAA_ENTRA_TENANT_ID: tenant, AAA_ENTRA_CLIENT_ID: clientId, AAA_ENTRA_AUTHORITY_HOST: 'http://login' }),
    /must be an HTTPS URL/
  );
  const config = loadAppAuthConfig({
    AAA_AUTH_MODE: 'entra',
    AAA_ENTRA_TENANT_ID: tenant,
    AAA_ENTRA_CLIENT_ID: clientId,
    AAA_ENTRA_AUTHORITY_HOST: 'https://login.microsoftonline.us/',
    AAA_ENTRA_ALLOWED_ROLES: 'AAA.User, AAA.Admin'
  });
  assert.equal(config.authorityHost, 'https://login.microsoftonline.us');
  assert.deepEqual(config.audiences, [`api://${clientId}`, clientId]);
  assert.deepEqual(config.scopes, [`api://${clientId}/access_as_user`]);
  assert.deepEqual(config.issuers, [`https://login.microsoftonline.us/${tenant}/v2.0`, `https://sts.windows.net/${tenant}/`]);
  assert.deepEqual(config.allowedRoles, ['AAA.User', 'AAA.Admin']);
});

test('the Entra verifier accepts valid v1 and v2 tokens and rejects wrong audience or expired tokens', async (t) => {
  const idp = await startIdentityProvider();
  t.after(idp.close);
  const verify = createEntraTokenVerifier(idp.config());
  const { identity, expiresAt } = await verify(await idp.sign({ roles: ['AAA.User'] }));
  assert.deepEqual(identity, { userId: 'user-1', displayName: 'Ada Analyst', username: 'ada@agency.gov', tenantId: tenant, roles: ['AAA.User'] });
  assert.ok(expiresAt > Date.now());
  assert.equal((await verify(await idp.sign({}, { issuer: `https://sts.windows.net/${tenant}/`, audience: clientId }))).identity.userId, 'user-1');
  t.mock.method(console, 'log', () => {});
  await assert.rejects(async () => verify(await idp.sign({}, { audience: 'api://someone-else' })), /invalid or expired/);
  await assert.rejects(async () => verify(await idp.sign({}, { expiresIn: '-1m' })), /invalid or expired/);
  await assert.rejects(async () => verify('not-a-jwt'), /invalid or expired/);
});

test('entra mode protects the API, issues a GET-only cookie, enforces roles, and records who ran the agent', async (t) => {
  const idp = await startIdentityProvider();
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'project'), { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Auth Package', rootPath: path.join(root, 'project') }]
  }));
  await writeFile(path.join(root, 'agent-connections.json'), JSON.stringify([{
    id: 'model', name: 'Test model', type: 'azure-openai', authMode: 'api-key',
    endpointEnv: 'E', apiKeyEnv: 'K', deploymentEnv: 'D', defaultApiVersion: '2025-01-01-preview'
  }]));
  const modelClient: ModelChatClient = {
    async *stream() {
      yield { type: 'assistant_text', text: 'Hello.' };
      yield { type: 'completed' };
    }
  };
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(root, 'projects.json')),
    dataRoot: path.join(root, 'data'),
    modelConfig: await ModelConnectionConfig.load(path.join(root, 'agent-connections.json'), { E: 'https://x.openai.azure.com', K: 'k', D: 'd' }),
    modelClient,
    auth: { config: idp.config({ allowedRoles: ['AAA.User'] }) }
  }));
  const base = await listen(server);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await idp.close();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'log', () => {});
  const allowed = await idp.sign({ roles: ['AAA.User'] });
  const bearer = { Authorization: `Bearer ${allowed}` };

  const config = await (await fetch(`${base}/api/auth/config`)).json();
  assert.deepEqual(config, { mode: 'entra', clientId, authority: `${idp.authorityHost}/${tenant}`, scopes: [`api://${clientId}/access_as_user`] });

  const anonymous = await fetch(`${base}/api/projects`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { code: string }).code, 'auth_required');
  assert.equal((await fetch(`${base}/api/projects`, { headers: bearer })).status, 200);

  const noRole = await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${await idp.sign({ roles: [] })}` } });
  assert.equal(noRole.status, 403);
  assert.match((await noRole.json() as { error: string }).error, /needs one of these AAA roles: AAA\.User/);

  const session = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: bearer });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^aaa_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=\d+$/);
  const sessionCookie = cookie.split(';')[0]!;
  assert.equal((await fetch(`${base}/api/projects`, { headers: { Cookie: sessionCookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/projects/project/sessions`, {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: '{}'
  })).status, 401, 'the cookie alone must not authorize state-changing requests');

  const me = await (await fetch(`${base}/api/auth/me`, { headers: bearer })).json() as { identity: { displayName: string } };
  assert.equal(me.identity.displayName, 'Ada Analyst');

  const created = await (await fetch(`${base}/api/projects/project/sessions`, {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}'
  })).json() as { id: string };
  await (await fetch(`${base}/api/projects/project/sessions/${created.id}/chat/stream`, {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hi' })
  })).text();
  const stored = await (await fetch(`${base}/api/projects/project/sessions/${created.id}`, { headers: bearer })).json() as ChatSession;
  assert.deepEqual(stored.runs[0]?.requestedBy, { userId: 'user-1', displayName: 'Ada Analyst' });

  const signOut = await fetch(`${base}/api/auth/session`, { method: 'DELETE', headers: { ...bearer, Cookie: sessionCookie } });
  assert.match(signOut.headers.get('set-cookie') ?? '', /aaa_session=; .*Max-Age=0/);
  assert.equal((await fetch(`${base}/api/projects`, { headers: { Cookie: sessionCookie } })).status, 401);
});

test('local mode needs no sign-in and reports mode none', async (t) => {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'project'), { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Local', rootPath: path.join(root, 'project') }]
  }));
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(root, 'projects.json')),
    dataRoot: path.join(root, 'data')
  }));
  const base = await listen(server);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(await (await fetch(`${base}/api/auth/config`)).json(), { mode: 'none' });
  assert.equal((await fetch(`${base}/api/projects`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/auth/me`)).json(), { mode: 'none' });
});
