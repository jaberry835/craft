import type {
  AgentAiSettings,
  AgentConnection,
  AgentConnectionSaveRequest,
  AgentConnectionStatus,
  AgentCreateRequest,
  AgentDefinition,
  AgentModelConnection,
  AgentModelConnectionStatus,
  AgentTemplateDefinition,
  AgentUpdateRequest,
  AzureAiSearchConnectionDefinition,
  McpCatalogEntry,
  McpCustomHeader,
  McpServerDefinition,
  McpServerSaveRequest,
  McpServerStatus,
  McpServerToolDefinition,
  ResolvedMcpServerDefinition,
  WorkspaceHistorySettings,
  WorkspaceHistorySettingsSaveRequest,
  WorkspaceTemplateImportRequest,
  WorkspaceTemplateImportResult,
  WorkspaceTemplateDefinition
} from '../types.js';
import type { AgentConfigStore, RuntimeAgentConfigStore } from './agentConfigStore.js';
import type { WorkspaceConnectionSecrets, WorkspaceMcpSecrets, WorkspaceSecretStore } from './workspaceSecretStore.js';
import type { WorkspaceStateStore } from './workspaceStateStore.js';

interface WorkspaceConfigDocument {
  agents: AgentDefinition[];
  connections: AgentConnection[];
  mcpServers: McpServerDefinition[];
  importedTemplateIds: string[];
  historySettings?: WorkspaceHistorySettings;
}

const configPath = '.junior/workspace-config.json';

const defaultHistorySettings: WorkspaceHistorySettings = {
  enabled: false,
  includeReasoning: true
};

function normalizeAgentAiSettings(aiSettings: AgentAiSettings | undefined, fallbackReasoningEffort?: AgentAiSettings['reasoningEffort']): AgentAiSettings | undefined {
  const temperature = aiSettings?.temperature;
  if (temperature !== undefined && (Number.isNaN(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error('Agent temperature must be between 0.0 and 2.0.');
  }

  const maxTokens = aiSettings?.maxTokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new Error('Agent max output tokens must be a positive integer.');
  }

  const reasoningEffort = aiSettings?.reasoningEffort ?? fallbackReasoningEffort;
  if (temperature === undefined && maxTokens === undefined && reasoningEffort === undefined) {
    return undefined;
  }

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
  };
}

export class WorkspaceConfigStore implements RuntimeAgentConfigStore {
  private config: WorkspaceConfigDocument = {
    agents: [],
    connections: [],
    mcpServers: [],
    importedTemplateIds: []
  };

  private connectorSecrets: WorkspaceConnectionSecrets = {};
  private mcpSecrets: WorkspaceMcpSecrets = {};

  constructor(
    private readonly stateStore: WorkspaceStateStore,
    private readonly secretStore: WorkspaceSecretStore,
    private readonly sharedStore: AgentConfigStore
  ) {}

  async load(): Promise<void> {
    this.config = await this.stateStore.readJson<WorkspaceConfigDocument>(configPath, this.config);
    this.connectorSecrets = await this.secretStore.loadConnectionSecrets(this.config.connections.map((connection) => connection.id));
    this.mcpSecrets = await this.secretStore.loadMcpSecrets(this.config.mcpServers.map((server) => ({ id: server.id })));
  }

  listPersistedAgents(): AgentDefinition[] {
    return [...this.config.agents];
  }

  listPersistedConnections(): AgentConnectionStatus[] {
    return this.config.connections.map((connection) => this.toConnectionStatus(connection));
  }

  listPersistedMcpServers(): McpServerStatus[] {
    return this.config.mcpServers.map((server) => this.toMcpStatus(server));
  }

  getHistorySettings(): WorkspaceHistorySettings {
    return {
      ...defaultHistorySettings,
      ...this.config.historySettings
    };
  }

  async saveHistorySettings(request: WorkspaceHistorySettingsSaveRequest): Promise<WorkspaceHistorySettings> {
    const current = this.getHistorySettings();
    const next: WorkspaceHistorySettings = {
      enabled: request.enabled ?? current.enabled,
      includeReasoning: request.includeReasoning ?? current.includeReasoning
    };

    this.config.historySettings = next;
    await this.saveConfig();
    return next;
  }

