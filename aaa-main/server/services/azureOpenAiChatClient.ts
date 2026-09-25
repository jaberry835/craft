import { DefaultAzureCredential } from '@azure/identity';
import type {
  AzureOpenAiEndpointKind,
  ModelApi,
  ModelChatClient,
  ModelChatMessage,
  ModelStreamChunk,
  ModelTokenParameter,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ResolvedModelConnection
} from '../modelTypes.js';
import { AgentRunError } from '../httpErrors.js';

type Fetch = typeof globalThis.fetch;
type JsonObject = Record<string, unknown>;
const defaultMaxTokens = 16000;
const maxAttempts = 5;
const defaultMaxRetries = 3;
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const tunableParameters = [
  'max_completion_tokens', 'max_output_tokens', 'max_tokens',
  'reasoning_effort', 'reasoning', 'stream_options', 'temperature', 'tool_choice'
] as const;
type TunableParameter = typeof tunableParameters[number];
const unsupportedPattern = /unsupported|unrecognized|not supported|does not support|isn't supported|not allowed|not permitted|unknown (?:parameter|field|argument)|extra inputs|invalid (?:parameter|argument)/i;
const apiMismatchPattern = /operation (?:does not work|is not supported)|not supported (?:for|with|by|on) (?:this|the) (?:model|api|endpoint|operation)|only (?:supported|available) (?:in|with|through|via) (?:the )?(?:v1\/)?(?:responses|chat)|use the (?:responses|chat ?completions?) api|unsupported (?:api|endpoint|operation)/i;
const policyPattern = /content_filter|ResponsibleAIPolicyViolation|context_length_exceeded|rate_limit|quota|insufficient/i;

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string } | null>;
}

/** Everything about a request that differs between deployments, APIs, and model families. */
export interface ModelRequestShape {
  api: ModelApi;
  tokenParameter: ModelTokenParameter;
  temperature: boolean;
  toolChoice: boolean;
  reasoning: boolean;
  /** Chat Completions `stream_options.include_usage`. */
  includeUsage: boolean;
}

interface ModelFailure {
  status: number;
  code: string;
  param: string;
  message: string;
  filtered: string[];
  raw: string;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Azure OpenAI / Foundry model client for Chat Completions and Responses.
 *
 * The connection definition is authoritative: an explicit `api` or `tokenParameter`
 * is never overridden. With `auto` values and `adaptive` enabled (the default), a
 * recognized compatibility error (404 route, rejected parameter, or a rejected
 * tool-result replay) is retried with a corrected shape, logged, and remembered for
 * the connection. Policy errors such as content filtering are never retried.
 */
export class AzureOpenAiChatClient implements ModelChatClient {
  private readonly learned = new Map<string, ModelRequestShape>();

