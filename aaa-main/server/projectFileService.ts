import { constants as fsConstants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import { BadRequestError, ConflictError, NotFoundError, PathBoundaryError, UnsupportedFileError } from './httpErrors.js';
import type {
  FileTreeNode,
  PublicationStatus,
  ProjectPathResult,
  ProjectTextFile,
  UploadedProjectFile
} from '../src/types/api.js';

const excludedDirectories = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'vendor',
  '.git', '.svn', '.hg', '.next', '.nuxt', '.svelte-kit', '.vite', '.cache',
  '.venv', 'venv', '__pycache__'
]);
const maximumTextFileBytes = 2 * 1024 * 1024;
const maximumUploadBytes = 10 * 1024 * 1024;
const textExtensions = new Set([
  '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.rb',
  '.rs', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
]);
const uploadExtensions = new Set([
  ...textExtensions,
  '.bmp', '.doc', '.docx', '.gif', '.jpeg', '.jpg', '.odp', '.ods', '.odt',
  '.pdf', '.png', '.ppt', '.pptx', '.svg', '.tif', '.tiff', '.webp', '.xls', '.xlsx'
]);
const imageContentTypes = new Map([
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);
const fileWriteQueues = new Map<string, Promise<void>>();

interface PublicationState {
  reviewed: Record<string, { hash: string; reviewedAt: string }>;
}

const bytes = (...values: number[]) => Buffer.from(values);
const binarySignatures: Record<string, Array<{ at: number; signature: Buffer }>> = {
  '.png': [{ at: 0, signature: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) }],
  '.jpg': [{ at: 0, signature: bytes(0xff, 0xd8, 0xff) }],
  '.jpeg': [{ at: 0, signature: bytes(0xff, 0xd8, 0xff) }],
  '.gif': [{ at: 0, signature: Buffer.from('GIF87a') }, { at: 0, signature: Buffer.from('GIF89a') }],
  '.bmp': [{ at: 0, signature: Buffer.from('BM') }],
  '.tif': [{ at: 0, signature: bytes(0x49, 0x49, 0x2a, 0x00) }, { at: 0, signature: bytes(0x4d, 0x4d, 0x00, 0x2a) }],
  '.tiff': [{ at: 0, signature: bytes(0x49, 0x49, 0x2a, 0x00) }, { at: 0, signature: bytes(0x4d, 0x4d, 0x00, 0x2a) }],
  '.pdf': [{ at: 0, signature: Buffer.from('%PDF-') }],
  '.doc': [{ at: 0, signature: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) }],
  '.xls': [{ at: 0, signature: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) }],
  '.ppt': [{ at: 0, signature: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) }]
};
const zipSignature = bytes(0x50, 0x4b, 0x03, 0x04);
const officeOpenXml = new Set(['.docx', '.xlsx', '.pptx']);
const openDocument = new Set(['.odt', '.ods', '.odp']);

/**
 * Rejects content whose bytes do not match its extension (for example an executable
 * renamed to .pdf), so previews and evidence handling only see the declared format.
 */
export function assertContentMatchesExtension(relativePath: string, content: Buffer): void {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const mismatch = (expected: string) => new UnsupportedFileError(
    `${path.posix.basename(relativePath)} does not contain valid ${expected} data; its content does not match the ${extension} extension.`,
    'file_signature_mismatch'
  );
  const signatures = binarySignatures[extension];
  if (signatures) {
    if (!signatures.some(({ at, signature }) => content.subarray(at, at + signature.length).equals(signature))) {
      throw mismatch(extension.slice(1).toUpperCase());
    }
    return;
  }
  if (extension === '.webp') {
    if (!(content.subarray(0, 4).toString('latin1') === 'RIFF' && content.subarray(8, 12).toString('latin1') === 'WEBP')) {
      throw mismatch('WebP');
    }
    return;
  }
  if (officeOpenXml.has(extension) || openDocument.has(extension)) {
    const text = content.toString('latin1');
    const valid = content.subarray(0, 4).equals(zipSignature) && (officeOpenXml.has(extension)
      ? text.includes('[Content_Types].xml')
      : text.includes('mimetypeapplication/vnd.oasis.opendocument'));
    if (!valid) throw mismatch(officeOpenXml.has(extension) ? 'Office Open XML' : 'OpenDocument');
    return;
  }
  // Text formats, including SVG: must be UTF-8 without NUL bytes.
  if (content.includes(0)) throw mismatch('text');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw mismatch('UTF-8 text');
  }
  if (extension === '.svg' && !/<svg(?:\s|>)/i.test(text)) throw mismatch('SVG');
}

