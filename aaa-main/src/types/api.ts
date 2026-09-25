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

export interface CapabilityTestToolParameter {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface CapabilityTestTool {
  name: string;
  description?: string;
  parameters?: CapabilityTestToolParameter[];
}

export interface CapabilityTestResult {
  itemId: string;
  ok: boolean;
  testedAt: string;
  summary: string;
  tools?: CapabilityTestTool[];
}

export interface ModelDiagnosticsCheck {
  scenario: 'text' | 'tools' | 'tool-history';
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface ModelDiagnosticsApiResult {
  api: 'chat-completions' | 'responses';
  /** Request URL used for this API; never includes credentials. */
  url: string;
  ok: boolean;
  checks: ModelDiagnosticsCheck[];
  /** Request shape AAA adapted to, when it differed from the configuration. */
  adaptedTo?: string;
  notes: string[];
}

export interface ModelDiagnosticsReport {
  testedAt: string;
  status: ModelConnectionStatus;
  results: ModelDiagnosticsApiResult[];
  /** Settings to pin in config/agent-connections.json when an API passed every check. */
  recommended?: { api: string; tokenParameter: string; temperature?: number | null };
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

export type ToolEventType = 'read' | 'search' | 'create' | 'edit' | 'skill' | 'mcp' | 'browser' | 'context';

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

/** Token counts reported by the model provider for one or more requests. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface RunUsage extends TokenUsage {
  /** Model requests in the run, including compaction and tool rounds. */
  requests: number;
  /** Input tokens of the first request: system prompt, tools, and conversation history. */
  promptTokens: number;
  /** Largest single-request input, i.e. the peak context used by the run. */
  peakInputTokens: number;
  /** True when the provider did not report usage for at least one request and it was estimated. */
  estimated: boolean;
}

export type CompactionTrigger = 'manual' | 'auto';

export interface SessionCompaction {
  id: string;
  createdAt: string;
  trigger: CompactionTrigger;
  /** Messages up to and including this id are represented by `summary` in model context. */
  throughMessageId: string;
  summary: string;
  messagesCompacted: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  focus?: string;
  usage?: TokenUsage;
}

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
  usage?: RunUsage;
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
  compactions?: SessionCompaction[];
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
  api: 'auto' | 'chat-completions' | 'responses';
  adaptive: boolean;
  /** Configured model context window in tokens; auto-compaction is off when absent. */
  contextWindow?: number;
  autoCompact: boolean;
  compactThreshold: number;
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
  /** `builtin` commands (such as /compact) are handled by AAA rather than the project. */
  kind: 'prompt' | 'skill' | 'builtin';
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
  | { type: 'usage'; usage: RunUsage }
  | { type: 'compaction'; compaction: SessionCompaction }
  | { type: 'status'; message: string }
  | { type: 'completed'; response: ChatStreamResponse; changedFiles: string[] }
  | { type: 'error'; message: string };

export interface CompactSessionRequest {
  /** Optional instruction about what the summary should preserve. */
  focus?: string;
}

export interface ApiError {
  error: string;
  code: string;
}
