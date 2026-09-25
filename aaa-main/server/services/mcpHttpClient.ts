import { DefaultAzureCredential } from '@azure/identity';
import type { ModelToolDefinition } from '../modelTypes.js';
import { log } from '../logger.js';
import type { McpAuthSettings } from '../../src/types/api.js';

type Fetch = typeof globalThis.fetch;

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** Resolved authentication (environment references already substituted). */
  auth?: McpAuthSettings;
}

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp?: number } | null>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const credentialCache = new Map<string, TokenCredentialLike>();
const defaultCredentialFactory = (auth: McpAuthSettings): TokenCredentialLike => new DefaultAzureCredential({
  ...(auth.managedIdentityClientId ? { managedIdentityClientId: auth.managedIdentityClientId } : {}),
  ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
  ...(auth.authorityHost ? { authorityHost: auth.authorityHost } : {})
} as ConstructorParameters<typeof DefaultAzureCredential>[0]);
let credentialFactory = defaultCredentialFactory;

/** Test hook: replace how Entra credentials are created (pass nothing to restore the default). */
export function setMcpCredentialFactory(factory?: (auth: McpAuthSettings) => TokenCredentialLike): void {
  credentialFactory = factory ?? defaultCredentialFactory;
  credentialCache.clear();
  tokenCache.clear();
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
  structured?: unknown;
  /** Embedded binary content (images, audio, resource blobs) to save as project files. */
  files?: McpFileContent[];
  /** Resources the server referenced by URI instead of embedding. */
  links?: McpResourceLink[];
}

export interface McpFileContent {
  name?: string;
  uri?: string;
  mimeType?: string;
  data: Buffer;
}

export interface McpResourceLink {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  data?: Buffer;
}

export interface HttpDownload {
  data: Buffer;
  contentType: string;
  fileName?: string;
}

interface McpContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  description?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export const maximumDownloadBytes = 10 * 1024 * 1024;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const protocolVersion = '2025-06-18';

