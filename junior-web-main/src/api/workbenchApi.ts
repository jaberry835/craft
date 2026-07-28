import { InteractionRequiredAuthError, PublicClientApplication } from '@azure/msal-browser';
import type { AdminConnectivityReport, AdminConnectivityTestResult, AgentConnectionSaveRequest, AgentDefinition, AgentCreateRequest, AgentModelConnectionStatus, AgentResponse, AgentRunOptions, AgentTemplateDefinition, AgentUpdateRequest, AuthConfig, AuthDiagnostics, ChatMessage, ChatSessionSummary, ClassificationBarSettings, ClassificationBarSettingsSaveRequest, McpCatalogEntry, McpServerSaveRequest, McpServerStatus, PendingChange, RequestIdentitySummary, WorkspaceCreateRequest, WorkspaceFile, WorkspaceHistorySettings, WorkspaceHistorySettingsSaveRequest, WorkspaceIndex, WorkspaceSearchResult, WorkspaceSummary, WorkspaceTemplateDefinition, WorkspaceTemplateImportRequest, WorkspaceTemplateImportResult, WorkspaceTemplateSaveRequest, WorkspaceTreeNode, WorkspaceUpdateRequest } from '../types/workbench';

export type AgentMessageStreamEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'completed'; response: AgentResponse }
  | { type: 'error'; message: string };

export interface LocalDevIdentityConfig {
  userId: string;
  displayName: string;
  tenantId?: string;
  roles: string[];
}

const localDevIdentityStorageKey = 'jr-workbench-local-dev-identity';
let activeAuthConfig: AuthConfig | null = null;
let msalRuntimePromise: Promise<PublicClientApplication> | null = null;
let msalRuntimeKey = '';
const authRetryStatuses = new Set([401, 403, 502]);

export class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

