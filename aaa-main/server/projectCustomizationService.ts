import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CustomizationEditor,
  CustomizationItem,
  EditableCustomizationKind,
  McpAuthSettings,
  ProjectCustomizations,
  SaveCustomizationRequest
} from '../src/types/api.js';
import { BadRequestError, ConflictError, NotFoundError } from './httpErrors.js';
import { builtInToolCatalog, builtInToolItemId } from './builtInTools.js';
import { describeMcpAuth, maskMcpAuth, mergeMcpAuth, validateMcpAuth } from './mcpAuth.js';

interface CapabilityState {
  enabled: Record<string, boolean>;
  metadata: Record<string, { name: string; description: string }>;
}

interface McpServer {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  auth?: McpAuthSettings;
  [key: string]: unknown;
}

interface McpConfig {
  servers?: Record<string, McpServer>;
  inputs?: unknown[];
}

const editableKinds = new Set<EditableCustomizationKind>(['agent', 'skill', 'mcp-server', 'tool', 'instruction']);
const repositoryInstructionsPath = '.github/copilot-instructions.md';

export class ProjectCustomizationService {
  private readonly statePath: string;

  constructor(private readonly projectId: string, private readonly rootPath: string) {
    this.statePath = path.join(rootPath, '.aaa', 'customizations.json');
  }

  async list(): Promise<ProjectCustomizations> {
    const state = await this.readState();
    const items = [
      ...await this.markdownItems('.github/agents', 'agent', '.agent.md'),
      ...await this.skillItems(),
      ...await this.mcpItems(),
      ...await this.instructionItems(),
      ...(await this.markdownItems('.github/prompts', 'instruction', '.prompt.md')).map((item) => ({
        ...item,
        detail: `Prompt file · run as /${item.sourcePath!.split('/').at(-1)!.replace(/\.prompt\.md$/i, '')}`
      })),
      ...this.toolItems()
    ].map((item) => {
      const metadata = state.metadata[item.id];
      return {
        ...item,
        ...(metadata ? { name: metadata.name, description: metadata.description } : {}),
        enabled: state.enabled[item.id] ?? item.enabled
      };
    });
    return { projectId: this.projectId, items };
  }

