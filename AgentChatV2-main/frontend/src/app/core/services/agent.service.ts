import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '@env/environment';

export interface MCPToolConfig {
  name: string;
  server_url?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface MCPServerConfig {
  id?: string;
  name: string;
  url: string;
  description?: string;
  discovered_tools: MCPToolConfig[];
  is_active?: boolean;
  last_discovered_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface MCPDiscoveryRequest {
  url: string;
  name?: string;
}

export interface MCPDiscoveryResponse {
  url: string;
  name?: string;
  tools: MCPToolConfig[];
  error?: string;
}

export interface MCPServerListResponse {
  servers: MCPServerConfig[];
  count: number;
}

// A2A (Agent-to-Agent) Protocol Types
export type AgentType = 'local' | 'a2a';

export interface A2AAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  protocol_version?: string;
  skills?: A2AAgentSkill[];
  capabilities?: Record<string, unknown>;
  default_input_modes?: string[];
  default_output_modes?: string[];
}

export interface A2ADiscoveryRequest {
  url: string;
  card_path?: string;
  a2a_client_id?: string;
  a2a_scope?: string;
}

export interface A2ADiscoveryResponse {
  url: string;
  name: string;
  description?: string;
  skills_count: number;
  card: A2AAgentCard;
  error?: string;
}

export interface A2ATestResponse {
  success: boolean;
  agent_name?: string;
  description?: string;
  skills_count: number;
  error?: string;
}

// Grounding configuration for document RAG
export interface GroundingSource {
  type?: 'managed' | 'external';  // 'managed' (blob-indexed) or 'external' (pre-existing index)
  container_url: string;  // Azure Blob Storage container URL (for managed)
  name?: string;          // Friendly name for the source
  description?: string;   // Description of what documents are in this source
  blob_prefix?: string;   // Optional prefix to filter blobs
  index_name?: string;    // Azure AI Search index name (for external)
}

export interface GroundingValidationResponse {
  valid: boolean;
  message: string;
  is_available: boolean;
}

export interface GroundingStatusResponse {
  available: boolean;
  message: string;
}

export interface ReindexResponse {
  message: string;
  index_name: string;
  document_count: number;
}

export interface SearchIndexInfo {
  name: string;
  field_count: number;
  document_count: number | null;
}

export interface SearchIndexListResponse {
  indexes: SearchIndexInfo[];
  count: number;
}

// Azure OpenAI Endpoint Types
export interface ModelDeployment {
  deployment_name: string;
  model_name: string;
  model_version?: string;
  capacity?: number;
  sku?: string;
}

export interface AOAIEndpointConfig {
  id?: string;
  name: string;
  endpoint: string;
  endpoint_type?: string;  // 'azure_openai' (default) or 'apim'
  cloud?: string;  // AzureCommercial, AzureGovernment, AzureChina
  api_version?: string;
  api_key?: string;  // Optional - uses managed identity if not provided; APIM subscription key for apim type
  // ARM API info for deployment discovery (required for auto-discovery, not used for APIM)
  subscription_id?: string;
  resource_group?: string;
  is_active?: boolean;
  description?: string;
  deployments?: ModelDeployment[];
  last_discovered_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AOAIEndpointListResponse {
  endpoints: AOAIEndpointConfig[];
  count: number;
}

export interface AOAIDeploymentOption {
  endpoint_id: string;
  endpoint_name: string;
  deployment_name: string;
  model_name: string;
  model_version?: string;
}

export interface AOAIDeploymentListResponse {
  deployments: AOAIDeploymentOption[];
  count: number;
}

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  agent_type?: AgentType;  // 'local' or 'a2a'
  ui_capabilities?: {
    html_preview?: boolean;
    structured_input_form?: boolean;
  };
  
  // For local agents (model is required for local agents)
  system_prompt?: string;  // Required for local, optional for A2A
  model?: string;  // Required for local agents - Azure OpenAI deployment name
  aoai_endpoint_id?: string;  // Reference to an AOAI endpoint configuration
  temperature?: number;
  max_tokens?: number;
  mcp_tools?: MCPToolConfig[];
  mcp_servers?: string[];
  