export class AuthRequiredError extends Error {
  constructor(message = 'Sign-in is required.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class ApiUnavailableError extends Error {
  constructor(message = 'The Junior API cannot be reached.') {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

function workspaceBasePath(workspaceId?: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId ?? 'current')}`;
}

function loadLocalDevIdentity(): LocalDevIdentityConfig | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(localDevIdentityStorageKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LocalDevIdentityConfig>;
    if (!parsed.userId?.trim()) {
      return null;
    }

    return {
      userId: parsed.userId.trim(),
      displayName: parsed.displayName?.trim() || parsed.userId.trim(),
      tenantId: parsed.tenantId?.trim() || undefined,
      roles: parsed.roles?.map((role) => role.trim()).filter(Boolean) ?? ['Junior.User']
    };
  } catch {
    return null;
  }
}

function requestIdentityHeaders(): HeadersInit {
  if (activeAuthConfig?.identityMode !== 'trusted-header') {
    return {};
  }

  const identity = loadLocalDevIdentity();
  if (!identity) {
    return {};
  }

  return {
    'x-junior-user-id': identity.userId,
    'x-junior-display-name': identity.displayName,
    'x-junior-roles': identity.roles.join(','),
    ...(identity.tenantId ? { 'x-junior-tenant-id': identity.tenantId } : {})
  };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response = await fetchWithResolvedAuth(path, init);
  if (!response.ok && shouldRetryWithFreshAuth(path, response.status)) {
    response = await fetchWithResolvedAuth(path, init, true);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new RequestError(response.status, payload.error ?? response.statusText);
  }

  return response.json() as Promise<T>;
}

async function requestStream(
  path: string,
  init: RequestInit,
  onEvent: (event: AgentMessageStreamEvent) => void | Promise<void>
): Promise<void> {
  let response = await fetchWithResolvedAuth(path, init);
  if (!response.ok && shouldRetryWithFreshAuth(path, response.status)) {
    response = await fetchWithResolvedAuth(path, init, true);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new RequestError(response.status, payload.error ?? response.statusText);
  }

  if (!response.body) {
    throw new Error('Streaming is not available in this browser session.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushBuffer = async (force = false) => {
    const lines = buffer.split('\n');
    buffer = force ? '' : lines.pop() ?? '';

    for (const line of force ? lines.filter((entry, index) => !(index === lines.length - 1 && entry === '')) : lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      await onEvent(JSON.parse(trimmed) as AgentMessageStreamEvent);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    await flushBuffer(done);
    if (done) {
      break;
    }
  }
}

function shouldRetryWithFreshAuth(path: string, status: number): boolean {
  return path !== '/api/auth/config'
    && activeAuthConfig?.identityMode === 'entra-msal'
    && authRetryStatuses.has(status);
}

async function fetchWithResolvedAuth(path: string, init?: RequestInit, forceRefresh = false): Promise<Response> {
  const authHeaders = await resolveAuthHeaders(path, forceRefresh);
  try {
    return await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...requestIdentityHeaders(),
        ...authHeaders,
        ...init?.headers
      }
    });
  } catch {
    throw new ApiUnavailableError();
  }
}

function msalConfigKey(config: AuthConfig): string {
  return JSON.stringify([
    config.clientId,
    config.authority,
    config.redirectUri,
    config.postLogoutRedirectUri,
    ...config.scopes
  ]);
}

async function ensureMsalClient(): Promise<PublicClientApplication> {
  if (activeAuthConfig?.identityMode !== 'entra-msal') {
    throw new Error('MSAL is only available when identityMode=entra-msal.');
  }

  if (!activeAuthConfig.clientId || !activeAuthConfig.authority || activeAuthConfig.scopes.length === 0) {
    throw new Error('MSAL configuration is incomplete.');
  }

  const nextKey = msalConfigKey(activeAuthConfig);
  if (!msalRuntimePromise || msalRuntimeKey !== nextKey) {
    msalRuntimeKey = nextKey;
    msalRuntimePromise = (async () => {
      const client = new PublicClientApplication({
        auth: {
          clientId: activeAuthConfig?.clientId ?? '',
          authority: activeAuthConfig?.authority ?? undefined,
          redirectUri: activeAuthConfig?.redirectUri ?? window.location.origin,
          postLogoutRedirectUri: activeAuthConfig?.postLogoutRedirectUri ?? window.location.origin
        },
        cache: {
          cacheLocation: 'localStorage'
        }
      });

      await client.initialize();
      const redirectResult = await client.handleRedirectPromise();
      const account = redirectResult?.account ?? client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
      if (account) {
        client.setActiveAccount(account);
      }

      return client;
    })();
  }

  return msalRuntimePromise;
}

async function resolveAuthHeaders(path: string, forceRefresh = false): Promise<HeadersInit> {
  if (path === '/api/auth/config') {
    return {};
  }

  if (activeAuthConfig?.identityMode !== 'entra-msal') {
    return {};
  }

  const token = await acquireMsalAccessToken(forceRefresh);
  return {
    Authorization: `Bearer ${token}`
  };
}

async function acquireMsalAccessToken(forceRefresh = false): Promise<string> {
  const client = await ensureMsalClient();
  const account = client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
  if (!account || !activeAuthConfig) {
    throw new AuthRequiredError('Microsoft Entra sign-in is required.');
  }

  try {
    const response = await client.acquireTokenSilent({
      account,
      scopes: activeAuthConfig.scopes,
      redirectUri: activeAuthConfig.redirectUri ?? window.location.origin,
      forceRefresh
    });
    return response.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      throw new AuthRequiredError('Microsoft Entra sign-in is required.');
    }

    throw error;
  }
}

async function fetchAuthConfig(): Promise<AuthConfig> {
  let response: Response;
  try {
    response = await fetch('/api/auth/config', {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch {
    throw new ApiUnavailableError();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new RequestError(response.status, payload.error ?? response.statusText);
  }

  return response.json() as Promise<AuthConfig>;
}

export const workbenchApi = {
  configureAuth: async (config: AuthConfig) => {
    activeAuthConfig = config;
    if (config.identityMode === 'entra-msal') {
      await ensureMsalClient();
    }
  },
  signIn: async () => {
    if (activeAuthConfig?.identityMode !== 'entra-msal') {
      throw new Error('Sign-in is only supported for the MSAL auth mode.');
    }

    const client = await ensureMsalClient();
    await client.loginRedirect({
      scopes: activeAuthConfig.scopes,
      redirectUri: activeAuthConfig.redirectUri ?? window.location.origin,
      prompt: 'select_account'
    });
  },
  signOut: async () => {
    if (activeAuthConfig?.identityMode !== 'entra-msal') {
      throw new Error('Sign-out is only supported for the MSAL auth mode.');
    }

    const client = await ensureMsalClient();
    const account = client.getActiveAccount() ?? client.getAllAccounts()[0] ?? undefined;
    await client.logoutRedirect({
      account,
      postLogoutRedirectUri: activeAuthConfig.postLogoutRedirectUri ?? window.location.origin
    });
  },
  getAuthConfig: () => fetchAuthConfig(),
  getAuthDiagnostics: () => requestJson<AuthDiagnostics>('/api/auth/claims'),
  getCurrentIdentity: async (forceRefresh = false) => {
    if (activeAuthConfig?.identityMode !== 'entra-msal') {
      return requestJson<RequestIdentitySummary>('/api/me');
    }

    const authHeaders = await resolveAuthHeaders('/api/me', forceRefresh);
    let response: Response;
    try {
      response = await fetch('/api/me', {
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        }
      });
    } catch {
      throw new ApiUnavailableError();
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw new RequestError(response.status, payload.error ?? response.statusText);
    }

    return response.json() as Promise<RequestIdentitySummary>;
  },
  getStoredLocalDevIdentity: () => loadLocalDevIdentity(),
  saveStoredLocalDevIdentity: (identity: LocalDevIdentityConfig) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(localDevIdentityStorageKey, JSON.stringify(identity));
    }
  },
  clearStoredLocalDevIdentity: () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(localDevIdentityStorageKey);
    }
  },
  getWorkspaces: () => requestJson<WorkspaceSummary[]>('/api/workspaces'),
  createWorkspace: (workspace: WorkspaceCreateRequest) => requestJson<WorkspaceSummary>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(workspace)
  }),
  updateWorkspace: (workspaceId: string, update: WorkspaceUpdateRequest) => requestJson<WorkspaceSummary>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(update)
  }),
  getWorkspaceAgents: (workspaceId?: string) => requestJson<AgentDefinition[]>(`${workspaceBasePath(workspaceId)}/agents`),
  getWorkspaceSettingsAgents: (workspaceId?: string) => requestJson<AgentDefinition[]>(`${workspaceBasePath(workspaceId)}/settings/agents`),
  createWorkspaceAgent: (agent: AgentCreateRequest, workspaceId?: string) => requestJson<AgentDefinition>(`${workspaceBasePath(workspaceId)}/settings/agents`, {
    method: 'POST',
    body: JSON.stringify(agent)
  }),
  updateWorkspaceAgent: (id: string, update: AgentUpdateRequest, workspaceId?: string) => requestJson<AgentDefinition>(`${workspaceBasePath(workspaceId)}/settings/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(update)
  }),
  deleteWorkspaceAgent: (id: string, workspaceId?: string) => requestJson<AgentDefinition>(`${workspaceBasePath(workspaceId)}/settings/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  getWorkspaceSharedAgentTemplates: (workspaceId?: string) => requestJson<AgentTemplateDefinition[]>(`${workspaceBasePath(workspaceId)}/shared/agent-templates`),
  getWorkspaceSharedConnections: (workspaceId?: string) => requestJson<AgentModelConnectionStatus[]>(`${workspaceBasePath(workspaceId)}/shared/connections`),
  getWorkspaceSharedMcpCatalog: (workspaceId?: string) => requestJson<McpCatalogEntry[]>(`${workspaceBasePath(workspaceId)}/shared/mcp-catalog`),
  importWorkspaceTemplateResources: (request: WorkspaceTemplateImportRequest, workspaceId?: string) => requestJson<WorkspaceTemplateImportResult>(`${workspaceBasePath(workspaceId)}/settings/template-import`, {
    method: 'POST',
    body: JSON.stringify(request)
  }),
  getWorkspaceAgentConnections: (workspaceId?: string) => requestJson<AgentModelConnectionStatus[]>(`${workspaceBasePath(workspaceId)}/settings/agent-connections`),
  saveWorkspaceAgentConnection: (connection: AgentConnectionSaveRequest, workspaceId?: string) => requestJson<AgentModelConnectionStatus>(`${workspaceBasePath(workspaceId)}/settings/agent-connections`, {
    method: 'POST',
    body: JSON.stringify(connection)
  }),
  deleteWorkspaceAgentConnection: (id: string, workspaceId?: string) => requestJson<AgentModelConnectionStatus>(`${workspaceBasePath(workspaceId)}/settings/agent-connections/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  getWorkspaceTemplates: () => requestJson<WorkspaceTemplateDefinition[]>('/api/admin/workspace-templates'),
  saveWorkspaceTemplate: (template: WorkspaceTemplateSaveRequest) => requestJson<WorkspaceTemplateDefinition>(template.id ? `/api/admin/workspace-templates/${encodeURIComponent(template.id)}` : '/api/admin/workspace-templates', {
    method: template.id ? 'PUT' : 'POST',
    body: JSON.stringify(template)
  }),
  deleteWorkspaceTemplate: (id: string) => requestJson<WorkspaceTemplateDefinition>(`/api/admin/workspace-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  getAgentTemplates: () => requestJson<AgentTemplateDefinition[]>('/api/admin/agent-templates'),
  getMcpCatalog: () => requestJson<McpCatalogEntry[]>('/api/admin/mcp-catalog'),
  getClassificationBar: () => requestJson<ClassificationBarSettings>('/api/admin/classification-bar'),
  saveClassificationBar: (settings: ClassificationBarSettingsSaveRequest) => requestJson<ClassificationBarSettings>('/api/admin/classification-bar', {
    method: 'POST',
    body: JSON.stringify(settings)
  }),
  getAdminConnectivity: () => requestJson<AdminConnectivityReport>('/api/admin/connectivity'),
  runAdminConnectivityTest: (target: 'cosmos' | 'storage') => requestJson<AdminConnectivityTestResult>(`/api/admin/connectivity/tests/${encodeURIComponent(target)}`, {
    method: 'POST'
  }),
  getChatSessions: (workspaceId?: string) => requestJson<ChatSessionSummary[]>(`${workspaceBasePath(workspaceId)}/chat/sessions`),
  createChatSession: (agentId?: string, workspaceId?: string) => requestJson<ChatSessionSummary>(`${workspaceBasePath(workspaceId)}/chat/sessions`, {
    method: 'POST',
    body: JSON.stringify({ agentId })
  }),
  getTree: (workspaceId?: string) => requestJson<WorkspaceTreeNode[]>(`${workspaceBasePath(workspaceId)}/tree`),
  getIndex: (workspaceId?: string) => requestJson<WorkspaceIndex>(`${workspaceBasePath(workspaceId)}/index`),
  refreshIndex: (workspaceId?: string) => requestJson<WorkspaceIndex>(`${workspaceBasePath(workspaceId)}/index/refresh`, { method: 'POST' }),
  searchWorkspace: (query: string, workspaceId?: string) => requestJson<WorkspaceSearchResult[]>(`${workspaceBasePath(workspaceId)}/search?q=${encodeURIComponent(query)}`),
  getAgents: () => requestJson<AgentDefinition[]>('/api/agents'),
  createAgent: (agent: AgentCreateRequest) => requestJson<AgentDefinition>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(agent)
  }),
  updateAgent: (id: string, update: AgentUpdateRequest) => requestJson<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(update)
  }),
  deleteAgent: (id: string) => requestJson<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  getAgentConnections: () => requestJson<AgentModelConnectionStatus[]>('/api/agent-connections'),
  saveAgentConnection: (connection: AgentConnectionSaveRequest) => requestJson<AgentModelConnectionStatus>('/api/agent-connections', {
    method: 'POST',
    body: JSON.stringify(connection)
  }),
  deleteAgentConnection: (id: string) => requestJson<AgentModelConnectionStatus>(`/api/agent-connections/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  getMcpServers: () => requestJson<McpServerStatus[]>('/api/mcp-servers'),
  getWorkspaceMcpServers: (workspaceId?: string) => requestJson<McpServerStatus[]>(`${workspaceBasePath(workspaceId)}/settings/mcp-servers`),
  saveMcpServer: (server: McpServerSaveRequest) => requestJson<McpServerStatus>('/api/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(server)
  }),
  saveWorkspaceMcpServer: (server: McpServerSaveRequest, workspaceId?: string) => requestJson<McpServerStatus>(`${workspaceBasePath(workspaceId)}/settings/mcp-servers`, {
    method: 'POST',
    body: JSON.stringify(server)
  }),
  deleteMcpServer: (id: string) => requestJson<McpServerStatus>(`/api/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  deleteWorkspaceMcpServer: (id: string, workspaceId?: string) => requestJson<McpServerStatus>(`${workspaceBasePath(workspaceId)}/settings/mcp-servers/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }),
  getWorkspaceHistorySettings: (workspaceId?: string) => requestJson<WorkspaceHistorySettings>(`${workspaceBasePath(workspaceId)}/settings/history`),
  saveWorkspaceHistorySettings: (settings: WorkspaceHistorySettingsSaveRequest, workspaceId?: string) => requestJson<WorkspaceHistorySettings>(`${workspaceBasePath(workspaceId)}/settings/history`, {
    method: 'PUT',
    body: JSON.stringify(settings)
  }),
  getFile: (path: string, workspaceId?: string) => requestJson<WorkspaceFile>(`${workspaceBasePath(workspaceId)}/files?path=${encodeURIComponent(path)}`),
  saveFile: (path: string, content: string, workspaceId?: string) => requestJson<WorkspaceFile>(`${workspaceBasePath(workspaceId)}/files`, {
    method: 'PUT',
    body: JSON.stringify({ path, content })
  }),
  createDirectory: (path: string, workspaceId?: string) => requestJson<{ path: string; type: 'directory' }>(`${workspaceBasePath(workspaceId)}/directories`, {
    method: 'POST',
    body: JSON.stringify({ path })
  }),
  deleteWorkspacePath: (path: string, workspaceId?: string) => requestJson<{ path: string; type: 'file' | 'directory' }>(`${workspaceBasePath(workspaceId)}/paths?path=${encodeURIComponent(path)}`, {
    method: 'DELETE'
  }),
  uploadWorkspaceFiles: async (files: Array<{ path: string; content: string }>, workspaceId?: string) => Promise.all(files.map((file) => workbenchApi.saveFile(file.path, file.content, workspaceId))),
  sendAgentMessage: (content: string, agentId?: string, options?: AgentRunOptions, workspaceId?: string, sessionId?: string) => requestJson<AgentResponse>(`${workspaceBasePath(workspaceId)}/agent/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, agentId, sessionId, ...options })
  }),
  sendAgentMessageStream: (content: string, agentId: string | undefined, options: AgentRunOptions | undefined, workspaceId: string | undefined, sessionId: string | undefined, onEvent: (event: AgentMessageStreamEvent) => void | Promise<void>, signal?: AbortSignal) => requestStream(`${workspaceBasePath(workspaceId)}/agent/messages/stream`, {
    method: 'POST',
    signal,
    body: JSON.stringify({ content, agentId, sessionId, ...options })
  }, onEvent),
  getMessages: (workspaceId?: string, sessionId?: string) => requestJson<ChatMessage[]>(`${workspaceBasePath(workspaceId)}/agent/messages${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  getChanges: (workspaceId?: string) => requestJson<PendingChange[]>(`${workspaceBasePath(workspaceId)}/changes`),
  approveChange: (id: string, workspaceId?: string) => requestJson<PendingChange>(`${workspaceBasePath(workspaceId)}/changes/${id}/approve`, { method: 'POST' }),
  undoChange: (id: string, workspaceId?: string) => requestJson<PendingChange>(`${workspaceBasePath(workspaceId)}/changes/${id}/undo`, { method: 'POST' })
};
