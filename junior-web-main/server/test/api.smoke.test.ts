import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { cleanupHarness, createHarness, createToolCall, FakeAzureOpenAiChatClient, startHarnessServer, stopHarnessServer } from './testHarness.js';

function identityHeaders(userId: string, options: { displayName?: string; roles?: string[]; tenantId?: string } = {}) {
  return {
    'Content-Type': 'application/json',
    'x-junior-user-id': userId,
    'x-junior-display-name': options.displayName ?? userId,
    'x-junior-roles': (options.roles ?? ['Junior.User']).join(','),
    ...(options.tenantId ? { 'x-junior-tenant-id': options.tenantId } : {})
  };
}

function bearerHeaders(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
}

test('saved workspace MCP servers expose their available tools', async (t) => {
  const mcpServer = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const rpc = JSON.parse(body) as { id: number; method: string };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: rpc.method === 'tools/list'
          ? {
              tools: [{
                name: 'search_documents',
                description: 'Search indexed workspace documents.',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query']
                }
              }]
            }
          : { protocolVersion: '2024-11-05', capabilities: {} }
      }));
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => mcpServer.close((error) => error ? reject(error) : resolve())));
  const address = mcpServer.address();
  assert.ok(address && typeof address !== 'string');

  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const adminSaveResponse = await fetch(`${baseUrl}/api/mcp-servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Admin Document MCP',
      transport: 'http',
      endpoint: `http://127.0.0.1:${address.port}`,
      authMode: 'bearer-token',
      bearerToken: 'admin-only-token'
    })
  });
  assert.equal(adminSaveResponse.status, 200);

  const catalogResponse = await fetch(`${baseUrl}/api/workspaces/current/shared/mcp-catalog`);
  assert.equal(catalogResponse.status, 200);
  const workspaceCatalog = await catalogResponse.json() as Array<{ id: string; name: string; endpoint?: string; bearerToken?: string }>;
  assert.equal(workspaceCatalog.some((entry) => entry.id === 'azure-docs-mcp'), true);
  const adminCatalogEntry = workspaceCatalog.find((entry) => entry.name === 'Admin Document MCP');
  assert.equal(adminCatalogEntry?.endpoint, `http://127.0.0.1:${address.port}`);
  assert.equal(adminCatalogEntry?.bearerToken, undefined);

  const saveResponse = await fetch(`${baseUrl}/api/workspaces/current/settings/mcp-servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Document Search MCP',
      transport: 'http',
      endpoint: `http://127.0.0.1:${address.port}`,
      authMode: 'bearer-token',
      bearerToken: 'workspace-only-token'
    })
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json() as { id: string };

  const listResponse = await fetch(`${baseUrl}/api/workspaces/current/settings/mcp-servers`);
  assert.equal(listResponse.status, 200);
  const persistedServers = await listResponse.json() as Array<{ id: string; endpoint?: string; authMode: string; hasBearerToken: boolean }>;
  const persistedServer = persistedServers.find((server) => server.id === saved.id);
  assert.equal(persistedServer?.endpoint, `http://127.0.0.1:${address.port}`);
  assert.equal(persistedServer?.authMode, 'bearer-token');
  assert.equal(persistedServer?.hasBearerToken, true);

  const discoveryResponse = await fetch(`${baseUrl}/api/workspaces/current/settings/mcp-servers/${encodeURIComponent(saved.id)}/discover-tools`, {
    method: 'POST'
  });
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json() as {
    tools: Array<{ toolName: string; description: string; inputSchema: { required?: string[] } }>;
    warnings: string[];
  };
  assert.deepEqual(discovery.warnings, []);
  assert.equal(discovery.tools[0]?.toolName, 'search_documents');
  assert.equal(discovery.tools[0]?.description, 'Search indexed workspace documents.');
  assert.deepEqual(discovery.tools[0]?.inputSchema.required, ['query']);

  const persistedDiscoveryResponse = await fetch(`${baseUrl}/api/workspaces/current/settings/mcp-servers`);
  assert.equal(persistedDiscoveryResponse.status, 200);
  const serversWithTools = await persistedDiscoveryResponse.json() as Array<{
    id: string;
    discoveredTools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    toolsDiscoveredAt?: string;
  }>;
  const serverWithTools = serversWithTools.find((server) => server.id === saved.id);
  assert.equal(serverWithTools?.discoveredTools[0]?.name, 'search_documents');
  assert.deepEqual(serverWithTools?.discoveredTools[0]?.inputSchema.required, ['query']);
  assert.ok(serverWithTools?.toolsDiscoveredAt);
});