  // Grounding sources for document RAG
  grounding_sources?: GroundingSource[];
  grounding_index_name?: string;  // System-managed, do not set manually
  has_grounding?: boolean;  // Lightweight flag from chat endpoint (no full sources)
  
  // For A2A agents
  a2a_url?: string;
  a2a_card?: A2AAgentCard;
  a2a_client_id?: string;  // Remote app registration client ID (triggers OBO when different)
  a2a_scope?: string;      // Custom OBO scope (defaults to api://{a2a_client_id}/.default)
  
  // Common
  is_orchestrator?: boolean;
  a2a_enabled?: boolean;
  
  // Orchestrator-specific prompts (used when is_orchestrator=true)
  analysis_prompt?: string;   // Phase 1: Analyze request and decide delegation
  synthesis_prompt?: string;  // Phase 3: Synthesize specialist responses
  
  created_at?: string;
  updated_at?: string;
}

export interface AgentListResponse {
  agents: AgentConfig[];
  count: number;
}

@Injectable({ providedIn: 'root' })
export class AgentService {
  // Admin endpoints (require admin role)
  private readonly adminApiUrl = environment.apiUrl + '/admin/agents';
  private readonly mcpApiUrl = environment.apiUrl + '/admin/mcp-servers';
  
  // User endpoints (no admin required)
  private readonly chatApiUrl = environment.apiUrl + '/chat/agents';
  
  private agentsSubject = new BehaviorSubject<AgentConfig[]>([]);
  agents$ = this.agentsSubject.asObservable();
  
  private mcpServersSubject = new BehaviorSubject<MCPServerConfig[]>([]);
  mcpServers$ = this.mcpServersSubject.asObservable();
  
  constructor(private http: HttpClient) {}
  
  // =========================================================================
  // Agent Operations (for regular users - uses chat endpoint)
  // =========================================================================
  
  /**
   * Load available agents for chat selection (no admin required).
   * Returns only active agents with minimal info.
   */
  loadAgents(): Observable<AgentListResponse> {
    return this.http.get<AgentListResponse>(this.chatApiUrl).pipe(
      tap(response => this.agentsSubject.next(response.agents))
    );
  }
  
  // =========================================================================
  // Admin Agent Operations (require admin role)
  // =========================================================================
  
  /**
   * Load all agents with full config (admin only).
   */
  loadAgentsAdmin(): Observable<AgentListResponse> {
    return this.http.get<AgentListResponse>(this.adminApiUrl).pipe(
      tap(response => this.agentsSubject.next(response.agents))
    );
  }
  
  getAgent(agentId: string): Observable<AgentConfig> {
    return this.http.get<AgentConfig>(`${this.adminApiUrl}/${agentId}`);
  }
  
  createAgent(agent: AgentConfig): Observable<AgentConfig> {
    return this.http.post<AgentConfig>(this.adminApiUrl, agent).pipe(
      tap(() => this.loadAgentsAdmin().subscribe())
    );
  }
  
  updateAgent(agentId: string, agent: AgentConfig): Observable<AgentConfig> {
    return this.http.put<AgentConfig>(`${this.adminApiUrl}/${agentId}`, agent).pipe(
      tap(() => this.loadAgentsAdmin().subscribe())
    );
  }
  
  deleteAgent(agentId: string): Observable<void> {
    return this.http.delete<void>(`${this.adminApiUrl}/${agentId}`).pipe(
      tap(() => this.loadAgentsAdmin().subscribe())
    );
  }
  