function assertSafeSvg(content: string): void {
  if (!/<svg(?:\s|>)/i.test(content)) {
    throw new UnsupportedFileError('The file is not a valid SVG document.', 'invalid_svg');
  }
  const unsafe = [
    /<!doctype|<!entity|<\?xml-stylesheet/i,
    /<(?:script|foreignObject|iframe|object|embed|style)\b/i,
    /\bon[a-z]+\s*=/i,
    /\b(?:href|src)\s*=\s*["']\s*(?!#|["'])/i,
    /\burl\s*\(/i,
    /@import/i
  ];
  if (unsafe.some((pattern) => pattern.test(content))) {
    throw new UnsupportedFileError(
      'SVG preview blocks scripts, event handlers, embedded HTML, stylesheets, and external resources.',
      'unsafe_svg'
    );
  }
}

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

async function replaceWithRetry(source: string, destination: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY'].includes(code ?? '') || attempt === attempts) throw error;
      await wait(attempt * 50);
    }
  }
}

async function withFileWriteLock<T>(absolutePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileWriteQueues.get(absolutePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  fileWriteQueues.set(absolutePath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileWriteQueues.get(absolutePath) === queued) fileWriteQueues.delete(absolutePath);
  }
}

export class ProjectFileService {
  constructor(private readonly rootPath: string) {}

  async listTree(options: { includeHidden?: boolean; path?: string } = {}): Promise<FileTreeNode[]> {
    const relativePath = options.path ? this.normalizeRelativePath(options.path) : '';
    return this.readDirectory(relativePath, options.includeHidden ?? false);
  }

