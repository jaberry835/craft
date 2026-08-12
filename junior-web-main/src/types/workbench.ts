export type TreeNodeType = 'file' | 'directory';

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: TreeNodeType;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
  updatedAt: string;
}

export interface WorkspaceIndexEntry {
  path: string;
  extension: string;
  modifiedAt: string;
  size: number;
  hash: string;
  indexed: boolean;
}

export interface WorkspaceIndex {
  generatedAt: string;
  fileCount: number;
  indexedFileCount: number;
  totalBytes: number;
  entries: WorkspaceIndexEntry[];
  packageSections: string[];
}

export interface WorkspaceSearchResult {
  path: string;
  score: number;
  preview: string;
  matchedTerms: string[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  rootPath: string;
  templateId?: string;
  templateName?: string;
}

export interface RequestIdentitySummary {
  userId: string;
  displayName: string;
  tenantId?: string;
  roles: string[];
  authSource: 'local-fallback' | 'trusted-header' | 'token';
  isAuthenticated: boolean;
}

export interface AuthConfig {
  identityMode: 'local-fallback' | 'trusted-header' | 'entra-msal';
  authRequired: boolean;
  providerName: string | null;
  signInPath: string | null;
  signOutPath: string | null;
  clientId: string | null;
  tenantId: string | null;
  authority: string | null;
  scopes: string[];
  redirectUri: string | null;
  postLogoutRedirectUri: string | null;
}

export interface AuthDiagnostics {
  identity: RequestIdentitySummary | null;
  tokenClaims: {
    aud?: string;
    iss?: string;
    oid?: string;
    tid?: string;
    name?: string;
    preferred_username?: string;
    scp?: string;
    roles?: string[];
  } | null;
}

export type ConnectivityState = 'ok' | 'error' | 'disabled';

export interface ConnectivityCheck {
  id: string;
  label: string;
  status: ConnectivityState;
  message: string;
  detail?: string;
}

export interface ConnectivitySection {
  id: 'cosmos' | 'storage' | 'secrets' | 'ai';
  label: string;
  status: ConnectivityState;
  message: string;
  checks: ConnectivityCheck[];
}

export interface AdminConnectivityReport {
  generatedAt: string;
  sections: ConnectivitySection[];
}

export interface AdminConnectivityTestResult {
  target: 'cosmos' | 'storage';
  startedAt: string;
  completedAt: string;
  status: ConnectivityState;
  message: string;
  checks: ConnectivityCheck[];
}

export interface ClassificationBarSettings {
  text: string;
  color: string;
}

export interface ClassificationBarSettingsSaveRequest {
  text: string;
  color: string;
}

export interface WorkspaceHistorySettings {
  enabled: boolean;
  includeReasoning: boolean;
}

export interface WorkspaceHistorySettingsSaveRequest {
  enabled?: boolean;
  includeReasoning?: boolean;
}

export interface WorkspaceCreateRequest {
  name: string;
  description?: string;
  templateId?: string;
  templateName?: string;
}

export interface WorkspaceUpdateRequest {
  name?: string;
  description?: string;
  templateId?: string;
  templateName?: string;
}

export interface WorkspaceTemplateImportRequest {
  templateId: string;
  agentTemplateIds?: string[];
  mcpCatalogIds?: string[];
  mcpServerIds?: string[];
  connectorIds?: string[];
}

export interface WorkspaceTemplateImportResult {
  importedAgents: string[];
  importedConnections: string[];
  importedMcpServers: string[];
}

export interface WorkspaceTemplateDefinition {
  id: string;
  name: string;
  description: string;
  agentTemplateIds?: string[];
  mcpCatalogIds?: string[];
  mcpServerIds?: string[];
  connectorIds?: string[];
  directories?: string[];
  files?: WorkspaceTemplateFile[];
}

export interface WorkspaceTemplateSaveRequest {
  id?: string;
  name: string;
  description?: string;
  agentTemplateIds?: string[];
  mcpCatalogIds?: string[];
  mcpServerIds?: string[];
  connectorIds?: string[];
  directories?: string[];
  files?: WorkspaceTemplateFile[];
}

export interface WorkspaceTemplateFile {
  path: string;
  content: string;
}

export interface AgentTemplateDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  suggestedModelConnectionId?: string;
  groundingSources?: AgentGroundingSource[];
  mcpServerIds?: string[];
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  transport: McpServerTransport;
  endpoint?: string;
  authMode: McpServerAuthMode;
  audience?: string;
  customHeaders?: McpCustomHeader[];
}