test('workspace file routes can create and read a file', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const createResponse = await fetch(`${baseUrl}/api/workspaces/current/files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'uploads/api-created.md',
      content: '# API Smoke Test\n\nCreated through the files route.\n'
    })
  });

  assert.equal(createResponse.status, 200);
  const createdFile = await createResponse.json() as { path: string; content: string };
  assert.equal(createdFile.path, 'uploads/api-created.md');
  assert.match(createdFile.content, /Created through the files route\./);

  const readResponse = await fetch(`${baseUrl}/api/workspaces/current/files?path=${encodeURIComponent('uploads/api-created.md')}`);
  assert.equal(readResponse.status, 200);
  const readFile = await readResponse.json() as { path: string; content: string };
  assert.equal(readFile.path, 'uploads/api-created.md');
  assert.equal(readFile.content, createdFile.content);
});

test('workspace file routes reject reading a directory as a file', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const createDirectoryResponse = await fetch(`${baseUrl}/api/workspaces/current/directories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'notes' })
  });
  assert.equal(createDirectoryResponse.status, 200);

  const readResponse = await fetch(`${baseUrl}/api/workspaces/current/files?path=${encodeURIComponent('notes')}`);
  assert.equal(readResponse.status, 400);
  const payload = await readResponse.json() as { error: string; code: string };
  assert.equal(payload.code, 'path_is_directory');
  assert.match(payload.error, /directory/i);
});

test('workspace registry lists the default workspace and supports id-scoped file routes', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const workspacesResponse = await fetch(`${baseUrl}/api/workspaces`);
  assert.equal(workspacesResponse.status, 200);
  const workspaces = await workspacesResponse.json() as Array<{ id: string; name: string; ownerId: string; rootPath: string }>;
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]?.id, 'default');
  assert.equal(workspaces[0]?.name, 'Default Workspace');
  assert.equal(workspaces[0]?.ownerId, 'admin');

  const fileResponse = await fetch(`${baseUrl}/api/workspaces/default/files?path=${encodeURIComponent('README.md')}`);
  assert.equal(fileResponse.status, 200);
  const file = await fileResponse.json() as { path: string; content: string };
  assert.equal(file.path, 'README.md');
  assert.match(file.content, /Junior workspace/);
});

test('identity endpoint returns the resolved fallback identity', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const response = await fetch(`${baseUrl}/api/me`);
  assert.equal(response.status, 200);
  const identity = await response.json() as {
    userId: string;
    displayName: string;
    roles: string[];
    authSource: string;
    isAuthenticated: boolean;
  };

  assert.equal(identity.userId, 'admin');
  assert.equal(identity.displayName, 'Admin');
  assert.equal(identity.roles.includes('Junior.Admin'), true);
  assert.equal(identity.authSource, 'local-fallback');
  assert.equal(identity.isAuthenticated, false);
});

