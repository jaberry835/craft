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
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ModelStreamChunk =
  | { type: 'assistant_text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'completed' };

export interface ModelChatClient {
  stream(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    signal?: AbortSignal
  ): AsyncIterable<ModelStreamChunk>;
}
