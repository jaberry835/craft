import { cp, lstat, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import { BadRequestError, ConflictError, NotFoundError, PathBoundaryError, UnsupportedFileError } from './httpErrors.js';
import type { FileTreeNode, ProjectPathResult, ProjectTextFile } from '../src/types/api.js';

const excludedDirectories = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'vendor',
  '.git', '.svn', '.hg', '.next', '.nuxt', '.svelte-kit', '.vite', '.cache',
  '.venv', 'venv', '__pycache__'
]);
const maximumTextFileBytes = 2 * 1024 * 1024;
const textExtensions = new Set([
  '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.rb',
  '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
]);

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw error;
      }
      if (attempt === attempts) {
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
        await rm(source, { recursive: true, force: false });
        return;
      }
      await wait(attempt * 50);
    }
  }
}

export class ProjectFileService {
  constructor(private readonly rootPath: string) {}

  async listTree(): Promise<FileTreeNode[]> {
    return this.readDirectory('');
  }

  async readTextFile(relativePath: string): Promise<ProjectTextFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const absolutePath = await this.resolveExistingPath(normalizedPath);
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      throw new BadRequestError(`Project path is not a file: ${normalizedPath}`, 'path_not_file');
    }
    const content = await this.readUtf8(absolutePath, fileStats.size);
    return {
      path: normalizedPath,
      content,
      updatedAt: fileStats.mtime.toISOString(),
      size: fileStats.size
    };
  }

  async writeTextFile(relativePath: string, content: string, updatedAt: string): Promise<ProjectTextFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.validateContent(content);
    if (typeof updatedAt !== 'string' || !updatedAt || Number.isNaN(Date.parse(updatedAt))) {
      throw new BadRequestError('A valid updatedAt value is required.', 'updated_at_required');
    }
    const absolutePath = await this.resolveExistingPath(normalizedPath);
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      throw new BadRequestError(`Project path is not a file: ${normalizedPath}`, 'path_not_file');
    }
    if (fileStats.mtime.toISOString() !== updatedAt) {
      throw new ConflictError('The file changed since it was opened.', 'file_update_conflict');
    }
    await writeFile(absolutePath, content, 'utf8');
    return this.readTextFile(normalizedPath);
  }

  async createTextFile(relativePath: string, content: string): Promise<ProjectTextFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertTextExtension(normalizedPath);
    this.validateContent(content);
    const absolutePath = await this.resolveNewPath(normalizedPath);
    try {
      await writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictError(`Project path already exists: ${normalizedPath}`, 'path_already_exists');
      }
      throw error;
    }
    return this.readTextFile(normalizedPath);
  }

  async renamePath(relativePath: string, newRelativePath: string): Promise<ProjectPathResult> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const normalizedNewPath = this.normalizeRelativePath(newRelativePath);
    const absolutePath = await this.resolveExistingPath(normalizedPath);
    const sourceStats = await stat(absolutePath);
    if (
      sourceStats.isDirectory()
      && (normalizedNewPath === normalizedPath || normalizedNewPath.startsWith(`${normalizedPath}/`))
    ) {
      throw new BadRequestError('A directory cannot be renamed into itself.', 'invalid_rename');
    }
    const destination = await this.resolveNewPath(normalizedNewPath);
    try {
      await renameWithRetry(absolutePath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictError(`Project path already exists: ${normalizedNewPath}`, 'path_already_exists');
      }
      throw error;
    }
    return { path: normalizedNewPath, type: sourceStats.isDirectory() ? 'directory' : 'file' };
  }

  async deletePath(relativePath: string): Promise<ProjectPathResult> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const absolutePath = await this.resolveExistingPath(normalizedPath);
    const fileStats = await stat(absolutePath);
    await rm(absolutePath, { recursive: fileStats.isDirectory(), force: false });
    return { path: normalizedPath, type: fileStats.isDirectory() ? 'directory' : 'file' };
  }

  async renderPublishedMarkdown(relativePath: string): Promise<string> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    if (path.posix.extname(normalizedPath).toLowerCase() !== '.md') {
      throw new UnsupportedFileError('Only Markdown files can be published.', 'markdown_required');
    }
    const file = await this.readTextFile(normalizedPath);
    const title = path.posix.basename(normalizedPath, path.posix.extname(normalizedPath));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:3rem auto;padding:0 1.5rem;color:#172033}pre{padding:1rem;overflow:auto;background:#f2f4f7}code{background:#f2f4f7;padding:.1rem .25rem}blockquote{border-left:3px solid #8590a2;padding-left:1rem;color:#526071}a{color:#174ea6}</style>
