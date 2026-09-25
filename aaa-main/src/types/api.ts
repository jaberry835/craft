export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  rootPath: string;
  active: boolean;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  activeProjectId: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  systemName?: string;
}

export interface CustomizationItem {
  id: string;
  name: string;
  description: string;
  kind: 'agent' | 'skill' | 'mcp-server' | 'instruction' | 'hook' | 'tool';
  enabled: boolean;
  status: 'ready' | 'configured' | 'unavailable';
  detail?: string;
  sourcePath?: string;
}

export interface ProjectCustomizations {
  projectId: string;
  items: CustomizationItem[];
}

export type EditableCustomizationKind = 'agent' | 'skill' | 'mcp-server' | 'tool';

export interface CustomizationEditor {
  id?: string;
  kind: EditableCustomizationKind;
  name: string;
  description: string;
  enabled: boolean;
  sourcePath?: string;
  instructions?: string;
  argumentHint?: string;
  tools?: string;
  transport?: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string;
  readOnly?: boolean;
}

export interface SaveCustomizationRequest {
  kind: EditableCustomizationKind;
  name: string;
  description: string;
  enabled: boolean;
  instructions?: string;
  argumentHint?: string;
  tools?: string;
  transport?: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string;
}

export interface SetCustomizationEnabledRequest {
  enabled: boolean;
}

export interface CapabilityTestTool {
  name: string;
  description?: string;
}

export interface CapabilityTestResult {
  itemId: string;
  ok: boolean;
  testedAt: string;
  summary: string;
  tools?: CapabilityTestTool[];
}

export type FileTreeNodeType = 'file' | 'directory';

export interface FileTreeNode {
  name: string;
  path: string;
  type: FileTreeNodeType;
  children?: FileTreeNode[];
}

export interface ProjectTextFile {
  path: string;
  content: string;
  updatedAt: string;
  size: number;
}

export interface WriteTextFileRequest {
  path: string;
  content: string;
  updatedAt: string;
}

export interface CreateTextFileRequest {
  path: string;
  content: string;
}

export interface UploadProjectFileRequest {
  path: string;
  contentBase64: string;
}

export interface UploadedProjectFile {
  path: string;
  type: 'file';
  size: number;
}

export interface BrowserLaunchRequest {
  headless?: boolean;
  url?: string;
}

export interface BrowserNavigateRequest {
  url: string;
}

export interface BrowserCaptureRequest {
  outputPath?: string;
}

export interface BrowserSessionStatus {
  active: boolean;
  headless?: boolean;
  currentUrl?: string;
  launchedAt?: string;
}

export interface BrowserCaptureResult {
  path: string;
  metadataPath: string;
  sourceUrl: string;
  capturedAt: string;
}

export interface PublicationStatus {
  path: string;
  reviewed: boolean;
  reviewedAt?: string;
}

export interface RenameProjectPathRequest {
  path: string;
  newPath: string;
}

export interface ProjectPathResult {
  path: string;
  type: FileTreeNodeType;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export type ToolEventType = 'read' | 'search' | 'create' | 'edit' | 'skill' | 'mcp' | 'browser';

export interface ToolEvent {
  id: string;
  type: ToolEventType;
  label: string;
  detail?: string;
  filePath?: string;
  createdAt: string;
}

export type ChatMessageDisplayPart =
  | { kind: 'reasoning'; text: string }
  | { kind: 'working'; title: string; events: ToolEvent[] };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  display?: ChatMessageDisplayPart[];
}

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface AgentRun {
  id: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt?: string;
  userMessageId: string;
  assistantMessageId?: string;
  modelConnectionId: string;
  reasoning: string;
  toolEvents: ToolEvent[];
  changedFiles: string[];
  assistantText?: string;
  error?: string;
}

export interface ChatSessionSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatMessage[];
  runs: AgentRun[];
}

export interface CreateSessionRequest {
  title?: string;
}

export interface RenameSessionRequest {
  title: string;
}

export interface AppendMessageRequest {
  role: ChatRole;
  content: string;
  display?: ChatMessageDisplayPart[];
}

export interface ModelConnectionStatus {
  id: string;
  name: string;
  provider: 'azure-openai';
  ready: boolean;
  missing: string[];
  authMode: 'entra' | 'api-key';
  endpointKind: 'auto' | 'foundry-project' | 'openai-v1' | 'azure-openai-legacy';
  endpointHost?: string;
  deployment?: string;
  apiVersion?: string;
}

export interface StorageBackendStatus {
  backend: 'local' | 'cosmos' | 'blob' | 'unsupported';
  configured: boolean;
  ready: boolean;
  active: boolean;
  missing: string[];
  invalid: string[];
  authMode?: 'entra' | 'api-key';
  endpointHost?: string;
  database?: string;
  container?: string;
  schemaMode?: 'native' | 'junior-compatible';
  autoCreate?: boolean;
}

export interface StorageStatus {
  sessions: StorageBackendStatus;
  workspaceFiles: StorageBackendStatus;
}

export interface ChatStreamRequest {
  content: string;
  /** Project agent id or name; `default` runs without a project agent. */
  agentId?: string;
}

export interface WorkflowAgentSummary {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
}

export interface WorkflowCommandSummary {
  name: string;
  kind: 'prompt' | 'skill';
  label: string;
  description: string;
  argumentHint?: string;
}

export interface ProjectWorkflowSummary {
  agents: WorkflowAgentSummary[];
  commands: WorkflowCommandSummary[];
  mcpServers: Array<{ name: string; available: boolean; reason?: string }>;
}

export interface ChatStreamResponse {
  sessionId: string;
  message: ChatMessage;
}

export type ChatStreamEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_event'; event: ToolEvent }
  | { type: 'completed'; response: ChatStreamResponse; changedFiles: string[] }
  | { type: 'error'; message: string };

export interface ApiError {
  error: string;
  code: string;
}
