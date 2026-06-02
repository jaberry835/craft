import { DefaultAzureCredential } from '@azure/identity';
import type { AgentModelConnection, AzureOpenAiEndpointKind, ReasoningEffort } from '../types.js';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatToolDefinition {
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

export interface ChatMessageInput {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionOptions {
  reasoningMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  maxTokens?: number;
  deploymentOverride?: string;
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: ChatToolCall[];
  reasoning?: string | null;
}

export type ChatCompletionStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCallStarted' }
  | { type: 'toolCalls'; calls: ChatToolCall[] }
  | { type: 'done' };

interface ResponsesApiPayload {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
}

type ResponsesStreamEvent =
  | { kind: 'output_text_delta'; text: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'reasoning_summary_delta'; text: string }
  | { kind: 'function_call_arguments_delta'; itemId: string; delta: string }
  | { kind: 'function_call_started'; itemId: string; callId: string; name: string }
  | { kind: 'response_completed' }
  | { kind: 'response_failed'; message: string };

export class AzureOpenAiChatClient {
  private readonly credential = new DefaultAzureCredential();

  constructor(private readonly apiKeyResolver?: (connection: AgentModelConnection) => string | undefined) {}

  async complete(
    connection: AgentModelConnection,
    messages: ChatMessageInput[],
    options?: ChatCompletionOptions
  ): Promise<string | null> {
    const result = await this.completeWithTools(connection, messages, undefined, options);
    return result.content?.trim() ?? null;
  }

  async completeWithTools(
    connection: AgentModelConnection,
    messages: ChatMessageInput[],
    tools?: ChatToolDefinition[],
    options?: ChatCompletionOptions
  ): Promise<ChatCompletionResult> {
    const endpoint = (connection.endpoint ?? (connection.endpointEnv ? process.env[connection.endpointEnv] : undefined))?.replace(/\/+$/, '');
    const deployment = options?.deploymentOverride ?? connection.deployment ?? (connection.deploymentEnv ? process.env[connection.deploymentEnv] : undefined);
    const apiKey = this.apiKeyResolver?.(connection) ?? (connection.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined);
    const authMode = this.resolveAuthMode(connection, apiKey);
    const apiVersion = connection.apiVersion ?? (connection.apiVersionEnv ? process.env[connection.apiVersionEnv] : undefined) ?? connection.defaultApiVersion ?? '2025-01-01-preview';

    if (!endpoint || !deployment) {
      return {
        content: null,
        toolCalls: []
      };
    }

    let authHeaders: Record<string, string>;
    try {
      authHeaders = authMode === 'api-key'
        ? { 'api-key': apiKey as string }
        : { Authorization: `Bearer ${await this.getAccessToken(connection)}` };
    } catch (error) {
      throw new Error(`Azure OpenAI Entra authentication failed: ${this.describeError(error)}`, { cause: error });
    }

    const request = this.buildRequest(endpoint, deployment, apiVersion, messages, tools, options, connection);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: JSON.stringify(request.body)
      });
    } catch (error) {
      throw new Error(`Azure OpenAI request could not reach ${this.safeHost(endpoint)} deployment ${deployment}: ${this.describeError(error)}`, { cause: error });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
    }

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: 'function';
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
      }>;
    } & ResponsesApiPayload;

    if (Array.isArray(payload.output)) {
      return this.parseResponsesPayload(payload);
    }

    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content?.trim() ?? null,
      reasoning: null,
      toolCalls: (message?.tool_calls ?? [])
        .map((toolCall) => ({
          id: toolCall.id ?? crypto.randomUUID(),
          type: 'function' as const,
          function: {
            name: toolCall.function?.name ?? '',
            arguments: toolCall.function?.arguments ?? '{}'
          }
        }))
        .filter((toolCall) => Boolean(toolCall.function.name))
    };
  }

  async *completeWithToolsStream(
    connection: AgentModelConnection,
    messages: ChatMessageInput[],
    tools?: ChatToolDefinition[],
    options?: ChatCompletionOptions
  ): AsyncGenerator<ChatCompletionStreamChunk> {
    const endpoint = (connection.endpoint ?? (connection.endpointEnv ? process.env[connection.endpointEnv] : undefined))?.replace(/\/+$/, '');
    const deployment = options?.deploymentOverride ?? connection.deployment ?? (connection.deploymentEnv ? process.env[connection.deploymentEnv] : undefined);
    const apiKey = this.apiKeyResolver?.(connection) ?? (connection.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined);
    const authMode = this.resolveAuthMode(connection, apiKey);
    const apiVersion = connection.apiVersion ?? (connection.apiVersionEnv ? process.env[connection.apiVersionEnv] : undefined) ?? connection.defaultApiVersion ?? '2025-01-01-preview';

    if (!endpoint || !deployment) {
      yield { type: 'done' };
      return;
    }

    const request = this.buildRequest(endpoint, deployment, apiVersion, messages, tools, options, connection, true);

    if (!/\/responses$/i.test(request.url)) {
      const result = await this.completeWithTools(connection, messages, tools, options);
      if (result.reasoning) {
        yield { type: 'reasoning', text: result.reasoning };
      }
      if (result.content) {
        yield { type: 'text', text: result.content };
      }
      if (result.toolCalls.length > 0) {
        yield { type: 'toolCallStarted' };
        yield { type: 'toolCalls', calls: result.toolCalls };
      }
      yield { type: 'done' };
      return;
    }

    let authHeaders: Record<string, string>;
    try {
      authHeaders = authMode === 'api-key'
        ? { 'api-key': apiKey as string }
        : { Authorization: `Bearer ${await this.getAccessToken(connection)}` };
    } catch (error) {
      throw new Error(`Azure OpenAI Entra authentication failed: ${this.describeError(error)}`, { cause: error });
    }

    const response = await fetch(request.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders
      },
      body: JSON.stringify(request.body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
    }

    if (!response.body) {
      throw new Error('Azure OpenAI streaming response body was not available.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<string, { callId: string; name: string; args: string }>();
    let toolCallStarted = false;
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const event = this.parseResponsesStreamEvent(trimmed.slice(5).trim());
        if (!event) {
          continue;
        }

        switch (event.kind) {
          case 'output_text_delta':
            yield { type: 'text', text: event.text };
            break;
          case 'reasoning_delta':
          case 'reasoning_summary_delta':
            yield { type: 'reasoning', text: event.text };
            break;
          case 'function_call_started':
            if (!toolCallStarted) {
              toolCallStarted = true;
              yield { type: 'toolCallStarted' };
            }
            toolCalls.set(event.itemId, { callId: event.callId, name: event.name, args: '' });
            break;
          case 'function_call_arguments_delta': {
            const current = toolCalls.get(event.itemId) ?? { callId: event.itemId, name: '', args: '' };
            current.args += event.delta;
            toolCalls.set(event.itemId, current);
            if (!toolCallStarted) {
              toolCallStarted = true;
              yield { type: 'toolCallStarted' };
            }
            break;
          }
          case 'response_completed': {
            if (toolCalls.size > 0) {
              yield {
                type: 'toolCalls',
                calls: Array.from(toolCalls.values()).map((toolCall) => ({
                  id: toolCall.callId,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.args
                  }
                }))
              };
            }
            yield { type: 'done' };
            return;
          }
          case 'response_failed':
            throw new Error(`Azure OpenAI streaming response failed: ${event.message}`);
        }
      }

      if (done) {
        break;
      }
    }

    if (toolCalls.size > 0) {
      yield {
        type: 'toolCalls',
        calls: Array.from(toolCalls.values()).map((toolCall) => ({
          id: toolCall.callId,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: toolCall.args
          }
        }))
      };
    }

    yield { type: 'done' };
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

  private resolveAuthMode(connection: AgentModelConnection, apiKey?: string): 'api-key' | 'entra' {
    return connection.authMode === 'api-key' && apiKey
      ? 'api-key'
      : 'entra';
  }

  private resolveEndpointKind(connection: AgentModelConnection, endpoint: string): AzureOpenAiEndpointKind {
    if (connection.endpointKind && connection.endpointKind !== 'auto') {
      return connection.endpointKind;
    }

    if (/\/api\/projects\//i.test(endpoint)) {
      return 'foundry-project';
    }

    if (/\/openai\/v1(?:\/|$)/i.test(endpoint) || /\/(chat\/completions|responses)$/i.test(endpoint)) {
      return 'openai-v1';
    }

    return 'azure-openai-legacy';
  }

  private buildRequest(
    endpoint: string,
    deployment: string,
    apiVersion: string,
    messages: ChatMessageInput[],
    tools: ChatToolDefinition[] | undefined,
    options: ChatCompletionOptions | undefined,
    connection: AgentModelConnection,
    stream = false
  ): { url: string; body: Record<string, unknown> } {
    const endpointKind = this.resolveEndpointKind(connection, endpoint);
    const isResponsesEndpoint = /\/responses$/i.test(endpoint);
    const isV1Endpoint = endpointKind === 'openai-v1' || isResponsesEndpoint;
    const normalizedV1Endpoint = endpoint.replace(/\/chat\/completions$/i, '').replace(/\/responses$/i, '');
    const useReasoning = options?.reasoningMode || (options?.reasoningEffort && options.reasoningEffort !== 'none');
    const shouldUseResponsesApi = endpointKind === 'foundry-project' || isResponsesEndpoint || (endpointKind === 'openai-v1' && useReasoning);
    const temperature = options?.temperature ?? connection.temperature ?? 0.2;
    const maxTokens = options?.maxTokens ?? connection.maxTokens ?? 1200;
    const body: Record<string, unknown> = {
      messages,
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      ...(!useReasoning ? { temperature } : {})
    };

    if (shouldUseResponsesApi) {
      const normalizedResponsesEndpoint = endpointKind === 'foundry-project' && !isResponsesEndpoint
        ? `${endpoint.replace(/\/+$/, '')}/responses`
        : isResponsesEndpoint
          ? endpoint
          : `${normalizedV1Endpoint}/responses`;
      const reasoning = options?.reasoningEffort && options.reasoningEffort !== 'none'
        ? { effort: options.reasoningEffort, summary: 'auto' }
        : undefined;

      return {
        url: normalizedResponsesEndpoint,
        body: {
          model: deployment,
          input: this.toResponsesInput(messages),
          ...(tools && tools.length > 0
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
          ...(reasoning ? { reasoning } : {}),
          ...(!useReasoning ? { temperature } : {}),
          max_output_tokens: maxTokens,
          stream
        }
      };
    }

    if (isV1Endpoint) {
      return {
        url: /\/chat\/completions$/i.test(endpoint)
          ? endpoint
          : `${normalizedV1Endpoint}/chat/completions`,
        body: {
          ...body,
          model: deployment,
          max_completion_tokens: maxTokens
        }
      };
    }

    return {
      url: `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      body: {
        ...body,
        max_tokens: maxTokens
      }
    };
  }

  private async getAccessToken(connection: AgentModelConnection): Promise<string> {
    const endpoint = connection.endpoint ?? (connection.endpointEnv ? process.env[connection.endpointEnv] : undefined);
    const token = await this.credential.getToken(connection.credentialScope ?? this.defaultScope(connection.cloud, endpoint, connection.endpointKind));

    if (!token?.token) {
      throw new Error('Unable to acquire an Entra token for Azure OpenAI. Sign in with Azure CLI or configure managed identity.');
    }

    return token.token;
  }

  private defaultScope(cloud = 'public', endpoint?: string, endpointKind: AzureOpenAiEndpointKind = 'auto'): string {
    const resolvedKind = endpoint ? this.resolveEndpointKind({ endpointKind } as AgentModelConnection, endpoint) : endpointKind;

    if (resolvedKind === 'foundry-project' || resolvedKind === 'openai-v1') {
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
  private parseResponsesPayload(payload: ResponsesApiPayload): ChatCompletionResult {
    const content = this.collectResponsesText(payload.output, ['message'], ['output_text', 'summary_text', 'text'], 'assistant');
    const reasoning = this.collectReasoningText(payload.output);

    const toolCalls = payload.output
      ?.filter((item) => item.type === 'function_call' && typeof item.name === 'string')
      .map((item) => ({
        id: item.call_id ?? item.id ?? crypto.randomUUID(),
        type: 'function' as const,
        function: {
          name: item.name ?? '',
          arguments: item.arguments ?? '{}'
        }
      }))
      .filter((toolCall) => Boolean(toolCall.function.name)) ?? [];

    return {
      content,
      reasoning,
      toolCalls
    };
  }

  private collectResponsesText(
    output: ResponsesApiPayload['output'],
    acceptedItemTypes: string[],
    acceptedContentTypes: string[],
    role?: string
  ): string | null {
    const text = output
      ?.filter((item) => acceptedItemTypes.includes(item.type ?? '') && (role ? item.role === role : true))
      .flatMap((item) => item.content ?? [])
      .filter((item) => acceptedContentTypes.includes(item.type ?? '') && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('')
      .trim();

    return text ? text : null;
  }

  private collectReasoningText(output: ResponsesApiPayload['output']): string | null {
    if (!output) {
      return null;
    }

    const fragments: string[] = [];

    for (const item of output) {
      if (item.type !== 'reasoning' && item.type !== 'reasoning_summary') {
        continue;
      }

      for (const content of item.content ?? []) {
        if (typeof content.text === 'string' && ['reasoning_text', 'summary_text', 'output_text'].includes(content.type ?? '')) {
          fragments.push(content.text);
        }
      }
    }

    const reasoning = fragments.join('').trim();
    return reasoning ? reasoning : null;
  }

  private parseResponsesStreamEvent(rawJson: string): ResponsesStreamEvent | null {
    if (!rawJson || rawJson === '[DONE]') {
      return null;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'response.output_text.delta': {
        return typeof event.delta === 'string' && event.delta
          ? { kind: 'output_text_delta', text: event.delta }
          : null;
      }
      case 'response.reasoning.delta':
      case 'response.reasoning_text.delta': {
        return typeof event.delta === 'string' && event.delta
          ? { kind: 'reasoning_delta', text: event.delta }
          : null;
      }
      case 'response.reasoning_summary.delta':
      case 'response.reasoning_summary_text.delta': {
        return typeof event.delta === 'string' && event.delta
          ? { kind: 'reasoning_summary_delta', text: event.delta }
          : null;
      }
      case 'response.output_item.added': {
        const item = typeof event.item === 'object' && event.item !== null ? event.item as Record<string, unknown> : undefined;
        if (item?.type !== 'function_call') {
          return null;
        }
        return {
          kind: 'function_call_started',
          itemId: typeof item.id === 'string' ? item.id : '',
          callId: typeof item.call_id === 'string' ? item.call_id : (typeof item.id === 'string' ? item.id : ''),
          name: typeof item.name === 'string' ? item.name : ''
        };
      }
      case 'response.function_call_arguments.delta':
        return {
          kind: 'function_call_arguments_delta',
          itemId: typeof event.item_id === 'string' ? event.item_id : '',
          delta: typeof event.delta === 'string' ? event.delta : ''
        };
      case 'response.completed':
        return { kind: 'response_completed' };
      case 'response.failed':
      case 'error': {
        const responseError = typeof event.response === 'object' && event.response !== null ? event.response as Record<string, unknown> : undefined;
        const nestedError = responseError && typeof responseError.error === 'object' && responseError.error !== null ? responseError.error as Record<string, unknown> : undefined;
        const topError = typeof event.error === 'object' && event.error !== null ? event.error as Record<string, unknown> : undefined;
        const message = nestedError?.message ?? topError?.message ?? event.message ?? 'response failed';
        return { kind: 'response_failed', message: String(message) };
      }
      default:
        return null;
    }
  }

  private toResponsesInput(messages: ChatMessageInput[]): Array<Record<string, unknown>> {
    return messages.flatMap((message) => {
      if (message.role === 'tool') {
        return [{
          type: 'function_call_output',
          call_id: message.tool_call_id ?? '',
          output: typeof message.content === 'string' ? message.content : message.content ?? ''
        }];
      }

      const items: Array<Record<string, unknown>> = [{
        type: 'message',
        role: message.role,
        content: [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: typeof message.content === 'string' ? message.content : message.content ?? ''
        }]
      }];

      for (const toolCall of message.tool_calls ?? []) {
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
}