export type AgentGroundingSourceType = 'workspace-index' | 'azure-ai-search';
export type SourceReferenceType = 'workspace-file' | 'search-indexed-chunk' | 'repository-file' | 'external-record';
export type SourceReferenceRetrievalKind = AgentGroundingSourceType | 'mcp';
export type SourceAttributionStrength = 'strong' | 'weak';

export interface SourceReference {
  label: string;
  sourceType: SourceReferenceType;
  retrievalKind: SourceReferenceRetrievalKind;
  attribution: SourceAttributionStrength;
  sourceSystem?: string;
  documentId?: string;
  chunkId?: string;
  repositoryId?: string;
  path?: string;
  workspacePath?: string;
  previewPath?: string;
  canonicalUrl?: string;
  externalUrl?: string;
  versionId?: string;
  sourceVersion?: string;
  mediaType?: string;
  sectionLabel?: string;
  pageNumber?: number;
  chunkOrdinal?: number;
  lastIndexedAt?: string;
}

export interface AgentGroundingSourceBase {
  id: string;
  type: AgentGroundingSourceType;
  label: string;
  enabled: boolean;
  top?: number;
}

export interface WorkspaceIndexGroundingSource extends AgentGroundingSourceBase {
  type: 'workspace-index';
}

export interface AzureAiSearchGroundingSource extends AgentGroundingSourceBase {
  type: 'azure-ai-search';
  connectorId?: string;
  endpoint?: string;
  endpointEnv?: string;
  indexName?: string;
  indexNameEnv?: string;
  keyEnv?: string;
  queryType?: 'simple' | 'full' | 'semantic';
  semanticConfiguration?: string;
  selectFields?: string[];
  titleField?: string;
  contentFields?: string[];
  pathField?: string;
  canonicalUrlField?: string;
  sourceSystemField?: string;
  documentIdField?: string;
  chunkIdField?: string;
  repositoryIdField?: string;
  mediaTypeField?: string;
  sectionField?: string;
  pageNumberField?: string;
  chunkOrdinalField?: string;
  lastIndexedAtField?: string;
  sourceVersionField?: string;
  filter?: string;
}

export type AgentGroundingSource = WorkspaceIndexGroundingSource | AzureAiSearchGroundingSource;

export type AzureAuthMode = 'entra' | 'api-key';
export type AzureCloud = 'public' | 'usgovernment' | 'china' | 'custom';
export type AzureOpenAiEndpointKind = 'auto' | 'foundry-project' | 'openai-v1' | 'azure-openai-legacy';
export type AgentConnectionType = 'azure-openai' | 'azure-ai-search';
export type McpServerTransport = 'http';
export type McpServerAuthMode = 'none' | 'bearer-token' | 'api-key' | 'entra' | 'custom-headers';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface McpCustomHeader {
  name: string;
  value?: string;
  valueEnv?: string;
}

export interface McpServerToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpServerDefinition {
  id: string;
  name: string;
  transport: McpServerTransport;
  endpoint?: string;
  endpointEnv?: string;
  authMode: McpServerAuthMode;
  bearerTokenEnv?: string;
  apiKeyEnv?: string;
  audience?: string;
  customHeaders?: McpCustomHeader[];
  discoveredTools?: McpServerToolDefinition[];
  toolsDiscoveredAt?: string;
  toolDiscoveryWarnings?: string[];
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpServerTransport;
  authMode: McpServerAuthMode;
  configured: boolean;
  missing: string[];
  endpoint?: string;
  endpointEnv?: string;
  hasBearerToken: boolean;
  bearerTokenEnv?: string;
  hasApiKey: boolean;
  apiKeyEnv?: string;
  audience?: string;
  customHeaders?: Array<{ name: string; configured: boolean; valueEnv?: string }>;
  discoveredTools: McpServerToolDefinition[];
  toolsDiscoveredAt?: string;
  toolDiscoveryWarnings: string[];
}

export interface McpServerSaveRequest {
  id?: string;
  name: string;
  transport: McpServerTransport;
  endpoint?: string;
  endpointEnv?: string;
  authMode: McpServerAuthMode;
  bearerToken?: string;
  bearerTokenEnv?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  audience?: string;
  customHeaders?: McpCustomHeader[];
}

