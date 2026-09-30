import type { FileTreeNode } from './types/api.js';

const previewImageExtensions = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

export function isPreviewImage(filePath: string): boolean {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return previewImageExtensions.has(extension);
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const elapsed = now - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

export function flattenVisibleNodes(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  depth = 0
): Array<{ node: FileTreeNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.type === 'directory' && expanded.has(node.path)
      ? flattenVisibleNodes(node.children ?? [], expanded, depth + 1)
      : [])
  ]);
}

export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node] : flattenFiles(node.children ?? []));
}

export function movedFilePath(sourcePath: string, destinationDirectory: string): string {
  const fileName = sourcePath.split('/').at(-1) ?? sourcePath;
  return destinationDirectory ? `${destinationDirectory}/${fileName}` : fileName;
}

export function findDefaultFile(nodes: FileTreeNode[]): FileTreeNode | undefined {
  const files = flattenFiles(nodes);
  return files.find((node) => node.name === 'validation-report.md')
    ?? files.find((node) => node.name === 'README.md')
    ?? files.find((node) => node.name.endsWith('.md'))
    ?? files[0];
}

export function initials(name: string): string {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase() || '?';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
