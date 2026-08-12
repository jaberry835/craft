import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { updatePersistenceMode } from './persistenceModeTracker.js';
import type { AgentAiSettings, AgentConnection, AgentConnectionSaveRequest, AgentConnectionStatus, AgentCreateRequest, AgentDefinition, AgentModelConnection, AgentModelConnectionStatus, AgentTemplateDefinition, AgentUpdateRequest, AzureAiSearchConnectionDefinition, ClassificationBarSettings, ClassificationBarSettingsSaveRequest, McpCatalogEntry, McpCustomHeader, McpServerDefinition, McpServerSaveRequest, McpServerStatus, McpServerToolDefinition, ResolvedMcpServerDefinition, WorkspaceSummary, WorkspaceTemplateDefinition, WorkspaceTemplateSaveRequest } from '../types.js';

export type RuntimeAgentConfigStore = Pick<AgentConfigStore, 'getConnection' | 'getSearchConnection' | 'resolveApiKey' | 'getConnectionStatus' | 'getResolvedMcpServer'> & {
  getAgent(agentId?: string): AgentDefinition | Promise<AgentDefinition>;
};

type ConnectorSecrets = Record<string, { apiKey?: string }>;
type McpServerSecrets = Record<string, { apiKey?: string; bearerToken?: string; customHeaders?: Record<string, string> }>;
type ConfigDocument<T> = { id: string; items: T[] };
type CosmosAuthMode = 'entra' | 'api-key';
type CosmosStoreSettings = {
  endpointHost: string;
  databaseId: string;
  containerId: string;
  authMode: CosmosAuthMode;
  keyConfigured: boolean;
};

