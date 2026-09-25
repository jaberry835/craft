import type { TokenUsage } from '../src/types/api.js';

export type ModelAuthMode = 'entra' | 'api-key';
export type AzureCloud = 'public' | 'usgovernment' | 'china' | 'custom';
export type AzureOpenAiEndpointKind = 'auto' | 'foundry-project' | 'openai-v1' | 'azure-openai-legacy';
export type ModelApi = 'chat-completions' | 'responses';
export type ModelApiSetting = 'auto' | ModelApi;
export type ModelTokenParameter = 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | 'omit';
export type ModelTokenParameterSetting = 'auto' | ModelTokenParameter;
export type ModelReasoningSummary = 'auto' | 'concise' | 'detailed';

export interface AzureOpenAiConnectionDefinition {
  id: string;
  name: string;
  type: 'azure-openai';
  authMode?: ModelAuthMode;
  cloud?: AzureCloud;
  endpointKind?: AzureOpenAiEndpointKind;
  /** Wire protocol. `auto` picks from the endpoint and may switch on recognized compatibility errors. */
  api?: ModelApiSetting;
  /** Output-limit parameter. `auto` picks per API/endpoint and may adapt on recognized errors. */
  tokenParameter?: ModelTokenParameterSetting;
  endpointEnv: string;
  apiKeyEnv?: string;
  credentialScope?: string;
  deploymentEnv: string;
  apiVersionEnv?: string;
  defaultApiVersion?: string;
  /** `null` omits temperature, which many reasoning models reject. */
  temperature?: number | null;
  maxTokens?: number;
  reasoningEffort?: string;
  reasoningSummary?: ModelReasoningSummary;
  /** Retry once per recognized compatibility error with a corrected request shape (default true). */
  adaptive?: boolean;
  /** Request server-sent-event streaming (default true). Complete JSON responses are handled either way. */
  stream?: boolean;
  /** Ask Chat Completions streams for a final usage chunk (default true; dropped if rejected). */
  includeUsage?: boolean;
  /** Retries for 429 and transient 5xx responses (default 3). */
  maxRetries?: number;
  /** Model context window in tokens. Required for auto-compaction and the in-run context guard. */
  contextWindow?: number;
  compaction?: {
    /** Compact automatically before a turn when estimated context crosses the threshold (default true). */
    auto?: boolean;
    /** Fraction of contextWindow that triggers compaction and tool-output trimming (default 0.8). */
    threshold?: number;
    /** Output budget for the summary request (default min(maxTokens, 8000)). */
    summaryMaxTokens?: number;
  };
}

export type ModelUsage = TokenUsage;

export interface ResolvedModelConnection {
  definition: AzureOpenAiConnectionDefinition;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey?: string;
}

export interface ModelChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
}

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export type ModelStreamChunk =
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: ModelToolCall[] }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'completed' };

export interface ModelChatClient {
  stream(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    signal?: AbortSignal,
    tools?: ModelToolDefinition[]
  ): AsyncIterable<ModelStreamChunk>;
}
