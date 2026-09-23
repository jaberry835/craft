import { randomUUID } from 'node:crypto';
import type {
  CreateSiteDraftInput,
  GeneratedFile,
  GeneratedSite,
  PublishOperation,
  SiteCatalogEntry,
  SiteDraft,
  SiteDraftSummary,
  SiteManifest,
  SiteManifestInput,
  UpsertSiteFilesInput,
} from '@mcp-sitebuilder/contracts';
import {
  CreateSiteDraftSchema,
  SiteDraftSchema,
  SiteManifestSchema,
  UpsertSiteFilesSchema,
} from '@mcp-sitebuilder/contracts';
import { generateSite } from '@mcp-sitebuilder/generator';

export interface QueueWorkItem {
  operationId: string;
  complete(): Promise<void>;
  retry(): Promise<void>;
}

export interface SiteBuilderStore {
  initialize(): Promise<void>;
  createDraft(draft: SiteDraft): Promise<boolean>;
  getDraft(siteId: string): Promise<SiteDraft | undefined>;
  saveDraft(draft: SiteDraft, expectedRevision: number): Promise<boolean>;
  stage(operationId: string, manifest: SiteManifest): Promise<void>;
  loadStaged(operationId: string): Promise<SiteManifest>;
  saveOperation(operation: PublishOperation): Promise<void>;
  getOperation(operationId: string): Promise<PublishOperation | undefined>;
  enqueue(operationId: string): Promise<void>;
  receive(): Promise<QueueWorkItem | undefined>;
  publish(site: GeneratedSite, manifest: SiteManifest): Promise<{ url: string }>;
  listSites(): Promise<SiteCatalogEntry[]>;
  getSite(siteId: string): Promise<SiteCatalogEntry | undefined>;
  deleteSite(siteId: string): Promise<boolean>;
  readPublishedFile?(path: string): Promise<GeneratedFile | undefined>;
}

function timestamp(): string {
  return new Date().toISOString();
}

function summarizeDraft(draft: SiteDraft): SiteDraftSummary {
  return {
    siteId: draft.siteId,
    displayName: draft.displayName,
    ...(draft.description ? { description: draft.description } : {}),
    themeId: draft.themeId,
    classification: draft.classification,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    fileCount: draft.documents.length,
    totalBytes: draft.documents.reduce(
      (total, document) => total + Buffer.byteLength(document.content, 'utf8'),
      0,
    ),
    files: draft.documents.map((document) => document.path),
  };
}

function transition(
  operation: PublishOperation,
  status: PublishOperation['status'],
  values: Partial<Pick<PublishOperation, 'version' | 'siteUrl' | 'error'>> = {},
): PublishOperation {
  return {
    ...operation,
    status,
    updatedAt: timestamp(),
    ...values,
  };
}

export class SiteBuilderApplication {
  public constructor(private readonly store: SiteBuilderStore) {}

  public async initialize(): Promise<void> {
    await this.store.initialize();
  }

  public async createDraft(input: CreateSiteDraftInput): Promise<SiteDraftSummary> {
    const metadata = CreateSiteDraftSchema.parse(input);
    const draft = SiteDraftSchema.parse({
      ...metadata,
      documents: [],
      revision: 0,
      updatedAt: timestamp(),
    });
    if (!(await this.store.createDraft(draft))) {
      throw new Error(`Draft ${draft.siteId} already exists.`);
    }
    return summarizeDraft(draft);
  }

  public async getDraft(siteId: string): Promise<SiteDraftSummary | undefined> {
    const draft = await this.store.getDraft(siteId);
    return draft ? summarizeDraft(draft) : undefined;
  }

