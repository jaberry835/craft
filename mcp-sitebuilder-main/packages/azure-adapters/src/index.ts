import {
  BlobServiceClient,
  type BlockBlobClient,
  type ContainerClient,
  RestError,
} from '@azure/storage-blob';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { QueueClient } from '@azure/storage-queue';
import type { QueueWorkItem, SiteBuilderStore } from '@mcp-sitebuilder/application';
import { renderCatalog } from '@mcp-sitebuilder/application';
import type {
  GeneratedFile,
  GeneratedSite,
  PublishOperation,
  SiteCatalogEntry,
  SiteDraft,
  SiteManifest,
} from '@mcp-sitebuilder/contracts';
import {
  PublishOperationSchema,
  SiteCatalogEntrySchema,
  SiteDraftSchema,
  SiteManifestSchema,
} from '@mcp-sitebuilder/contracts';

const stagingContainerName = 'sitebuilder-staging';
const operationsContainerName = 'sitebuilder-operations';
const webContainerName = '$web';
const queueName = 'sitebuilder-jobs';
const catalogBlobName = 'catalog.json';

async function streamToText(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) throw new Error('Blob content is unavailable.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson<T>(
  blob: BlockBlobClient,
  parser: { parse(value: unknown): T },
): Promise<T> {
  const response = await blob.download();
  return parser.parse(JSON.parse(await streamToText(response.readableStreamBody)));
}

function isNotFound(error: unknown): boolean {
  return error instanceof RestError && error.statusCode === 404;
}

function isPreconditionFailed(error: unknown): boolean {
  return error instanceof RestError && error.statusCode === 412;
}

export interface AzureStoreOptions {
  accountName?: string;
  connectionString?: string;
  webBaseUrl?: string;
  managedIdentityClientId?: string;
}

export class AzureSiteBuilderStore implements SiteBuilderStore {
  private readonly blobService: BlobServiceClient;
  private readonly queue: QueueClient;
  private readonly staging: ContainerClient;
  private readonly operations: ContainerClient;
  private readonly web: ContainerClient;
  private readonly webBaseUrl: string;