</head><body><main>${renderMarkdown(file.content)}</main></body></html>`;
  }

  private async readDirectory(relativePath: string): Promise<FileTreeNode[]> {
    const absolutePath = relativePath ? await this.resolveExistingPath(relativePath) : this.rootPath;
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) =>
      !entry.name.startsWith('.')
      && !entry.isSymbolicLink()
      && !(entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase()))
    );
    const nodes = await Promise.all(visibleEntries.map(async (entry): Promise<FileTreeNode> => {
      const childPath = this.normalizeRelativePath(path.join(relativePath, entry.name));
      const node: FileTreeNode = {
        name: entry.name,
        path: childPath,
        type: entry.isDirectory() ? 'directory' : 'file'
      };
      if (entry.isDirectory()) {
        node.children = await this.readDirectory(childPath);
      }
      return node;
    }));
    return nodes.sort((left, right) =>
      left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'directory' ? -1 : 1
    );
  }

  private async resolveExistingPath(relativePath: string): Promise<string> {
    const candidate = path.resolve(this.rootPath, relativePath);
    this.assertWithinRoot(candidate);
    try {
      await this.assertNoSymlinks(relativePath);
      const canonical = await realpath(candidate);
      this.assertWithinRoot(canonical);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Project path was not found: ${relativePath}`);
      }
      throw error;
    }
  }

  private async resolveNewPath(relativePath: string): Promise<string> {
    const parent = path.posix.dirname(relativePath);
    const parentPath = parent === '.' ? '' : parent;
    const canonicalParent = parentPath ? await this.resolveExistingPath(parentPath) : await realpath(this.rootPath);
    const parentStats = await stat(canonicalParent);
    if (!parentStats.isDirectory()) {
      throw new BadRequestError(`Parent path is not a directory: ${parentPath}`, 'parent_not_directory');
    }
    const candidate = path.join(canonicalParent, path.posix.basename(relativePath));
    this.assertWithinRoot(candidate);
    try {
      await lstat(candidate);
      throw new ConflictError(`Project path already exists: ${relativePath}`, 'path_already_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return candidate;
  }

  private async assertNoSymlinks(relativePath: string): Promise<void> {
    let current = this.rootPath;
    for (const segment of relativePath.split('/')) {
      current = path.join(current, segment);
      const entryStats = await lstat(current);
      if (entryStats.isSymbolicLink()) {
        throw new PathBoundaryError('Symbolic links are not allowed in project paths.');
      }
    }
  }

  private assertWithinRoot(candidate: string): void {
    const relative = path.relative(this.rootPath, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new PathBoundaryError();
    }
  }

  private normalizeRelativePath(relativePath: string): string {
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      throw new BadRequestError('A project-relative path is required.', 'path_required');
    }
    if (relativePath !== relativePath.trim() || path.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath)) {
      throw new PathBoundaryError();
    }
    const normalized = relativePath.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (segments.some((segment) =>
      !segment || segment === '.' || segment === '..' || segment.length > 255
      || [...segment].some((character) => character.charCodeAt(0) < 32)
      || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
    )) {
      if (segments.includes('..')) {
        throw new PathBoundaryError();
      }
      throw new BadRequestError('The project-relative path is invalid.', 'invalid_path');
    }
    if (normalized.length > 1024) {
      throw new BadRequestError('The project-relative path is too long.', 'invalid_path');
    }
    this.assertAllowedSegments(segments);
    return normalized;
  }

  private assertAllowedSegments(segments: string[]): void {
    const excluded = segments.find((segment) => excludedDirectories.has(segment.toLowerCase()));
    if (excluded) {
      throw new BadRequestError(`Project path uses an excluded directory: ${excluded}`, 'excluded_path');
    }
  }

  private assertTextExtension(relativePath: string): void {
    if (!textExtensions.has(path.posix.extname(relativePath).toLowerCase())) {
      throw new UnsupportedFileError('The project path does not have a supported text extension.', 'unsupported_text_extension');
    }
  }

  private validateContent(content: string): void {
    if (typeof content !== 'string') {
      throw new BadRequestError('File content must be text.', 'invalid_content');
    }
    if (content.includes('\0')) {
      throw new UnsupportedFileError('Binary content cannot be written as text.', 'binary_content');
    }
    if (Buffer.byteLength(content, 'utf8') > maximumTextFileBytes) {
      throw new UnsupportedFileError('File is too large to write as text.', 'file_too_large');
    }
  }

  private async readUtf8(absolutePath: string, size: number): Promise<string> {
    if (size > maximumTextFileBytes) {
      throw new UnsupportedFileError('File is too large to read as text.', 'file_too_large');
    }
    const bytes = await readFile(absolutePath);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new UnsupportedFileError('File is not valid UTF-8 text.', 'invalid_utf8');
    }
    if (content.includes('\0')) {
      throw new UnsupportedFileError('Binary files cannot be read as text.', 'binary_file');
    }
    return content;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] as string);
}

function renderInline(value: string): string {
  let rendered = escapeHtml(value);
  rendered = rendered.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  rendered = rendered.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = href.startsWith('#') ? href : '#';
    return `<a href="${safeHref}">${label}</a>`;
  });
  return rendered;
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let code: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (code) {
      if (line.startsWith('```')) {
        output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      flushParagraph(); closeList(); code = [];
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      output.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
    } else if (item) {
      flushParagraph();
      const nextList = /\d+\./.test(item[2]) ? 'ol' : 'ul';
      if (list !== nextList) { closeList(); list = nextList; output.push(`<${list}>`); }
      output.push(`<li>${renderInline(item[3])}</li>`);
    } else if (/^\s*$/.test(line)) {
      flushParagraph(); closeList();
    } else if (line.startsWith('> ')) {
      flushParagraph(); closeList(); output.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
    } else {
      paragraph.push(line.trim());
    }
  }
  if (code) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph(); closeList();
  return output.join('\n');
}