  public async upsertDraftFiles(input: UpsertSiteFilesInput): Promise<SiteDraftSummary> {
    const update = UpsertSiteFilesSchema.parse(input);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.store.getDraft(update.siteId);
      if (!current) throw new Error(`Draft ${update.siteId} was not found.`);
      const documents = new Map(
        current.documents.map((document) => [document.path.toLocaleLowerCase('en-US'), document]),
      );
      for (const file of update.files) {
        documents.set(file.path.toLocaleLowerCase('en-US'), file);
      }
      const manifest = SiteManifestSchema.parse({
        siteId: current.siteId,
        displayName: current.displayName,
        ...(current.description ? { description: current.description } : {}),
        themeId: current.themeId,
        classification: current.classification,
        documents: [...documents.values()],
      });
      const next = SiteDraftSchema.parse({
        ...manifest,
        revision: current.revision + 1,
        updatedAt: timestamp(),
      });
      if (await this.store.saveDraft(next, current.revision)) return summarizeDraft(next);
    }
    throw new Error(`Draft ${update.siteId} update conflicted too many times.`);
  }

  public async publish(input: SiteManifestInput): Promise<PublishOperation> {
    const manifest = SiteManifestSchema.parse(input);
    return this.queuePublication(manifest);
  }

  public async publishDraft(siteId: string): Promise<PublishOperation> {
    const draft = await this.store.getDraft(siteId);
    if (!draft) throw new Error(`Draft ${siteId} was not found.`);
    const manifest = SiteManifestSchema.parse({
      siteId: draft.siteId,
      displayName: draft.displayName,
      ...(draft.description ? { description: draft.description } : {}),
      themeId: draft.themeId,
      classification: draft.classification,
      documents: draft.documents,
    });
    return this.queuePublication(manifest);
  }

  private async queuePublication(manifest: SiteManifest): Promise<PublishOperation> {
    const operationId = randomUUID();
    const now = timestamp();
    const operation: PublishOperation = {
      operationId,
      siteId: manifest.siteId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.stage(operationId, manifest);
    await this.store.saveOperation(operation);
    await this.store.enqueue(operationId);
    return operation;
  }

  public getOperation(operationId: string): Promise<PublishOperation | undefined> {
    return this.store.getOperation(operationId);
  }

  public listSites(): Promise<SiteCatalogEntry[]> {
    return this.store.listSites();
  }

  public getSite(siteId: string): Promise<SiteCatalogEntry | undefined> {
    return this.store.getSite(siteId);
  }

  public deleteSite(siteId: string): Promise<boolean> {
    return this.store.deleteSite(siteId);
  }

  public readPublishedFile(path: string): Promise<GeneratedFile | undefined> {
    return this.store.readPublishedFile?.(path) ?? Promise.resolve(undefined);
  }

  public async processNext(): Promise<boolean> {
    const item = await this.store.receive();
    if (!item) return false;
    const existing = await this.store.getOperation(item.operationId);
    if (!existing) {
      await item.complete();
      return true;
    }
    if (existing.status === 'succeeded') {
      await item.complete();
      return true;
    }

    try {
      await this.store.saveOperation(transition(existing, 'building'));
      const manifest = await this.store.loadStaged(item.operationId);
      const generated = generateSite(manifest);
      await this.store.saveOperation(
        transition(existing, 'publishing', { version: generated.version }),
      );
      const published = await this.store.publish(generated, manifest);
      await this.store.saveOperation(
        transition(existing, 'succeeded', {
          version: generated.version,
          siteUrl: published.url,
        }),
      );
      await item.complete();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown publish failure.';
      await this.store.saveOperation(transition(existing, 'failed', { error: message }));
      await item.complete();
    }
    return true;
  }
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

export function startBoundedWorker(
  application: SiteBuilderApplication,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): WorkerHandle {
  const intervalMs = options.intervalMs ?? 1_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref();
  };
  const tick = async (): Promise<void> => {
    try {
      while (!stopped && (await application.processNext())) {
        // Drain one item at a time to cap memory and generation concurrency.
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      schedule();
    }
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderCatalog(entries: SiteCatalogEntry[]): string {
  const cards = [...entries]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map(
      (entry) =>
        `<article class="card"><div class="mark">${escapeHtml(entry.classification.replace('_', ' '))}</div><h2><a href="${escapeHtml(entry.url)}">${escapeHtml(entry.displayName)}</a></h2><p>${escapeHtml(entry.description ?? 'Published documentation site')}</p><div class="meta">Updated ${escapeHtml(entry.updatedAt)} · Theme ${escapeHtml(entry.themeId)}</div></article>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Published Sites</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}.classification{background:#237804;color:#fff;text-align:center;padding:.4rem;font-weight:800;letter-spacing:.12em}main{max-width:1100px;margin:auto;padding:3rem 1.25rem}h1{font-size:2.5rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem}.card{background:#fff;border:1px solid #dfe4ec;border-radius:12px;padding:1.25rem;box-shadow:0 8px 24px rgba(30,45,70,.06)}.mark{font-size:.7rem;font-weight:800;color:#237804;letter-spacing:.08em}.card a{color:#005ea8}.meta{color:#667085;font-size:.8rem}</style></head><body><div class="classification">UNCLASSIFIED</div><main><h1>Published sites</h1><p>Current documentation generated by the site builder service.</p><section class="grid">${cards || '<p>No sites have been published.</p>'}</section></main></body></html>`;
}
