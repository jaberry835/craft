export interface ChatMessage {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: Date;
  isLoading?: boolean;
  metadata?: {
    sources?: DocumentSource[];
    toolCalls?: ToolCall[];
  };
}

export interface DocumentSource {
  id: string;
  title: string;
  content: string;
  url?: string;
  score?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  result?: any;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}

export interface UploadedDocument {
  id: string;
  filename: string;
  content: string;
  uploadedAt: Date;
  userId: string;
  indexed: boolean;
}

// API Response models
export interface ChatHistoryResponse {
  messages: ChatMessage[];
  hasMore: boolean;
  continuationToken?: string;
}

export interface SessionListResponse {
  sessions: ChatSession[];
  hasMore: boolean;
  continuationToken?: string;
}

export interface CreateSessionRequest {
  userId: string;
  title: string;
}

export interface ChatHistoryRequest {
  userId: string;
  sessionId: string;
  pageSize: number;
  continuationToken?: string;
}

export interface SessionListRequest {
  userId: string;
  pageSize: number;
  continuationToken?: string;
  includeArchived: boolean;
}

export interface AgentInteraction {
  id: string;
  agentName: string;
  action: string;
  result: string;
  timestamp: Date;
  status: 'success' | 'error' | 'in-progress';
  duration?: number;
}

export interface ChatCompletionResponse {
  message: ChatMessage;
  sources?: DocumentSource[];
  toolCalls?: ToolCall[];
  agentInteractions?: AgentInteraction[];
}
