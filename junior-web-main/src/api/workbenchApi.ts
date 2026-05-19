import type { AgentConnectionSaveRequest, AgentDefinition, AgentCreateRequest, AgentModelConnectionStatus, AgentResponse, AgentUpdateRequest, ChatMessage, PendingChange, PublishResult, WorkspaceFile, WorkspaceIndex, WorkspaceSearchResult, WorkspaceTreeNode } from '../types/workbench';

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

export const workbenchApi = {
  getTree: () => requestJson<WorkspaceTreeNode[]>('/api/workspaces/current/tree'),
  getIndex: () => requestJson<WorkspaceIndex>('/api/workspaces/current/index'),
  refreshIndex: () => requestJson<WorkspaceIndex>('/api/workspaces/current/index/refresh', { method: 'POST' }),
  searchWorkspace: (query: string) => requestJson<WorkspaceSearchResult[]>(`/api/workspaces/current/search?q=${encodeURIComponent(query)}`),
  getAgents: () => requestJson<AgentDefinition[]>('/api/agents'),
  createAgent: (agent: AgentCreateRequest) => requestJson<AgentDefinition>('/api/agents', {
    method: 'POST',
    body: JSON.stringify(agent)
  }),
  updateAgent: (id: string, update: AgentUpdateRequest) => requestJson<AgentDefinition>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(update)
  }),
  getAgentConnections: () => requestJson<AgentModelConnectionStatus[]>('/api/agent-connections'),
  saveAgentConnection: (connection: AgentConnectionSaveRequest) => requestJson<AgentModelConnectionStatus>('/api/agent-connections', {
    method: 'POST',
    body: JSON.stringify(connection)
  }),
  getFile: (path: string) => requestJson<WorkspaceFile>(`/api/workspaces/current/files?path=${encodeURIComponent(path)}`),
  saveFile: (path: string, content: string) => requestJson<WorkspaceFile>('/api/workspaces/current/files', {
    method: 'PUT',
    body: JSON.stringify({ path, content })
  }),
  sendAgentMessage: (content: string, agentId?: string) => requestJson<AgentResponse>('/api/agent/messages', {
    method: 'POST',
    body: JSON.stringify({ content, agentId })
  }),
  getMessages: () => requestJson<ChatMessage[]>('/api/agent/messages'),
  getChanges: () => requestJson<PendingChange[]>('/api/changes'),
  approveChange: (id: string) => requestJson<PendingChange>(`/api/changes/${id}/approve`, { method: 'POST' }),
  undoChange: (id: string) => requestJson<PendingChange>(`/api/changes/${id}/undo`, { method: 'POST' }),
  approveAll: () => requestJson<PendingChange[]>('/api/changes/approve-all', { method: 'POST' }),
  undoAll: () => requestJson<PendingChange[]>('/api/changes/undo-all', { method: 'POST' }),
  publish: () => requestJson<PublishResult>('/api/publish', { method: 'POST' })
};