test('workspace creation adds a new workspace with isolated seeded files', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Research Topic Intel vs AMD Chips', description: 'Research workspace', templateId: 'research-workspace' })
  });
  assert.equal(createResponse.status, 200);
  const createdWorkspace = await createResponse.json() as { id: string; name: string; ownerId: string; templateId?: string; templateName?: string };
  assert.equal(createdWorkspace.name, 'Research Topic Intel vs AMD Chips');
  assert.equal(createdWorkspace.ownerId, 'admin');
  assert.equal(createdWorkspace.templateId, 'research-workspace');
  assert.equal(createdWorkspace.templateName, 'Research Workspace');

  const workspacesResponse = await fetch(`${baseUrl}/api/workspaces`);
  const workspaces = await workspacesResponse.json() as Array<{ id: string }>;
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces.some((workspace) => workspace.id === createdWorkspace.id), true);

  const fileResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/files?path=${encodeURIComponent('README.md')}`);
  assert.equal(fileResponse.status, 200);
  const file = await fileResponse.json() as { content: string };
  assert.match(file.content, /Junior workspace/);

  const templateFileResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/files?path=${encodeURIComponent('research/brief.md')}`);
  assert.equal(templateFileResponse.status, 200);
  const templateFile = await templateFileResponse.json() as { content: string };
  assert.match(templateFile.content, /Research brief/);

  const templateTreeResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/tree`);
  assert.equal(templateTreeResponse.status, 200);
  const templateTree = await templateTreeResponse.json() as Array<{ path: string }>;
  assert.equal(templateTree.some((node) => node.path === 'sources'), true);
});

test('workspace settings can attach a shared template after creation', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Empty Workspace', description: 'No template yet' })
  });
  assert.equal(createResponse.status, 200);
  const createdWorkspace = await createResponse.json() as { id: string; templateId?: string };
  assert.equal(createdWorkspace.templateId, undefined);

  const updateResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: 'research-workspace' })
  });
  assert.equal(updateResponse.status, 200);
  const updatedWorkspace = await updateResponse.json() as { id: string; templateId?: string; templateName?: string };
  assert.equal(updatedWorkspace.id, createdWorkspace.id);
  assert.equal(updatedWorkspace.templateId, 'research-workspace');
  assert.equal(updatedWorkspace.templateName, 'Research Workspace');

  const workspacesResponse = await fetch(`${baseUrl}/api/workspaces`);
  assert.equal(workspacesResponse.status, 200);
  const workspaces = await workspacesResponse.json() as Array<{ id: string; templateId?: string; templateName?: string }>;
  const persistedWorkspace = workspaces.find((workspace) => workspace.id === createdWorkspace.id);
  assert.equal(persistedWorkspace?.templateId, 'research-workspace');
  assert.equal(persistedWorkspace?.templateName, 'Research Workspace');

  const agentsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/agents`);
  assert.equal(agentsResponse.status, 200);
  const agents = await agentsResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(agents.some((agent) => agent.id === 'research-analyst'), true);
  assert.equal(agents.some((agent) => agent.name === 'Research Analyst'), true);

  const persistedAgentsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/settings/agents`);
  assert.equal(persistedAgentsResponse.status, 200);
  const persistedAgents = await persistedAgentsResponse.json() as Array<{ id: string; name: string }>; 
  assert.equal(persistedAgents.some((agent) => agent.id === 'research-analyst'), true);

  const persistedConnectionsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/settings/agent-connections`);
  assert.equal(persistedConnectionsResponse.status, 200);
  const persistedConnections = await persistedConnectionsResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(persistedConnections.some((connection) => connection.id === 'default-azure-openai'), true);

  const persistedMcpResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/settings/mcp-servers`);
  assert.equal(persistedMcpResponse.status, 200);
  const persistedMcpServers = await persistedMcpResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(persistedMcpServers.some((server) => server.id === 'azure-docs-mcp'), true);

  const sharedAgentTemplatesResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/shared/agent-templates`);
  assert.equal(sharedAgentTemplatesResponse.status, 200);
  const sharedAgentTemplates = await sharedAgentTemplatesResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(sharedAgentTemplates.length, 1);
  assert.equal(sharedAgentTemplates[0]?.id, 'research-analyst');

  const sharedConnectionsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/shared/connections`);
  assert.equal(sharedConnectionsResponse.status, 200);
  const sharedConnections = await sharedConnectionsResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(sharedConnections.length, 1);
  assert.equal(sharedConnections[0]?.id, 'default-azure-openai');

  const sharedMcpCatalogResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/shared/mcp-catalog`);
  assert.equal(sharedMcpCatalogResponse.status, 200);
  const sharedMcpCatalog = await sharedMcpCatalogResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(sharedMcpCatalog.length, 1);
  assert.equal(sharedMcpCatalog[0]?.id, 'azure-docs-mcp');

  const messageResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(createdWorkspace.id)}/agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Summarize the workspace.',
      agentId: 'research-analyst',
      autoApproveChanges: false
    })
  });
  assert.equal(messageResponse.status, 200);
  const message = await messageResponse.json() as { activeAgent: { id: string; name: string } };
  assert.equal(message.activeAgent.id, 'research-analyst');
  assert.equal(message.activeAgent.name, 'Research Analyst');
});

