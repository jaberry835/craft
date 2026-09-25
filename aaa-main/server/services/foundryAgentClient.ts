import { DefaultAzureCredential } from '@azure/identity';
import { randomUUID } from 'node:crypto';
import type { AaaAgentProgressHandlers, AaaAgentRunResult } from '../aaaAgentLoop.js';
import { AgentRunError } from '../httpErrors.js';
import type { ModelChatMessage } from '../modelTypes.js';

export interface FoundryAgentConnection {
  endpointEnv: string;
  authMode: 'entra' | 'api-key';
  apiKeyEnv?: string;
  credentialScope?: string;
}

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
}

export class FoundryAgentClient {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly credential: TokenCredentialLike = new DefaultAzureCredential()
  ) {}

  status(connection: FoundryAgentConnection): { ready: boolean; endpoint?: string; missing: string[] } {
    const endpoint = this.environment[connection.endpointEnv]?.trim();
    const missing = [
      !endpoint && connection.endpointEnv,
      connection.authMode === 'api-key' && !this.environment[connection.apiKeyEnv ?? '']?.trim()
        ? connection.apiKeyEnv || 'Foundry API key environment variable'
        : ''
    ].filter(Boolean) as string[];
    if (endpoint) validateEndpoint(endpoint);
    return { ready: missing.length === 0, ...(endpoint ? { endpoint } : {}), missing };
  }

  async invoke(
    connection: FoundryAgentConnection,
    messages: ModelChatMessage[],
    signal: AbortSignal,
    handlers: AaaAgentProgressHandlers = {}
  ): Promise<AaaAgentRunResult> {
    const status = this.status(connection);
    if (!status.ready || !status.endpoint) {
      throw new AgentRunError(`Foundry agent connection is missing: ${status.missing.join(', ')}.`);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (connection.authMode === 'api-key') {
      headers['api-key'] = this.environment[connection.apiKeyEnv!]!.trim();
    } else {
      const token = await this.credential.getToken(connection.credentialScope || 'https://ai.azure.com/.default');
      if (!token?.token) throw new AgentRunError('Microsoft Entra could not acquire a token for the Foundry agent.');
      headers.Authorization = `Bearer ${token.token}`;
    }
    const event = {
      id: randomUUID(),
      type: 'agent' as const,
      label: 'Invoked Foundry agent',
      detail: new URL(status.endpoint).host,
      createdAt: new Date().toISOString()
    };
    await handlers.onToolEvent?.(event);
    const response = await this.fetchImpl(status.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: messages
          .filter((message) => message.role !== 'tool')
          .map((message) => ({ role: message.role, content: message.content }))
      }),
      signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AgentRunError(`Foundry agent request failed with status ${response.status}: ${safeError(text)}.`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AgentRunError('Foundry agent returned a non-JSON response; configure its full Responses protocol endpoint.');
    }
    const content = responseText(body);
    if (!content) throw new AgentRunError('Foundry agent completed without response text.');
    await handlers.onAssistantText?.(content);
    const usage = responseUsage(body);
    await handlers.onUsage?.(usage);
    return { content, reasoning: '', toolEvents: [event], changedFiles: [], usage };
  }
}

function validateEndpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new AgentRunError('The Foundry agent endpoint environment variable must contain an absolute URL.');
  }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname))) {
    throw new AgentRunError('The Foundry agent endpoint must use HTTPS (HTTP is allowed only for local tests).');
  }
}

function responseText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  if (!Array.isArray(record.output)) return '';
  return record.output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []);
  }).join('');
}

function responseUsage(body: unknown) {
  const usage = body && typeof body === 'object' && (body as Record<string, unknown>).usage;
  const record = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const inputTokens = number(record.input_tokens);
  const outputTokens = number(record.output_tokens);
  const cachedInputTokens = number(
    record.input_tokens_details && typeof record.input_tokens_details === 'object'
      ? (record.input_tokens_details as Record<string, unknown>).cached_tokens
      : undefined
  );
  const reasoningTokens = number(
    record.output_tokens_details && typeof record.output_tokens_details === 'object'
      ? (record.output_tokens_details as Record<string, unknown>).reasoning_tokens
      : undefined
  );
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens,
    requests: 1,
    promptTokens: inputTokens,
    peakInputTokens: inputTokens,
    estimated: !usage
  };
}

const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

function safeError(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\s+/g, ' ').trim().slice(0, 1000) || 'No error detail';
}