  listRuntimeAgents(): AgentDefinition[] {
    return this.config.agents.length > 0
      ? [...this.config.agents]
      : this.sharedStore.listAgents();
  }

  getAgent(agentId?: string): AgentDefinition {
    const agents = this.listRuntimeAgents();
    const agent = agents.find((candidate) => candidate.id === agentId) ?? agents[0];

    if (!agent) {
      throw new Error('No agents are configured.');
    }

    return agent;
  }

  async createAgent(request: AgentCreateRequest): Promise<AgentDefinition> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Agent name is required.');
    }

    const reasoningEffort = request.reasoningEffort ?? request.aiSettings?.reasoningEffort ?? 'medium';

    const agent: AgentDefinition = {
      id: this.uniqueId(this.slugify(name), this.config.agents.map((candidate) => candidate.id)),
      name,
      description: request.description?.trim() ?? '',
      instructions: request.instructions,
      modelConnectionId: request.modelConnectionId,
      reasoningEffort,
      aiSettings: normalizeAgentAiSettings(request.aiSettings, reasoningEffort),
      tools: ['read_file', 'search_files', 'grep_search', 'semantic_search', 'write_file', 'edit_file'],
      groundingSources: request.groundingSources ?? [
        {
          id: 'workspace',
          type: 'workspace-index',
          label: 'Workspace index',
          enabled: true,
          top: 5
        }
      ],
      mcpServerIds: this.cleanMcpServerIds(request.mcpServerIds)
    };

    this.config = {
      ...this.config,
      agents: [...this.config.agents, agent]
    };
    await this.saveConfig();
    return agent;
  }

  async updateAgent(agentId: string, update: AgentUpdateRequest): Promise<AgentDefinition> {
    const index = this.config.agents.findIndex((agent) => agent.id === agentId);
    if (index === -1) {
      throw new Error(`Workspace agent not found: ${agentId}`);
    }

    const current = this.config.agents[index];
    const reasoningEffort = update.reasoningEffort ?? current.reasoningEffort ?? current.aiSettings?.reasoningEffort ?? 'medium';
    const aiSettings = Object.hasOwn(update, 'aiSettings')
      ? normalizeAgentAiSettings(update.aiSettings, reasoningEffort)
      : normalizeAgentAiSettings(current.aiSettings, reasoningEffort);
    const next: AgentDefinition = {
      ...current,
      name: update.name?.trim() || current.name,
      description: update.description ?? current.description,
      modelConnectionId: update.modelConnectionId ?? current.modelConnectionId,
      reasoningEffort,
      aiSettings,
      instructions: update.instructions ?? current.instructions,
      groundingSources: update.groundingSources ?? current.groundingSources,
      mcpServerIds: this.cleanMcpServerIds(update.mcpServerIds ?? current.mcpServerIds)
    };

    this.config = {
      ...this.config,
      agents: this.config.agents.map((agent) => agent.id === agentId ? next : agent)
    };
    await this.saveConfig();
    return next;
  }

  async deleteAgent(agentId: string): Promise<AgentDefinition> {
    const agent = this.config.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Workspace agent not found: ${agentId}`);
    }

    this.config = {
      ...this.config,
      agents: this.config.agents.filter((candidate) => candidate.id !== agentId)
    };
    await this.saveConfig();
    return agent;
  }

  listConnections(): AgentConnectionStatus[] {
    return this.config.connections.length > 0
      ? this.listPersistedConnections()
      : this.sharedStore.listConnections();
  }

  async saveConnection(request: AgentConnectionSaveRequest): Promise<AgentConnectionStatus> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Connector name is required.');
    }

    const id = request.id?.trim() || this.uniqueId(this.slugify(name), this.config.connections.map((connection) => connection.id));
    const current = this.config.connections.find((connection) => connection.id === id);
    const endpoint = request.endpoint?.trim() || undefined;
    const endpointEnv = request.endpointEnv?.trim() || current?.endpointEnv || this.defaultEndpointEnv(request.type, id);
    const authMode = request.authMode ?? current?.authMode ?? 'entra';
    const cloud = request.cloud ?? current?.cloud ?? 'public';
    const base = {
      id,
      name,
      type: request.type,
      authMode,
      cloud,
      endpointKind: request.type === 'azure-openai'
        ? (request.endpointKind ?? (current?.type === 'azure-openai' ? current.endpointKind : undefined) ?? 'auto')
        : undefined,
      endpoint,
      endpointEnv,
      apiKeyEnv: request.apiKeyEnv?.trim() || current?.apiKeyEnv || this.defaultApiKeyEnv(request.type, id),
      credentialScope: request.credentialScope?.trim() || undefined
    };
    const next: AgentConnection = request.type === 'azure-openai'
      ? {
        ...base,
        type: 'azure-openai',
        deployment: request.deployment?.trim() || undefined,
        deploymentEnv: request.deploymentEnv?.trim() || (current?.type === 'azure-openai' ? current.deploymentEnv : undefined),
        apiVersion: request.apiVersion?.trim() || undefined,
        apiVersionEnv: request.apiVersionEnv?.trim() || (current?.type === 'azure-openai' ? current.apiVersionEnv : undefined),
        defaultApiVersion: request.defaultApiVersion?.trim() || (current?.type === 'azure-openai' ? current.defaultApiVersion : undefined) || '2025-01-01-preview',
        temperature: request.temperature,
        maxTokens: request.maxTokens
      }
      : {
        ...base,
        type: 'azure-ai-search',
        audience: request.audience?.trim() || undefined,
        indexNames: this.cleanList(request.indexNames),
        semanticConfigurations: this.cleanList(request.semanticConfigurations),
        queryType: request.queryType ?? 'semantic',
        top: request.top ?? 5
      };

    this.config = {
      ...this.config,
      connections: this.config.connections.some((connection) => connection.id === id)
        ? this.config.connections.map((connection) => connection.id === id ? next : connection)
        : [...this.config.connections, next]
    };

    if (request.apiKey?.trim()) {
      this.connectorSecrets[id] = { apiKey: request.apiKey.trim() };
      await this.secretStore.saveConnectionSecret(id, this.connectorSecrets[id]);
    } else if (authMode === 'entra' && this.connectorSecrets[id]) {
      delete this.connectorSecrets[id];
      await this.secretStore.deleteConnectionSecret(id);
    }

    await this.saveConfig();
    return this.toConnectionStatus(next);
  }

  async deleteConnection(connectionId: string): Promise<AgentConnectionStatus> {
    const connection = this.config.connections.find((candidate) => candidate.id === connectionId);
    if (!connection) {
      throw new Error(`Workspace connector not found: ${connectionId}`);
    }

    const modelUsers = this.config.agents.filter((agent) => agent.modelConnectionId === connectionId).map((agent) => agent.name);
    const groundingUsers = this.config.agents.filter((agent) => agent.groundingSources.some((source) => source.type === 'azure-ai-search' && source.connectorId === connectionId)).map((agent) => agent.name);
    if (modelUsers.length > 0 || groundingUsers.length > 0) {
      const usages = [
        modelUsers.length > 0 ? `model for ${modelUsers.join(', ')}` : undefined,
        groundingUsers.length > 0 ? `grounding for ${groundingUsers.join(', ')}` : undefined
      ].filter((value): value is string => Boolean(value));
      throw new Error(`Connector ${connection.name} is still in use as ${usages.join(' and ')}.`);
    }

    this.config = {
      ...this.config,
      connections: this.config.connections.filter((candidate) => candidate.id !== connectionId)
    };
    if (this.connectorSecrets[connectionId]) {
      delete this.connectorSecrets[connectionId];
      await this.secretStore.deleteConnectionSecret(connectionId);
    }
    await this.saveConfig();
    return this.toConnectionStatus(connection);
  }

  getConnection(connectionId: string): AgentModelConnection {
    const connection = this.config.connections.find((candidate) => candidate.id === connectionId);
    if (connection?.type === 'azure-openai') {
      return connection;
    }

    return this.sharedStore.getConnection(connectionId);
  }

  getSearchConnection(connectionId: string): AzureAiSearchConnectionDefinition {
    const connection = this.config.connections.find((candidate) => candidate.id === connectionId);
    if (connection?.type === 'azure-ai-search') {
      return connection;
    }

    return this.sharedStore.getSearchConnection(connectionId);
  }

  resolveApiKey(connection: AgentConnection): string | undefined {
    return this.connectorSecrets[connection.id]?.apiKey ?? this.sharedStore.resolveApiKey(connection);
  }

  getConnectionStatus(connectionId: string): AgentModelConnectionStatus {
    const connection = this.config.connections.find((candidate) => candidate.id === connectionId);
    return connection?.type === 'azure-openai'
      ? this.toConnectionStatus(connection)
      : this.sharedStore.getConnectionStatus(connectionId);
  }

  listMcpServers(): McpServerStatus[] {
    return this.config.mcpServers.length > 0
      ? this.listPersistedMcpServers()
      : this.sharedStore.listMcpServers();
  }

  getResolvedMcpServer(serverId: string): ResolvedMcpServerDefinition {
    const server = this.config.mcpServers.find((candidate) => candidate.id === serverId);
    if (!server) {
      return this.sharedStore.getResolvedMcpServer(serverId);
    }

    const endpoint = server.endpoint ?? (server.endpointEnv ? process.env[server.endpointEnv] : undefined);
    const bearerToken = this.mcpSecrets[server.id]?.bearerToken ?? (server.bearerTokenEnv ? process.env[server.bearerTokenEnv] : undefined);
    const apiKey = this.mcpSecrets[server.id]?.apiKey ?? (server.apiKeyEnv ? process.env[server.apiKeyEnv] : undefined);
    const customHeaders = Object.fromEntries(
      (server.customHeaders ?? []).flatMap((header) => {
        const value = this.mcpSecrets[server.id]?.customHeaders?.[header.name] ?? (header.valueEnv ? process.env[header.valueEnv] : undefined);
        return value ? [[header.name, value]] : [];
      })
    );
    const resolvedEndpoint = endpoint;
    const missing = [
      resolvedEndpoint ? undefined : server.endpointEnv ?? 'endpoint',
      server.authMode === 'bearer-token' && !bearerToken ? server.bearerTokenEnv ?? 'bearer token' : undefined,
      server.authMode === 'api-key' && !apiKey ? server.apiKeyEnv ?? 'api key' : undefined,
      server.authMode === 'entra' && !server.audience ? 'audience' : undefined,
      server.authMode === 'custom-headers' && (server.customHeaders ?? []).some((header) => !(this.mcpSecrets[server.id]?.customHeaders?.[header.name] ?? (header.valueEnv ? process.env[header.valueEnv] : undefined))) ? 'custom headers' : undefined
    ].filter((value): value is string => Boolean(value));

    if (missing.length > 0) {
      throw new Error(`MCP server ${server.name} is not fully configured. Missing: ${missing.join(', ')}.`);
    }

    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      endpoint: resolvedEndpoint as string,
      authMode: server.authMode,
      bearerToken,
      apiKey,
      audience: server.audience,
      customHeaders: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
      discoveredTools: server.discoveredTools
    };
  }

  async saveMcpServer(request: McpServerSaveRequest): Promise<McpServerStatus> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('MCP server name is required.');
    }

    const id = request.id?.trim() || this.uniqueId(this.slugify(name), this.config.mcpServers.map((server) => server.id));
    const current = this.config.mcpServers.find((server) => server.id === id);
    const authMode = request.authMode ?? current?.authMode ?? 'none';
    const next: McpServerDefinition = {
      id,
      name,
      transport: request.transport,
      endpoint: request.endpoint?.trim() || undefined,
      endpointEnv: request.endpointEnv?.trim() || current?.endpointEnv || this.defaultMcpEndpointEnv(id),
      authMode,
      bearerTokenEnv: request.bearerTokenEnv?.trim() || current?.bearerTokenEnv || this.defaultMcpBearerTokenEnv(id),
      apiKeyEnv: request.apiKeyEnv?.trim() || current?.apiKeyEnv || this.defaultMcpApiKeyEnv(id),
      audience: request.audience?.trim() || undefined,
      customHeaders: this.cleanMcpHeaders(request.customHeaders)
    };

    this.config = {
      ...this.config,
      mcpServers: this.config.mcpServers.some((server) => server.id === id)
        ? this.config.mcpServers.map((server) => server.id === id ? next : server)
        : [...this.config.mcpServers, next]
    };

    const currentSecrets = this.mcpSecrets[id] ?? {};
    const nextSecrets: WorkspaceMcpSecrets[string] = {
      ...currentSecrets,
      apiKey: request.apiKey?.trim() ? request.apiKey.trim() : currentSecrets.apiKey,
      bearerToken: request.bearerToken?.trim() ? request.bearerToken.trim() : currentSecrets.bearerToken,
      customHeaders: this.mergeMcpCustomHeaderSecrets(currentSecrets.customHeaders, request.customHeaders)
    };

    if (authMode === 'none' || authMode === 'entra') {
      delete nextSecrets.apiKey;
      delete nextSecrets.bearerToken;
    }
    if (authMode !== 'custom-headers') {
      delete nextSecrets.customHeaders;
    }

    if (Object.keys(nextSecrets).length > 0) {
      this.mcpSecrets[id] = nextSecrets;
      await this.secretStore.saveMcpSecret(id, nextSecrets);
    } else if (this.mcpSecrets[id]) {
      delete this.mcpSecrets[id];
      await this.secretStore.deleteMcpSecret(id);
    }

    await this.saveConfig();
    return this.toMcpStatus(next);
  }

  async saveMcpServerTools(serverId: string, tools: McpServerToolDefinition[], warnings: string[]): Promise<McpServerStatus> {
    const server = this.config.mcpServers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`Workspace MCP server not found: ${serverId}`);
    }

    const next: McpServerDefinition = {
      ...server,
      discoveredTools: tools,
      toolsDiscoveredAt: new Date().toISOString(),
      toolDiscoveryWarnings: warnings
    };
    this.config = {
      ...this.config,
      mcpServers: this.config.mcpServers.map((candidate) => candidate.id === serverId ? next : candidate)
    };
    await this.saveConfig();
    return this.toMcpStatus(next);
  }

  async deleteMcpServer(serverId: string): Promise<McpServerStatus> {
    const server = this.config.mcpServers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`Workspace MCP server not found: ${serverId}`);
    }

    const usedByAgents = this.config.agents.filter((agent) => agent.mcpServerIds?.includes(serverId)).map((agent) => agent.name);
    if (usedByAgents.length > 0) {
      throw new Error(`MCP server ${server.name} is still attached to ${usedByAgents.join(', ')}.`);
    }

    this.config = {
      ...this.config,
      mcpServers: this.config.mcpServers.filter((candidate) => candidate.id !== serverId)
    };
    if (this.mcpSecrets[serverId]) {
      delete this.mcpSecrets[serverId];
      await this.secretStore.deleteMcpSecret(serverId);
    }
    await this.saveConfig();
    return this.toMcpStatus(server);
  }

  async applyTemplate(template: WorkspaceTemplateDefinition): Promise<void> {
    if (this.config.importedTemplateIds.includes(template.id)) {
      return;
    }

    await this.importTemplateSelection(template, {
      templateId: template.id,
      agentTemplateIds: template.agentTemplateIds,
      mcpCatalogIds: template.mcpCatalogIds,
      mcpServerIds: template.mcpServerIds,
      connectorIds: template.connectorIds
    }, true);
  }

  async importTemplateSelection(
    template: WorkspaceTemplateDefinition,
    selection: WorkspaceTemplateImportRequest,
    trackTemplateImport = false
  ): Promise<WorkspaceTemplateImportResult> {
    const selectedConnectorIds = this.selectTemplateIds('connectors', selection.connectorIds, template.connectorIds);
    const selectedMcpCatalogIds = this.selectTemplateIds('MCP catalog entries', selection.mcpCatalogIds, template.mcpCatalogIds);
    const selectedMcpServerIds = this.selectTemplateIds('MCP servers', selection.mcpServerIds, template.mcpServerIds);
    const selectedAgentTemplateIds = this.selectTemplateIds('agent templates', selection.agentTemplateIds, template.agentTemplateIds);
    const selectedTemplate: WorkspaceTemplateDefinition = {
      ...template,
      connectorIds: selectedConnectorIds,
      mcpCatalogIds: selectedMcpCatalogIds,
      mcpServerIds: selectedMcpServerIds,
      agentTemplateIds: selectedAgentTemplateIds
    };

    const importedConnections = selectedConnectorIds
      .map((connectionId) => this.sharedStore.getConnectionDefinition(connectionId))
      .filter((connection): connection is AgentConnection => Boolean(connection));
    const importedMcpCatalogServers = selectedMcpCatalogIds
      .map((catalogId) => this.sharedStore.getMcpCatalogEntry(catalogId))
      .filter((entry): entry is McpCatalogEntry => Boolean(entry))
      .map((entry) => this.sharedStore.materializeMcpCatalogEntry(entry));
    const importedConfiguredMcpServers = selectedMcpServerIds
      .map((serverId) => this.sharedStore.getMcpServerDefinition(serverId))
      .filter((server): server is McpServerDefinition => Boolean(server));
    const importedMcpServers = Array.from(new Map(
      [...importedMcpCatalogServers, ...importedConfiguredMcpServers].map((server) => [server.id, server])
    ).values());
    const availableMcpIds = new Set([
      ...this.config.mcpServers.map((server) => server.id),
      ...importedMcpServers.map((server) => server.id)
    ]);
    const availableModelConnectionIds = new Set([
      ...this.config.connections.filter((connection) => connection.type === 'azure-openai').map((connection) => connection.id),
      ...importedConnections.filter((connection) => connection.type === 'azure-openai').map((connection) => connection.id)
    ]);
    const fallbackModelConnectionId = importedConnections.find((connection) => connection.type === 'azure-openai')?.id
      ?? this.config.connections.find((connection) => connection.type === 'azure-openai')?.id;
    const importedAgents = selectedAgentTemplateIds
      .map((templateId) => this.sharedStore.getAgentTemplate(templateId))
      .filter((item): item is AgentTemplateDefinition => Boolean(item))
      .map((agentTemplate) => {
        const materialized = this.sharedStore.materializeAgentTemplate(agentTemplate, selectedTemplate);
        const mcpServerIds = materialized.mcpServerIds?.filter((serverId) => availableMcpIds.has(serverId));
        return {
          ...materialized,
          id: agentTemplate.id,
          modelConnectionId: availableModelConnectionIds.has(materialized.modelConnectionId)
            ? materialized.modelConnectionId
            : fallbackModelConnectionId ?? materialized.modelConnectionId,
          mcpServerIds: mcpServerIds && mcpServerIds.length > 0 ? mcpServerIds : undefined
        };
      });

    const newAgents = importedAgents.filter((agent) => !this.config.agents.some((candidate) => candidate.id === agent.id));
    const newConnections = importedConnections.filter((connection) => !this.config.connections.some((candidate) => candidate.id === connection.id));
    const newMcpServers = importedMcpServers.filter((server) => !this.config.mcpServers.some((candidate) => candidate.id === server.id));

    this.config = {
      agents: [...this.config.agents, ...newAgents],
      connections: [...this.config.connections, ...newConnections],
      mcpServers: [...this.config.mcpServers, ...newMcpServers],
      importedTemplateIds: trackTemplateImport
        ? Array.from(new Set([...this.config.importedTemplateIds, template.id]))
        : this.config.importedTemplateIds
    };

    await this.saveConfig();
    return {
      importedAgents: newAgents.map((agent) => agent.id),
      importedConnections: newConnections.map((connection) => connection.id),
      importedMcpServers: newMcpServers.map((server) => server.id)
    };
  }

  private selectTemplateIds(label: string, requestedIds: string[] | undefined, availableIds: string[] | undefined): string[] {
    const allowed = new Set(availableIds ?? []);
    const requested = requestedIds ? requestedIds : [...allowed];
    const invalid = requested.filter((id) => !allowed.has(id));

    if (invalid.length > 0) {
      throw new Error(`Unknown ${label} for template import: ${invalid.join(', ')}`);
    }

    return Array.from(new Set(requested));
  }

  private toConnectionStatus(connection: AgentConnection): AgentConnectionStatus {
    const endpoint = connection.endpoint ?? (connection.endpointEnv ? process.env[connection.endpointEnv] : undefined);
    const authMode = connection.authMode ?? 'entra';
    const apiKey = this.resolveApiKey(connection);
    const requiresApiKey = authMode === 'api-key' && connection.type !== 'azure-openai';
    const missing = [
      endpoint ? undefined : connection.endpointEnv ?? 'endpoint',
      connection.type === 'azure-openai' && !(connection.deployment ?? (connection.deploymentEnv ? process.env[connection.deploymentEnv] : undefined)) ? connection.deploymentEnv ?? 'deployment' : undefined,
      requiresApiKey && !apiKey ? connection.apiKeyEnv ?? 'api key' : undefined
    ].filter((value): value is string => Boolean(value));
    const deployment = connection.type === 'azure-openai'
      ? connection.deployment ?? (connection.deploymentEnv ? process.env[connection.deploymentEnv] : undefined)
      : undefined;
    const apiVersion = connection.type === 'azure-openai'
      ? connection.apiVersion ?? (connection.apiVersionEnv ? process.env[connection.apiVersionEnv] : undefined) ?? connection.defaultApiVersion ?? '2025-01-01-preview'
      : undefined;

    return {
      id: connection.id,
      name: connection.name,
      type: connection.type,
      authMode,
      cloud: connection.cloud ?? 'public',
      endpointKind: connection.type === 'azure-openai' ? connection.endpointKind ?? 'auto' : undefined,
      configured: missing.length === 0,
      missing,
      endpoint,
      endpointEnv: connection.endpointEnv,
      hasApiKey: Boolean(apiKey),
      apiKeyEnv: connection.apiKeyEnv,
      credentialScope: connection.credentialScope,
      audience: connection.type === 'azure-ai-search' ? connection.audience : undefined,
      deployment,
      deploymentEnv: connection.type === 'azure-openai' ? connection.deploymentEnv : undefined,
      apiVersion,
      defaultApiVersion: connection.type === 'azure-openai' ? connection.defaultApiVersion : undefined,
      temperature: connection.type === 'azure-openai' ? connection.temperature : undefined,
      maxTokens: connection.type === 'azure-openai' ? connection.maxTokens : undefined,
      indexNames: connection.type === 'azure-ai-search' ? connection.indexNames : undefined,
      semanticConfigurations: connection.type === 'azure-ai-search' ? connection.semanticConfigurations : undefined,
      queryType: connection.type === 'azure-ai-search' ? connection.queryType : undefined,
      top: connection.type === 'azure-ai-search' ? connection.top : undefined
    };
  }

  private toMcpStatus(server: McpServerDefinition): McpServerStatus {
    const endpoint = server.endpoint ?? (server.endpointEnv ? process.env[server.endpointEnv] : undefined);
    const bearerToken = this.mcpSecrets[server.id]?.bearerToken ?? (server.bearerTokenEnv ? process.env[server.bearerTokenEnv] : undefined);
    const apiKey = this.mcpSecrets[server.id]?.apiKey ?? (server.apiKeyEnv ? process.env[server.apiKeyEnv] : undefined);
    const customHeaders = server.customHeaders?.map((header) => ({
      name: header.name,
      configured: Boolean(this.mcpSecrets[server.id]?.customHeaders?.[header.name] ?? (header.valueEnv ? process.env[header.valueEnv] : undefined)),
      valueEnv: header.valueEnv
    }));
    const missing = [
      endpoint ? undefined : server.endpointEnv ?? 'endpoint',
      server.authMode === 'bearer-token' && !bearerToken ? server.bearerTokenEnv ?? 'bearer token' : undefined,
      server.authMode === 'api-key' && !apiKey ? server.apiKeyEnv ?? 'api key' : undefined,
      server.authMode === 'custom-headers' && customHeaders?.some((header) => !header.configured) ? 'custom headers' : undefined
    ].filter((value): value is string => Boolean(value));

    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      authMode: server.authMode,
      configured: missing.length === 0,
      missing,
      endpoint,
      endpointEnv: server.endpointEnv,
      hasBearerToken: Boolean(bearerToken),
      bearerTokenEnv: server.bearerTokenEnv,
      hasApiKey: Boolean(apiKey),
      apiKeyEnv: server.apiKeyEnv,
      audience: server.audience,
      customHeaders,
      discoveredTools: server.discoveredTools ?? [],
      toolsDiscoveredAt: server.toolsDiscoveredAt,
      toolDiscoveryWarnings: server.toolDiscoveryWarnings ?? []
    };
  }

  private async saveConfig(): Promise<void> {
    await this.stateStore.writeJson(configPath, this.config);
  }

  private cleanList(values?: string[]): string[] | undefined {
    const next = values?.map((value) => value.trim()).filter(Boolean) ?? [];
    return next.length > 0 ? next : undefined;
  }

  private cleanMcpHeaders(headers?: McpCustomHeader[]): McpCustomHeader[] | undefined {
    const next = headers?.map((header) => ({
      name: header.name.trim(),
      valueEnv: header.valueEnv?.trim() || undefined
    })).filter((header) => header.name) ?? [];
    return next.length > 0 ? next : undefined;
  }

  private cleanMcpServerIds(ids: string[] | undefined): string[] | undefined {
    const next = Array.from(new Set(ids?.map((id) => id.trim()).filter(Boolean) ?? []));
    const invalid = next.filter((id) => !this.config.mcpServers.some((server) => server.id === id));
    if (invalid.length > 0) {
      throw new Error(`Unknown MCP server selection: ${invalid.join(', ')}`);
    }
    return next.length > 0 ? next : undefined;
  }

  private mergeMcpCustomHeaderSecrets(current: Record<string, string> | undefined, headers: McpCustomHeader[] | undefined): Record<string, string> | undefined {
    if (!headers || headers.length === 0) {
      return current;
    }

    const next: Record<string, string> = { ...(current ?? {}) };
    let changed = false;
    for (const header of headers) {
      const name = header.name.trim();
      const value = header.value?.trim();
      if (!name || !value) {
        continue;
      }
      next[name] = value;
      changed = true;
    }

    return changed ? next : current;
  }

  private defaultEndpointEnv(type: AgentConnection['type'], id: string): string {
    return `${type === 'azure-openai' ? 'AZURE_OPENAI' : 'AZURE_AI_SEARCH'}_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_ENDPOINT`;
  }

  private defaultApiKeyEnv(type: AgentConnection['type'], id: string): string {
    return `${type === 'azure-openai' ? 'AZURE_OPENAI' : 'AZURE_AI_SEARCH'}_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  }

  private defaultMcpEndpointEnv(id: string): string {
    return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_ENDPOINT`;
  }

  private defaultMcpBearerTokenEnv(id: string): string {
    return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BEARER_TOKEN`;
  }

  private defaultMcpApiKeyEnv(id: string): string {
    return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace-item';
  }

  private uniqueId(base: string, existing: string[]): string {
    if (!existing.includes(base)) {
      return base;
    }

    let suffix = 2;
    while (existing.includes(`${base}-${suffix}`)) {
      suffix += 1;
    }

    return `${base}-${suffix}`;
  }
}
