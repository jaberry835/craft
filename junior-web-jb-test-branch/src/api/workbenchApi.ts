import type { AdminConnectivityReport, AdminConnectivityTestResult, AgentConnectionSaveRequest, AgentDefinition, AgentCreateRequest, AgentModelConnectionStatus, AgentResponse, AgentRunOptions, AgentTemplateDefinition, AgentUpdateRequest, ChatMessage, ChatSessionSummary, McpCatalogEntry, McpServerSaveRequest, McpServerStatus, PendingChange, WorkspaceCreateRequest, WorkspaceFile, WorkspaceIndex, WorkspaceSearchResult, WorkspaceSummary, WorkspaceTemplateDefinition, WorkspaceTemplateImportRequest, WorkspaceTemplateImportResult, WorkspaceTreeNode, WorkspaceUpdateRequest } from '../types/workbench';

export type AgentMessageStreamEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'completed'; response: AgentResponse }
  | { type: 'error'; message: string };

function workspaceBasePath(workspaceId?: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId ?? 'current')}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error ?? response.statusText);
  }

  return response.json() as Promise<T>;
}

async function requestStream(
  path: string,
  init: RequestInit,
  onEvent: (event: AgentMessageStreamEvent) => void | Promise<void>
): Promise<void> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers
    }
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error ?? response.statusText);
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

export const workbenchApi = {
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
  getAgentTemplates: () => requestJson<AgentTemplateDefinition[]>('/api/admin/agent-templates'),
  getMcpCatalog: () => requestJson<McpCatalogEntry[]>('/api/admin/mcp-catalog'),
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
  sendAgentMessageStream: (content: string, agentId: string | undefined, options: AgentRunOptions | undefined, workspaceId: string | undefined, sessionId: string | undefined, onEvent: (event: AgentMessageStreamEvent) => void | Promise<void>) => requestStream(`${workspaceBasePath(workspaceId)}/agent/messages/stream`, {
    method: 'POST',
    body: JSON.stringify({ content, agentId, sessionId, ...options })
  }, onEvent),
  getMessages: (workspaceId?: string, sessionId?: string) => requestJson<ChatMessage[]>(`${workspaceBasePath(workspaceId)}/agent/messages${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  getChanges: (workspaceId?: string) => requestJson<PendingChange[]>(`${workspaceBasePath(workspaceId)}/changes`),
  approveChange: (id: string, workspaceId?: string) => requestJson<PendingChange>(`${workspaceBasePath(workspaceId)}/changes/${id}/approve`, { method: 'POST' }),
  undoChange: (id: string, workspaceId?: string) => requestJson<PendingChange>(`${workspaceBasePath(workspaceId)}/changes/${id}/undo`, { method: 'POST' })
};