  constructor(
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly credential: TokenCredentialLike = new DefaultAzureCredential(),
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  /** The shape learned through adaptation for this connection, if any. */
  learnedShape(connection: ResolvedModelConnection): ModelRequestShape | undefined {
    return this.learned.get(this.cacheKey(connection));
  }

  async *stream(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    signal?: AbortSignal,
    tools?: ModelToolDefinition[]
  ): AsyncGenerator<ModelStreamChunk> {
    const endpointKind = this.resolveEndpointKind(connection);
    let shape = this.learned.get(this.cacheKey(connection)) ?? this.configuredShape(connection, endpointKind);
    const headers = await this.authHeaders(connection, endpointKind);
    const attempts: Array<{ shape: ModelRequestShape; failure: ModelFailure }> = [];

    for (;;) {
      const request = this.buildRequest(connection, messages, endpointKind, shape, tools);
      const response = await this.sendWithRetry(connection, request, headers, signal);
      if (response.ok) {
        if (attempts.length > 0) {
          this.learned.set(this.cacheKey(connection), shape);
          this.log(`[model] ${connection.definition.id}: continuing with ${describeShape(shape)}.`);
        }
        yield* this.readResponse(response, shape.api, connection, signal);
        return;
      }

      const failure = await this.readFailure(response, connection);
      attempts.push({ shape, failure });
      const next = attempts.length < maxAttempts
        ? this.adapt(connection, endpointKind, shape, failure, request.body, messages, attempts.map((a) => a.shape))
        : undefined;
      if (!next) {
        throw this.requestError(connection, attempts, messages, tools);
      }
      this.log(
        `[model] ${this.safeHost(connection.endpoint)} returned ${failure.status}${failure.code ? ` (${failure.code})` : ''} `
        + `for ${shape.api}: ${failure.message.slice(0, 200) || 'no detail'}. Retrying with ${describeChange(shape, next)}.`
      );
      shape = next;
    }
  }

  /** Retries throttling (429), timeouts, transient 5xx, and network failures with backoff. */
  private async sendWithRetry(
    connection: ResolvedModelConnection,
    request: { url: string; body: JsonObject },
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Response> {
    const maxRetries = connection.definition.maxRetries ?? defaultMaxRetries;
    for (let retry = 0; ; retry += 1) {
      let response: Response | undefined;
      let networkError: unknown;
      try {
        response = await this.send(connection, request, headers, signal);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        networkError = error;
      }
      const transient = networkError !== undefined || transientStatuses.has(response!.status);
      if (!transient || retry >= maxRetries) {
        if (networkError !== undefined) throw networkError;
        return response!;
      }
      const delay = retryDelay(response?.headers, retry);
      await response?.body?.cancel().catch(() => undefined);
      this.log(
        `[model] ${this.safeHost(connection.endpoint)} ${networkError !== undefined ? 'was unreachable' : `returned ${response!.status}`}; `
        + `retry ${retry + 1} of ${maxRetries} in ${Math.round(delay)} ms.`
      );
      await sleep(delay, signal);
    }
  }

  private async send(
    connection: ResolvedModelConnection,
    request: { url: string; body: JsonObject },
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      return await this.fetchImpl(request.url, {
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
  }

  private configuredShape(connection: ResolvedModelConnection, endpointKind: AzureOpenAiEndpointKind): ModelRequestShape {
    const configured = connection.definition.api ?? 'auto';
    const api: ModelApi = configured !== 'auto'
      ? configured
      : endpointKind === 'foundry-project' || /\/responses$/i.test(connection.endpoint)
        ? 'responses'
        : 'chat-completions';
    return {
      api,
      tokenParameter: this.tokenParameterFor(connection, endpointKind, api),
      temperature: connection.definition.temperature !== null,
      toolChoice: true,
      reasoning: Boolean(connection.definition.reasoningEffort || connection.definition.reasoningSummary),
      includeUsage: connection.definition.includeUsage !== false
    };
  }

  private tokenParameterFor(
    connection: ResolvedModelConnection,
    endpointKind: AzureOpenAiEndpointKind,
    api: ModelApi
  ): ModelTokenParameter {
    const setting = connection.definition.tokenParameter ?? 'auto';
    if (setting === 'omit') return 'omit';
    if (api === 'responses') return 'max_output_tokens';
    if (setting === 'max_tokens' || setting === 'max_completion_tokens') return setting;
    return endpointKind === 'azure-openai-legacy' ? 'max_tokens' : 'max_completion_tokens';
  }

  /** Returns a corrected shape for a recognized compatibility failure, or undefined to fail. */
  private adapt(
    connection: ResolvedModelConnection,
    endpointKind: AzureOpenAiEndpointKind,
    shape: ModelRequestShape,
    failure: ModelFailure,
    body: JsonObject,
    messages: ModelChatMessage[],
    tried: ModelRequestShape[]
  ): ModelRequestShape | undefined {
    const definition = connection.definition;
    if (definition.adaptive === false) return undefined;
    if (failure.status !== 400 && failure.status !== 404) return undefined;
    if (policyPattern.test(`${failure.code} ${failure.message}`) || failure.filtered.length > 0) return undefined;
    const fresh = (candidate: ModelRequestShape) =>
      tried.some((previous) => sameShape(previous, candidate)) ? undefined : candidate;

    const parameter = failure.status === 400 ? this.rejectedParameter(failure, body) : undefined;
    if (parameter) {
      if (parameter === 'temperature') return fresh({ ...shape, temperature: false });
      if (parameter === 'tool_choice') return fresh({ ...shape, toolChoice: false });
      if (parameter === 'reasoning' || parameter === 'reasoning_effort') return fresh({ ...shape, reasoning: false });
      if (parameter === 'stream_options') return fresh({ ...shape, includeUsage: false });
      if ((definition.tokenParameter ?? 'auto') !== 'auto') return undefined;
      if (shape.api === 'chat-completions' && parameter !== 'max_output_tokens') {
        const alternate = parameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
        return fresh({ ...shape, tokenParameter: alternate }) ?? fresh({ ...shape, tokenParameter: 'omit' });
      }
      return fresh({ ...shape, tokenParameter: 'omit' });
    }

    if ((definition.api ?? 'auto') !== 'auto') return undefined;
    const replaysTools = messages.some((message) => message.role === 'tool' || Boolean(message.toolCalls?.length));
    if (failure.status === 404 || replaysTools || apiMismatchPattern.test(failure.message)) {
      const api: ModelApi = shape.api === 'responses' ? 'chat-completions' : 'responses';
      return fresh({ ...shape, api, tokenParameter: this.tokenParameterFor(connection, endpointKind, api) });
    }
    return undefined;
  }

  private rejectedParameter(failure: ModelFailure, body: JsonObject): TunableParameter | undefined {
    const sent = (name: TunableParameter) => Object.hasOwn(body, name);
    const param = failure.param.split(/[.[]/, 1)[0] as TunableParameter;
    if ((tunableParameters as readonly string[]).includes(param) && sent(param)) return param;
    if (!unsupportedPattern.test(failure.message)) return undefined;
    let earliest: { name: TunableParameter; index: number } | undefined;
    for (const name of tunableParameters) {
      if (!sent(name)) continue;
      const index = failure.message.search(new RegExp(`\\b${name}\\b`, 'i'));
      if (index >= 0 && (!earliest || index < earliest.index)) earliest = { name, index };
    }
    return earliest?.name;
  }

  private async authHeaders(
    connection: ResolvedModelConnection,
    endpointKind: AzureOpenAiEndpointKind
  ): Promise<Record<string, string>> {
    if ((connection.definition.authMode ?? 'entra') === 'api-key') {
      if (!connection.apiKey) {
        throw new Error('Azure OpenAI API-key authentication is not configured.');
      }
      return { 'api-key': connection.apiKey };
    }

    const token = await this.credential.getToken(
      connection.definition.credentialScope
      ?? this.defaultScope(connection.definition.cloud, endpointKind)
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
    shape: ModelRequestShape,
    tools?: ModelToolDefinition[]
  ): { url: string; body: JsonObject } {
    const { definition, endpoint, deployment, apiVersion } = connection;
    const legacy = endpointKind === 'azure-openai-legacy';
    const base = legacy
      ? endpoint.replace(/\/+$/, '').replace(/\/openai$/i, '')
      : endpoint.replace(/\/(?:chat\/completions|responses)\/?$/i, '').replace(/\/+$/, '');
    const version = `api-version=${encodeURIComponent(apiVersion)}`;
    const body: JsonObject = {};
    let url: string;

    if (shape.api === 'responses') {
      url = legacy ? `${base}/openai/responses?${version}` : `${base}/responses`;
      body.model = deployment;
      body.input = this.toResponsesInput(messages);
      if (tools?.length) {
        // Responses defaults function tools to strict schemas; AAA and MCP schemas are not strict.
        body.tools = tools.map((tool) => ({
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: false
        }));
        if (shape.toolChoice) body.tool_choice = 'auto';
      }
      if (shape.reasoning) {
        body.reasoning = {
          ...(definition.reasoningEffort ? { effort: definition.reasoningEffort } : {}),
          ...(definition.reasoningSummary ? { summary: definition.reasoningSummary } : {})
        };
      }
    } else {
      url = legacy
        ? `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?${version}`
        : `${base}/chat/completions`;
      if (!legacy) body.model = deployment;
      body.messages = this.toChatMessages(messages);
      if (tools?.length) {
        body.tools = tools;
        if (shape.toolChoice) body.tool_choice = 'auto';
      }
      if (shape.reasoning && definition.reasoningEffort) body.reasoning_effort = definition.reasoningEffort;
    }

    if (shape.temperature && definition.temperature !== null) body.temperature = definition.temperature ?? 0.2;
    if (shape.tokenParameter !== 'omit') body[shape.tokenParameter] = definition.maxTokens ?? defaultMaxTokens;
    body.stream = definition.stream !== false;
    if (body.stream && shape.api === 'chat-completions' && shape.includeUsage) {
      body.stream_options = { include_usage: true };
    }
    return { url, body };
  }

  private async *readResponse(
    response: Response,
    api: ModelApi,
    connection: ResolvedModelConnection,
    signal?: AbortSignal
  ): AsyncGenerator<ModelStreamChunk> {
    const contentType = response.headers.get('content-type') ?? '';
    if (/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
      yield* this.readCompleteResponse(await response.text(), api, connection);
      return;
    }
    if (!response.body) {
      throw new Error('Azure OpenAI streaming response body was not available.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number | string, ToolCallAccumulator>();
    let buffer = '';
    let completed = false;
    let usage: ModelUsage | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') {
            completed = true;
            continue;
          }
          let event: JsonObject;
          try {
            event = JSON.parse(data) as JsonObject;
          } catch {
            continue;
          }
          const result = api === 'responses'
            ? this.responsesEvent(event, toolCalls, connection)
            : this.chatEvent(event, toolCalls, connection);
          if (result.chunk) yield result.chunk;
          if (result.finished) completed = true;
          usage = normalizeUsage(api === 'responses'
            ? (isObject(event.response) ? event.response.usage : undefined)
            : event.usage) ?? usage;
        }
        if (done) break;
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
    if (usage) yield { type: 'usage', usage };
    const calls = completedToolCalls(toolCalls);
    if (calls.length > 0) yield { type: 'tool_calls', calls };
    yield { type: 'completed' };
  }

  private chatEvent(
    event: JsonObject,
    toolCalls: Map<number | string, ToolCallAccumulator>,
    connection: ResolvedModelConnection
  ): { chunk?: ModelStreamChunk; finished?: boolean } {
    if (isObject(event.error)) {
      throw new AgentRunError(`Azure OpenAI streaming response failed: ${errorText(event.error)}`);
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const first = choices[0] as {
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
        tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: unknown;
    } | undefined;
    this.assertFinishReason(first?.finish_reason, connection);

    for (const delta of first?.delta?.tool_calls ?? []) {
      const key = delta.index ?? 0;
      const current = toolCalls.get(key) ?? { id: delta.id ?? `call_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 40), name: '', arguments: '' };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name += delta.function.name;
      if (delta.function?.arguments) current.arguments += delta.function.arguments;
      toolCalls.set(key, current);
    }

    const finished = typeof first?.finish_reason === 'string' && first.finish_reason.length > 0;
    const delta = first?.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      return { chunk: { type: 'assistant_text', text: delta.content }, finished };
    }
    const reasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta?.reasoning === 'string' ? delta.reasoning : '';
    return reasoning ? { chunk: { type: 'reasoning', text: reasoning }, finished } : { finished };
  }

  private responsesEvent(
    event: JsonObject,
    toolCalls: Map<number | string, ToolCallAccumulator>,
    connection: ResolvedModelConnection
  ): { chunk?: ModelStreamChunk; finished?: boolean } {
    const type = typeof event.type === 'string' ? event.type : '';
    const item = isObject(event.item) ? event.item : undefined;

    if ((type === 'response.output_item.added' || type === 'response.output_item.done') && item?.type === 'function_call') {
      const key = typeof item.id === 'string' ? item.id : typeof item.call_id === 'string' ? item.call_id : String(toolCalls.size);
      const current = toolCalls.get(key) ?? { id: key, name: '', arguments: '' };
      if (typeof item.call_id === 'string') current.id = item.call_id;
      if (typeof item.name === 'string' && item.name) current.name = item.name;
      if (typeof item.arguments === 'string' && item.arguments) current.arguments = item.arguments;
      toolCalls.set(key, current);
      return {};
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const key = typeof event.item_id === 'string' ? event.item_id : String(Math.max(toolCalls.size - 1, 0));
      const current = toolCalls.get(key) ?? { id: key, name: '', arguments: '' };
      if (type === 'response.function_call_arguments.done') {
        if (typeof event.arguments === 'string' && event.arguments) current.arguments = event.arguments;
      } else if (typeof event.delta === 'string') {
        current.arguments += event.delta;
      }
      toolCalls.set(key, current);
      return {};
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      return { chunk: { type: 'assistant_text', text: event.delta } };
    }
    if (
      ['response.reasoning.delta', 'response.reasoning_text.delta',
        'response.reasoning_summary.delta', 'response.reasoning_summary_text.delta'].includes(type)
      && typeof event.delta === 'string'
    ) {
      return { chunk: { type: 'reasoning', text: event.delta } };
    }
    if (type === 'response.incomplete') {
      this.assertResponseComplete(isObject(event.response) ? event.response : {}, connection);
      return { finished: true };
    }
    if (type === 'response.completed') {
      return { finished: true };
    }
    if (type === 'response.failed' || type === 'error') {
      const response = isObject(event.response) ? event.response : undefined;
      const detail = isObject(response?.error) ? errorText(response.error) : errorText(event);
      throw new AgentRunError(`Azure OpenAI streaming response failed${detail ? `: ${detail}` : '.'}`);
    }
    return {};
  }

  /** Handles a non-streaming JSON body (for example a gateway that buffers or `stream: false`). */
  private *readCompleteResponse(
    raw: string,
    api: ModelApi,
    connection: ResolvedModelConnection
  ): Generator<ModelStreamChunk> {
    let body: JsonObject;
    try {
      body = JSON.parse(raw) as JsonObject;
    } catch {
      throw new Error('Azure OpenAI returned a JSON response that could not be parsed.');
    }
    if (isObject(body.error)) {
      throw new AgentRunError(`Azure OpenAI response failed: ${errorText(body.error)}`);
    }
    const calls: ModelToolCall[] = [];
    if (api === 'responses') {
      this.assertResponseComplete(body, connection);
      for (const item of Array.isArray(body.output) ? body.output.filter(isObject) : []) {
        if (item.type === 'reasoning') {
          const text = textParts(item.summary);
          if (text) yield { type: 'reasoning', text };
        } else if (item.type === 'message') {
          const text = textParts(item.content);
          if (text) yield { type: 'assistant_text', text };
        } else if (item.type === 'function_call' && typeof item.name === 'string') {
          calls.push(toolCall(
            typeof item.call_id === 'string' ? item.call_id : String(item.id ?? calls.length),
            item.name,
            typeof item.arguments === 'string' ? item.arguments : ''
          ));
        }
      }
    } else {
      const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as {
        message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: ModelToolCall[] };
        finish_reason?: unknown;
      } | undefined;
      this.assertFinishReason(choice?.finish_reason, connection);
      const message = choice?.message;
      if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
        yield { type: 'reasoning', text: message.reasoning_content };
      }
      if (typeof message?.content === 'string' && message.content) {
        yield { type: 'assistant_text', text: message.content };
      }
      for (const call of message?.tool_calls ?? []) {
        if (call.function?.name) calls.push(toolCall(call.id, call.function.name, call.function.arguments ?? ''));
      }
    }
    const usage = normalizeUsage(body.usage);
    if (usage) yield { type: 'usage', usage };
    if (calls.length > 0) yield { type: 'tool_calls', calls };
    yield { type: 'completed' };
  }

  private assertFinishReason(reason: unknown, connection: ResolvedModelConnection): void {
    if (reason === 'length') throw this.truncatedError(connection);
    if (reason === 'content_filter') {
      throw new AgentRunError('The deployment\'s content filter stopped the model response. Review the filter policy or rephrase the request.');
    }
  }

  private assertResponseComplete(response: JsonObject, connection: ResolvedModelConnection): void {
    if (response.status !== 'incomplete') return;
    const reason = isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
    if (reason === 'max_output_tokens') throw this.truncatedError(connection);
    throw new AgentRunError(`The model response was incomplete${typeof reason === 'string' ? ` (${reason})` : ''}.`);
  }

  private truncatedError(connection: ResolvedModelConnection): AgentRunError {
    return new AgentRunError(
      `The model reached its ${connection.definition.maxTokens ?? defaultMaxTokens}-token output limit before finishing. `
      + 'Increase maxTokens in config/agent-connections.json or ask for smaller steps, such as one file at a time.'
    );
  }

  private async readFailure(response: Response, connection: ResolvedModelConnection): Promise<ModelFailure> {
    let raw = '';
    try {
      raw = await response.text();
    } catch {
      // The status alone is still reported.
    }
    const redact = (text: string) => {
      const key = connection.apiKey;
      return (key ? text.split(key).join('[redacted]') : text).replace(/\s+/g, ' ').trim().slice(0, 600);
    };
    const failure: ModelFailure = { status: response.status, code: '', param: '', message: '', filtered: [], raw: redact(raw) };
    try {
      const parsed = JSON.parse(raw) as { error?: JsonObject; message?: unknown };
      const error = parsed.error ?? {};
      const inner = isObject(error.innererror) ? error.innererror : {};
      failure.code = typeof error.code === 'string' ? error.code
        : typeof inner.code === 'string' ? inner.code : '';
      failure.param = typeof error.param === 'string' ? error.param : '';
      failure.message = redact(typeof error.message === 'string' ? error.message
        : typeof parsed.message === 'string' ? parsed.message : '');
      failure.filtered = Object.entries(isObject(inner.content_filter_result) ? inner.content_filter_result : {})
        .filter(([, value]) => isObject(value) && (value.filtered === true || value.detected === true))
        .map(([name]) => name);
    } catch {
      failure.message = failure.raw;
    }
    return failure;
  }

  /** Builds a user-visible error that explains the failure without exposing credentials. */
  private requestError(
    connection: ResolvedModelConnection,
    attempts: Array<{ shape: ModelRequestShape; failure: ModelFailure }>,
    messages: ModelChatMessage[],
    tools?: ModelToolDefinition[]
  ): AgentRunError {
    const { failure } = attempts.at(-1)!;
    const toolResults = messages.filter((message) => message.role === 'tool').length;
    console.error(
      `[model] ${this.safeHost(connection.endpoint)} request failed; messages=${messages.length}, `
      + `toolResults=${toolResults}, tools=${tools?.length ?? 0}; attempts: `
      + attempts.map(({ shape, failure: f }) => `${describeShape(shape)} -> ${f.status} ${f.raw || '(empty body)'}`).join(' | ')
    );

    const parts = [`Azure OpenAI request failed with status ${failure.status}${failure.code ? ` (${failure.code})` : ''}.`];
    if (failure.message) parts.push(failure.message);
    if (failure.filtered.length > 0) parts.push(`Filtered categories: ${failure.filtered.join(', ')}.`);
    if (attempts.length > 1) {
      parts.push(`Tried ${attempts.map(({ shape, failure: f }) => `${shape.api} (${f.status})`).join(', ')}.`);
    }
    if (/content_filter|ResponsibleAIPolicyViolation/i.test(failure.code) || failure.filtered.length > 0) {
      parts.push('The deployment\'s content filter blocked the prompt or a tool result, such as loaded skill text. '
        + 'Review the filter policy, including prompt shields for indirect attacks, or adjust the skill wording.');
    } else if (/context_length_exceeded/i.test(failure.code)) {
      parts.push('The conversation plus tool results exceeded the model\'s context window. Start a new session or ask for a smaller step.');
    } else if (failure.status === 400 || failure.status === 404) {
      parts.push('Run "npm run model:probe" to test Chat Completions and Responses against this deployment, '
        + 'then set "api" and "tokenParameter" in config/agent-connections.json.');
    }
    return new AgentRunError(parts.join(' '));
  }

  private toChatMessages(messages: ModelChatMessage[]): JsonObject[] {
    return messages.map((message) => ({
      role: message.role,
      // Tool-call-only assistant turns use null content per the Chat Completions contract;
      // some deployments reject an empty string there.
      content: message.role === 'assistant' && message.toolCalls?.length && !message.content
        ? null
        : message.content,
      ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {})
    }));
  }

  private toResponsesInput(messages: ModelChatMessage[]): JsonObject[] {
    return messages.flatMap((message) => {
      if (message.role === 'tool') {
        return [{
          type: 'function_call_output',
          call_id: message.toolCallId ?? '',
          output: message.content
        }];
      }
      const items: JsonObject[] = [];
      // Empty assistant text before a function call is not a valid output_text item.
      if (message.content || message.role !== 'assistant') {
        items.push({
          type: 'message',
          role: message.role,
          content: [{
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: message.content
          }]
        });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
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

  private cacheKey(connection: ResolvedModelConnection): string {
    return `${connection.definition.id}|${connection.endpoint}|${connection.deployment}`;
  }

  private safeHost(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return 'the configured endpoint';
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: JsonObject): string {
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return [code && `(${code})`, message].filter(Boolean).join(' ').slice(0, 600);
}

function textParts(value: unknown): string {
  return (Array.isArray(value) ? value : [])
    .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function toolCall(id: string, name: string, args: string): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: args || '{}' } };
}

function completedToolCalls(toolCalls: Map<number | string, ToolCallAccumulator>): ModelToolCall[] {
  return Array.from(toolCalls.values())
    .filter((call) => call.name)
    .map((call) => toolCall(call.id, call.name, call.arguments));
}

function sameShape(left: ModelRequestShape, right: ModelRequestShape): boolean {
  return left.api === right.api
    && left.tokenParameter === right.tokenParameter
    && left.temperature === right.temperature
    && left.toolChoice === right.toolChoice
    && left.reasoning === right.reasoning
    && left.includeUsage === right.includeUsage;
}

/** Normalizes Chat Completions (`prompt_tokens`) and Responses (`input_tokens`) usage objects. */
export function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!isObject(raw)) return undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  const inputDetails = isObject(raw.input_tokens_details) ? raw.input_tokens_details
    : isObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const outputDetails = isObject(raw.output_tokens_details) ? raw.output_tokens_details
    : isObject(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
  const inputTokens = count(raw.input_tokens ?? raw.prompt_tokens);
  const outputTokens = count(raw.output_tokens ?? raw.completion_tokens);
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    cachedInputTokens: count(inputDetails.cached_tokens),
    outputTokens,
    reasoningTokens: count(outputDetails.reasoning_tokens),
    totalTokens: count(raw.total_tokens) || inputTokens + outputTokens
  };
}

function retryDelay(headers: Headers | undefined, retry: number): number {
  const maximum = 60_000;
  const millisecondsHeader = headers?.get('retry-after-ms') ?? headers?.get('x-ms-retry-after-ms');
  const milliseconds = millisecondsHeader ? Number(millisecondsHeader) : Number.NaN;
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.min(milliseconds, maximum);
  const retryAfter = headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, maximum);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maximum);
  }
  return Math.min(1000 * 2 ** retry + Math.random() * 250, 30_000);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function describeShape(shape: ModelRequestShape): string {
  return [
    shape.api,
    shape.tokenParameter === 'omit' ? 'no token limit' : shape.tokenParameter,
    shape.temperature ? 'temperature' : 'no temperature',
    ...(shape.toolChoice ? [] : ['no tool_choice']),
    ...(shape.reasoning ? ['reasoning'] : []),
    ...(shape.api === 'chat-completions' && !shape.includeUsage ? ['no stream usage'] : [])
  ].join(', ');
}

function describeChange(from: ModelRequestShape, to: ModelRequestShape): string {
  const changes: string[] = [];
  if (from.api !== to.api) changes.push(`api ${to.api}`);
  if (from.tokenParameter !== to.tokenParameter) changes.push(`token parameter ${to.tokenParameter}`);
  if (from.temperature !== to.temperature) changes.push('temperature omitted');
  if (from.toolChoice !== to.toolChoice) changes.push('tool_choice omitted');
  if (from.reasoning !== to.reasoning) changes.push('reasoning omitted');
  if (from.includeUsage !== to.includeUsage) changes.push('stream_options omitted');
  return changes.join(', ') || describeShape(to);
}