  /** Case-insensitive text search across supported text files under an optional project subdirectory. */
  async searchFiles(
    query: string,
    options: { path?: string; maxResults?: number } = {}
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    if (typeof query !== 'string' || !query.trim()) {
      throw new BadRequestError('A search query is required.', 'query_required');
    }
    const needle = query.toLowerCase();
    const maxResults = options.maxResults ?? 100;
    const results: Array<{ path: string; line: number; text: string }> = [];
    const files: string[] = [];
    const collect = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'directory') collect(node.children ?? []);
        else if (textExtensions.has(path.posix.extname(node.name).toLowerCase())) files.push(node.path);
      }
    };
    if (options.path) {
      const normalized = this.normalizeRelativePath(options.path);
      const target = await stat(await this.resolveExistingPath(normalized));
      if (target.isDirectory()) collect(await this.readDirectory(normalized, true));
      else files.push(normalized);
    } else {
      collect(await this.readDirectory('', false));
    }
    for (const filePath of files) {
      let content: string;
      try {
        content = (await this.readTextFile(filePath)).content;
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]!.toLowerCase().includes(needle)) {
          results.push({ path: filePath, line: index + 1, text: lines[index]!.trim().slice(0, 300) });
          if (results.length >= maxResults) return results;
        }
      }
    }
    return results;
  }

  /**
   * Copies a project file or directory to a new location inside the project.
   * Existing destination files are always preserved, so repeated copies only fill gaps.
   */
  async copyPath(sourcePath: string, destinationPath: string): Promise<{ created: string[]; preserved: string[] }> {
    const source = this.normalizeRelativePath(sourcePath);
    const destination = this.normalizeRelativePath(destinationPath);
    if (destination === source || destination.startsWith(`${source}/`)) {
      throw new BadRequestError('The copy destination cannot be the source or inside it.', 'invalid_copy_destination');
    }
    const created: string[] = [];
    const preserved: string[] = [];
    const maximumFiles = 500;
    const copyEntry = async (relativeSource: string, relativeDestination: string): Promise<void> => {
      const absoluteSource = await this.resolveExistingPath(relativeSource);
      const sourceStats = await stat(absoluteSource);
      if (sourceStats.isDirectory()) {
        await this.ensureDirectory(relativeDestination);
        const entries = await readdir(absoluteSource, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink() || (entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase()))) {
            continue;
          }
          await copyEntry(`${relativeSource}/${entry.name}`, `${relativeDestination}/${entry.name}`);
        }
        return;
      }
      if (created.length + preserved.length >= maximumFiles) {
        throw new BadRequestError(`Copy is limited to ${maximumFiles} files.`, 'copy_too_large');
      }
      const normalizedDestination = this.normalizeRelativePath(relativeDestination);
      const parent = path.posix.dirname(normalizedDestination);
      if (parent !== '.') await this.ensureDirectory(parent);
      const absoluteDestination = path.resolve(this.rootPath, normalizedDestination);
      this.assertWithinRoot(absoluteDestination);
      try {
        await copyFile(absoluteSource, absoluteDestination, fsConstants.COPYFILE_EXCL);
        created.push(normalizedDestination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        preserved.push(normalizedDestination);
      }
    };
    await copyEntry(source, destination);
    return { created, preserved };
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
    return withFileWriteLock(absolutePath, async () => {
      const fileStats = await stat(absolutePath);
      if (!fileStats.isFile()) {
        throw new BadRequestError(`Project path is not a file: ${normalizedPath}`, 'path_not_file');
      }
      if (fileStats.mtime.toISOString() !== updatedAt) {
        throw new ConflictError('The file changed since it was opened.', 'file_update_conflict');
      }

      const temporaryPath = path.join(
        path.dirname(absolutePath),
        `.${path.basename(absolutePath)}.${randomUUID()}.tmp`
      );
      try {
        await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
        const committedMtime = new Date(Math.max(Date.now(), fileStats.mtimeMs + 1));
        await utimes(temporaryPath, committedMtime, committedMtime);
        const currentStats = await stat(absolutePath);
        if (!currentStats.isFile() || currentStats.mtime.toISOString() !== updatedAt) {
          throw new ConflictError('The file changed since it was opened.', 'file_update_conflict');
        }
        await replaceWithRetry(temporaryPath, absolutePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return this.readTextFile(normalizedPath);
    });
  }

  async createTextFile(
    relativePath: string,
    content: string,
    options: { createParents?: boolean } = {}
  ): Promise<ProjectTextFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertTextExtension(normalizedPath);
    this.validateContent(content);
    const parent = path.posix.dirname(normalizedPath);
    if (options.createParents && parent !== '.') {
      await this.ensureDirectory(parent);
    }
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

  async uploadFile(
    relativePath: string,
    contentBase64: string,
    options: { createParents?: boolean } = {}
  ): Promise<UploadedProjectFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertUploadExtension(normalizedPath);
    if (typeof contentBase64 !== 'string') {
      throw new BadRequestError('Uploaded file content is required.', 'upload_content_required');
    }
    if (contentBase64.length > Math.ceil(maximumUploadBytes / 3) * 4) {
      throw new UnsupportedFileError('Uploaded files must be 10 MB or smaller.', 'file_too_large');
    }
    if (!isValidBase64(contentBase64)) {
      throw new BadRequestError('Uploaded file content is not valid base64.', 'invalid_upload_content');
    }
    const content = Buffer.from(contentBase64, 'base64');
    if (content.length > maximumUploadBytes) {
      throw new UnsupportedFileError('Uploaded files must be 10 MB or smaller.', 'file_too_large');
    }
    const parent = path.posix.dirname(normalizedPath);
    if (options.createParents && parent !== '.') {
      await this.ensureDirectory(parent);
    }
    const absolutePath = await this.resolveNewPath(normalizedPath);
    assertContentMatchesExtension(normalizedPath, content);
    try {
      await writeFile(absolutePath, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictError(`Project path already exists: ${normalizedPath}`, 'path_already_exists');
      }
      throw error;
    }
    return { path: normalizedPath, type: 'file', size: content.length };
  }

  /**
   * Saves downloaded or tool-produced content as a new project file. Never overwrites:
   * if the path exists, a numbered name such as `report-2.json` is used instead.
   */
  async saveNewFile(relativePath: string, content: Buffer): Promise<UploadedProjectFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertUploadExtension(normalizedPath);
    assertContentMatchesExtension(normalizedPath, content);
    if (content.length > maximumUploadBytes) {
      throw new UnsupportedFileError('Saved files must be 10 MB or smaller.', 'file_too_large');
    }
    const parent = path.posix.dirname(normalizedPath);
    if (parent !== '.') await this.ensureDirectory(parent);
    const extension = path.posix.extname(normalizedPath);
    const stem = normalizedPath.slice(0, normalizedPath.length - extension.length);
    for (let attempt = 1; attempt <= 200; attempt += 1) {
      const candidate = attempt === 1 ? normalizedPath : `${stem}-${attempt}${extension}`;
      try {
        const absolutePath = await this.resolveNewPath(candidate);
        await writeFile(absolutePath, content, { flag: 'wx' });
        return { path: candidate, type: 'file', size: content.length };
      } catch (error) {
        if (!(error instanceof ConflictError) && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new ConflictError(`Could not find a free file name for ${normalizedPath}.`, 'path_already_exists');
  }

  /** Whether a path's extension can be stored as a project file. */
  static canStore(relativePath: string): boolean {
    return uploadExtensions.has(path.posix.extname(relativePath).toLowerCase());
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
    await this.movePublicationReviews(normalizedPath, normalizedNewPath);
    return { path: normalizedNewPath, type: sourceStats.isDirectory() ? 'directory' : 'file' };
  }

  async deletePath(relativePath: string): Promise<ProjectPathResult> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const absolutePath = await this.resolveExistingPath(normalizedPath);
    const fileStats = await stat(absolutePath);
    await rm(absolutePath, { recursive: fileStats.isDirectory(), force: false });
    await this.removePublicationReviews(normalizedPath);
    return { path: normalizedPath, type: fileStats.isDirectory() ? 'directory' : 'file' };
  }

  async readImage(relativePath: string): Promise<{ content: Buffer; contentType: string }> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const contentType = imageContentTypes.get(path.posix.extname(normalizedPath).toLowerCase());
    if (!contentType) {
      throw new UnsupportedFileError('Only supported images can be previewed.', 'image_required');
    }
    const absolutePath = await this.resolveExistingPath(normalizedPath);
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      throw new BadRequestError(`Project path is not a file: ${normalizedPath}`, 'path_not_file');
    }
    if (fileStats.size > maximumUploadBytes) {
      throw new UnsupportedFileError('Image is too large to preview.', 'file_too_large');
    }
    const content = await readFile(absolutePath);
    if (contentType === 'image/svg+xml') {
      assertSafeSvg(content.toString('utf8'));
    }
    return { content, contentType };
  }

  async publicationStatus(relativePath: string): Promise<PublicationStatus> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertMarkdown(normalizedPath);
    const file = await this.readTextFile(normalizedPath);
    const state = await this.readPublicationState();
    const review = state.reviewed[normalizedPath];
    return {
      path: normalizedPath,
      reviewed: review?.hash === contentHash(file.content),
      ...(review?.hash === contentHash(file.content) ? { reviewedAt: review.reviewedAt } : {})
    };
  }

  async markReviewed(relativePath: string): Promise<PublicationStatus> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertMarkdown(normalizedPath);
    const file = await this.readTextFile(normalizedPath);
    const reviewedAt = new Date().toISOString();
    await this.updatePublicationState((state) => {
      state.reviewed[normalizedPath] = { hash: contentHash(file.content), reviewedAt };
      return true;
    });
    return { path: normalizedPath, reviewed: true, reviewedAt };
  }

  async renderPublishedMarkdown(relativePath: string): Promise<string> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    this.assertMarkdown(normalizedPath);
    // Read once and render exactly the bytes whose hash was verified, so an edit made
    // between the review check and rendering can never be published unreviewed.
    const file = await this.readTextFile(normalizedPath);
    const review = (await this.readPublicationState()).reviewed[normalizedPath];
    if (review?.hash !== contentHash(file.content)) {
      throw new ConflictError(
        'This Markdown version must be reviewed before it can be published.',
        'review_required'
      );
    }
    const title = path.posix.basename(normalizedPath, path.posix.extname(normalizedPath));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:3rem auto;padding:0 1.5rem;color:#172033}pre{padding:1rem;overflow:auto;background:#f2f4f7}code{background:#f2f4f7;padding:.1rem .25rem}blockquote{border-left:3px solid #8590a2;padding-left:1rem;color:#526071}a{color:#174ea6}</style>