test('workspace settings routes create and delete workspace-local config without mutating admin config', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Config Workspace', description: 'Workspace-local config test' })
  });
  assert.equal(createWorkspaceResponse.status, 200);
  const workspace = await createWorkspaceResponse.json() as { id: string };

  const createConnectionResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/agent-connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Workspace OpenAI',
      type: 'azure-openai',
      authMode: 'entra',
      endpoint: 'https://workspace.example.test',
      deployment: 'workspace-gpt'
    })
  });
  assert.equal(createConnectionResponse.status, 200);
  const workspaceConnection = await createConnectionResponse.json() as { id: string; name: string };

  const createAgentResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Workspace Agent',
      description: 'Local only',
      instructions: 'Use the workspace connector.',
      modelConnectionId: workspaceConnection.id
    })
  });
  assert.equal(createAgentResponse.status, 200);
  const workspaceAgent = await createAgentResponse.json() as { id: string; name: string };

  const workspaceAgentsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/agents`);
  assert.equal(workspaceAgentsResponse.status, 200);
  const workspaceAgents = await workspaceAgentsResponse.json() as Array<{ id: string }>;
  assert.equal(workspaceAgents.some((agent) => agent.id === workspaceAgent.id), true);

  const adminAgentsResponse = await fetch(`${baseUrl}/api/agents`);
  assert.equal(adminAgentsResponse.status, 200);
  const adminAgents = await adminAgentsResponse.json() as Array<{ id: string }>;
  assert.equal(adminAgents.some((agent) => agent.id === workspaceAgent.id), false);

  const deleteAgentResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/agents/${encodeURIComponent(workspaceAgent.id)}`, {
    method: 'DELETE'
  });
  assert.equal(deleteAgentResponse.status, 200);
});

