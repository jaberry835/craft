import { DefaultAzureCredential } from '@azure/identity';
import type { AgentModelConnection } from '../types.js';

interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AzureOpenAiChatClient {
  private readonly credential = new DefaultAzureCredential();

  constructor(private readonly apiKeyResolver?: (connection: AgentModelConnection) => string | undefined) {}

  async complete(connection: AgentModelConnection, messages: ChatMessageInput[]): Promise<string | null> {
    const endpoint = (connection.endpoint ?? (connection.endpointEnv ? process.env[connection.endpointEnv] : undefined))?.replace(/\/+$/, '');
    const deployment = connection.deployment ?? (connection.deploymentEnv ? process.env[connection.deploymentEnv] : undefined);
    const apiKey = this.apiKeyResolver?.(connection) ?? (connection.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined);
    const authMode = connection.authMode ?? 'entra';
    const apiVersion = connection.apiVersion ?? (connection.apiVersionEnv ? process.env[connection.apiVersionEnv] : undefined) ?? connection.defaultApiVersion ?? '2025-01-01-preview';

    if (!endpoint || !deployment || (authMode === 'api-key' && !apiKey)) {
      return null;
    }

    let authHeaders: Record<string, string>;
    try {
      authHeaders = authMode === 'api-key'
        ? { 'api-key': apiKey as string }
        : { Authorization: `Bearer ${await this.getAccessToken(connection)}` };
    } catch (error) {
      throw new Error(`Azure OpenAI Entra authentication failed: ${this.describeError(error)}`, { cause: error });
    }

    const requestUrl = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify({
          messages,
          temperature: connection.temperature ?? 0.2,
          max_tokens: connection.maxTokens ?? 1200
        })
      });
    } catch (error) {
      throw new Error(`Azure OpenAI request could not reach ${this.safeHost(endpoint)} deployment ${deployment}: ${this.describeError(error)}`, { cause: error });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content?.trim() ?? null;
  }

  private safeHost(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async getAccessToken(connection: AgentModelConnection): Promise<string> {
    const token = await this.credential.getToken(connection.credentialScope ?? this.defaultScope(connection.cloud));

    if (!token?.token) {
      throw new Error('Unable to acquire an Entra token for Azure OpenAI. Sign in with Azure CLI or configure managed identity.');
    }

    return token.token;
  }

  private defaultScope(cloud = 'public'): string {
    if (cloud === 'usgovernment') {
      return 'https://cognitiveservices.azure.us/.default';
    }

    if (cloud === 'china') {
      return 'https://cognitiveservices.azure.cn/.default';
    }

    return 'https://cognitiveservices.azure.com/.default';
  }
}