</head><body><main>${renderMarkdown(file.content)}</main></body></html>`;
  }

  private async ensureDirectory(relativePath: string): Promise<void> {
    let current = this.rootPath;
    for (const segment of this.normalizeRelativePath(relativePath).split('/')) {
      current = path.join(current, segment);
      this.assertWithinRoot(current);
      try {
        const entryStats = await lstat(current);
        if (entryStats.isSymbolicLink()) {
          throw new PathBoundaryError('Symbolic links are not allowed in project paths.');
        }
        if (!entryStats.isDirectory()) {
          throw new BadRequestError(`Project path is not a directory: ${relativePath}`, 'parent_not_directory');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current);
      }
    }
  }

  private async readDirectory(relativePath: string, includeHidden = false): Promise<FileTreeNode[]> {
    const absolutePath = relativePath ? await this.resolveExistingPath(relativePath) : this.rootPath;
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) =>
      (includeHidden || !entry.name.startsWith('.'))
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
        node.children = await this.readDirectory(childPath, includeHidden);
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

  private assertUploadExtension(relativePath: string): void {
    if (!uploadExtensions.has(path.posix.extname(relativePath).toLowerCase())) {
      throw new UnsupportedFileError(
        'This file type is not supported for project uploads.',
        'unsupported_upload_extension'
      );
    }
  }

  private assertMarkdown(relativePath: string): void {
    if (path.posix.extname(relativePath).toLowerCase() !== '.md') {
      throw new UnsupportedFileError('Only Markdown files can be published.', 'markdown_required');
    }
  }

  private async readPublicationState(): Promise<PublicationState> {
    try {
      const content = await readFile(path.join(this.rootPath, '.aaa', 'publication.json'), 'utf8');
      const state = JSON.parse(content) as Partial<PublicationState>;
      return {
        reviewed: state.reviewed && typeof state.reviewed === 'object' ? state.reviewed : {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reviewed: {} };
      throw error;
    }
  }

  private async writePublicationState(state: PublicationState): Promise<void> {
    const statePath = this.publicationStatePath();
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await renameWithRetry(temporaryPath, statePath);
  }

  private publicationStatePath(): string {
    return path.resolve(this.rootPath, '.aaa', 'publication.json');
  }

  /**
   * Read-modify-write of `.aaa/publication.json`, serialized per project so concurrent
   * reviews, renames, and deletes never overwrite each other's changes.
   */
  private async updatePublicationState(update: (state: PublicationState) => boolean): Promise<void> {
    await withFileWriteLock(this.publicationStatePath(), async () => {
      const state = await this.readPublicationState();
      if (update(state)) await this.writePublicationState(state);
    });
  }

  private async movePublicationReviews(sourcePath: string, destinationPath: string): Promise<void> {
    await this.updatePublicationState((state) => {
      let changed = false;
      for (const [reviewedPath, review] of Object.entries(state.reviewed)) {
        if (reviewedPath === sourcePath || reviewedPath.startsWith(`${sourcePath}/`)) {
          const suffix = reviewedPath.slice(sourcePath.length);
          state.reviewed[`${destinationPath}${suffix}`] = review;
          delete state.reviewed[reviewedPath];
          changed = true;
        }
      }
      return changed;
    });
  }

  private async removePublicationReviews(deletedPath: string): Promise<void> {
    await this.updatePublicationState((state) => {
      let changed = false;
      for (const reviewedPath of Object.keys(state.reviewed)) {
        if (reviewedPath === deletedPath || reviewedPath.startsWith(`${deletedPath}/`)) {
          delete state.reviewed[reviewedPath];
          changed = true;
        }
      }
      return changed;
    });
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

function isValidBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const paddingStart = value.endsWith('==')
    ? value.length - 2
    : value.endsWith('=')
      ? value.length - 1
      : value.length;
  for (let index = 0; index < paddingStart; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) return false;
  }
  for (let index = paddingStart; index < value.length; index += 1) {
    if (value[index] !== '=') return false;
  }
  return true;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
