import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type { AuthIdentity } from '../../src/types/api.js';
import { createAaaApp } from '../app.js';
import type { AppAuthConfig } from '../appAuth.js';
import { ProjectAccessService } from '../projectAccessService.js';
import { ProjectRegistry } from '../projectRegistry.js';

const root = path.join(process.cwd(), '.test-data', 'project-access');
const statePath = path.join(root, 'project-access.json');
const alice: AuthIdentity = { userId: 'alice', displayName: 'Alice', roles: ['AAA.User'] };
const bob: AuthIdentity = { userId: 'bob', displayName: 'Bob', roles: ['AAA.User'] };
const admin: AuthIdentity = { userId: 'admin', displayName: 'Admin', roles: ['AAA.ProjectAdmin'] };

test('Entra project ACLs filter users and persist outside project content', async (t) => {
  await rm(root, { recursive: true, force: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const access = new ProjectAccessService('entra', statePath, ['AAA.ProjectAdmin']);

  assert.equal(access.canAccess('legacy', bob), true);
  assert.throws(() => access.get('legacy', bob), /Only a project administrator/);
  assert.equal(access.get('legacy', admin).unrestricted, true);
  await access.assignOwner('restricted', alice);
  assert.equal(access.canAccess('restricted', alice), true);
  assert.equal(access.canAccess('restricted', bob), false);
  assert.equal(access.canAccess('restricted', admin), true);
  assert.throws(() => access.get('restricted', bob), /Only the project owner/);

  const updated = await access.update('restricted', alice, {
    userIds: ['bob'],
    roles: ['Assessors']
  });
  assert.deepEqual(updated.userIds, ['alice', 'bob']);
  assert.equal(access.canAccess('restricted', bob), true);

  const restored = new ProjectAccessService('entra', statePath, ['AAA.ProjectAdmin']);
  assert.equal(restored.canAccess('restricted', bob), true);
  assert.equal(restored.canAccess('restricted', { ...bob, userId: 'carol', roles: ['Assessors'] }), true);
});

test('local mode remains unrestricted', async (t) => {
  await rm(root, { recursive: true, force: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const access = new ProjectAccessService('none', statePath);
  assert.equal(access.canAccess('any-project'), true);
  assert.equal(access.get('any-project').unrestricted, true);
});

test('project listings and project-scoped routes enforce Entra ACLs', async (t) => {
  await rm(root, { recursive: true, force: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const legacyProject = path.join(root, 'legacy-project');
  const client = path.join(root, 'client');
  await Promise.all([
    mkdir(projectA, { recursive: true }),
    mkdir(projectB, { recursive: true }),
    mkdir(legacyProject, { recursive: true }),
    mkdir(client, { recursive: true })
  ]);
  await writeFile(path.join(client, 'index.html'), '<title>test</title>');
  const configPath = path.join(root, 'projects.json');
  await writeFile(configPath, JSON.stringify({
    activeProjectId: 'project-a',
    projects: [
      { id: 'project-a', name: 'Project A', rootPath: projectA },
      { id: 'project-b', name: 'Project B', rootPath: projectB },
      { id: 'legacy-project', name: 'Legacy Project', rootPath: legacyProject }
    ]
  }));
  const registry = await ProjectRegistry.load(configPath);
  const access = new ProjectAccessService('entra', statePath, ['AAA.ProjectAdmin']);
  await access.assignOwner('project-a', alice);
  await access.assignOwner('project-b', bob);
  const authConfig: AppAuthConfig = {
    mode: 'entra',
    tenantId: 'tenant',
    clientId: 'client',
    authorityHost: 'https://login.example.test',
    audiences: ['api://client'],
    scopes: ['api://client/access_as_user'],
    issuers: ['https://login.example.test/tenant/v2.0'],
    allowedRoles: []
  };
  const identities: Record<string, AuthIdentity> = { alice, bob, admin };
  const app = createAaaApp({
    registry,
    dataRoot: path.join(root, 'data'),
    clientDistPath: client,
    auth: {
      config: authConfig,
      verifier: async (token) => ({ identity: identities[token]!, expiresAt: Date.now() + 60_000 })
    },
    projectAccess: access
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (url: string, token: string) => fetch(`${base}${url}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const list = await get('/api/projects', 'alice');
  assert.equal(list.status, 200);
  assert.deepEqual(
    (await list.json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id),
    ['project-a', 'legacy-project']
  );
  assert.equal((await get('/api/projects/project-a/tree', 'alice')).status, 200);
  assert.equal((await get('/api/projects/project-b/tree', 'alice')).status, 403);
  assert.equal((await get('/api/projects/project-b/tree', 'admin')).status, 200);
  assert.equal((await get('/api/projects/legacy-project/access', 'bob')).status, 403);
  assert.equal((await get('/api/projects/legacy-project/access', 'admin')).status, 200);
  assert.equal((await fetch(`${base}/api/projects/legacy-project`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer bob` }
  })).status, 403);
});
