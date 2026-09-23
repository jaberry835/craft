import { DefaultAzureCredential } from '@azure/identity';
import type {
  AzureOpenAiEndpointKind,
  ModelChatClient,
  ModelChatMessage,
  ModelStreamChunk,
  ModelToolCall,
  ModelToolDefinition,
  ResolvedModelConnection
} from '../modelTypes.js';

type Fetch = typeof globalThis.fetch;
interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
}

export class AzureOpenAiChatClient implements ModelChatClient {
  constructor(
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly credential: TokenCredentialLike = new DefaultAzureCredential()
  ) {}

  async *stream(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    signal?: AbortSignal,
    tools?: ModelToolDefinition[]
  ): AsyncGenerator<ModelStreamChunk> {
    const endpointKind = this.resolveEndpointKind(connection);
    const useResponsesApi = endpointKind === 'foundry-project'
      || /\/responses$/i.test(connection.endpoint);
    const request = this.buildRequest(connection, messages, endpointKind, useResponsesApi, tools);
    const headers = await this.authHeaders(connection);

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(request.body),
        signal
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      throw new Error(
        `Azure OpenAI request could not reach ${this.safeHost(connection.endpoint)}.`,
        { cause: error }
      );
    }

    if (!response.ok) {
      throw new Error(`Azure OpenAI request failed with status ${response.status}.`);
    }
    if (!response.body) {
      throw new Error('Azure OpenAI streaming response body was not available.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    let emittedToolCalls = false;
    const toolCalls = new Map<number | string, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            completed = true;
            continue;
          }
          if (this.captureToolCallDelta(data, useResponsesApi, toolCalls)) {
            continue;
          }
          const event = this.parseEvent(data, useResponsesApi);
          if (!event) {
            continue;
          }
          if (event.type === 'completed') {
            const calls = this.completedToolCalls(toolCalls);
            if (calls.length > 0) {
              emittedToolCalls = true;
              yield { type: 'tool_calls', calls };
            }
            completed = true;
          } else {
            yield event;
          }
        }
        if (done) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!completed) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
      }
      throw new Error('Azure OpenAI streaming response ended before completion.');
    }
    if (!emittedToolCalls) {
      const calls = this.completedToolCalls(toolCalls);
      if (calls.length > 0) {
        yield { type: 'tool_calls', calls };
      }
    }
    yield { type: 'completed' };
  }

  private async authHeaders(connection: ResolvedModelConnection): Promise<Record<string, string>> {
    if ((connection.definition.authMode ?? 'entra') === 'api-key') {
      if (!connection.apiKey) {
        throw new Error('Azure OpenAI API-key authentication is not configured.');
      }
      return { 'api-key': connection.apiKey };
    }

    const token = await this.credential.getToken(
      connection.definition.credentialScope
      ?? this.defaultScope(connection.definition.cloud, this.resolveEndpointKind(connection))
    );
    if (!token?.token) {
      throw new Error('Unable to acquire an Entra token for Azure OpenAI.');
    }
    return { Authorization: `Bearer ${token.token}` };
  }

  private buildRequest(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    endpointKind: AzureOpenAiEndpointKind,
    useResponsesApi: boolean,
    tools?: ModelToolDefinition[]
  ): { url: string; body: Record<string, unknown> } {
    const { definition, endpoint, deployment, apiVersion } = connection;
    const temperature = definition.temperature ?? 0.2;
    const maxTokens = definition.maxTokens ?? 1200;

    if (useResponsesApi) {
      return {
        url: /\/responses$/i.test(endpoint)
          ? endpoint
          : `${endpoint.replace(/\/+$/, '')}/responses`,
        body: {
          model: deployment,
          input: this.toResponsesInput(messages),
          ...(tools?.length
            ? {
              tools: tools.map((tool) => ({
                type: 'function',
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters
              })),
              tool_choice: 'auto'
            }
            : {}),
          temperature,
          max_output_tokens: maxTokens,
          stream: true
        }
      };
    }

    if (endpointKind === 'openai-v1') {
      const normalized = endpoint.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
      return {
        url: /\/chat\/completions$/i.test(endpoint) ? endpoint : `${normalized}/chat/completions`,
        body: {
          model: deployment,
          messages: this.toChatMessages(messages),
          ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
          temperature,
          max_completion_tokens: maxTokens,
          stream: true
        }
      };
    }

    return {
      url: `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      body: {
        messages: this.toChatMessages(messages),
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        temperature,
        max_tokens: maxTokens,
        stream: true
      }
    };
  }

  private parseEvent(rawJson: string, responsesApi: boolean): ModelStreamChunk | null {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (responsesApi) {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        return { type: 'assistant_text', text: event.delta };
      }
      if (
        ['response.reasoning.delta', 'response.reasoning_text.delta',
          'response.reasoning_summary.delta', 'response.reasoning_summary_text.delta'].includes(type)
        && typeof event.delta === 'string'
      ) {
        return { type: 'reasoning', text: event.delta };
      }
      if (type === 'response.completed') {
        return { type: 'completed' };
      }
      if (type === 'response.failed' || type === 'error') {
        throw new Error('Azure OpenAI streaming response failed.');
      }
      return null;
    }

    const choices = Array.isArray(event.choices) ? event.choices : [];
    const first = choices[0] as { delta?: { content?: unknown; reasoning_content?: unknown } } | undefined;
    if (typeof first?.delta?.content === 'string' && first.delta.content) {
      return { type: 'assistant_text', text: first.delta.content };
    }
    if (typeof first?.delta?.reasoning_content === 'string' && first.delta.reasoning_content) {
      return { type: 'reasoning', text: first.delta.reasoning_content };
    }
    return null;
  }

  private captureToolCallDelta(
    rawJson: string,
    responsesApi: boolean,
    toolCalls: Map<number | string, { id: string; name: string; arguments: string }>
  ): boolean {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return false;
    }

    if (responsesApi) {
      if (event.type === 'response.output_item.added') {
        const item = typeof event.item === 'object' && event.item !== null
          ? event.item as Record<string, unknown>
          : undefined;
        if (item?.type !== 'function_call') {
          return false;
        }
        const key = typeof item.id === 'string' ? item.id : String(toolCalls.size);
        toolCalls.set(key, {
          id: typeof item.call_id === 'string' ? item.call_id : key,
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : ''
        });
        return true;
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const key = typeof event.item_id === 'string' ? event.item_id : String(toolCalls.size);
        const current = toolCalls.get(key) ?? { id: key, name: '', arguments: '' };
        current.arguments += typeof event.delta === 'string' ? event.delta : '';
        toolCalls.set(key, current);
        return true;
      }
      return false;
    }

    const choices = Array.isArray(event.choices) ? event.choices : [];
    const first = choices[0] as {
      delta?: {
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    } | undefined;
    const deltas = first?.delta?.tool_calls ?? [];
    for (const delta of deltas) {
      const key = delta.index ?? 0;
      const current = toolCalls.get(key) ?? {
        id: delta.id ?? crypto.randomUUID(),
        name: '',
        arguments: ''
      };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name += delta.function.name;
      if (delta.function?.arguments) current.arguments += delta.function.arguments;
      toolCalls.set(key, current);
    }
    return deltas.length > 0;
  }

  private completedToolCalls(
    toolCalls: Map<number | string, { id: string; name: string; arguments: string }>
  ): ModelToolCall[] {
    return Array.from(toolCalls.values())
      .filter((call) => call.name)
      .map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.arguments || '{}'
        }
      }));
  }

  private toChatMessages(messages: ModelChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {})
    }));
  }

  private toResponsesInput(messages: ModelChatMessage[]): Array<Record<string, unknown>> {
    return messages.flatMap((message) => {
      if (message.role === 'tool') {
        return [{
          type: 'function_call_output',
          call_id: message.toolCallId ?? '',
          output: message.content
        }];
      }
      const items: Array<Record<string, unknown>> = [{
        type: 'message',
        role: message.role,
        content: [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content
        }]
      }];
      for (const toolCall of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        });
      }
      return items;
    });
  }

  private resolveEndpointKind(connection: ResolvedModelConnection): AzureOpenAiEndpointKind {
    const configured = connection.definition.endpointKind ?? 'auto';
    if (configured !== 'auto') {
      return configured;
    }
    if (/\/api\/projects\//i.test(connection.endpoint)) {
      return 'foundry-project';
    }
    if (/\/openai\/v1(?:\/|$)/i.test(connection.endpoint)
      || /\/(chat\/completions|responses)$/i.test(connection.endpoint)) {
      return 'openai-v1';
    }
    return 'azure-openai-legacy';
  }

  private defaultScope(
    cloud = 'public',
    endpointKind: AzureOpenAiEndpointKind
  ): string {
    if (endpointKind === 'foundry-project' || endpointKind === 'openai-v1') {
      return 'https://ai.azure.com/.default';
    }
    if (cloud === 'usgovernment') {
      return 'https://cognitiveservices.azure.us/.default';
    }
    if (cloud === 'china') {
      return 'https://cognitiveservices.azure.cn/.default';
    }
    return 'https://cognitiveservices.azure.com/.default';
  }

  private safeHost(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return 'the configured endpoint';
    }
  }
}
