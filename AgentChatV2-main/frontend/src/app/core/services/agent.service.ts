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

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  agent_type?: AgentType;  // 'local' or 'a2a'
  
  // For local agents (model is required for local agents)
  system_prompt?: string;  // Required for local, optional for A2A
  model?: string;  // Required for local agents - Azure OpenAI deployment name
  temperature?: number;
  max_tokens?: number;
  mcp_tools?: MCPToolConfig[];
  mcp_servers?: string[];
  
  // For A2A agents
  a2a_url?: string;
  a2a_card?: A2AAgentCard;
  
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
}
