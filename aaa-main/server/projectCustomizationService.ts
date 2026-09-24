import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CustomizationEditor,
  CustomizationItem,
  EditableCustomizationKind,
  ProjectCustomizations,
  SaveCustomizationRequest
} from '../src/types/api.js';
import { BadRequestError, ConflictError, NotFoundError } from './httpErrors.js';

interface CapabilityState {
  enabled: Record<string, boolean>;
  metadata: Record<string, { name: string; description: string }>;
}

interface McpServer {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
}

interface McpConfig {
  servers?: Record<string, McpServer>;
  inputs?: unknown[];
}

const editableKinds = new Set<EditableCustomizationKind>(['agent', 'skill', 'mcp-server', 'tool']);

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
      ...await this.markdownItems('.github/prompts', 'instruction', '.prompt.md'),
      ...this.toolItems()
    ].map((item) => {
      const metadata = state.metadata[item.id];
      if (item.kind === 'instruction') {
        return { ...item, enabled: false, status: 'unavailable' as const, detail: 'Coming soon' };
      }
      return {
        ...item,
        ...(metadata ? { name: metadata.name, description: metadata.description } : {}),
        enabled: state.enabled[item.id] ?? item.enabled
      };
    });
    return { projectId: this.projectId, items };
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
        args: server.args?.join('\n') ?? ''
      };
    }

    const content = await readFile(path.join(this.rootPath, ...item.sourcePath!.split('/')), 'utf8');
    const parsed = parseMarkdown(content);
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
      ...(kind === 'agent' ? { tools: toolNames(parsed.metadata.tools).join(', ') } : {})
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
    const id = input.kind === 'agent' ? `agent:${key}.agent.md` : `skill:${key}`;
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
      config.servers = { ...config.servers, [key]: mcpServer(input) };
      await this.writeMcpConfig(config);
      await this.setMetadata(itemId, input.name, input.description);
    } else {
      const target = path.join(this.rootPath, ...current.sourcePath!.split('/'));
      const content = await readFile(target, 'utf8');
      await writeFile(target, updateMarkdown(content, input), 'utf8');
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
          ...(metadata.tools ? { detail: `Tools: ${metadata.tools}` } : {})
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
      detail: server.type ? `${server.type.toUpperCase()} transport` : undefined,
      sourcePath: '.vscode/mcp.json'
    }));
  }

  private toolItems(): CustomizationItem[] {
    return [
      ['list-files', 'List files', 'Inspect project paths without leaving the project root.', 'read'],
      ['read-file', 'Read file', 'Read supported UTF-8 project files.', 'read'],
      ['search-files', 'Search files', 'Find text across project files.', 'search'],
      ['write-file', 'Write file', 'Create or replace supported project text files.', 'edit'],
      ['edit-file', 'Edit file', 'Apply a targeted exact-text replacement.', 'edit'],
      ['copy-path', 'Copy path', 'Copy template files or folders without overwriting existing files.', 'edit'],
      ['browser-capture', 'Browser capture', 'Launch Microsoft Edge, navigate to web pages, and save screenshot evidence.', 'browser'],
      ['load-skill', 'Load skill', 'Load a project skill procedure when a request matches it.', 'skills']
    ].map(([id, name, description, detail]) => ({
      id: `tool:${id}`,
      name,
      description,
      kind: 'tool',
      enabled: true,
      status: 'ready',
      detail: `${detail} capability`
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

function updateMarkdown(content: string, input: SaveCustomizationRequest): string {
  const parsed = parseMarkdown(content);
  const metadata: Record<string, string> = {
    ...parsed.metadata,
    name: input.name,
    description: input.description,
    'argument-hint': input.argumentHint ?? ''
  };
  if (input.kind === 'agent') metadata.tools = toolList(input.tools);
  return markdownDocument(metadata, input.instructions ?? parsed.body);
}

function createMarkdown(input: SaveCustomizationRequest): string {
  const metadata: Record<string, string> = {
    name: input.name,
    description: input.description,
    'argument-hint': input.argumentHint ?? ''
  };
  if (input.kind === 'agent') {
    metadata.tools = toolList(input.tools);
    metadata.agents = '[]';
    metadata['user-invocable'] = 'true';
  }
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
  return {
    ...request,
    name,
    description,
    instructions: request.instructions?.trim(),
    argumentHint: request.argumentHint?.trim().slice(0, 500),
    tools: request.tools?.trim().slice(0, 1000),
    url: request.url?.trim().slice(0, 2000),
    command: request.command?.trim().slice(0, 1000),
    args: request.args?.trim().slice(0, 4000)
  };
}

function mcpServer(input: SaveCustomizationRequest): McpServer {
  return input.transport === 'http'
    ? { type: 'http', url: input.url }
    : {
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
