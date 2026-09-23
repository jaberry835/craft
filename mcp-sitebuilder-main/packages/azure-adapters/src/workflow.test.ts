import { describe, expect, it } from 'vitest';
import { SiteBuilderApplication } from '@mcp-sitebuilder/application';
import { MemorySiteBuilderStore } from './index.js';

describe('publish workflow', () => {
  it('queues, builds, publishes, and lists a site', async () => {
    const store = new MemorySiteBuilderStore();
    const app = new SiteBuilderApplication(store);
    await app.initialize();
    const queued = await app.publish({
      siteId: 'sample-site',
      displayName: 'Sample',
      documents: [{ path: 'index.md', content: '# Hello' }],
    });

    expect(queued.status).toBe('queued');
    expect(await app.processNext()).toBe(true);
    expect((await app.getOperation(queued.operationId))?.status).toBe('succeeded');
    expect(await app.listSites()).toHaveLength(1);
  });

  it('builds a durable draft with individual and batched file updates before publishing', async () => {
    const store = new MemorySiteBuilderStore();
    const app = new SiteBuilderApplication(store);
    await app.initialize();

    const empty = await app.createDraft({ siteId: 'draft-site', displayName: 'Draft Site' });
    expect(empty).toMatchObject({ fileCount: 0, files: [], revision: 0 });

    await app.upsertDraftFiles({
      siteId: 'draft-site',
      files: [{ path: 'index.md', content: '# Initial' }],
    });
    const updated = await app.upsertDraftFiles({
      siteId: 'draft-site',
      files: [
        { path: 'index.md', content: '# Final' },
        { path: 'guides/setup.txt', content: 'Setup steps' },
      ],
    });

    expect(updated).toMatchObject({
      fileCount: 2,
      files: ['index.md', 'guides/setup.txt'],
      revision: 2,
    });
    expect(updated).not.toHaveProperty('documents');

    const queued = await app.publishDraft('draft-site');
    expect(queued.status).toBe('queued');
    await app.processNext();
    expect((await app.getOperation(queued.operationId))?.status).toBe('succeeded');
    expect((await app.getSite('draft-site'))?.siteId).toBe('draft-site');
  });
});
