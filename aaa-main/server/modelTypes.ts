export type ModelAuthMode = 'entra' | 'api-key';
export type AzureCloud = 'public' | 'usgovernment' | 'china' | 'custom';
export type AzureOpenAiEndpointKind = 'auto' | 'foundry-project' | 'openai-v1' | 'azure-openai-legacy';

export interface AzureOpenAiConnectionDefinition {
  id: string;
  name: string;
  type: 'azure-openai';
  authMode?: ModelAuthMode;
  cloud?: AzureCloud;
  endpointKind?: AzureOpenAiEndpointKind;
  endpointEnv: string;
  apiKeyEnv?: string;
  credentialScope?: string;
  deploymentEnv: string;
  apiVersionEnv?: string;
  defaultApiVersion?: string;
  temperature?: number;
  maxTokens?: number;
}

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
  | { type: 'completed' };

export interface ModelChatClient {
  stream(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    signal?: AbortSignal,
    tools?: ModelToolDefinition[]
  ): AsyncIterable<ModelStreamChunk>;
}