test('trusted header mode filters workspaces by owner and rejects cross-owner access', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness, {
    appOptions: {
      identity: {
        mode: 'trusted-header'
      }
    }
  });
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const unauthenticatedResponse = await fetch(`${baseUrl}/api/workspaces`);
  assert.equal(unauthenticatedResponse.status, 401);

  const aliceCreateResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: identityHeaders('alice', { displayName: 'Alice Example' }),
    body: JSON.stringify({ name: 'Alice Workspace', description: 'Owned by Alice' })
  });
  assert.equal(aliceCreateResponse.status, 200);
  const aliceWorkspace = await aliceCreateResponse.json() as { id: string; ownerId: string };
  assert.equal(aliceWorkspace.ownerId, 'alice');

  const bobCreateResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: identityHeaders('bob', { displayName: 'Bob Example' }),
    body: JSON.stringify({ name: 'Bob Workspace', description: 'Owned by Bob' })
  });
  assert.equal(bobCreateResponse.status, 200);
  const bobWorkspace = await bobCreateResponse.json() as { id: string; ownerId: string };
  assert.equal(bobWorkspace.ownerId, 'bob');

  const aliceListResponse = await fetch(`${baseUrl}/api/workspaces`, {
    headers: identityHeaders('alice', { displayName: 'Alice Example' })
  });
  assert.equal(aliceListResponse.status, 200);
  const aliceWorkspaces = await aliceListResponse.json() as Array<{ id: string; ownerId: string }>;
  assert.equal(aliceWorkspaces.length, 1);
  assert.equal(aliceWorkspaces[0]?.id, aliceWorkspace.id);
  assert.equal(aliceWorkspaces[0]?.ownerId, 'alice');

  const forbiddenResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(bobWorkspace.id)}/files?path=${encodeURIComponent('package/index.md')}`, {
    headers: identityHeaders('alice', { displayName: 'Alice Example' })
  });
  assert.equal(forbiddenResponse.status, 403);
});

test('trusted header mode exposes auth config and rejects callers without a Junior role', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness, {
    appOptions: {
      identity: {
        mode: 'trusted-header'
      }
    }
  });
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const authConfigResponse = await fetch(`${baseUrl}/api/auth/config`);
  assert.equal(authConfigResponse.status, 200);
  const authConfig = await authConfigResponse.json() as {
    identityMode: string;
    authRequired: boolean;
    providerName: string | null;
    signInPath: string | null;
  };
  assert.equal(authConfig.identityMode, 'trusted-header');
  assert.equal(authConfig.authRequired, true);
  assert.equal(authConfig.providerName, 'Microsoft Entra ID');
  assert.equal(authConfig.signInPath, '/.auth/login/aad');

  const unauthorizedRoleResponse = await fetch(`${baseUrl}/api/workspaces`, {
    headers: {
      'Content-Type': 'application/json',
      'x-junior-user-id': 'guest-user',
      'x-junior-display-name': 'Guest User',
      'x-junior-roles': 'Guest'
    }
  });
  assert.equal(unauthorizedRoleResponse.status, 403);

  const adminRoleResponse = await fetch(`${baseUrl}/api/workspaces`, {
    headers: identityHeaders('admin-user', { displayName: 'Admin User', roles: ['Junior.Admin'] })
  });
  assert.equal(adminRoleResponse.status, 200);
});

test('entra msal mode accepts bearer token identities and publishes client auth config', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness, {
    appOptions: {
      identity: {
        mode: 'entra-msal',
        entra: {
          tenantId: '11111111-1111-1111-1111-111111111111',
          clientId: '22222222-2222-2222-2222-222222222222',
          audience: 'api://junior-workbench',
          authority: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111',
          scopes: ['api://junior-workbench/Junior.Workbench.Access']
        },
        tokenVerifier: async (token) => ({
          userId: token === 'admin-token' ? 'admin-user' : 'user-token',
          displayName: token === 'admin-token' ? 'Admin User' : 'Standard User',
          tenantId: '11111111-1111-1111-1111-111111111111',
          roles: token === 'admin-token' ? ['Junior.Admin', 'Junior.User'] : ['Junior.User'],
          authSource: 'token',
          isAuthenticated: true
        })
      }
    }
  });
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const authConfigResponse = await fetch(`${baseUrl}/api/auth/config`);
  assert.equal(authConfigResponse.status, 200);
  const authConfig = await authConfigResponse.json() as {
    identityMode: string;
    clientId: string | null;
    authority: string | null;
    scopes: string[];
  };
  assert.equal(authConfig.identityMode, 'entra-msal');
  assert.equal(authConfig.clientId, '22222222-2222-2222-2222-222222222222');
  assert.equal(authConfig.authority, 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111');
  assert.deepEqual(authConfig.scopes, ['api://junior-workbench/Junior.Workbench.Access']);

  const unauthenticatedResponse = await fetch(`${baseUrl}/api/workspaces`);
  assert.equal(unauthenticatedResponse.status, 401);

  const userResponse = await fetch(`${baseUrl}/api/workspaces`, {
    headers: bearerHeaders('user-token')
  });
  assert.equal(userResponse.status, 200);

  const adminResponse = await fetch(`${baseUrl}/api/admin/workspace-templates`, {
    headers: bearerHeaders('admin-token')
  });
  assert.equal(adminResponse.status, 200);
});

test('workspace template import can selectively materialize chosen resources', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Selective Import Workspace', description: 'Selective template import test' })
  });
  assert.equal(createWorkspaceResponse.status, 200);
  const workspace = await createWorkspaceResponse.json() as { id: string };

  const importResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/template-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: 'research-workspace',
      agentTemplateIds: ['research-analyst'],
      connectorIds: [],
      mcpCatalogIds: []
    })
  });
  assert.equal(importResponse.status, 200);
  const importResult = await importResponse.json() as { importedAgents: string[]; importedConnections: string[]; importedMcpServers: string[] };
  assert.deepEqual(importResult.importedAgents, ['research-analyst']);
  assert.deepEqual(importResult.importedConnections, []);
  assert.deepEqual(importResult.importedMcpServers, []);

  const persistedAgentsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/agents`);
  assert.equal(persistedAgentsResponse.status, 200);
  const persistedAgents = await persistedAgentsResponse.json() as Array<{ id: string }>;
  assert.equal(persistedAgents.some((agent) => agent.id === 'research-analyst'), true);

  const persistedConnectionsResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/agent-connections`);
  assert.equal(persistedConnectionsResponse.status, 200);
  const persistedConnections = await persistedConnectionsResponse.json() as Array<{ id: string }>;
  assert.equal(persistedConnections.length, 0);

  const persistedMcpResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/settings/mcp-servers`);
  assert.equal(persistedMcpResponse.status, 200);
  const persistedMcpServers = await persistedMcpResponse.json() as Array<{ id: string }>;
  assert.equal(persistedMcpServers.length, 0);
});

