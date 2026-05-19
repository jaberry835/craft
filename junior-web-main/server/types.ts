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

export type AgentGroundingSourceType = 'workspace-index' | 'azure-ai-search';

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
  filter?: string;
}

export type AgentGroundingSource = WorkspaceIndexGroundingSource | AzureAiSearchGroundingSource;

export type AzureAuthMode = 'entra' | 'api-key';
export type AzureCloud = 'public' | 'usgovernment' | 'china' | 'custom';
export type AgentConnectionType = 'azure-openai' | 'azure-ai-search';

export interface AgentConnectionBase {
  id: string;
  name: string;
  type: AgentConnectionType;
  authMode?: AzureAuthMode;
  cloud?: AzureCloud;
  endpoint?: string;
  endpointEnv?: string;
  apiKeyEnv?: string;
  credentialScope?: string;
}

export interface AzureOpenAiConnectionDefinition {
  id: string;
  name: string;
  type: 'azure-openai';
  authMode?: AzureAuthMode;
  cloud?: AzureCloud;
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
  endpointEnv: string;
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
  configured: boolean;
  missing: string[];
  authMode: AzureAuthMode;
  cloud: AzureCloud;
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

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelConnectionId: string;
  tools: string[];
  groundingSources: AgentGroundingSource[];
}

export interface AgentUpdateRequest {
  name?: string;
  description?: string;
  modelConnectionId?: string;
  instructions?: string;
  groundingSources?: AgentGroundingSource[];
}

export interface AgentCreateRequest {
  name: string;
  description?: string;
  instructions: string;
  modelConnectionId: string;
  groundingSources?: AgentGroundingSource[];
}

export interface GroundingSnippet {
  id: string;
  sourceId: string;
  sourceLabel: string;
  sourceType: AgentGroundingSourceType;
  title: string;
  content: string;
  path?: string;
  score?: number;
}

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export type ToolEventType = 'read' | 'search' | 'create' | 'edit' | 'publish' | 'ask';

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
  toolEvents: ToolEvent[];
  pendingChanges: PendingChange[];
  activeAgent: AgentDefinition;
  modelConnection: AgentModelConnectionStatus;
  grounding: GroundingSnippet[];
}

export interface PublishResult {
  url: string;
  outputPath: string;
  publishedAt: string;
}