function envMilliseconds(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Servers that recently failed to connect are skipped for a short period so that an
 * unreachable server (common on isolated networks, where packets are dropped rather
 * than refused) does not stall every chat turn. Keyed by server name and URL.
 */
const unreachableServers = new Map<string, { until: number; message: string }>();
const healthKey = (server: McpServerConfig) => `${server.name}|${server.url}`;

/** Clears the remembered failure for a server, e.g. after a successful connection test. */
export function markMcpServerHealthy(server: McpServerConfig): void {
  unreachableServers.delete(healthKey(server));
}

/** Test hook: forget every remembered MCP server failure. */
export function resetMcpServerHealth(): void {
  unreachableServers.clear();
}

/**
 * Minimal MCP client for the Streamable HTTP transport. It supports the subset AAA
 * needs (initialize, tools/list, tools/call) with JSON or SSE responses and optional
 * Mcp-Session-Id sessions, without adding an SDK dependency to the offline bundle.
 *
 * Connecting and listing tools use a short timeout (`AAA_MCP_CONNECT_TIMEOUT_MS`,
 * default 8 s) so a down server fails fast; tool calls use a longer one
 * (`AAA_MCP_TOOL_TIMEOUT_MS`, default 120 s) for legitimately slow work.
 */
export class McpHttpClient {
  private sessionId?: string;
  private negotiatedVersion?: string;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly server: McpServerConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly callTimeoutMs = envMilliseconds('AAA_MCP_TOOL_TIMEOUT_MS', 120_000),
    private readonly connectTimeoutMs = envMilliseconds('AAA_MCP_CONNECT_TIMEOUT_MS', 8_000)
  ) {}

  get name(): string {
    return this.server.name;
  }

  get config(): McpServerConfig {
    return this.server;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.initialize(signal);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal, this.connectTimeoutMs) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(result.tools ?? []).filter((tool) => typeof tool?.name === 'string'));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.initialize(signal);
    const result = await this.request('tools/call', { name, arguments: args }, signal, this.callTimeoutMs) as {
      content?: McpContentItem[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const parts: string[] = [];
    const files: McpFileContent[] = [];
    const links: McpResourceLink[] = [];
    for (const item of result.content ?? []) {
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') {
        files.push({ mimeType: item.mimeType, data: Buffer.from(item.data, 'base64') });
      } else if (item.type === 'resource' && item.resource) {
        if (typeof item.resource.blob === 'string') {
          files.push({ uri: item.resource.uri, mimeType: item.resource.mimeType, data: Buffer.from(item.resource.blob, 'base64') });
        } else {
          parts.push(item.resource.text ?? item.resource.uri ?? '');
        }
      } else if (item.type === 'resource_link' && typeof item.uri === 'string') {
        links.push({ uri: item.uri, name: item.name, mimeType: item.mimeType, description: item.description });
      } else if (item.type) {
        parts.push(`[${item.type} content]`);
      }
    }
    if (result.structuredContent !== undefined) {
      parts.push(parts.length ? `Structured result: ${JSON.stringify(result.structuredContent)}` : JSON.stringify(result.structuredContent));
    }
    return {
      text: parts.filter(Boolean).join('\n'),
      isError: result.isError === true,
      structured: result.structuredContent,
      ...(files.length ? { files } : {}),
      ...(links.length ? { links } : {})
    };
  }

  /** Reads an MCP resource (`resources/read`), e.g. a `resource_link` URI returned by a tool. */
  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    await this.initialize(signal);
    const result = await this.request('resources/read', { uri }, signal, this.callTimeoutMs) as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
    };
    return (result.contents ?? []).map((content) => ({
      uri: content.uri ?? uri,
      mimeType: content.mimeType,
      ...(typeof content.blob === 'string' ? { data: Buffer.from(content.blob, 'base64') } : { text: content.text ?? '' })
    }));
  }

  /** Whether an HTTP(S) URL is served from this MCP server's host (same origin). */
  sharesOrigin(url: URL): boolean {
    try {
      return new URL(this.server.url).origin === url.origin;
    } catch {
      return false;
    }
  }

  /** GETs a file from this server's origin with the server's headers and authentication. */
  async download(url: URL, signal?: AbortSignal): Promise<HttpDownload> {
    return httpDownload(url, this.fetchImpl, { ...this.server.headers, ...await this.authHeaders(signal, false) }, this.callTimeoutMs, signal);
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'aaa-workbench', version: '0.1.0' }
    }, signal, this.connectTimeoutMs) as { protocolVersion?: string };
    this.negotiatedVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : protocolVersion;
    const acknowledgement = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal, this.connectTimeoutMs);
    await acknowledgement.body?.cancel().catch(() => undefined);
    this.initialized = true;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal, timeoutMs);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    const contentType = response.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream')
      ? await this.readSseResponse(response, id)
      : await response.json() as JsonRpcMessage;
    if (message.error) {
      throw new Error(`MCP server ${this.server.name} rejected ${method}: ${message.error.message ?? 'unknown error'}`);
    }
    return message.result ?? {};
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
    const refreshable = this.server.auth?.type === 'oauth' || this.server.auth?.type === 'entra';
    let response = await this.send(body, signal, timeoutMs, false);
    if (response.status === 401 && refreshable) {
      // The cached token may have been revoked or expired early; get a fresh one once.
      await response.body?.cancel().catch(() => undefined);
      response = await this.send(body, signal, timeoutMs, true);
    }
    if (!response.ok) {
      throw new Error(`MCP server ${this.server.name} returned HTTP ${response.status}${
        response.status === 401 || response.status === 403 ? ' (check its authentication settings)' : ''}.`);
    }
    return response;
  }

  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    refreshToken: boolean
  ): Promise<Response> {
    const authHeaders = await this.authHeaders(signal, refreshToken);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout, ...(signal ? [signal] : [])];
    try {
      return await this.fetchImpl(this.server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.negotiatedVersion ? { 'MCP-Protocol-Version': this.negotiatedVersion } : {}),
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.server.headers,
          ...authHeaders
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(timeout.aborted
        ? `MCP server ${this.server.name} did not respond within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} at ${safeHost(this.server.url)}.`
        : `MCP server ${this.server.name} could not be reached at ${safeHost(this.server.url)}.`, {
        cause: error
      });
    }
  }

  private async authHeaders(signal: AbortSignal | undefined, refresh: boolean): Promise<Record<string, string>> {
    const auth = this.server.auth;
    if (!auth || auth.type === 'none') return {};
    if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token ?? ''}` };
    if (auth.type === 'header') return { [auth.headerName!]: auth.value ?? '' };

    const key = auth.type === 'oauth'
      ? `oauth|${auth.tokenUrl}|${auth.clientId}|${auth.scope ?? ''}|${auth.audience ?? ''}`
      : `entra|${auth.scope}|${auth.managedIdentityClientId ?? ''}|${auth.tenantId ?? ''}|${auth.authorityHost ?? ''}`;
    const cached = tokenCache.get(key);
    if (cached && !refresh && cached.expiresAt > Date.now() + 60_000) {
      return { Authorization: `Bearer ${cached.token}` };
    }
    const fresh = auth.type === 'oauth'
      ? await this.clientCredentialsToken(auth, signal)
      : await this.entraToken(auth, key);
    tokenCache.set(key, fresh);
    return { Authorization: `Bearer ${fresh.token}` };
  }

  private async clientCredentialsToken(
    auth: McpAuthSettings,
    signal?: AbortSignal
  ): Promise<{ token: string; expiresAt: number }> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.clientId ?? '',
      client_secret: auth.clientSecret ?? '',
      ...(auth.scope ? { scope: auth.scope } : {}),
      ...(auth.audience ? { audience: auth.audience } : {})
    });
    let response: Response;
    try {
      response = await this.fetchImpl(auth.tokenUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form.toString(),
        signal: AbortSignal.any([AbortSignal.timeout(this.connectTimeoutMs), ...(signal ? [signal] : [])])
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`MCP server ${this.server.name} could not reach its OAuth token endpoint at ${safeHost(auth.tokenUrl!)}.`, {
        cause: error
      });
    }
    const payload = await response.json().catch(() => ({})) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    if (!response.ok || typeof payload.access_token !== 'string') {
      const reason = [payload.error, payload.error_description].filter((part) => typeof part === 'string').join(': ');
      throw new Error(`MCP server ${this.server.name} could not obtain an OAuth token (HTTP ${response.status}${
        reason ? `, ${reason.slice(0, 300)}` : ''}).`);
    }
    const seconds = Number(payload.expires_in);
    return { token: payload.access_token, expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000 };
  }

  private async entraToken(auth: McpAuthSettings, key: string): Promise<{ token: string; expiresAt: number }> {
    let credential = credentialCache.get(key);
    if (!credential) {
      credential = credentialFactory(auth);
      credentialCache.set(key, credential);
    }
    let token: Awaited<ReturnType<TokenCredentialLike['getToken']>>;
    try {
      token = await credential.getToken(auth.scope!);
    } catch (error) {
      throw new Error(`MCP server ${this.server.name} could not obtain a Microsoft Entra token for ${auth.scope}: ${
        error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : 'unknown error'}`, { cause: error });
    }
    if (!token?.token) throw new Error(`MCP server ${this.server.name} could not obtain a Microsoft Entra token for ${auth.scope}.`);
    return { token: token.token, expiresAt: token.expiresOnTimestamp ?? Date.now() + 3_000_000 };
  }

  private async readSseResponse(response: Response, id: number): Promise<JsonRpcMessage> {
    if (!response.body) throw new Error(`MCP server ${this.server.name} returned an empty stream.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = done ? '' : events.pop() ?? '';
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const message = JSON.parse(data) as JsonRpcMessage;
          if (message.id === id) return message;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error(`MCP server ${this.server.name} closed the stream without a response.`);
  }
}