  refreshCache(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${environment.apiUrl}/admin/agents/refresh`, {});
  }
  
  // =========================================================================
  // MCP Server Operations (admin only)
  // =========================================================================
  
  /**
   * Discover tools from an MCP server URL.
   * This probes the server and returns available tools without registering.
   */
  discoverMcpTools(request: MCPDiscoveryRequest): Observable<MCPDiscoveryResponse> {
    return this.http.post<MCPDiscoveryResponse>(`${this.mcpApiUrl}/discover`, request);
  }
  
  /**
   * Load all registered MCP servers.
   */
  loadMcpServers(): Observable<MCPServerListResponse> {
    return this.http.get<MCPServerListResponse>(this.mcpApiUrl).pipe(
      tap(response => this.mcpServersSubject.next(response.servers))
    );
  }
  
  /**
   * Get a specific MCP server by ID.
   */
  getMcpServer(serverId: string): Observable<MCPServerConfig> {
    return this.http.get<MCPServerConfig>(`${this.mcpApiUrl}/${serverId}`);
  }
  
  /**
   * Register a new MCP server (after discovery).
   */
  registerMcpServer(server: MCPServerConfig): Observable<MCPServerConfig> {
    return this.http.post<MCPServerConfig>(this.mcpApiUrl, server).pipe(
      tap(() => this.loadMcpServers().subscribe())
    );
  }
  
  /**
   * Update an existing MCP server configuration.
   */
  updateMcpServer(serverId: string, server: MCPServerConfig): Observable<MCPServerConfig> {
    return this.http.put<MCPServerConfig>(`${this.mcpApiUrl}/${serverId}`, server).pipe(
      tap(() => this.loadMcpServers().subscribe())
    );
  }
  
  /**
   * Delete an MCP server registration.
   */
  deleteMcpServer(serverId: string): Observable<void> {
    return this.http.delete<void>(`${this.mcpApiUrl}/${serverId}`).pipe(
      tap(() => this.loadMcpServers().subscribe())
    );
  }
  
  /**
   * Refresh/re-discover tools from an existing MCP server.
   */
  refreshMcpServer(serverId: string): Observable<MCPServerConfig> {
    return this.http.post<MCPServerConfig>(`${this.mcpApiUrl}/${serverId}/refresh`, {}).pipe(
      tap(() => this.loadMcpServers().subscribe())
    );
  }
  
  // =========================================================================
  // A2A (Agent-to-Agent) Operations
  // =========================================================================
  
  private readonly a2aApiUrl = environment.apiUrl + '/admin/a2a';
  
  /**
   * Discover an external A2A agent by fetching its agent card.
   * Use this to preview an agent before adding it.
   */
  discoverA2AAgent(request: A2ADiscoveryRequest): Observable<A2ADiscoveryResponse> {
    return this.http.post<A2ADiscoveryResponse>(`${this.a2aApiUrl}/discover`, request);
  }
  
  /**
   * Test connection to an external A2A agent.
   * Lightweight check to verify the agent is reachable.
   */
  testA2AConnection(request: A2ADiscoveryRequest): Observable<A2ATestResponse> {
    return this.http.post<A2ATestResponse>(`${this.a2aApiUrl}/test`, request);
  }
  
  /**
   * Discover and add an external A2A agent in one step.
   * Fetches the agent card and creates a new agent configuration.
   */
  addA2AAgent(request: A2ADiscoveryRequest): Observable<AgentConfig> {
    return this.http.post<AgentConfig>(`${this.a2aApiUrl}/add`, request).pipe(
      tap(() => this.loadAgents().subscribe())
    );
  }
  
  // =========================================================================
  // Grounding Operations (Document RAG)
  // =========================================================================
  
  private readonly groundingApiUrl = environment.apiUrl + '/admin/grounding';
  
  /**
   * Check if grounding service is available.
   */
  getGroundingStatus(): Observable<GroundingStatusResponse> {
    return this.http.get<GroundingStatusResponse>(`${this.groundingApiUrl}/status`);
  }
  
  /**
   * Validate a grounding source container URL.
   */
  validateGroundingSource(containerUrl: string): Observable<GroundingValidationResponse> {
    return this.http.post<GroundingValidationResponse>(
      `${this.groundingApiUrl}/validate`,
      { container_url: containerUrl }
    );
  }

  /**
   * Re-index grounding documents for an agent.
   * Deletes the existing index and rebuilds from blob sources with current schema/metadata.
   */
  reindexGrounding(agentId: string): Observable<ReindexResponse> {
    return this.http.post<ReindexResponse>(
      `${this.adminApiUrl}/${agentId}/reindex`,
      {}
    );
  }

  /**
   * List all Azure AI Search indexes available on the configured search service.
   * Used to populate the 'Use Existing Index' dropdown for BYOI.
   */
  listSearchIndexes(): Observable<SearchIndexListResponse> {
    return this.http.get<SearchIndexListResponse>(
      `${environment.apiUrl}/admin/search/indexes`
    );
  }
  
  // =========================================================================
  // Azure OpenAI Endpoint Operations
  // =========================================================================
  
  private readonly aoaiApiUrl = environment.apiUrl + '/admin/aoai-endpoints';
  
  private aoaiEndpointsSubject = new BehaviorSubject<AOAIEndpointConfig[]>([]);
  aoaiEndpoints$ = this.aoaiEndpointsSubject.asObservable();
  
  private deploymentsSubject = new BehaviorSubject<AOAIDeploymentOption[]>([]);
  deployments$ = this.deploymentsSubject.asObservable();
  
  /**
   * Load all registered Azure OpenAI endpoints.
   */
  loadAoaiEndpoints(): Observable<AOAIEndpointListResponse> {
    return this.http.get<AOAIEndpointListResponse>(this.aoaiApiUrl).pipe(
      tap(response => this.aoaiEndpointsSubject.next(response.endpoints))
    );
  }
  
  /**
   * Get all available model deployments across all endpoints.
   * Used to populate the model dropdown when creating/editing agents.
   */
  loadDeployments(): Observable<AOAIDeploymentListResponse> {
    return this.http.get<AOAIDeploymentListResponse>(`${this.aoaiApiUrl}/deployments`).pipe(
      tap(response => this.deploymentsSubject.next(response.deployments))
    );
  }
  
  /**
   * Get a specific Azure OpenAI endpoint.
   */
  getAoaiEndpoint(endpointId: string): Observable<AOAIEndpointConfig> {
    return this.http.get<AOAIEndpointConfig>(`${this.aoaiApiUrl}/${endpointId}`);
  }
  
  /**
   * Create a new Azure OpenAI endpoint.
   * Automatically discovers available model deployments.
   */
  createAoaiEndpoint(endpoint: AOAIEndpointConfig): Observable<AOAIEndpointConfig> {
    return this.http.post<AOAIEndpointConfig>(this.aoaiApiUrl, endpoint).pipe(
      tap(() => {
        this.loadAoaiEndpoints().subscribe();
        this.loadDeployments().subscribe();
      })
    );
  }
  
  /**
   * Update an existing Azure OpenAI endpoint.
   */
  updateAoaiEndpoint(endpointId: string, endpoint: AOAIEndpointConfig): Observable<AOAIEndpointConfig> {
    return this.http.put<AOAIEndpointConfig>(`${this.aoaiApiUrl}/${endpointId}`, endpoint).pipe(
      tap(() => {
        this.loadAoaiEndpoints().subscribe();
        this.loadDeployments().subscribe();
      })
    );
  }
  
  /**
   * Delete an Azure OpenAI endpoint.
   */
  deleteAoaiEndpoint(endpointId: string): Observable<void> {
    return this.http.delete<void>(`${this.aoaiApiUrl}/${endpointId}`).pipe(
      tap(() => {
        this.loadAoaiEndpoints().subscribe();
        this.loadDeployments().subscribe();
      })
    );
  }
  
  /**
   * Refresh/re-discover deployments from an existing Azure OpenAI endpoint.
   */
  refreshAoaiEndpoint(endpointId: string): Observable<AOAIEndpointConfig> {
    return this.http.post<AOAIEndpointConfig>(`${this.aoaiApiUrl}/${endpointId}/refresh`, {}).pipe(
      tap(() => {
        this.loadAoaiEndpoints().subscribe();
        this.loadDeployments().subscribe();
      })
    );
  }
}