test('admin can create, update, and delete full workspace templates', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const mcpResponse = await fetch(`${baseUrl}/api/mcp-servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'template-docs-mcp',
      name: 'Template Docs MCP',
      transport: 'http',
      endpoint: 'https://docs.example.test/mcp',
      authMode: 'none'
    })
  });
  assert.equal(mcpResponse.status, 200);

  const createTemplateResponse = await fetch(`${baseUrl}/api/admin/workspace-templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Editable Template',
      description: 'Created from the admin editor.',
      agentTemplateIds: ['research-analyst'],
      mcpCatalogIds: ['azure-docs-mcp'],
      mcpServerIds: ['template-docs-mcp'],
      connectorIds: ['default-azure-openai'],
      directories: ['intake', 'evidence'],
      files: [{ path: 'intake/brief.md', content: '# Intake brief\n' }]
    })
  });
  assert.equal(createTemplateResponse.status, 200);
  const createdTemplate = await createTemplateResponse.json() as { id: string; directories?: string[]; files?: Array<{ path: string }>; mcpServerIds?: string[] };
  assert.deepEqual(createdTemplate.directories, ['intake', 'evidence']);
  assert.equal(createdTemplate.files?.[0]?.path, 'intake/brief.md');
  assert.deepEqual(createdTemplate.mcpServerIds, ['template-docs-mcp']);

  const updateTemplateResponse = await fetch(`${baseUrl}/api/admin/workspace-templates/${encodeURIComponent(createdTemplate.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Editable Template Updated',
      description: 'Updated from the admin editor.',
      directories: ['intake', 'evidence', 'approval'],
      files: [{ path: 'approval/summary.md', content: '# Approval summary\n' }]
    })
  });
  assert.equal(updateTemplateResponse.status, 200);
  const updatedTemplate = await updateTemplateResponse.json() as { id: string; name: string; files?: Array<{ path: string }> };
  assert.equal(updatedTemplate.name, 'Editable Template Updated');
  assert.equal(updatedTemplate.files?.[0]?.path, 'approval/summary.md');

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Editable Template Workspace', templateId: updatedTemplate.id })
  });
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json() as { id: string };

  const scaffoldFileResponse = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/files?path=${encodeURIComponent('approval/summary.md')}`);
  assert.equal(scaffoldFileResponse.status, 200);

  const deleteTemplateResponse = await fetch(`${baseUrl}/api/admin/workspace-templates/${encodeURIComponent(updatedTemplate.id)}`, {
    method: 'DELETE'
  });
  assert.equal(deleteTemplateResponse.status, 200);
});

