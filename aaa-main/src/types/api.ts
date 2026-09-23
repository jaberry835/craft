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

export interface RenameProjectPathRequest {
  path: string;
  newPath: string;
}

export interface ProjectPathResult {
  path: string;
  type: FileTreeNodeType;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
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
}

export interface StorageStatus {
  sessions: StorageBackendStatus;
  workspaceFiles: StorageBackendStatus;
}

export interface ChatStreamRequest {
  content: string;
}

export interface ChatStreamResponse {
  sessionId: string;
  message: ChatMessage;
}

export type ChatStreamEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'completed'; response: ChatStreamResponse }
  | { type: 'error'; message: string };

export interface ApiError {
  error: string;
  code: string;
}
