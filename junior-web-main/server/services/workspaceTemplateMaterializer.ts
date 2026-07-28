import type { WorkspaceTemplateDefinition } from '../types.js';
import type { WorkspaceIndexer } from './workspaceIndexer.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export interface WorkspaceTemplateMaterializationResult {
  createdDirectories: string[];
  createdFiles: string[];
  skippedFiles: string[];
}

/**
 * Applies a template's filesystem scaffold without overwriting workspace content.
 * Template definitions are configuration, so paths are normalized and rejected when
 * they attempt to escape the workspace root before the storage seam is called.
 */
export async function materializeWorkspaceTemplate(
  template: WorkspaceTemplateDefinition,
  storage: WorkspaceStorage,
  workspaceIndexer?: WorkspaceIndexer
): Promise<WorkspaceTemplateMaterializationResult> {
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  const directories = Array.from(new Set((template.directories ?? []).map(normalizeTemplatePath))).sort();
  const files = template.files ?? [];

  for (const directory of directories) {
    await storage.createDirectory(directory);
    createdDirectories.push(directory);
  }

  for (const file of files) {
    const filePath = normalizeTemplatePath(file.path);
    if (await workspaceFileExists(storage, filePath)) {
      skippedFiles.push(filePath);
      continue;
    }

    await storage.writeTextFile(filePath, file.content);
    createdFiles.push(filePath);
  }

  if (createdDirectories.length > 0 || createdFiles.length > 0) {
    await workspaceIndexer?.refresh();
  }

  return { createdDirectories, createdFiles, skippedFiles };
}

async function workspaceFileExists(storage: WorkspaceStorage, relativePath: string): Promise<boolean> {
  try {
    await storage.readTextFile(relativePath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function normalizeTemplatePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');

  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid workspace template path: ${value}`);
  }

  return normalized;
}