export interface DiscoveredMcpTool {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolDiscoveryResult {
  tools: DiscoveredMcpTool[];
  warnings: string[];
}

export interface AzureOpenAiConnectionDefinition {
  id: string;
  name: string;
  type: 'azure-openai';
  authMode?: AzureAuthMode;
  cloud?: AzureCloud;
  endpointKind?: AzureOpenAiEndpointKind;
  endpoint?: string;
  endpointEnv?: string;
  apiKeyEnv?: string;
  credentialScope?: string;
  deployment?: string;
  deploymentEnv?: string;
  apiVersion?: string;
  apiVersionEnv?: string;
  defaultApiVersion?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AzureAiSearchConnectionDefinition {
  id: string;
  name: string;
  type: 'azure-ai-search';
  authMode?: AzureAuthMode;
  cloud?: AzureCloud;
  endpoint?: string;
  endpointEnv?: string;
  apiKeyEnv?: string;
  credentialScope?: string;
  audience?: string;
  indexNames?: string[];
  semanticConfigurations?: string[];
  queryType?: 'simple' | 'full' | 'semantic';
  top?: number;
}

export type AgentConnection = AzureOpenAiConnectionDefinition | AzureAiSearchConnectionDefinition;
export type AgentModelConnection = AzureOpenAiConnectionDefinition;

export interface AgentConnectionStatus {
  id: string;
  name: string;
  type: AgentConnectionType;
  authMode: AzureAuthMode;
  cloud: AzureCloud;
  endpointKind?: AzureOpenAiEndpointKind;
  configured: boolean;
  missing: string[];
  endpoint?: string;
  endpointEnv?: string;
  hasApiKey: boolean;
  apiKeyEnv?: string;
  credentialScope?: string;
  audience?: string;
  deployment?: string;
  deploymentEnv?: string;
  apiVersion?: string;
  defaultApiVersion?: string;
  temperature?: number;
  maxTokens?: number;
  indexNames?: string[];
  semanticConfigurations?: string[];
  queryType?: 'simple' | 'full' | 'semantic';
  top?: number;
}

export type AgentModelConnectionStatus = AgentConnectionStatus;

export interface AgentConnectionSaveRequest {
  id?: string;
  name: string;
  type: AgentConnectionType;
  authMode?: AzureAuthMode;
  cloud?: AzureCloud;
  endpointKind?: AzureOpenAiEndpointKind;
  endpoint?: string;
  endpointEnv?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  credentialScope?: string;
  audience?: string;
  deployment?: string;
  deploymentEnv?: string;
  apiVersion?: string;
  apiVersionEnv?: string;
  defaultApiVersion?: string;
  temperature?: number;
  maxTokens?: number;
  indexNames?: string[];
  semanticConfigurations?: string[];
  queryType?: 'simple' | 'full' | 'semantic';
  top?: number;
}

export interface AgentAiSettings {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelConnectionId: string;
  reasoningEffort?: ReasoningEffort;
  aiSettings?: AgentAiSettings;
  tools: string[];
  groundingSources: AgentGroundingSource[];
  mcpServerIds?: string[];
}

export interface AgentUpdateRequest {
  name?: string;
  description?: string;
  modelConnectionId?: string;
  reasoningEffort?: ReasoningEffort;
  aiSettings?: AgentAiSettings;
  instructions?: string;
  groundingSources?: AgentGroundingSource[];
  mcpServerIds?: string[];
}

export interface AgentCreateRequest {
  name: string;
  description?: string;
  instructions: string;
  modelConnectionId: string;
  reasoningEffort?: ReasoningEffort;
  aiSettings?: AgentAiSettings;
  groundingSources?: AgentGroundingSource[];
  mcpServerIds?: string[];
}

export interface GroundingSnippet {
  id: string;
  sourceId: string;
  sourceLabel: string;
  sourceType: AgentGroundingSourceType;
  sourceReference: SourceReference;
  title: string;
  content: string;
  path?: string;
  score?: number;
}

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatMessageReasoningPart {
  kind: 'reasoning';
  text: string;
}

export interface ChatMessageWorkingPart {
  kind: 'working';
  title: string;
  events: ToolEvent[];
}

export type ChatMessageDisplayPart = ChatMessageReasoningPart | ChatMessageWorkingPart;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  display?: ChatMessageDisplayPart[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AgentRunOptions {
  autoApproveChanges?: boolean;
}

export type ToolEventType = 'read' | 'search' | 'create' | 'edit' | 'ask';

export interface ToolEvent {
  id: string;
  type: ToolEventType;
  label: string;
  detail?: string;
  filePath?: string;
  createdAt: string;
}

export interface PendingChange {
  id: string;
  path: string;
  action: 'create' | 'edit' | 'delete';
  originalContent: string;
  proposedContent: string;
  summary: string;
  createdAt: string;
}

export interface AgentResponse {
  message: ChatMessage;
  sessionId: string;
  toolEvents: ToolEvent[];
  pendingChanges: PendingChange[];
  activeAgent: AgentDefinition;
  modelConnection: AgentModelConnectionStatus;
  grounding: GroundingSnippet[];
  changeHandling: 'review' | 'auto-apply';
  appliedChangeCount: number;
}