  /** `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md` (VS Code format). */
  private async instructionItems(): Promise<CustomizationItem[]> {
    const items: CustomizationItem[] = [];
    try {
      const content = await readFile(path.join(this.rootPath, ...repositoryInstructionsPath.split('/')), 'utf8');
      const firstLine = parseMarkdown(content).body.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, '').trim();
      items.push({
        id: 'instruction:copilot-instructions.md',
        name: 'Repository instructions',
        description: firstLine?.slice(0, 200) || 'Always-on instructions for every request in this project.',
        kind: 'instruction',
        enabled: true,
        status: 'ready',
        detail: 'Applies to every request',
        sourcePath: repositoryInstructionsPath
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const directory = path.join(this.rootPath, '.github', 'instructions');
    for (const entry of (await safeReadDirectory(directory)).filter((candidate) =>
      candidate.isFile() && candidate.name.toLowerCase().endsWith('.instructions.md'))) {
      const metadata = parseMarkdown(await readFile(path.join(directory, entry.name), 'utf8')).metadata;
      const applyTo = metadata.applyTo?.trim();
      items.push({
        id: `instruction:instructions/${entry.name}`,
        name: metadata.name || friendlyName(entry.name.replace(/\.instructions\.md$/i, '')),
        description: metadata.description || 'Project instructions',
        kind: 'instruction',
        enabled: true,
        status: 'ready',
        detail: applyTo && applyTo !== '**' ? `Applies to ${applyTo}` : 'Applies to every request',
        sourcePath: `.github/instructions/${entry.name}`
      });
    }
    return items;
  }

  async getEditor(itemId: string): Promise<CustomizationEditor> {
    const item = (await this.list()).items.find((candidate) => candidate.id === itemId);
    if (!item || !editableKinds.has(item.kind as EditableCustomizationKind)) {
      throw new NotFoundError(`Unknown editable customization: ${itemId}`);
    }
    if (item.kind === 'tool') {
      return {
        id: item.id,
        kind: 'tool',
        name: item.name,
        description: item.description,
        enabled: item.enabled,
        readOnly: true
      };
    }
    if (item.kind === 'mcp-server') {
      const name = item.id.slice('mcp-server:'.length);
      const config = await this.readMcpConfig();
      const server = config.servers?.[name];
      if (!server) throw new NotFoundError(`Unknown MCP server: ${name}`);
      return {
        id: item.id,
        kind: 'mcp-server',
        name,
        description: item.description,
        enabled: item.enabled,
        sourcePath: '.vscode/mcp.json',
        transport: server.url ? 'http' : 'stdio',
        url: server.url ?? '',
        command: server.command ?? '',
        args: server.args?.join('\n') ?? '',
        auth: maskMcpAuth(server.auth) ?? { type: 'none' }
      };
    }

    const content = await readFile(path.join(this.rootPath, ...item.sourcePath!.split('/')), 'utf8');
    const parsed = parseMarkdown(content);
    if (item.kind === 'instruction') {
      const repository = item.sourcePath === repositoryInstructionsPath;
      const prompt = item.sourcePath!.toLowerCase().endsWith('.prompt.md');
      return {
        id: item.id,
        kind: 'instruction',
        name: repository ? item.name : parsed.metadata.name || item.name,
        description: repository ? item.description : parsed.metadata.description || item.description,
        enabled: item.enabled,
        sourcePath: item.sourcePath,
        instructions: parsed.body,
        ...(prompt ? { argumentHint: parsed.metadata['argument-hint'] ?? '' } : {}),
        ...(!repository && !prompt ? { applyTo: parsed.metadata.applyTo ?? '' } : {})
      };
    }
    const kind = item.kind as 'agent' | 'skill';
    return {
      id: item.id,
      kind,
      name: parsed.metadata.name || item.name,
      description: parsed.metadata.description || item.description,
      enabled: item.enabled,
      sourcePath: item.sourcePath,
      instructions: parsed.body,
      argumentHint: parsed.metadata['argument-hint'] ?? '',
      ...(kind === 'agent' ? {
        tools: toolNames(parsed.metadata.tools).join(', '),
        foundryEndpointEnv: parsed.metadata['foundry-endpoint-env'] ?? '',
        foundryAuthMode: parsed.metadata['foundry-auth'] === 'api-key' ? 'api-key' : 'entra',
        foundryApiKeyEnv: parsed.metadata['foundry-api-key-env'] ?? '',
        foundryCredentialScope: parsed.metadata['foundry-credential-scope'] ?? ''
      } : {})
    };
  }

  async create(request: SaveCustomizationRequest): Promise<CustomizationEditor> {
    const input = validateRequest(request);
    if (input.kind === 'tool') {
      throw new BadRequestError('Built-in tools cannot be created.', 'tool_creation_unsupported');
    }
    if (input.kind === 'mcp-server') {
      const key = slug(input.name);
      const config = await this.readMcpConfig();
      if (config.servers?.[key]) {
        throw new ConflictError(`An MCP server named ${key} already exists.`, 'customization_exists');
      }
      config.servers = { ...config.servers, [key]: mcpServer(input) };
      await this.writeMcpConfig(config);
      const id = `mcp-server:${key}`;
      await this.setMetadata(id, input.name, input.description);
      await this.setEnabled(id, input.enabled);
      return this.getEditor(id);
    }

    const key = slug(input.name);
    const relativePath = input.kind === 'agent'
      ? `.github/agents/${key}.agent.md`
      : input.kind === 'instruction'
        ? `.github/instructions/${key}.instructions.md`
        : `.github/skills/${key}/SKILL.md`;
    const target = path.join(this.rootPath, ...relativePath.split('/'));
    try {
      await readFile(target, 'utf8');
      throw new ConflictError(`A ${input.kind} named ${key} already exists.`, 'customization_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, createMarkdown(input), 'utf8');
    const id = input.kind === 'agent'
      ? `agent:${key}.agent.md`
      : input.kind === 'instruction' ? `instruction:instructions/${key}.instructions.md` : `skill:${key}`;
    await this.setEnabled(id, input.enabled);
    return this.getEditor(id);
  }

  async update(itemId: string, request: SaveCustomizationRequest): Promise<CustomizationEditor> {
    const current = await this.getEditor(itemId);
    const input = validateRequest(request);
    if (current.kind !== input.kind) {
      throw new BadRequestError('Customization type cannot be changed.', 'customization_kind_mismatch');
    }
    if (current.kind === 'tool') {
      await this.setEnabled(itemId, input.enabled);
      return this.getEditor(itemId);
    }
    if (current.kind === 'mcp-server') {
      const key = itemId.slice('mcp-server:'.length);
      const config = await this.readMcpConfig();
      config.servers = { ...config.servers, [key]: mcpServer(input, config.servers?.[key]) };
      await this.writeMcpConfig(config);
      await this.setMetadata(itemId, input.name, input.description);
    } else {
      const target = path.join(this.rootPath, ...current.sourcePath!.split('/'));
      const content = await readFile(target, 'utf8');
      await writeFile(target, current.sourcePath === repositoryInstructionsPath
        ? updateRepositoryInstructions(content, input)
        : updateMarkdown(content, input, current.sourcePath!), 'utf8');
    }
    await this.setEnabled(itemId, input.enabled);
    return this.getEditor(itemId);
  }

  async setEnabled(itemId: string, enabled: boolean): Promise<CustomizationItem> {
    if (typeof enabled !== 'boolean') {
      throw new BadRequestError('Enabled must be a boolean.', 'invalid_customization_enabled');
    }
    const item = (await this.list()).items.find((candidate) => candidate.id === itemId);
    if (!item || !editableKinds.has(item.kind as EditableCustomizationKind)) {
      throw new NotFoundError(`Unknown editable customization: ${itemId}`);
    }
    const state = await this.readState();
    state.enabled[itemId] = enabled;
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return { ...item, enabled };
  }

  private async skillItems(): Promise<CustomizationItem[]> {
    const directory = path.join(this.rootPath, '.github', 'skills');
    const entries = await safeReadDirectory(directory);
    const items: CustomizationItem[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const relativePath = `.github/skills/${entry.name}/SKILL.md`;
      try {
        const content = await readFile(path.join(directory, entry.name, 'SKILL.md'), 'utf8');
        const metadata = parseMarkdown(content).metadata;
        items.push({
          id: `skill:${entry.name}`,
          name: metadata.name || friendlyName(entry.name),
          description: metadata.description || 'Project skill',
          kind: 'skill',
          enabled: true,
          status: 'ready',
          sourcePath: relativePath
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return items;
  }

  private async markdownItems(
    relativeDirectory: string,
    kind: 'agent' | 'instruction',
    suffix: string
  ): Promise<CustomizationItem[]> {
    const directory = path.join(this.rootPath, ...relativeDirectory.split('/'));
    const entries = await safeReadDirectory(directory);
    return Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(suffix))
      .map(async (entry) => {
        const relativePath = `${relativeDirectory}/${entry.name}`;
        const metadata = parseMarkdown(await readFile(path.join(directory, entry.name), 'utf8')).metadata;
        return {
          id: `${kind}:${entry.name}`,
          name: metadata.name || friendlyName(entry.name.replace(suffix, '')),
          description: metadata.description || `Project ${kind}`,
          kind,
          enabled: true,
          status: 'ready',
          sourcePath: relativePath,
          ...(metadata['foundry-endpoint-env']
            ? { detail: `Foundry Responses endpoint: \${env:${metadata['foundry-endpoint-env']}}` }
            : metadata.tools ? { detail: `Tools: ${metadata.tools}` } : {})
        } satisfies CustomizationItem;
      }));
  }

  private async mcpItems(): Promise<CustomizationItem[]> {
    const config = await this.readMcpConfig();
    return Object.entries(config.servers ?? {}).map(([name, server]) => ({
      id: `mcp-server:${name}`,
      name: friendlyName(name),
      description: server.url
        ? `Connects to ${safeEndpoint(server.url)}`
        : server.command
          ? `Runs local command ${server.command}`
          : 'Project MCP server',
      kind: 'mcp-server',
      enabled: true,
      status: 'configured',
      detail: [server.type ? `${server.type.toUpperCase()} transport` : '', server.url ? describeMcpAuth(server.auth) : '']
        .filter(Boolean).join(' · ') || undefined,
      sourcePath: '.vscode/mcp.json'
    }));
  }

  private toolItems(): CustomizationItem[] {
    return builtInToolCatalog.map((tool) => ({
      id: builtInToolItemId(tool.name),
      name: tool.label,
      description: tool.description,
      kind: 'tool',
      enabled: true,
      status: 'ready',
      detail: `${tool.capability} capability`
    }));
  }

  private async readState(): Promise<CapabilityState> {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<CapabilityState>;
      return {
        enabled: state.enabled && typeof state.enabled === 'object' ? state.enabled : {},
        metadata: state.metadata && typeof state.metadata === 'object' ? state.metadata : {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: {}, metadata: {} };
      throw error;
    }
  }

  private async setMetadata(itemId: string, name: string, description: string): Promise<void> {
    const state = await this.readState();
    state.metadata[itemId] = { name, description };
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private async readMcpConfig(): Promise<McpConfig> {
    try {
      return JSON.parse(await readFile(path.join(this.rootPath, '.vscode', 'mcp.json'), 'utf8')) as McpConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {}, inputs: [] };
      throw error;
    }
  }

  private async writeMcpConfig(config: McpConfig): Promise<void> {
    const target = path.join(this.rootPath, '.vscode', 'mcp.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
}

async function safeReadDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function parseMarkdown(content: string): { metadata: Record<string, string>; body: string } {
  if (!content.startsWith('---')) return { metadata: {}, body: content.trim() };
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { metadata: {}, body: content.trim() };
  const metadata: Record<string, string> = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value.startsWith('"')) {
      try {
        metadata[key] = JSON.parse(value) as string;
        continue;
      } catch {
        // Preserve manually authored YAML-like values that are not JSON strings.
      }
    }
    metadata[key] = value.replace(/^["']|["']$/g, '');
  }
  return { metadata, body: content.slice(end + 4).trim() };
}

function updateMarkdown(content: string, input: SaveCustomizationRequest, sourcePath = ''): string {
  const parsed = parseMarkdown(content);
  const metadata: Record<string, string> = {
    ...parsed.metadata,
    name: input.name,
    description: input.description,
    'argument-hint': input.argumentHint ?? ''
  };
  if (input.kind === 'agent') {
    metadata.tools = toolList(input.tools);
    metadata['foundry-endpoint-env'] = input.foundryEndpointEnv ?? '';
    metadata['foundry-auth'] = input.foundryEndpointEnv ? input.foundryAuthMode ?? 'entra' : '';
    metadata['foundry-api-key-env'] = input.foundryAuthMode === 'api-key' ? input.foundryApiKeyEnv ?? '' : '';
    metadata['foundry-credential-scope'] = input.foundryCredentialScope ?? '';
  }
  if (input.kind === 'instruction' && sourcePath.toLowerCase().endsWith('.instructions.md')) {
    metadata.applyTo = input.applyTo ?? '';
  }
  return markdownDocument(metadata, input.instructions ?? parsed.body);
}

/** copilot-instructions.md is plain Markdown; only its body is edited and any front matter is kept. */
function updateRepositoryInstructions(content: string, input: SaveCustomizationRequest): string {
  const parsed = parseMarkdown(content);
  const body = input.instructions ?? parsed.body;
  return Object.keys(parsed.metadata).length > 0 ? markdownDocument(parsed.metadata, body) : `${body.trim()}\n`;
}

function createMarkdown(input: SaveCustomizationRequest): string {
  const metadata: Record<string, string> = {
    name: input.name,
    description: input.description,
    'argument-hint': input.argumentHint ?? ''
  };
  if (input.kind === 'agent') {
    metadata.tools = toolList(input.tools);
    metadata['foundry-endpoint-env'] = input.foundryEndpointEnv ?? '';
    metadata['foundry-auth'] = input.foundryEndpointEnv ? input.foundryAuthMode ?? 'entra' : '';
    metadata['foundry-api-key-env'] = input.foundryAuthMode === 'api-key' ? input.foundryApiKeyEnv ?? '' : '';
    metadata['foundry-credential-scope'] = input.foundryCredentialScope ?? '';
    metadata.agents = '[]';
    metadata['user-invocable'] = 'true';
  }
  if (input.kind === 'instruction') metadata.applyTo = input.applyTo ?? '';
  return markdownDocument(metadata, input.instructions ?? '');
}

function markdownDocument(metadata: Record<string, string>, body: string): string {
  const rawValues = new Set(['tools', 'agents', 'user-invocable']);
  const lines = Object.entries(metadata)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${rawValues.has(key) ? value : JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

function toolList(value?: string): string {
  const tools = toolNames(value);
  return `[${tools.map((tool) => JSON.stringify(tool)).join(', ')}]`;
}

export function toolNames(value?: string): string[] {
  return (value ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => {
      const trimmed = item.trim();
      if (trimmed.startsWith('"')) {
        try {
          return JSON.parse(trimmed) as string;
        } catch {
          return trimmed.replace(/^["']|["']$/g, '');
        }
      }
      return trimmed.replace(/^["']|["']$/g, '');
    })
    .filter(Boolean);
}

function validateRequest(request: SaveCustomizationRequest): SaveCustomizationRequest {
  if (!request || !editableKinds.has(request.kind)) {
    throw new BadRequestError('An editable customization type is required.', 'invalid_customization_kind');
  }
  const name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
  const description = typeof request.description === 'string'
    ? request.description.trim().slice(0, 2000)
    : '';
  if (!name) throw new BadRequestError('A capability name is required.', 'customization_name_required');
  if (!description) {
    throw new BadRequestError('A capability description is required.', 'customization_description_required');
  }
  if (typeof request.enabled !== 'boolean') {
    throw new BadRequestError('Enabled must be a boolean.', 'invalid_customization_enabled');
  }
  if (request.kind === 'mcp-server') {
    if (request.transport === 'http') {
      try {
        const url = new URL(request.url ?? '');
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
      } catch {
        throw new BadRequestError('HTTP MCP servers require a valid HTTP or HTTPS URL.', 'invalid_mcp_url');
      }
    } else if (request.transport === 'stdio') {
      if (!request.command?.trim()) {
        throw new BadRequestError('Local MCP servers require a command.', 'mcp_command_required');
      }
    } else {
      throw new BadRequestError('Choose HTTP or local command transport.', 'invalid_mcp_transport');
    }
  } else if (request.kind !== 'tool' && !request.instructions?.trim()) {
    throw new BadRequestError('Capability instructions are required.', 'customization_instructions_required');
  }
  if (request.kind === 'agent' && request.foundryEndpointEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.foundryEndpointEnv.trim())) {
      throw new BadRequestError('Foundry endpoint must reference an environment variable name.', 'invalid_foundry_endpoint_env');
    }
    if (request.foundryAuthMode !== 'entra' && request.foundryAuthMode !== 'api-key') {
      throw new BadRequestError('Choose Entra or API-key authentication for the Foundry agent.', 'invalid_foundry_auth');
    }
    if (request.foundryAuthMode === 'api-key' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.foundryApiKeyEnv?.trim() ?? '')) {
      throw new BadRequestError('API-key Foundry agents require an API-key environment variable name.', 'invalid_foundry_api_key_env');
    }
  }
  return {
    ...request,
    name,
    description,
    instructions: request.instructions?.trim(),
    argumentHint: request.argumentHint?.trim().slice(0, 500),
    tools: request.tools?.trim().slice(0, 1000),
    foundryEndpointEnv: request.foundryEndpointEnv?.trim().slice(0, 200),
    foundryAuthMode: request.foundryEndpointEnv ? request.foundryAuthMode : undefined,
    foundryApiKeyEnv: request.foundryApiKeyEnv?.trim().slice(0, 200),
    foundryCredentialScope: request.foundryCredentialScope?.trim().slice(0, 500),
    applyTo: request.applyTo?.trim().slice(0, 500),
    url: request.url?.trim().slice(0, 2000),
    command: request.command?.trim().slice(0, 1000),
    args: request.args?.trim().slice(0, 4000),
    auth: request.kind === 'mcp-server' && request.transport === 'http' ? validateMcpAuth(request.auth) : undefined
  };
}

/**
 * Builds the `.vscode/mcp.json` entry. Keys AAA does not edit (such as `headers`) are
 * preserved from the existing entry, and masked secrets keep their stored value.
 */
function mcpServer(input: SaveCustomizationRequest, existing?: McpServer): McpServer {
  const { type: _type, url: _url, command: _command, args: _args, auth: _auth, ...preserved } = existing ?? {};
  void _type; void _url; void _command; void _args; void _auth;
  if (input.transport === 'http') {
    const auth = mergeMcpAuth(existing?.auth, input.auth);
    return { ...preserved, type: 'http', url: input.url, ...(auth ? { auth } : {}) };
  }
  return {
    ...preserved,
    type: 'stdio',
    command: input.command,
    args: input.args?.split(/\r?\n/).map((argument) => argument.trim()).filter(Boolean) ?? []
  };
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  if (!result) throw new BadRequestError('The name must contain letters or numbers.', 'invalid_customization_name');
  return result;
}

function friendlyName(value: string): string {
  return value.split(/[-_]/).filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ');
}

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return 'the configured endpoint';
  }
}