const defaultClassificationBarSettings: ClassificationBarSettings = {
  text: '',
  color: '#7f1d1d'
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

export class AgentConfigStore {
  private agents: AgentDefinition[] = [];
  private agentTemplates: AgentTemplateDefinition[] = [];
  private connections: AgentConnection[] = [];
  private secrets: ConnectorSecrets = {};
  private mcpServers: McpServerDefinition[] = [];
  private mcpCatalog: McpCatalogEntry[] = [];
  private workspaceTemplates: WorkspaceTemplateDefinition[] = [];
  private classificationBarSettings: ClassificationBarSettings = defaultClassificationBarSettings;
  private mcpSecrets: McpServerSecrets = {};
  private cosmosContainer?: Container;
  private cosmosSettings?: CosmosStoreSettings;

  constructor(private readonly configRoot: string) {}

  async load(): Promise<void> {
    const [agentsJson, connectionsJson, mcpServersJson, agentTemplatesJson, mcpCatalogJson, workspaceTemplatesJson, adminSettingsJson] = await Promise.all([
      readFile(path.join(this.configRoot, 'agents.json'), 'utf8'),
      readFile(path.join(this.configRoot, 'agent-connections.json'), 'utf8'),
      readFile(path.join(this.configRoot, 'mcp-servers.json'), 'utf8'),
      this.readOptionalConfig('agent-templates.json', '[]'),
      this.readOptionalConfig('mcp-catalog.json', '[]'),
      this.readOptionalConfig('workspace-templates.json', '[]'),
      this.readOptionalConfig('admin-settings.json', '{}')
    ]);

    const seedAgents = JSON.parse(agentsJson) as AgentDefinition[];
    const seedConnections = JSON.parse(connectionsJson) as AgentConnection[];
    const seedMcpServers = JSON.parse(mcpServersJson) as McpServerDefinition[];
    const seedAgentTemplates = JSON.parse(agentTemplatesJson) as AgentTemplateDefinition[];
    const seedMcpCatalog = JSON.parse(mcpCatalogJson) as McpCatalogEntry[];
    const seedWorkspaceTemplates = JSON.parse(workspaceTemplatesJson) as WorkspaceTemplateDefinition[];
    const seedAdminSettings = JSON.parse(adminSettingsJson) as { classificationBar?: ClassificationBarSettings };
    this.cosmosContainer = this.createCosmosContainer();
    const cosmosConfig = this.cosmosContainer ? await this.loadFromCosmos(seedAgents, seedConnections, seedMcpServers, seedWorkspaceTemplates) : undefined;

    this.agents = cosmosConfig?.agents ?? seedAgents;
    this.connections = cosmosConfig?.connections ?? seedConnections;
    this.mcpServers = cosmosConfig?.mcpServers ?? seedMcpServers;
    this.agentTemplates = seedAgentTemplates;
    this.mcpCatalog = seedMcpCatalog;
    this.workspaceTemplates = cosmosConfig?.workspaceTemplates ?? seedWorkspaceTemplates;
    this.classificationBarSettings = this.normalizeClassificationBarSettings(seedAdminSettings.classificationBar);
    this.secrets = await this.loadSecrets();
    this.mcpSecrets = await this.loadMcpSecrets();
  }

  getClassificationBarSettings(): ClassificationBarSettings {
    return { ...this.classificationBarSettings };
  }

  async saveClassificationBarSettings(request: ClassificationBarSettingsSaveRequest): Promise<ClassificationBarSettings> {
    this.classificationBarSettings = this.normalizeClassificationBarSettings(request);
    await this.saveAdminSettings();
    return this.getClassificationBarSettings();
  }

  listAgents(): AgentDefinition[] {
    return this.agents;
  }

  listAgentsForWorkspace(workspace?: WorkspaceSummary): AgentDefinition[] {
    return [...this.agents, ...this.workspaceTemplateAgentsFor(workspace)];
  }

  listAgentTemplates(): AgentTemplateDefinition[] {
    return this.agentTemplates;
  }

  getAgentTemplate(templateId: string): AgentTemplateDefinition | undefined {
    return this.agentTemplates.find((candidate) => candidate.id === templateId);
  }

  listMcpCatalog(): McpCatalogEntry[] {
    return this.mcpCatalog;
  }

  getMcpCatalogEntry(entryId: string): McpCatalogEntry | undefined {
    return this.mcpCatalog.find((candidate) => candidate.id === entryId);
  }

  listWorkspaceTemplates(): WorkspaceTemplateDefinition[] {
    return this.workspaceTemplates;
  }

  getWorkspaceTemplate(templateId: string): WorkspaceTemplateDefinition | undefined {
    return this.workspaceTemplates.find((candidate) => candidate.id === templateId);
  }

  getMcpServerDefinition(serverId: string): McpServerDefinition | undefined {
    return this.mcpServers.find((candidate) => candidate.id === serverId);
  }

  async saveWorkspaceTemplate(request: WorkspaceTemplateSaveRequest): Promise<WorkspaceTemplateDefinition> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Workspace template name is required.');
    }

    const id = request.id?.trim() || this.uniqueId(this.slugify(name), this.workspaceTemplates.map((template) => template.id));
    const template: WorkspaceTemplateDefinition = {
      id,
      name,
      description: request.description?.trim() ?? '',
      agentTemplateIds: this.cleanTemplateReferences('agent templates', request.agentTemplateIds, this.agentTemplates.map((agentTemplate) => agentTemplate.id)),
      mcpCatalogIds: this.cleanTemplateReferences('MCP catalog entries', request.mcpCatalogIds, this.mcpCatalog.map((entry) => entry.id)),
      mcpServerIds: this.cleanTemplateReferences('MCP servers', request.mcpServerIds, this.mcpServers.map((server) => server.id)),
      connectorIds: this.cleanTemplateReferences('connectors', request.connectorIds, this.connections.map((connection) => connection.id)),
      directories: this.cleanTemplateDirectories(request.directories),
      files: this.cleanTemplateFiles(request.files)
    };

    this.workspaceTemplates = this.workspaceTemplates.some((candidate) => candidate.id === id)
      ? this.workspaceTemplates.map((candidate) => candidate.id === id ? template : candidate)
      : [...this.workspaceTemplates, template];
    await this.saveWorkspaceTemplates();
    return template;
  }

  async deleteWorkspaceTemplate(templateId: string): Promise<WorkspaceTemplateDefinition> {
    const template = this.workspaceTemplates.find((candidate) => candidate.id === templateId);
    if (!template) {
      throw new Error(`Workspace template not found: ${templateId}`);
    }

    this.workspaceTemplates = this.workspaceTemplates.filter((candidate) => candidate.id !== templateId);
    await this.saveWorkspaceTemplates();
    return template;
  }

  getConnectionDefinition(connectionId: string): AgentConnection | undefined {
    return this.connections.find((candidate) => candidate.id === connectionId);
  }

  listSharedAgentTemplatesForWorkspace(workspace?: WorkspaceSummary): AgentTemplateDefinition[] {
    const workspaceTemplate = workspace?.templateId
      ? this.workspaceTemplates.find((candidate) => candidate.id === workspace.templateId)
      : undefined;

    if (!workspaceTemplate?.agentTemplateIds?.length) {
      return [];
    }

    return workspaceTemplate.agentTemplateIds
      .map((templateId) => this.agentTemplates.find((candidate) => candidate.id === templateId))
      .filter((template): template is AgentTemplateDefinition => Boolean(template));
  }

  listSharedConnectionsForWorkspace(workspace?: WorkspaceSummary): AgentConnectionStatus[] {
    const workspaceTemplate = workspace?.templateId
      ? this.workspaceTemplates.find((candidate) => candidate.id === workspace.templateId)
      : undefined;

    if (!workspaceTemplate?.connectorIds?.length) {
      return [];
    }

    return workspaceTemplate.connectorIds
      .map((connectionId) => this.connections.find((candidate) => candidate.id === connectionId))
      .filter((connection): connection is AgentConnection => Boolean(connection))
      .map((connection) => this.toStatus(connection));
  }

  listSharedMcpCatalogForWorkspace(_workspace?: WorkspaceSummary): McpCatalogEntry[] {
    const catalogEntries = [...this.mcpCatalog];
    const catalogIds = new Set(catalogEntries.map((entry) => entry.id));
    const adminServers = this.mcpServers
      .filter((server) => !catalogIds.has(server.id))
      .map((server): McpCatalogEntry => ({
        id: server.id,
        name: server.name,
        description: 'Configured by an administrator. Workspace credentials are stored separately.',
        transport: server.transport,
        endpoint: server.endpoint ?? (server.endpointEnv ? process.env[server.endpointEnv] : undefined),
        authMode: server.authMode,
        audience: server.audience,
        customHeaders: server.customHeaders
      }));

    return [...catalogEntries, ...adminServers];
  }

  getAgent(agentId?: string): AgentDefinition {
    const agent = this.agents.find((candidate) => candidate.id === agentId) ?? this.agents[0];

    if (!agent) {
      throw new Error('No agents are configured.');
    }

    return agent;
  }

  getAgentForWorkspace(workspace: WorkspaceSummary | undefined, agentId?: string): AgentDefinition {
    const agents = this.listAgentsForWorkspace(workspace);
    const agent = agents.find((candidate) => candidate.id === agentId) ?? agents[0];

    if (!agent) {
      throw new Error('No agents are configured.');
    }

    return agent;
  }

  async updateAgent(agentId: string, update: AgentUpdateRequest): Promise<AgentDefinition> {
    const index = this.agents.findIndex((agent) => agent.id === agentId);

    if (index === -1) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const current = this.agents[index];
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

    this.agents[index] = next;
    await this.saveAgents();
    return next;
  }

  async createAgent(request: AgentCreateRequest): Promise<AgentDefinition> {
    const name = request.name.trim();

    if (!name) {
      throw new Error('Agent name is required.');
    }

    const reasoningEffort = request.reasoningEffort ?? request.aiSettings?.reasoningEffort ?? 'medium';

    const agent: AgentDefinition = {
      id: this.uniqueId(this.slugify(name), this.agents.map((candidate) => candidate.id)),
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

    this.agents = [...this.agents, agent];
    await this.saveAgents();
    return agent;
  }

  async deleteAgent(agentId: string): Promise<AgentDefinition> {
    const agent = this.agents.find((candidate) => candidate.id === agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (this.agents.length <= 1) {
      throw new Error('At least one agent must remain configured.');
    }

    this.agents = this.agents.filter((candidate) => candidate.id !== agentId);
    await this.saveAgents();
    return agent;
  }

  listConnectionStatuses(): AgentModelConnectionStatus[] {
    return this.connections.map((connection) => this.toStatus(connection));
  }

  listConnections(): AgentConnectionStatus[] {
    return this.connections.map((connection) => this.toStatus(connection));
  }

  listMcpServers(): McpServerStatus[] {
    return this.mcpServers.map((server) => this.toMcpStatus(server));
  }

  getResolvedMcpServer(serverId: string): ResolvedMcpServerDefinition {
    const server = this.mcpServers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    const endpoint = server.endpoint ?? (server.endpointEnv ? process.env[server.endpointEnv] : undefined);
    const bearerToken = this.resolveMcpBearerToken(server);
    const apiKey = this.resolveMcpApiKey(server);
    const customHeaders = Object.fromEntries(
      (server.customHeaders ?? []).flatMap((header) => {
        const value = this.resolveMcpCustomHeaderValue(server.id, header);
        return value ? [[header.name, value]] : [];
      })
    );
    const resolvedEndpoint = endpoint;
    const missing = [
      resolvedEndpoint ? undefined : server.endpointEnv ?? 'endpoint',
      server.authMode === 'bearer-token' && !bearerToken ? server.bearerTokenEnv ?? 'bearer token' : undefined,
      server.authMode === 'api-key' && !apiKey ? server.apiKeyEnv ?? 'api key' : undefined,
      server.authMode === 'entra' && !server.audience ? 'audience' : undefined,
      server.authMode === 'custom-headers' && (server.customHeaders ?? []).some((header) => !this.resolveMcpCustomHeaderValue(server.id, header)) ? 'custom headers' : undefined
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

  getConnection(connectionId: string): AgentModelConnection {
    const connection = this.connections.find((candidate) => candidate.id === connectionId);

    if (!connection || connection.type !== 'azure-openai') {
      throw new Error(`Agent model connection not found: ${connectionId}`);
    }

    return connection;
  }

  getSearchConnection(connectionId: string): AzureAiSearchConnectionDefinition {
    const connection = this.connections.find((candidate) => candidate.id === connectionId);

    if (!connection || connection.type !== 'azure-ai-search') {
      throw new Error(`Azure AI Search connector not found: ${connectionId}`);
    }

    return connection;
  }

  resolveApiKey(connection: AgentConnection): string | undefined {
    return this.secrets[connection.id]?.apiKey ?? (connection.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined);
  }

  getConnectionStatus(connectionId: string): AgentModelConnectionStatus {
    return this.toStatus(this.getConnection(connectionId));
  }

  async saveMcpServer(request: McpServerSaveRequest): Promise<McpServerStatus> {
    const name = request.name.trim();

    if (!name) {
      throw new Error('MCP server name is required.');
    }

    const id = request.id?.trim() || this.uniqueId(this.slugify(name), this.mcpServers.map((server) => server.id));
    const current = this.mcpServers.find((server) => server.id === id);
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

    const index = this.mcpServers.findIndex((server) => server.id === id);
    this.mcpServers = index === -1
      ? [...this.mcpServers, next]
      : this.mcpServers.map((server) => server.id === id ? next : server);

    const currentSecrets = this.mcpSecrets[id] ?? {};
    const nextSecrets: McpServerSecrets[string] = {
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
      await this.saveMcpSecrets();
    } else if (this.mcpSecrets[id]) {
      delete this.mcpSecrets[id];
      await this.saveMcpSecrets();
    }

    await this.saveMcpServers();
    return this.toMcpStatus(next);
  }

  async saveMcpServerTools(serverId: string, tools: McpServerToolDefinition[], warnings: string[]): Promise<McpServerStatus> {
    const server = this.mcpServers.find((candidate) => candidate.id === serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    const next: McpServerDefinition = {
      ...server,
      discoveredTools: tools,
      toolsDiscoveredAt: new Date().toISOString(),
      toolDiscoveryWarnings: warnings
    };
    this.mcpServers = this.mcpServers.map((candidate) => candidate.id === serverId ? next : candidate);
    await this.saveMcpServers();
    return this.toMcpStatus(next);
  }

  async deleteMcpServer(serverId: string): Promise<McpServerStatus> {
    const server = this.mcpServers.find((candidate) => candidate.id === serverId);

    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    const usedByAgents = this.agents
      .filter((agent) => agent.mcpServerIds?.includes(serverId))
      .map((agent) => agent.name);

    if (usedByAgents.length > 0) {
      throw new Error(`MCP server ${server.name} is still attached to ${usedByAgents.join(', ')}.`);
    }

    this.mcpServers = this.mcpServers.filter((candidate) => candidate.id !== serverId);

    if (this.mcpSecrets[serverId]) {
      delete this.mcpSecrets[serverId];
      await this.saveMcpSecrets();
    }

    await this.saveMcpServers();
    return this.toMcpStatus(server);
  }

  async saveConnection(request: AgentConnectionSaveRequest): Promise<AgentConnectionStatus> {
    const name = request.name.trim();

    if (!name) {
      throw new Error('Connector name is required.');
    }

    const id = request.id?.trim() || this.uniqueId(this.slugify(name), this.connections.map((connection) => connection.id));
    const current = this.connections.find((connection) => connection.id === id);
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

    const index = this.connections.findIndex((connection) => connection.id === id);
    this.connections = index === -1
      ? [...this.connections, next]
      : this.connections.map((connection) => connection.id === id ? next : connection);

    if (request.apiKey?.trim()) {
      this.secrets[id] = { apiKey: request.apiKey.trim() };
      await this.saveSecrets();
    } else if (authMode === 'entra' && this.secrets[id]) {
      delete this.secrets[id];
      await this.saveSecrets();
    }

    await this.saveConnections();
    return this.toStatus(next);
  }

  async deleteConnection(connectionId: string): Promise<AgentConnectionStatus> {
    const connection = this.connections.find((candidate) => candidate.id === connectionId);

    if (!connection) {
      throw new Error(`Connector not found: ${connectionId}`);
    }

    const modelUsers = this.agents
      .filter((agent) => agent.modelConnectionId === connectionId)
      .map((agent) => agent.name);
    const groundingUsers = this.agents
      .filter((agent) => agent.groundingSources.some((source) => source.type === 'azure-ai-search' && source.connectorId === connectionId))
      .map((agent) => agent.name);

    if (modelUsers.length > 0 || groundingUsers.length > 0) {
      const usages = [
        modelUsers.length > 0 ? `model for ${modelUsers.join(', ')}` : undefined,
        groundingUsers.length > 0 ? `grounding for ${groundingUsers.join(', ')}` : undefined
      ].filter((value): value is string => Boolean(value));
      throw new Error(`Connector ${connection.name} is still in use as ${usages.join(' and ')}.`);
    }

    this.connections = this.connections.filter((candidate) => candidate.id !== connectionId);

    if (this.secrets[connectionId]) {
      delete this.secrets[connectionId];
      await this.saveSecrets();
    }

    await this.saveConnections();
    return this.toStatus(connection);
  }

  private toStatus(connection: AgentConnection): AgentConnectionStatus {
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
    const bearerToken = this.resolveMcpBearerToken(server);
    const apiKey = this.resolveMcpApiKey(server);
    const customHeaders = server.customHeaders?.map((header) => ({
      name: header.name,
      configured: Boolean(this.resolveMcpCustomHeaderValue(server.id, header)),
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

  private async saveAgents(): Promise<void> {
    if (this.cosmosContainer) {
      await this.upsertConfigDocument('agents', this.agents);
      return;
    }

    await writeFile(path.join(this.configRoot, 'agents.json'), `${JSON.stringify(this.agents, null, 2)}\n`, 'utf8');
  }

  private async saveConnections(): Promise<void> {
    if (this.cosmosContainer) {
      await this.upsertConfigDocument('connections', this.connections);
      return;
    }

    await writeFile(path.join(this.configRoot, 'agent-connections.json'), `${JSON.stringify(this.connections, null, 2)}\n`, 'utf8');
  }

  private async saveMcpServers(): Promise<void> {
    if (this.cosmosContainer) {
      await this.upsertConfigDocument('mcpServers', this.mcpServers);
      return;
    }

    await writeFile(path.join(this.configRoot, 'mcp-servers.json'), `${JSON.stringify(this.mcpServers, null, 2)}\n`, 'utf8');
  }

  private async saveWorkspaceTemplates(): Promise<void> {
    if (this.cosmosContainer) {
      await this.upsertConfigDocument('workspaceTemplates', this.workspaceTemplates);
      return;
    }

    await writeFile(path.join(this.configRoot, 'workspace-templates.json'), `${JSON.stringify(this.workspaceTemplates, null, 2)}\n`, 'utf8');
  }

  private async saveAdminSettings(): Promise<void> {
    await writeFile(path.join(this.configRoot, 'admin-settings.json'), `${JSON.stringify({ classificationBar: this.classificationBarSettings }, null, 2)}\n`, 'utf8');
  }

  private async readOptionalConfig(fileName: string, fallback: string): Promise<string> {
    try {
      return await readFile(path.join(this.configRoot, fileName), 'utf8');
    } catch {
      return fallback;
    }
  }

  private createCosmosContainer(): Container | undefined {
    const endpoint = process.env.COSMOS_DB_ENDPOINT;

    if (!endpoint) {
      console.info('[config-store] Cosmos DB config storage is disabled; using local JSON files.');
      updatePersistenceMode({ scope: 'config-store', configured: 'local', effective: 'local', fallbackActive: false });
      return undefined;
    }

    const requestedAuthMode = (process.env.COSMOS_DB_AUTH_MODE ?? 'entra').trim().toLowerCase();
    const authMode: CosmosAuthMode = requestedAuthMode === 'api-key' ? 'api-key' : 'entra';
    const databaseId = process.env.COSMOS_DB_DATABASE ?? 'JuniorWeb';
    const containerId = process.env.COSMOS_DB_CONFIG_CONTAINER ?? 'Agents';
    const keyConfigured = Boolean(process.env.COSMOS_DB_KEY);

    if (requestedAuthMode !== 'entra' && requestedAuthMode !== 'api-key') {
      console.warn(`[config-store] Unsupported COSMOS_DB_AUTH_MODE="${requestedAuthMode}"; using Entra ID auth.`);
    }

    if (authMode === 'api-key' && !keyConfigured) {
      throw new Error('COSMOS_DB_KEY is required when COSMOS_DB_AUTH_MODE=api-key.');
    }

    this.cosmosSettings = {
      endpointHost: this.endpointHost(endpoint),
      databaseId,
      containerId,
      authMode,
      keyConfigured
    };

    console.info(`[config-store] Cosmos DB config storage enabled: endpointHost=${this.cosmosSettings.endpointHost}, database=${databaseId}, container=${containerId}, authMode=${authMode}, keyConfigured=${keyConfigured}.`);
    updatePersistenceMode({ scope: 'config-store', configured: 'cosmos', effective: 'cosmos', fallbackActive: false });

    const client = authMode === 'api-key'
      ? new CosmosClient({ endpoint, key: process.env.COSMOS_DB_KEY })
      : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });

    return client.database(databaseId).container(containerId);
  }

  private async loadFromCosmos(seedAgents: AgentDefinition[], seedConnections: AgentConnection[], seedMcpServers: McpServerDefinition[], seedWorkspaceTemplates: WorkspaceTemplateDefinition[]): Promise<{ agents: AgentDefinition[]; connections: AgentConnection[]; mcpServers: McpServerDefinition[]; workspaceTemplates: WorkspaceTemplateDefinition[] }> {
    try {
      const [agents, connections, mcpServers, workspaceTemplates] = await Promise.all([
        this.readConfigDocument('agents', seedAgents),
        this.readConfigDocument('connections', seedConnections),
        this.readConfigDocument('mcpServers', seedMcpServers),
        this.readConfigDocument('workspaceTemplates', seedWorkspaceTemplates)
      ]);

      console.info('[config-store] Loaded agent and connector configuration from Cosmos DB.');
      return { agents, connections, mcpServers, workspaceTemplates };
    } catch (error) {
      this.logCosmosError('load configuration from Cosmos DB', error);
      console.warn('[config-store] Falling back to local JSON config because Cosmos DB is unavailable.');
      this.cosmosContainer = undefined;
      updatePersistenceMode({ scope: 'config-store', configured: 'cosmos', effective: 'local', fallbackActive: true, reason: error instanceof Error ? error.message : String(error) });
      return {
        agents: seedAgents,
        connections: seedConnections,
        mcpServers: seedMcpServers,
        workspaceTemplates: seedWorkspaceTemplates
      };
    }
  }

  private async readConfigDocument<T>(id: string, seedItems: T[]): Promise<T[]> {
    if (!this.cosmosContainer) {
      return seedItems;
    }

    try {
      const { resource } = await this.cosmosContainer.item(id, id).read<ConfigDocument<T>>();

      if (resource?.items) {
        return resource.items;
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 404)) {
        throw error;
      }
    }

    await this.upsertConfigDocument(id, seedItems);
    return seedItems;
  }

  private async upsertConfigDocument<T>(id: string, items: T[]): Promise<void> {
    if (!this.cosmosContainer) {
      return;
    }

    try {
      await this.cosmosContainer.items.upsert<ConfigDocument<T>>({ id, items });
      console.info(`[config-store] Saved "${id}" configuration document to Cosmos DB.`);
    } catch (error) {
      this.logCosmosError(`save "${id}" configuration document to Cosmos DB`, error);
      throw error;
    }
  }

  private cleanTemplateReferences(label: string, values: string[] | undefined, validValues: string[]): string[] | undefined {
    const cleaned = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
    const valid = new Set(validValues);
    const invalid = cleaned.filter((value) => !valid.has(value));
    if (invalid.length > 0) {
      throw new Error(`Unknown ${label}: ${invalid.join(', ')}.`);
    }

    return cleaned.length > 0 ? cleaned : undefined;
  }

  private cleanTemplateDirectories(values: string[] | undefined): string[] | undefined {
    const directories = Array.from(new Set((values ?? []).map((value) => this.normalizeTemplatePath(value)).filter(Boolean)));
    return directories.length > 0 ? directories : undefined;
  }

  private cleanTemplateFiles(values: Array<{ path: string; content: string }> | undefined): Array<{ path: string; content: string }> | undefined {
    const seen = new Set<string>();
    const files = (values ?? []).map((file) => {
      const path = this.normalizeTemplatePath(file.path);
      if (seen.has(path)) {
        throw new Error(`Workspace template contains duplicate file path: ${path}.`);
      }
      seen.add(path);
      if (typeof file.content !== 'string') {
        throw new Error(`Workspace template file ${path} must include text content.`);
      }
      return { path, content: file.content };
    });

    return files.length > 0 ? files : undefined;
  }

  private normalizeTemplatePath(value: string): string {
    const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    const segments = normalized.split('/');
    if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Invalid workspace template path: ${value}`);
    }
    return normalized;
  }

  private normalizeClassificationBarSettings(settings?: Partial<ClassificationBarSettings>): ClassificationBarSettings {
    const text = settings?.text?.trim() ?? '';
    const color = settings?.color?.trim();

    return {
      text,
      color: color && /^#[0-9a-fA-F]{6}$/.test(color)
        ? color
        : defaultClassificationBarSettings.color
    };
  }

  private logCosmosError(operation: string, error: unknown): void {
    const settings = this.cosmosSettings;
    const details = error && typeof error === 'object'
      ? {
        code: 'code' in error ? error.code : undefined,
        substatus: 'substatus' in error ? error.substatus : undefined,
        message: 'message' in error ? error.message : undefined
      }
      : { code: undefined, substatus: undefined, message: String(error) };
    const localAuthDisabledHint = settings?.authMode === 'api-key' && details.code === 401 && details.substatus === 5202
      ? ' Cosmos reported local/key authorization is disabled for this account; enable local auth on the account or use COSMOS_DB_AUTH_MODE=entra.'
      : '';

    console.error(`[config-store] Failed to ${operation}: endpointHost=${settings?.endpointHost ?? 'unknown'}, database=${settings?.databaseId ?? 'unknown'}, container=${settings?.containerId ?? 'unknown'}, authMode=${settings?.authMode ?? 'unknown'}, keyConfigured=${settings?.keyConfigured ?? false}, code=${details.code ?? 'unknown'}, substatus=${details.substatus ?? 'unknown'}, message=${details.message ?? 'unknown'}.${localAuthDisabledHint}`);
  }

  private endpointHost(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return 'invalid-endpoint';
    }
  }

  private async loadSecrets(): Promise<ConnectorSecrets> {
    try {
      return JSON.parse(await readFile(this.secretsPath(), 'utf8')) as ConnectorSecrets;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return {};
      }

      throw error;
    }
  }

  private async saveSecrets(): Promise<void> {
    await writeFile(this.secretsPath(), `${JSON.stringify(this.secrets, null, 2)}\n`, 'utf8');
  }

  private async loadMcpSecrets(): Promise<McpServerSecrets> {
    try {
      return JSON.parse(await readFile(this.mcpSecretsPath(), 'utf8')) as McpServerSecrets;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return {};
      }

      throw error;
    }
  }

  private async saveMcpSecrets(): Promise<void> {
    await writeFile(this.mcpSecretsPath(), `${JSON.stringify(this.mcpSecrets, null, 2)}\n`, 'utf8');
  }

  private secretsPath(): string {
    return path.join(this.configRoot, 'connector-secrets.local.json');
  }

  private mcpSecretsPath(): string {
    return path.join(this.configRoot, 'mcp-secrets.local.json');
  }

  private defaultEndpointEnv(type: AgentConnection['type'], id: string): string {
    return `${this.envPrefix(type, id)}_ENDPOINT`;
  }

  private defaultApiKeyEnv(type: AgentConnection['type'], id: string): string {
    return `${this.envPrefix(type, id)}_API_KEY`;
  }

  private defaultMcpEndpointEnv(id: string): string {
    return `${this.mcpEnvPrefix(id)}_ENDPOINT`;
  }

  private defaultMcpBearerTokenEnv(id: string): string {
    return `${this.mcpEnvPrefix(id)}_BEARER_TOKEN`;
  }

  private defaultMcpApiKeyEnv(id: string): string {
    return `${this.mcpEnvPrefix(id)}_API_KEY`;
  }

  private envPrefix(type: AgentConnection['type'], id: string): string {
    return `${type === 'azure-openai' ? 'AZURE_OPENAI' : 'AZURE_AI_SEARCH'}_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  }

  private mcpEnvPrefix(id: string): string {
    return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
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

  private cleanMcpServerIds(ids?: string[]): string[] | undefined {
    const next = Array.from(new Set(ids?.map((id) => id.trim()).filter(Boolean) ?? []));
    const invalid = next.filter((id) => !this.mcpServers.some((server) => server.id === id));

    if (invalid.length > 0) {
      throw new Error(`Unknown MCP server selection: ${invalid.join(', ')}`);
    }

    return next.length > 0 ? next : undefined;
  }

  private resolveMcpApiKey(server: McpServerDefinition): string | undefined {
    return this.mcpSecrets[server.id]?.apiKey ?? (server.apiKeyEnv ? process.env[server.apiKeyEnv] : undefined);
  }

  private resolveMcpBearerToken(server: McpServerDefinition): string | undefined {
    return this.mcpSecrets[server.id]?.bearerToken ?? (server.bearerTokenEnv ? process.env[server.bearerTokenEnv] : undefined);
  }

  private resolveMcpCustomHeaderValue(serverId: string, header: McpCustomHeader): string | undefined {
    return this.mcpSecrets[serverId]?.customHeaders?.[header.name] ?? (header.valueEnv ? process.env[header.valueEnv] : undefined);
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

  private workspaceTemplateAgentsFor(workspace?: WorkspaceSummary): AgentDefinition[] {
    const workspaceTemplate = workspace?.templateId
      ? this.workspaceTemplates.find((candidate) => candidate.id === workspace.templateId)
      : undefined;

    if (!workspaceTemplate?.agentTemplateIds?.length) {
      return [];
    }

    return workspaceTemplate.agentTemplateIds
      .map((templateId) => this.agentTemplates.find((candidate) => candidate.id === templateId))
      .filter((template): template is AgentTemplateDefinition => Boolean(template))
      .map((template) => this.materializeAgentTemplate(template, workspaceTemplate));
  }

  materializeAgentTemplate(template: AgentTemplateDefinition, workspaceTemplate: WorkspaceTemplateDefinition): AgentDefinition {
    const fallbackModelConnectionId = workspaceTemplate.connectorIds?.find((connectionId) => {
      const connection = this.connections.find((candidate) => candidate.id === connectionId);
      return connection?.type === 'azure-openai';
    }) ?? this.connections.find((connection) => connection.type === 'azure-openai')?.id;

    return {
      id: this.workspaceTemplateAgentId(template.id),
      name: template.name,
      description: template.description,
      instructions: template.instructions,
      modelConnectionId: template.suggestedModelConnectionId ?? fallbackModelConnectionId ?? this.agents[0]?.modelConnectionId ?? '',
      tools: ['read_file', 'search_files', 'grep_search', 'semantic_search', 'write_file', 'edit_file'],
      groundingSources: template.groundingSources ?? [
        {
          id: 'workspace',
          type: 'workspace-index',
          label: 'Workspace index',
          enabled: true,
          top: 5
        }
      ],
      mcpServerIds: template.mcpServerIds
    };
  }

  materializeMcpCatalogEntry(entry: McpCatalogEntry): McpServerDefinition {
    return {
      id: entry.id,
      name: entry.name,
      transport: entry.transport,
      endpoint: entry.endpoint,
      endpointEnv: this.defaultMcpEndpointEnv(entry.id),
      authMode: entry.authMode,
      bearerTokenEnv: this.defaultMcpBearerTokenEnv(entry.id),
      apiKeyEnv: this.defaultMcpApiKeyEnv(entry.id),
      audience: entry.audience,
      customHeaders: this.cleanMcpHeaders(entry.customHeaders)
    };
  }

  private workspaceTemplateAgentId(templateId: string): string {
    return `workspace-template:${templateId}`;
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'connector';
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