test('admin catalog routes return agent templates and known MCP entries', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const agentTemplatesResponse = await fetch(`${baseUrl}/api/admin/agent-templates`);
  assert.equal(agentTemplatesResponse.status, 200);
  const agentTemplates = await agentTemplatesResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(agentTemplates.length, 1);
  assert.equal(agentTemplates[0]?.id, 'research-analyst');

  const mcpCatalogResponse = await fetch(`${baseUrl}/api/admin/mcp-catalog`);
  assert.equal(mcpCatalogResponse.status, 200);
  const mcpCatalog = await mcpCatalogResponse.json() as Array<{ id: string; authMode: string }>;
  assert.equal(mcpCatalog.length, 1);
  assert.equal(mcpCatalog[0]?.id, 'azure-docs-mcp');
  assert.equal(mcpCatalog[0]?.authMode, 'entra');

  const workspaceTemplatesResponse = await fetch(`${baseUrl}/api/admin/workspace-templates`);
  assert.equal(workspaceTemplatesResponse.status, 200);
  const workspaceTemplates = await workspaceTemplatesResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(workspaceTemplates.length, 1);
  assert.equal(workspaceTemplates[0]?.id, 'research-workspace');
  assert.equal(workspaceTemplates[0]?.name, 'Research Workspace');
});

test('trusted header mode blocks admin routes for non-admin identities', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness, {
    appOptions: {
      identity: {
        mode: 'trusted-header'
      }
    }
  });
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const forbiddenResponse = await fetch(`${baseUrl}/api/admin/agent-templates`, {
    headers: identityHeaders('user-1', { roles: ['Junior.User'] })
  });
  assert.equal(forbiddenResponse.status, 403);

  const allowedResponse = await fetch(`${baseUrl}/api/admin/agent-templates`, {
    headers: identityHeaders('admin-1', { roles: ['Junior.Admin', 'Junior.User'] })
  });
  assert.equal(allowedResponse.status, 200);
  const payload = await allowedResponse.json() as Array<{ id: string }>;
  assert.equal(payload.length, 1);
});

test('admin connectivity routes report service status and run local storage diagnostics', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const reportResponse = await fetch(`${baseUrl}/api/admin/connectivity`);
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json() as { sections: Array<{ id: string; status: string; checks: Array<{ status: string }> }> };
  assert.equal(report.sections.length, 4);
  assert.equal(report.sections.some((section) => section.id === 'cosmos'), true);
  assert.equal(report.sections.some((section) => section.id === 'storage'), true);
  assert.equal(report.sections.some((section) => section.id === 'secrets'), true);
  assert.equal(report.sections.some((section) => section.id === 'ai'), true);

  const storageTestResponse = await fetch(`${baseUrl}/api/admin/connectivity/tests/storage`, {
    method: 'POST'
  });
  assert.equal(storageTestResponse.status, 200);
  const storageTest = await storageTestResponse.json() as { target: string; status: string; checks: Array<{ id: string; status: string }> };
  assert.equal(storageTest.target, 'storage');
  assert.equal(storageTest.status, 'disabled');
  assert.equal(storageTest.checks[0]?.id, 'workspace-storage');

  const cosmosTestResponse = await fetch(`${baseUrl}/api/admin/connectivity/tests/cosmos`, {
    method: 'POST'
  });
  assert.equal(cosmosTestResponse.status, 200);
  const cosmosTest = await cosmosTestResponse.json() as { target: string; status: string; checks: Array<{ status: string }> };
  assert.equal(cosmosTest.target, 'cosmos');
  assert.equal(cosmosTest.status, 'disabled');
  assert.equal(cosmosTest.checks.length, 5);
});

