import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentConnection, AgentConnectionSaveRequest, AgentConnectionStatus, AgentCreateRequest, AgentDefinition, AgentModelConnection, AgentModelConnectionStatus, AgentUpdateRequest, AzureAiSearchConnectionDefinition } from '../types.js';

type ConnectorSecrets = Record<string, { apiKey?: string }>;
type ConfigDocument<T> = { id: string; items: T[] };
type CosmosAuthMode = 'entra' | 'api-key';
type CosmosStoreSettings = {
  endpointHost: string;
  databaseId: string;
  containerId: string;
  authMode: CosmosAuthMode;
  keyConfigured: boolean;
};

export class AgentConfigStore {
  private agents: AgentDefinition[] = [];
  private connections: AgentConnection[] = [];
  private secrets: ConnectorSecrets = {};
  private cosmosContainer?: Container;
  private cosmosSettings?: CosmosStoreSettings;

  constructor(private readonly configRoot: string) {}

  async load(): Promise<void> {
    const [agentsJson, connectionsJson] = await Promise.all([
      readFile(path.join(this.configRoot, 'agents.json'), 'utf8'),
      readFile(path.join(this.configRoot, 'agent-connections.json'), 'utf8')
    ]);

    const seedAgents = JSON.parse(agentsJson) as AgentDefinition[];
    const seedConnections = JSON.parse(connectionsJson) as AgentConnection[];
    this.cosmosContainer = this.createCosmosContainer();
    const cosmosConfig = this.cosmosContainer ? await this.loadFromCosmos(seedAgents, seedConnections) : undefined;

    this.agents = cosmosConfig?.agents ?? seedAgents;
    this.connections = cosmosConfig?.connections ?? seedConnections;
    this.secrets = await this.loadSecrets();
  }

  listAgents(): AgentDefinition[] {
    return this.agents;
  }

  getAgent(agentId?: string): AgentDefinition {
    const agent = this.agents.find((candidate) => candidate.id === agentId) ?? this.agents[0];

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
    const next: AgentDefinition = {
      ...current,
      name: update.name?.trim() || current.name,
      description: update.description ?? current.description,
      modelConnectionId: update.modelConnectionId ?? current.modelConnectionId,
      instructions: update.instructions ?? current.instructions,
      groundingSources: update.groundingSources ?? current.groundingSources
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

    const agent: AgentDefinition = {
      id: this.uniqueId(this.slugify(name), this.agents.map((candidate) => candidate.id)),
      name,
      description: request.description?.trim() ?? '',
      instructions: request.instructions,
      modelConnectionId: request.modelConnectionId,
      tools: ['read_file', 'search_files', 'grep_search', 'semantic_search', 'write_file', 'edit_file', 'publish_package'],
      groundingSources: request.groundingSources ?? [
        {
          id: 'workspace',
          type: 'workspace-index',
          label: 'Workspace index',
          enabled: true,
          top: 5
        }
      ]
    };

    this.agents = [...this.agents, agent];
    await this.saveAgents();
    return agent;
  }

  listConnectionStatuses(): AgentModelConnectionStatus[] {
    return this.connections.map((connection) => this.toStatus(connection));
  }

  listConnections(): AgentConnectionStatus[] {
    return this.connections.map((connection) => this.toStatus(connection));
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

  private toStatus(connection: AgentConnection): AgentConnectionStatus {
    const endpoint = connection.endpoint ?? (connection.endpointEnv ? process.env[connection.endpointEnv] : undefined);
    const authMode = connection.authMode ?? 'entra';
    const apiKey = this.resolveApiKey(connection);
    const missing = [
      endpoint ? undefined : connection.endpointEnv ?? 'endpoint',
      connection.type === 'azure-openai' && !(connection.deployment ?? (connection.deploymentEnv ? process.env[connection.deploymentEnv] : undefined)) ? connection.deploymentEnv ?? 'deployment' : undefined,
      authMode === 'api-key' && !apiKey ? connection.apiKeyEnv ?? 'api key' : undefined
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

  private createCosmosContainer(): Container | undefined {
    const endpoint = process.env.COSMOS_DB_ENDPOINT;

    if (!endpoint) {
      console.info('[config-store] Cosmos DB config storage is disabled; using local JSON files.');
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

    const client = authMode === 'api-key'
      ? new CosmosClient({ endpoint, key: process.env.COSMOS_DB_KEY })
      : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });

    return client.database(databaseId).container(containerId);
  }

  private async loadFromCosmos(seedAgents: AgentDefinition[], seedConnections: AgentConnection[]): Promise<{ agents: AgentDefinition[]; connections: AgentConnection[] }> {
    try {
      const [agents, connections] = await Promise.all([
        this.readConfigDocument('agents', seedAgents),
        this.readConfigDocument('connections', seedConnections)
      ]);

      console.info('[config-store] Loaded agent and connector configuration from Cosmos DB.');
      return { agents, connections };
    } catch (error) {
      this.logCosmosError('load configuration from Cosmos DB', error);
      throw error;
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

  private secretsPath(): string {
    return path.join(this.configRoot, 'connector-secrets.local.json');
  }

  private defaultEndpointEnv(type: AgentConnection['type'], id: string): string {
    return `${this.envPrefix(type, id)}_ENDPOINT`;
  }

  private defaultApiKeyEnv(type: AgentConnection['type'], id: string): string {
    return `${this.envPrefix(type, id)}_API_KEY`;
  }

  private envPrefix(type: AgentConnection['type'], id: string): string {
    return `${type === 'azure-openai' ? 'AZURE_OPENAI' : 'AZURE_AI_SEARCH'}_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  }

  private cleanList(values?: string[]): string[] | undefined {
    const next = values?.map((value) => value.trim()).filter(Boolean) ?? [];
    return next.length > 0 ? next : undefined;
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
