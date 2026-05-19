import { randomUUID } from 'node:crypto';
import type { ToolEvent, WorkspaceTreeNode } from '../../types.js';
import type { ChangeManager } from '../changeManager.js';
import type { WorkspaceIndexer } from '../workspaceIndexer.js';
import type { WorkspaceStorage } from '../workspaceStorage.js';
import type { LoopToolEntry } from './types.js';

interface WorkspaceToolDependencies {
  changeManager: ChangeManager;
  storage: WorkspaceStorage;
  workspaceIndexer: WorkspaceIndexer;
}

export function createWorkspaceTools(dependencies: WorkspaceToolDependencies): LoopToolEntry[] {
  return [
    {
      definition: {
        name: 'inspect-workspace',
        description: 'Inspect the current indexed workspace state, package sections, and pending changes.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: { type: 'object', properties: {} }
      },
      execute: async (context) => {
        const pendingChanges = await dependencies.changeManager.list();
        context.state.set('workspaceSummary', {
          indexedFileCount: context.index?.indexedFileCount ?? 0,
          fileCount: context.index?.fileCount ?? 0,
          packageSections: context.index?.packageSections ?? [],
          pendingChangeCount: pendingChanges.length
        });
        context.toolEvents.push(createToolEvent(
          'read',
          'Inspected workspace state',
          `${context.index?.indexedFileCount ?? 0}/${context.index?.fileCount ?? 0} indexed files; ${pendingChanges.length} pending change${pendingChanges.length === 1 ? '' : 's'}.`
        ));
        return { success: true, result: 'Workspace state inspected.' };
      }
    },
    {
      definition: {
        name: 'inspect-pending-changes',
        description: 'Inspect staged changes before further edits.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: { type: 'object', properties: {} }
      },
      execute: async (context) => {
        const pendingChanges = await dependencies.changeManager.list();
        context.state.set('pendingChangesSnapshot', pendingChanges.map((change) => ({
          path: change.path,
          action: change.action,
          summary: change.summary
        })));
        context.toolEvents.push(createToolEvent(
          'read',
          'Inspected pending changes',
          pendingChanges.length > 0
            ? `${pendingChanges.length} pending change${pendingChanges.length === 1 ? '' : 's'} currently staged.`
            : 'No pending changes are currently staged.'
        ));
        return {
          success: true,
          result: pendingChanges.length > 0
            ? pendingChanges.map((change) => `${change.path}: ${change.summary}`).join('\n')
            : 'No pending changes are currently staged.'
        };
      }
    },
    {
      definition: {
        name: 'list_directory',
        description: 'List files and directories under a relative workspace path.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          }
        }
      },
      execute: async (_context, args) => {
        const targetPath = String(args.path ?? '').trim();
        const tree = await dependencies.storage.listTree();
        const prefix = targetPath.replace(/^\/+|\/+$/g, '');
        const nodes = prefix
          ? flattenNodes(tree).filter((node) => node.path.startsWith(prefix === '' ? '' : `${prefix}`))
          : flattenNodes(tree);
        return {
          success: true,
          result: nodes.length > 0
            ? nodes.map((node) => `${node.type === 'directory' ? 'dir' : 'file'} ${node.path}`).join('\n')
            : `No entries found for ${prefix || '.'}.`
        };
      }
    },
    {
      definition: {
        name: 'search_files',
        description: 'Search workspace file paths by substring and return matching relative paths.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['query']
        }
      },
      execute: async (_context, args) => {
        const query = String(args.query ?? '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(100, Number(args.limit ?? 50)));
        const tree = await dependencies.storage.listTree();
        const matches = flattenNodes(tree)
          .filter((node) => node.type === 'file' && node.path.toLowerCase().includes(query))
          .slice(0, limit)
          .map((node) => node.path);
        return {
          success: true,
          result: matches.length > 0 ? matches.join('\n') : 'No files match.'
        };
      }
    },
    {
      definition: {
        name: 'grep_search',
        description: 'Search for literal text or a regex across workspace files and return matching lines with file paths and line numbers.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            include: { type: 'string' },
            isRegex: { type: 'boolean' },
            limit: { type: 'number' }
          },
          required: ['pattern']
        }
      },
      execute: async (context, args) => {
        const pattern = String(args.pattern ?? '').trim();
        const include = String(args.include ?? '').trim();
        const isRegex = Boolean(args.isRegex ?? false);
        const limit = Math.max(1, Math.min(100, Number(args.limit ?? 50)));
        if (!pattern) {
          return { success: false, result: 'pattern is required.' };
        }

        let matcher: RegExp | null = null;
        try {
          matcher = isRegex ? new RegExp(pattern, 'i') : null;
        } catch (error) {
          return { success: false, result: `Invalid regex: ${error instanceof Error ? error.message : String(error)}` };
        }

        const tree = await dependencies.storage.listTree();
        const files = flattenNodes(tree)
          .filter((node) => node.type === 'file')
          .map((node) => node.path)
          .filter((path) => !include || path.includes(include));
        const results: string[] = [];

        for (const path of files) {
          if (results.length >= limit) {
            break;
          }

          const file = await dependencies.storage.readTextFile(path);
          const lines = file.content.split('\n');
          for (let index = 0; index < lines.length && results.length < limit; index += 1) {
            const line = lines[index];
            const matched = matcher ? matcher.test(line) : line.toLowerCase().includes(pattern.toLowerCase());
            if (matched) {
              results.push(`${path}:${index + 1}: ${line.trim()}`);
            }
          }
        }

        context.toolEvents.push(createToolEvent('search', 'Ran grep search', `${results.length} match${results.length === 1 ? '' : 'es'} for ${pattern}.`));
        return {
          success: true,
          result: results.length > 0 ? results.join('\n') : 'No matches found.'
        };
      }
    },
    {
      definition: {
        name: 'read_file',
        description: 'Read the contents of a workspace file by relative path. Optional startLine and endLine narrow the output.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' }
          },
          required: ['path']
        }
      },
      execute: async (context, args) => {
        const path = String(args.path ?? '').trim();
        if (!path) {
          return { success: false, result: 'path is required.' };
        }

        const file = await dependencies.storage.readTextFile(path);
        const lines = file.content.split('\n');
        const startLine = Math.max(1, Number(args.startLine ?? 1));
        const endLine = Math.min(lines.length, Number(args.endLine ?? lines.length));
        const slice = lines.slice(startLine - 1, endLine);
        const body = slice.map((line, index) => `${startLine + index}: ${line}`).join('\n');
        context.toolEvents.push(createToolEvent('read', 'Read workspace file', `${path} lines ${startLine}-${endLine}`, path));
        return { success: true, result: body || `${path} is empty.` };
      }
    },
    {
      definition: {
        name: 'replace_lines',
        description: 'Replace an inclusive line range in a workspace file with new content. Use this when an exact-string edit is too brittle.',
        isReadOnly: false,
        requiresConfirmation: true,
        confirmationCategory: 'file-edit',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
            content: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['path', 'startLine', 'endLine', 'content']
        }
      },
      execute: async (context, args) => {
        const path = String(args.path ?? '').trim();
        const startLine = Number(args.startLine);
        const endLine = Number(args.endLine);
        const replacement = String(args.content ?? '');
        const summary = String(args.summary ?? `Replace lines in ${path}`);
        if (!path || Number.isNaN(startLine) || Number.isNaN(endLine)) {
          return { success: false, result: 'path, startLine, endLine, and content are required.' };
        }

        const current = await dependencies.storage.readTextFile(path);
        const lines = current.content.split('\n');
        if (startLine < 1 || endLine < startLine || endLine > lines.length) {
          return { success: false, result: `Invalid line range ${startLine}-${endLine} for ${path} (${lines.length} lines).` };
        }

        const updated = [
          ...lines.slice(0, startLine - 1),
          ...replacement.split('\n'),
          ...lines.slice(endLine)
        ].join('\n');
        context.staged.push(await dependencies.changeManager.stageFileChange(path, updated, summary));
        context.toolEvents.push(createToolEvent('edit', 'Staged line-range edit', `${path} lines ${startLine}-${endLine}`, path));
        return { success: true, result: `Staged line-range edit for ${path} lines ${startLine}-${endLine}.` };
      }
    },
    {
      definition: {
        name: 'search_workspace',
        description: 'Search indexed workspace file paths and contents for a query string.',
        isReadOnly: true,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['query']
        }
      },
      execute: async (context, args) => {
        const query = String(args.query ?? '').trim();
        const limit = Math.max(1, Math.min(10, Number(args.limit ?? 5)));
        if (!query) {
          return { success: false, result: 'query is required.' };
        }

        const results = dependencies.workspaceIndexer.search(query, limit);
        context.toolEvents.push(createToolEvent('search', 'Searched workspace index', `${results.length} result${results.length === 1 ? '' : 's'} for "${query}".`));
        return {
          success: true,
          result: results.length > 0
            ? results.map((result) => `${result.path} (score ${result.score}): ${result.preview}`).join('\n\n')
            : `No indexed matches for "${query}".`
        };
      }
    },
    {
      definition: {
        name: 'write_file',
        description: 'Create or fully replace a workspace file with the provided content.',
        isReadOnly: false,
        requiresConfirmation: true,
        confirmationCategory: 'file-write',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['path', 'content']
        }
      },
      execute: async (context, args) => {
        const path = String(args.path ?? '').trim();
        const content = String(args.content ?? '');
        const summary = String(args.summary ?? `Write ${path}`);
        if (!path) {
          return { success: false, result: 'path is required.' };
        }

        context.staged.push(await dependencies.changeManager.stageFileChange(path, content, summary));
        context.toolEvents.push(createToolEvent('edit', 'Staged file write', summary, path));
        return { success: true, result: `Staged write for ${path}.` };
      }
    },
    {
      definition: {
        name: 'edit_file',
        description: 'Replace an exact string in a workspace file with new content. Use for targeted edits.',
        isReadOnly: false,
        requiresConfirmation: true,
        confirmationCategory: 'file-edit',
        category: 'workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldString: { type: 'string' },
            newString: { type: 'string' },
            summary: { type: 'string' }
          },
          required: ['path', 'oldString', 'newString']
        }
      },
      execute: async (context, args) => {
        const path = String(args.path ?? '').trim();
        const oldString = String(args.oldString ?? '');
        const newString = String(args.newString ?? '');
        const summary = String(args.summary ?? `Edit ${path}`);
        if (!path || !oldString) {
          return { success: false, result: 'path and oldString are required.' };
        }

        const current = await dependencies.storage.readTextFile(path);
        const matchCount = current.content.split(oldString).length - 1;
        if (matchCount !== 1) {
          return { success: false, result: `Expected exactly one match for oldString in ${path}, found ${matchCount}.` };
        }

        const updated = current.content.replace(oldString, newString);
        context.staged.push(await dependencies.changeManager.stageFileChange(path, updated, summary));
        context.toolEvents.push(createToolEvent('edit', 'Staged file edit', summary, path));
        return { success: true, result: `Staged targeted edit for ${path}.` };
      }
    }
  ];
}

function flattenNodes(nodes: WorkspaceTreeNode[]): Array<{ path: string; type: 'file' | 'directory' }> {
  return nodes.flatMap((node) => [
    { path: node.path, type: node.type },
    ...flattenNodes(node.children ?? [])
  ]);
}

function createToolEvent(type: ToolEvent['type'], label: string, detail?: string, filePath?: string): ToolEvent {
  return {
    id: randomUUID(),
    type,
    label,
    detail,
    filePath,
    createdAt: new Date().toISOString()
  };
}