  public constructor(options: AzureStoreOptions = {}) {
    const connectionString =
      options.connectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
    const accountName = options.accountName ?? process.env.AZURE_STORAGE_ACCOUNT_NAME;
    if (connectionString) {
      this.blobService = BlobServiceClient.fromConnectionString(connectionString);
      this.queue = new QueueClient(connectionString, queueName);
      this.webBaseUrl =
        options.webBaseUrl ??
        process.env.STATIC_WEBSITE_URL ??
        'http://127.0.0.1:10000/devstoreaccount1/$web';
    } else {
      if (!accountName) throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required.');
      const clientId = options.managedIdentityClientId ?? process.env.AZURE_CLIENT_ID;
      const credential = process.env.WEBSITE_INSTANCE_ID
        ? clientId
          ? new ManagedIdentityCredential(clientId)
          : new ManagedIdentityCredential()
        : new DefaultAzureCredential();
      this.blobService = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential,
      );
      this.queue = new QueueClient(
        `https://${accountName}.queue.core.windows.net/${queueName}`,
        credential,
      );
      this.webBaseUrl =
        options.webBaseUrl ??
        process.env.STATIC_WEBSITE_URL ??
        `https://${accountName}.z20.web.core.windows.net`;
    }
    this.staging = this.blobService.getContainerClient(stagingContainerName);
    this.operations = this.blobService.getContainerClient(operationsContainerName);
    this.web = this.blobService.getContainerClient(webContainerName);
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      this.staging.createIfNotExists(),
      this.operations.createIfNotExists(),
      this.web.createIfNotExists(),
      this.queue.createIfNotExists(),
    ]);
    const catalog = this.web.getBlockBlobClient(catalogBlobName);
    if (!(await catalog.exists())) {
      await this.writeCatalog([], undefined);
    }
  }

  public async createDraft(draft: SiteDraft): Promise<boolean> {
    try {
      await this.staging
        .getBlockBlobClient(`drafts/${draft.siteId}.json`)
        .uploadData(Buffer.from(JSON.stringify(draft)), {
          blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
          conditions: { ifNoneMatch: '*' },
        });
      return true;
    } catch (error) {
      if (isPreconditionFailed(error)) return false;
      throw error;
    }
  }

  public async getDraft(siteId: string): Promise<SiteDraft | undefined> {
    try {
      return await readJson(
        this.staging.getBlockBlobClient(`drafts/${siteId}.json`),
        SiteDraftSchema,
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  public async saveDraft(draft: SiteDraft, expectedRevision: number): Promise<boolean> {
    const blob = this.staging.getBlockBlobClient(`drafts/${draft.siteId}.json`);
    try {
      const response = await blob.download();
      const current = SiteDraftSchema.parse(
        JSON.parse(await streamToText(response.readableStreamBody)),
      );
      if (current.revision !== expectedRevision || !response.etag) return false;
      await blob.uploadData(Buffer.from(JSON.stringify(draft)), {
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
        conditions: { ifMatch: response.etag },
      });
      return true;
    } catch (error) {
      if (isNotFound(error) || isPreconditionFailed(error)) return false;
      throw error;
    }
  }

  public async stage(operationId: string, manifest: SiteManifest): Promise<void> {
    await this.staging
      .getBlockBlobClient(`${operationId}/manifest.json`)
      .uploadData(Buffer.from(JSON.stringify(manifest)), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifNoneMatch: '*' },
      });
  }

  public loadStaged(operationId: string): Promise<SiteManifest> {
    return readJson(
      this.staging.getBlockBlobClient(`${operationId}/manifest.json`),
      SiteManifestSchema,
    );
  }

  public async saveOperation(operation: PublishOperation): Promise<void> {
    await this.operations
      .getBlockBlobClient(`${operation.operationId}.json`)
      .uploadData(Buffer.from(JSON.stringify(operation)), {
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
      });
  }

  public async getOperation(operationId: string): Promise<PublishOperation | undefined> {
    try {
      return await readJson(
        this.operations.getBlockBlobClient(`${operationId}.json`),
        PublishOperationSchema,
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  public async enqueue(operationId: string): Promise<void> {
    await this.queue.sendMessage(JSON.stringify({ operationId }));
  }

  public async receive(): Promise<QueueWorkItem | undefined> {
    const result = await this.queue.receiveMessages({
      numberOfMessages: 1,
      visibilityTimeout: 300,
    });
    const message = result.receivedMessageItems[0];
    if (!message) return undefined;
    let payload: { operationId?: unknown };
    try {
      payload = JSON.parse(message.messageText) as { operationId?: unknown };
    } catch {
      await this.queue.deleteMessage(message.messageId, message.popReceipt);
      return undefined;
    }
    if (typeof payload.operationId !== 'string') {
      await this.queue.deleteMessage(message.messageId, message.popReceipt);
      return undefined;
    }
    return {
      operationId: payload.operationId,
      complete: async () => {
        await this.queue.deleteMessage(message.messageId, message.popReceipt);
      },
      retry: async () => {
        await this.queue.updateMessage(
          message.messageId,
          message.popReceipt,
          message.messageText,
          0,
        );
      },
    };
  }

  public async publish(site: GeneratedSite, manifest: SiteManifest): Promise<{ url: string }> {
    const versionPrefix = `sites/${site.siteId}/versions/${site.version}`;
    for (const file of site.files) {
      await this.web
        .getBlockBlobClient(`${versionPrefix}/${file.path}`)
        .uploadData(Buffer.from(file.content), {
          blobHTTPHeaders: {
            blobContentType: file.contentType,
            blobCacheControl: file.cacheControl,
          },
        });
    }

    const stablePath = `sites/${site.siteId}/index.html`;
    const relativeTarget = `versions/${site.version}/index.html`;
    const stableHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${relativeTarget}"><title>${manifest.displayName}</title></head><body><a href="${relativeTarget}">Open ${manifest.displayName}</a></body></html>`;
    await this.web.getBlockBlobClient(stablePath).uploadData(Buffer.from(stableHtml), {
      blobHTTPHeaders: {
        blobContentType: 'text/html; charset=utf-8',
        blobCacheControl: 'no-cache',
      },
    });

    const url = `${this.webBaseUrl.replace(/\/$/u, '')}/${stablePath}`;
    const entry: SiteCatalogEntry = {
      siteId: site.siteId,
      displayName: manifest.displayName,
      ...(manifest.description ? { description: manifest.description } : {}),
      classification: manifest.classification,
      themeId: manifest.themeId,
      templateId: manifest.templateId,
      features: manifest.features,
      version: site.version,
      url,
      updatedAt: new Date().toISOString(),
    };
    await this.mutateCatalog((entries) => [
      ...entries.filter((candidate) => candidate.siteId !== entry.siteId),
      entry,
    ]);
    return { url };
  }

  public async listSites(): Promise<SiteCatalogEntry[]> {
    return (await this.readCatalog()).entries;
  }

  public async getSite(siteId: string): Promise<SiteCatalogEntry | undefined> {
    return (await this.listSites()).find((entry) => entry.siteId === siteId);
  }

  public async deleteSite(siteId: string): Promise<boolean> {
    const existing = await this.getSite(siteId);
    if (!existing) return false;
    await this.mutateCatalog((entries) => entries.filter((entry) => entry.siteId !== siteId));
    for await (const blob of this.web.listBlobsFlat({ prefix: `sites/${siteId}/` })) {
      await this.web.deleteBlob(blob.name, { deleteSnapshots: 'include' });
    }
    return true;
  }

  private async readCatalog(): Promise<{ entries: SiteCatalogEntry[]; etag?: string }> {
    const blob = this.web.getBlockBlobClient(catalogBlobName);
    try {
      const response = await blob.download();
      const raw = JSON.parse(await streamToText(response.readableStreamBody)) as unknown;
      const entries = SiteCatalogEntrySchema.array().parse(raw);
      return { entries, ...(response.etag ? { etag: response.etag } : {}) };
    } catch (error) {
      if (isNotFound(error)) return { entries: [] };
      throw error;
    }
  }

  private async writeCatalog(entries: SiteCatalogEntry[], etag: string | undefined): Promise<void> {
    const catalog = this.web.getBlockBlobClient(catalogBlobName);
    await catalog.uploadData(Buffer.from(JSON.stringify(entries)), {
      blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-cache' },
      conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
    });
    await this.web
      .getBlockBlobClient('index.html')
      .uploadData(Buffer.from(renderCatalog(entries)), {
        blobHTTPHeaders: {
          blobContentType: 'text/html; charset=utf-8',
          blobCacheControl: 'no-cache',
        },
      });
  }

  private async mutateCatalog(
    mutate: (entries: SiteCatalogEntry[]) => SiteCatalogEntry[],
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.readCatalog();
      try {
        await this.writeCatalog(mutate(current.entries), current.etag);
        return;
      } catch (error) {
        if (!isPreconditionFailed(error)) throw error;
      }
    }
    throw new Error('Catalog update failed after concurrent-write retries.');
  }
}

export class MemorySiteBuilderStore implements SiteBuilderStore {
  private readonly drafts = new Map<string, SiteDraft>();
  private readonly staged = new Map<string, SiteManifest>();
  private readonly operations = new Map<string, PublishOperation>();
  private readonly queued: string[] = [];
  private readonly sites = new Map<string, SiteCatalogEntry>();
  private readonly files = new Map<string, GeneratedFile>();

  public async initialize(): Promise<void> {}

  public async createDraft(draft: SiteDraft): Promise<boolean> {
    if (this.drafts.has(draft.siteId)) return false;
    this.drafts.set(draft.siteId, structuredClone(draft));
    return true;
  }

  public async getDraft(siteId: string): Promise<SiteDraft | undefined> {
    const draft = this.drafts.get(siteId);
    return draft ? structuredClone(draft) : undefined;
  }

  public async saveDraft(draft: SiteDraft, expectedRevision: number): Promise<boolean> {
    const current = this.drafts.get(draft.siteId);
    if (!current || current.revision !== expectedRevision) return false;
    this.drafts.set(draft.siteId, structuredClone(draft));
    return true;
  }

  public async stage(operationId: string, manifest: SiteManifest): Promise<void> {
    this.staged.set(operationId, manifest);
  }

  public async loadStaged(operationId: string): Promise<SiteManifest> {
    const manifest = this.staged.get(operationId);
    if (!manifest) throw new Error(`Staged operation ${operationId} was not found.`);
    return manifest;
  }

  public async saveOperation(operation: PublishOperation): Promise<void> {
    this.operations.set(operation.operationId, operation);
  }

  public async getOperation(operationId: string): Promise<PublishOperation | undefined> {
    return this.operations.get(operationId);
  }

  public async enqueue(operationId: string): Promise<void> {
    this.queued.push(operationId);
  }

  public async receive(): Promise<QueueWorkItem | undefined> {
    const operationId = this.queued.shift();
    if (!operationId) return undefined;
    return {
      operationId,
      complete: async () => {},
      retry: async () => {
        this.queued.unshift(operationId);
      },
    };
  }

  public async publish(site: GeneratedSite, manifest: SiteManifest): Promise<{ url: string }> {
    const url = `http://localhost:3000/sites/${site.siteId}/index.html`;
    const versionPrefix = `sites/${site.siteId}/versions/${site.version}`;
    for (const file of site.files) {
      this.files.set(`${versionPrefix}/${file.path}`, file);
    }
    this.files.set(`sites/${site.siteId}/index.html`, {
      path: `sites/${site.siteId}/index.html`,
      content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=versions/${site.version}/index.html"><title>${manifest.displayName}</title></head><body><a href="versions/${site.version}/index.html">Open ${manifest.displayName}</a></body></html>`,
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    });
    this.sites.set(site.siteId, {
      siteId: site.siteId,
      displayName: manifest.displayName,
      ...(manifest.description ? { description: manifest.description } : {}),
      classification: manifest.classification,
      themeId: manifest.themeId,
      templateId: manifest.templateId,
      features: manifest.features,
      version: site.version,
      url,
      updatedAt: new Date().toISOString(),
    });
    return { url };
  }

  public async listSites(): Promise<SiteCatalogEntry[]> {
    return [...this.sites.values()];
  }

  public async getSite(siteId: string): Promise<SiteCatalogEntry | undefined> {
    return this.sites.get(siteId);
  }

  public async deleteSite(siteId: string): Promise<boolean> {
    const deleted = this.sites.delete(siteId);
    for (const path of this.files.keys()) {
      if (path.startsWith(`sites/${siteId}/`)) this.files.delete(path);
    }
    return deleted;
  }

  public async readPublishedFile(path: string): Promise<GeneratedFile | undefined> {
    return this.files.get(path.replace(/^\/+/, ''));
  }
}