test('chat sessions are created, listed, and isolated per workspace session id', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      { content: 'First response.', toolCalls: [] },
      { content: 'Second response.', toolCalls: [] }
    ]
  }));
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const firstSessionResponse = await fetch(`${baseUrl}/api/workspaces/current/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(firstSessionResponse.status, 200);
  const firstSession = await firstSessionResponse.json() as { id: string };

  const secondSessionResponse = await fetch(`${baseUrl}/api/workspaces/current/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(secondSessionResponse.status, 200);
  const secondSession = await secondSessionResponse.json() as { id: string };
  assert.notEqual(firstSession.id, secondSession.id);

  const firstMessageResponse = await fetch(`${baseUrl}/api/workspaces/current/agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'First session prompt', sessionId: firstSession.id, autoApproveChanges: false })
  });
  assert.equal(firstMessageResponse.status, 200);

  const secondMessageResponse = await fetch(`${baseUrl}/api/workspaces/current/agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Second session prompt', sessionId: secondSession.id, autoApproveChanges: false })
  });
  assert.equal(secondMessageResponse.status, 200);

  const sessionsResponse = await fetch(`${baseUrl}/api/workspaces/current/chat/sessions`);
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json() as Array<{ id: string; messageCount: number; title: string }>;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.every((session) => session.messageCount === 2), true);

  const firstMessagesResponse = await fetch(`${baseUrl}/api/workspaces/current/agent/messages?sessionId=${encodeURIComponent(firstSession.id)}`);
  assert.equal(firstMessagesResponse.status, 200);
  const firstMessages = await firstMessagesResponse.json() as Array<{ content: string }>;
  assert.equal(firstMessages.length, 2);
  assert.equal(firstMessages[0]?.content, 'First session prompt');

  const secondMessagesResponse = await fetch(`${baseUrl}/api/workspaces/current/agent/messages?sessionId=${encodeURIComponent(secondSession.id)}`);
  assert.equal(secondMessagesResponse.status, 200);
  const secondMessages = await secondMessagesResponse.json() as Array<{ content: string }>;
  assert.equal(secondMessages.length, 2);
  assert.equal(secondMessages[0]?.content, 'Second session prompt');
});

test('agent message route applies agent-created files directly', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'I will create an agent notes file.',
        toolCalls: [createToolCall('write_file', {
          path: 'package/agent-notes.md',
          content: '# Agent Notes\n\nCreated by the API smoke test.\n',
          summary: 'Create agent notes file.'
        })]
      },
      {
        content: 'The file is staged for review.',
        toolCalls: []
      }
    ]
  }));
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const messageResponse = await fetch(`${baseUrl}/api/agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Create an agent notes file directly in the workspace.',
      autoApproveChanges: true
    })
  });

  assert.equal(messageResponse.status, 200);
  const messagePayload = await messageResponse.json() as { pendingChanges: Array<{ id: string; path: string }>; appliedChangeCount: number };
  assert.equal(messagePayload.appliedChangeCount, 1);
  assert.equal(messagePayload.pendingChanges.length, 0);

  const fileResponse = await fetch(`${baseUrl}/api/workspaces/current/files?path=${encodeURIComponent('package/agent-notes.md')}`);
  assert.equal(fileResponse.status, 200);
  const file = await fileResponse.json() as { content: string };
  assert.match(file.content, /Created by the API smoke test\./);
});

test('agent message route auto-applies changes when requested', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'I will create an auto-applied file.',
        toolCalls: [createToolCall('write_file', {
          path: 'package/auto-applied.md',
          content: '# Auto Applied\n\nCreated by auto-apply.\n',
          summary: 'Create auto-applied file.'
        })]
      },
      {
        content: 'The file was created.',
        toolCalls: []
      }
    ]
  }));
  const { server, baseUrl } = await startHarnessServer(harness);
  t.after(async () => {
    await stopHarnessServer(server);
    await cleanupHarness(harness);
  });

  const messageResponse = await fetch(`${baseUrl}/api/agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: 'Create and apply an auto-applied file.',
      autoApproveChanges: true
    })
  });

  assert.equal(messageResponse.status, 200);
  const messagePayload = await messageResponse.json() as { pendingChanges: unknown[]; appliedChangeCount: number };
  assert.equal(messagePayload.appliedChangeCount, 1);
  assert.equal(messagePayload.pendingChanges.length, 0);

  const changesResponse = await fetch(`${baseUrl}/api/changes`);
  const changes = await changesResponse.json() as unknown[];
  assert.equal(changes.length, 0);

  const fileResponse = await fetch(`${baseUrl}/api/workspaces/current/files?path=${encodeURIComponent('package/auto-applied.md')}`);
  assert.equal(fileResponse.status, 200);
  const file = await fileResponse.json() as { content: string };
  assert.match(file.content, /Created by auto-apply\./);
});