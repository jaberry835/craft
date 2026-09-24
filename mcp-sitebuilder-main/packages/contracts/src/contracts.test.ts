import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizeDocumentPath, SiteManifestSchema } from './index.js';

describe('site contracts', () => {
  it('normalizes safe paths and supplies defaults', () => {
    const parsed = SiteManifestSchema.parse({
      siteId: 'sample-site',
      displayName: 'Sample',
      documents: [{ path: 'guide\\setup.md', content: '# Setup' }],
    });

    expect(parsed.documents[0]?.path).toBe('guide/setup.md');
    expect(parsed.themeId).toBe('clarity');
    expect(parsed.templateId).toBe('static-docs');
    expect(parsed.features).toEqual({
      search: false,
      tableOfContents: false,
      copyCode: false,
      themeToggle: false,
    });
    expect(parsed.classification).toBe('UNCLASSIFIED');
  });

  it('accepts only trusted templates and validated feature flags', () => {
    const parsed = SiteManifestSchema.parse({
      siteId: 'interactive-site',
      displayName: 'Interactive',
      templateId: 'interactive-docs-v1',
      features: { search: true, copyCode: true },
      documents: [{ path: 'index.md', content: '# Interactive' }],
    });

    expect(parsed.features.search).toBe(true);
    expect(parsed.features.copyCode).toBe(true);
    expect(() =>
      SiteManifestSchema.parse({
        siteId: 'unsafe-site',
        displayName: 'Unsafe',
        templateId: 'uploaded-template',
        documents: [{ path: 'index.md', content: '# Unsafe' }],
      }),
    ).toThrow();
  });

  it('accepts plain-text documents', () => {
    expect(normalizeDocumentPath('notes\\readme.TXT')).toBe('notes/readme.TXT');
  });

  it('exposes a JSON Schema compatible publish contract', () => {
    expect(() => z.toJSONSchema(SiteManifestSchema)).not.toThrow();
  });

  it.each(['../secret.md', '/root.md', 'C:\\secret.md', 'guide/file.pdf'])('rejects %s', (path) => {
    expect(() => normalizeDocumentPath(path)).toThrow();
  });

  it('rejects case-insensitive path collisions', () => {
    expect(() =>
      SiteManifestSchema.parse({
        siteId: 'sample-site',
        displayName: 'Sample',
        documents: [
          { path: 'Guide.md', content: '# One' },
          { path: 'guide.md', content: '# Two' },
        ],
      }),
    ).toThrow();
  });

  it('rejects documents that map to the same HTML path', () => {
    expect(() =>
      SiteManifestSchema.parse({
        siteId: 'sample-site',
        displayName: 'Sample',
        documents: [
          { path: 'guide.md', content: '# Guide' },
          { path: 'guide.txt', content: 'Guide' },
        ],
      }),
    ).toThrow('Document paths must produce unique HTML paths.');
  });
});
