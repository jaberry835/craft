import type {
  AgentDefinition,
  AgentRunOptions,
  ChatMessage,
  GroundingSnippet,
  PendingChange,
  ToolEvent,
  WorkspaceFile,
  WorkspaceIndex
} from '../../types.js';
import type { AgentConfigStore } from '../agentConfigStore.js';

export interface LoopToolContext {
  content: string;
  options: AgentRunOptions;
  chatHistory: ChatMessage[];
  groundingQuery: string;
  activeAgent: AgentDefinition;
  connection: ReturnType<AgentConfigStore['getConnection']>;
  modelConnection: ReturnType<AgentConfigStore['getConnectionStatus']>;
  toolEvents: ToolEvent[];
  index?: WorkspaceIndex;
  grounding: GroundingSnippet[];
  packageFiles: WorkspaceFile[];
  staged: PendingChange[];
  assistantContent?: string;
  stop: boolean;
  appliedChangeCount: number;
  plannerRound: number;
  toolCallCount: number;
  loopMessages: LoopChatMessage[];
  availableTools: LoopToolDefinition[];
  state: Map<string, unknown>;
}

export interface LoopToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LoopChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: LoopToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LoopToolResult {
  success: boolean;
  result: string;
}

export interface LoopToolDefinition {
  name: string;
  description: string;
  isReadOnly: boolean;
  allowRepeatedCalls?: boolean;
  requiresConfirmation: boolean;
  confirmationCategory?: string;
  category: 'workspace' | 'package';
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LoopToolEntry {
  definition: LoopToolDefinition;
  execute(context: LoopToolContext, args: Record<string, unknown>): Promise<LoopToolResult>;
}

export interface LoopToolValidationResult {
  valid: boolean;
  errors: string[];
}