import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import path from 'node:path';
import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';
import type { WorkspaceStorage } from './workspaceStorage.js';
import { seedFiles } from './workspaceSeed.js';

const directoryPlaceholder = '.keep';

export interface BlobWorkspaceStorageOptions {
  connectionString?: string;
  serviceUrl?: string;
  containerName: string;
  workspaceId: string;
  prefix?: string;
}

export class BlobWorkspaceStorage implements WorkspaceStorage {
  private readonly container: ContainerClient;
  private readonly workspacePrefix: string;

  constructor(private readonly options: BlobWorkspaceStorageOptions) {
    const serviceClient = options.connectionString?.trim()
      ? BlobServiceClient.fromConnectionString(options.connectionString)
      : this.createIdentityServiceClient(options.serviceUrl);
    this.container = serviceClient.getContainerClient(options.containerName);
    const prefix = options.prefix?.replace(/^\/+|\/+$/g, '') || 'workspaces';
    this.workspacePrefix = `${prefix}/${options.workspaceId}/`;
  }

  async ensureSeedWorkspace(): Promise<void> {
    await this.container.createIfNotExists();

    for (const [relativePath, content] of Object.entries(seedFiles)) {
      const blobClient = this.container.getBlockBlobClient(this.blobName(relativePath));
      if (await blobClient.exists()) {
        continue;
      }

      await blobClient.upload(content, Buffer.byteLength(content, 'utf8'), {
        blobHTTPHeaders: { blobContentType: this.contentType(relativePath) }
      });
    }
  }

  async listTree(): Promise<WorkspaceTreeNode[]> {
    await this.container.createIfNotExists();
    const roots: WorkspaceTreeNode[] = [];

    for await (const blob of this.container.listBlobsFlat({ prefix: this.workspacePrefix })) {
      const relativePath = this.relativePath(blob.name);
      if (!relativePath || !this.isVisiblePath(relativePath)) {
        continue;
      }

      this.insertNode(roots, relativePath);
    }

    return this.sortNodes(roots);
  }

  async readTextFile(relativePath: string): Promise<WorkspaceFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const blobClient = this.container.getBlobClient(this.blobName(normalizedPath));
    const download = await blobClient.download();
    const content = await this.streamToString(download.readableStreamBody);

    return {
      path: normalizedPath,
      content,
      updatedAt: download.lastModified?.toISOString() ?? new Date().toISOString()
    };
  }

  async writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const blobClient = this.container.getBlockBlobClient(this.blobName(normalizedPath));
    await this.container.createIfNotExists();
    await blobClient.upload(content, Buffer.byteLength(content, 'utf8'), {
      blobHTTPHeaders: { blobContentType: this.contentType(normalizedPath) }
    });
    return this.readTextFile(normalizedPath);
  }

  async createDirectory(relativePath: string): Promise<WorkspaceTreeNode> {
    const normalizedPath = this.normalizeRelativePath(relativePath).replace(/\/+$/g, '');
    const blobClient = this.container.getBlockBlobClient(this.blobName(`${normalizedPath}/${directoryPlaceholder}`));
    await this.container.createIfNotExists();
    await blobClient.upload('', 0);

    return {
      name: path.posix.basename(normalizedPath),
      path: normalizedPath,
      type: 'directory'
    };
  }

  async deletePath(relativePath: string): Promise<{ path: string; type: 'file' | 'directory' }> {
    const normalizedPath = this.normalizeRelativePath(relativePath).replace(/\/+$/g, '');
    const fileBlob = this.container.getBlobClient(this.blobName(normalizedPath));

    if (await fileBlob.exists()) {
      await fileBlob.delete();
      return { path: normalizedPath, type: 'file' };
    }

    const prefix = this.blobName(`${normalizedPath}/`);
    const toDelete: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      toDelete.push(blob.name);
    }

    if (toDelete.length === 0) {
      throw new Error(`Workspace path not found: ${normalizedPath}`);
    }

    await Promise.all(toDelete.map((name) => this.container.deleteBlob(name)));
    return { path: normalizedPath, type: 'directory' };
  }

  async readMarkdownPackageFiles(): Promise<WorkspaceFile[]> {
    const tree = await this.listTree();
    const markdownPaths = this.flattenTree(tree)
      .filter((node) => node.type === 'file' && node.path.endsWith('.md'))
      .map((node) => node.path);

    return Promise.all(markdownPaths.map((filePath) => this.readTextFile(filePath)));
  }

  getAbsoluteRoot(): string {
    return `blob://${this.options.containerName}/${this.workspacePrefix}`;
  }

  private blobName(relativePath: string): string {
    return `${this.workspacePrefix}${this.normalizeRelativePath(relativePath)}`;
  }

  private relativePath(blobName: string): string {
    const relativePath = blobName.startsWith(this.workspacePrefix) ? blobName.slice(this.workspacePrefix.length) : blobName;
    return relativePath.endsWith(`/${directoryPlaceholder}`)
      ? relativePath.slice(0, -(`/${directoryPlaceholder}`.length))
      : relativePath;
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  }

  private isVisiblePath(relativePath: string): boolean {
    return relativePath.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.'));
  }

  private insertNode(nodes: WorkspaceTreeNode[], relativePath: string): void {
    const segments = relativePath.split('/').filter(Boolean);
    let currentNodes = nodes;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const isLeaf = index === segments.length - 1;
      const nodePath = segments.slice(0, index + 1).join('/');
      let node = currentNodes.find((candidate) => candidate.path === nodePath);

      if (!node) {
        node = {
          name: segment,
          path: nodePath,
          type: isLeaf ? 'file' : 'directory'
        };
        if (!isLeaf) {
          node.children = [];
        }
        currentNodes.push(node);
      }

      if (!isLeaf) {
        node.type = 'directory';
        node.children ??= [];
        currentNodes = node.children;
      }
    }
  }

  private sortNodes(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
    return nodes
      .map((node) => node.type === 'directory'
        ? { ...node, children: this.sortNodes(node.children ?? []) }
        : node)
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
  }

  private flattenTree(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
    return nodes.flatMap((node) => [node, ...this.flattenTree(node.children ?? [])]);
  }

  private async streamToString(stream: NodeJS.ReadableStream | undefined | null): Promise<string> {
    if (!stream) {
      return '';
    }

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  private contentType(relativePath: string): string {
    const extension = path.extname(relativePath).toLowerCase();
    switch (extension) {
      case '.md':
      case '.markdown':
        return 'text/markdown; charset=utf-8';
      case '.json':
        return 'application/json; charset=utf-8';
      case '.yaml':
      case '.yml':
        return 'application/yaml; charset=utf-8';
      case '.txt':
      default:
        return 'text/plain; charset=utf-8';
    }
  }

  private createIdentityServiceClient(serviceUrl: string | undefined): BlobServiceClient {
    if (!serviceUrl?.trim()) {
      throw new Error('Blob storage requires either a connection string or a blob service URL.');
    }

    return new BlobServiceClient(serviceUrl.trim(), new DefaultAzureCredential());
  }
}