/** Exposes the tools of one or more MCP servers to the model under collision-free function names. */
export class McpToolbox {
  private readonly routes = new Map<string, { client: McpHttpClient; tool: string }>();

  constructor(
    private readonly clients: McpHttpClient[],
    private readonly retryAfterMs = envMilliseconds('AAA_MCP_RETRY_AFTER_MS', 60_000)
  ) {}

  /**
   * Lists every server's tools in parallel. A server that fails, times out, or failed
   * recently is reported in `errors` and skipped; it never fails or blocks the run.
   */
  async load(
    signal?: AbortSignal,
    filter?: (server: string, tool: string) => boolean
  ): Promise<{ definitions: ModelToolDefinition[]; errors: string[] }> {
    const listed = await Promise.all(this.clients.map(async (client) => {
      const key = healthKey(client.config);
      const known = unreachableServers.get(key);
      if (known && known.until > Date.now()) {
        const seconds = Math.ceil((known.until - Date.now()) / 1000);
        return { client, error: `${known.message} Skipped; AAA retries it in about ${seconds} s.` };
      }
      try {
        const tools = await client.listTools(signal);
        unreachableServers.delete(key);
        return { client, tools };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : `MCP server ${client.name} is unavailable.`;
        unreachableServers.set(key, { until: Date.now() + this.retryAfterMs, message });
        log.error('mcp', `${message} Continuing without its tools.`, { server: client.name });
        return { client, error: `${message} Continuing without its tools.` };
      }
    }));

    const definitions: ModelToolDefinition[] = [];
    const errors: string[] = [];
    for (const { client, tools, error } of listed) {
      if (error) {
        errors.push(error);
        continue;
      }
      for (const tool of tools ?? []) {
        if (filter && !filter(client.name, tool.name)) continue;
        const functionName = this.uniqueName(`mcp_${client.name}_${tool.name}`);
        this.routes.set(functionName, { client, tool: tool.name });
        const { $schema: _schema, ...schema } = tool.inputSchema ?? {};
        void _schema;
        definitions.push({
          type: 'function',
          function: {
            name: functionName,
            description: `[MCP ${client.name}] ${tool.description ?? tool.name}`.slice(0, 900)
              + ' String arguments may be "aaa-file:<project-relative-path>" to send that project file\'s text.',
            parameters: {
              type: 'object',
              properties: {},
              ...schema
            } as ModelToolDefinition['function']['parameters']
          }
        });
      }
    }
    return { definitions, errors };
  }

  has(functionName: string): boolean {
    return this.routes.has(functionName);
  }

  /** The configured MCP client with this name, if any. */
  client(name: string): McpHttpClient | undefined {
    return this.clients.find((client) => client.name === name);
  }

  /** The configured MCP client whose endpoint shares the URL's origin, if any. */
  clientForUrl(url: URL): McpHttpClient | undefined {
    return this.clients.find((client) => client.sharesOrigin(url));
  }

  serverNames(): string[] {
    return this.clients.map((client) => client.name);
  }

  describe(functionName: string): { server: string; tool: string } | undefined {
    const route = this.routes.get(functionName);
    return route ? { server: route.client.name, tool: route.tool } : undefined;
  }

  async call(functionName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    const route = this.routes.get(functionName);
    if (!route) throw new Error(`Unknown MCP tool: ${functionName}`);
    return route.client.callTool(route.tool, args, signal);
  }

  private uniqueName(candidate: string): string {
    const base = candidate.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    let name = base;
    for (let suffix = 2; this.routes.has(name); suffix += 1) {
      name = `${base.slice(0, 60)}_${suffix}`;
    }
    return name;
  }
}

/** GETs a URL with a size cap and timeout, returning the bytes and response metadata. */
export async function httpDownload(
  url: URL,
  fetchImpl: Fetch,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<HttpDownload> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Download from ${url.host} failed: the host could not be reached or did not respond in time.`, { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Download from ${url.host} returned HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumDownloadBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Download from ${url.host} is ${Math.ceil(declared / 1024 / 1024)} MB; the limit is 10 MB.`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumDownloadBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Download from ${url.host} exceeded the 10 MB limit.`);
    }
    chunks.push(value);
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const fileName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
    ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  return {
    data: Buffer.concat(chunks),
    contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase(),
    ...(fileName ? { fileName: decodeURIComponent(fileName) } : {})
  };
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'the configured endpoint';
  }
}
