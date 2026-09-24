import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { SiteManifestSchema } from '@mcp-sitebuilder/contracts';
import { complexSiteFixture } from './fixtures/complex-site.js';
import { generateSite } from './index.js';

describe('static site generator', () => {
  it('generates nested pages, navigation, safe links, and classification bars', () => {
    const site = SiteManifestSchema.parse({
      siteId: 'sample-site',
      displayName: 'Sample Site',
      documents: [
        { path: 'index.md', content: '# Welcome\n\n[Setup](guide/setup.md)' },
        {
          path: 'guide/setup.md',
          content: '---\ntitle: Install\n---\n# Setup\n<script>alert(1)</script>',
        },
      ],
    });

    const result = generateSite(site);
    const home = result.files.find((file) => file.path === 'index.html');
    const page = result.files.find((file) => file.path === 'guide/setup.html');

    expect(home?.content).toContain('UNCLASSIFIED');
    expect(home?.content).toContain('guide/setup.html');
    expect(page?.content).toContain('Install');
    expect(page?.content).not.toContain('<script>');
    expect(result.files.some((file) => file.path === 'assets/site.css')).toBe(true);
  });

  it('is deterministic for identical content', () => {
    const site = SiteManifestSchema.parse({
      siteId: 'sample-site',
      displayName: 'Sample Site',
      documents: [{ path: 'readme.md', content: '# Hello' }],
    });
    expect(generateSite(site).version).toBe(generateSite(site).version);
  });

  it('adds only repository-owned assets for the interactive template', () => {
    const site = SiteManifestSchema.parse({
      siteId: 'interactive-site',
      displayName: 'Interactive Site',
      templateId: 'interactive-docs-v1',
      features: { search: true, tableOfContents: true, copyCode: true },
      documents: [
        { path: 'index.md', content: '# Hello\n\n## Details\n\n```ts\nconst ok = true;\n```' },
      ],
    });

    const result = generateSite(site);
    const home = result.files.find((file) => file.path === 'index.html');
    const script = result.files.find((file) => file.path === 'assets/interactive-docs.js');
    const searchIndex = result.files.find((file) => file.path === 'assets/search-index.json');

    expect(home?.content).toContain('data-template="interactive-docs-v1"');
    expect(home?.content).toContain('src="assets/interactive-docs.js"');
    expect(script?.contentType).toBe('text/javascript; charset=utf-8');
    expect(searchIndex?.content).toContain('Hello');
  });

  it('renders text files as escaped preformatted pages linked from Markdown', () => {
    const site = SiteManifestSchema.parse({
      siteId: 'text-site',
      displayName: 'Text Site',
      documents: [
        { path: 'index.md', content: '# Home\n\n[Read notes](notes/readme.txt)' },
        { path: 'notes/readme.txt', content: 'First line\n<script>alert(1)</script>' },
      ],
    });

    const result = generateSite(site);
    const home = result.files.find((file) => file.path === 'index.html');
    const notes = result.files.find((file) => file.path === 'notes/readme.html');

    expect(home?.content).toContain('href="notes/readme.html"');
    expect(notes?.content).toContain('<pre class="plain-text">');
    expect(notes?.content).toContain('First line\n&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(notes?.content).not.toContain('<script>');
  });

  it('generates a complex handbook with valid internal and external links', () => {
    const site = SiteManifestSchema.parse(complexSiteFixture);
    const result = generateSite(site);
    const htmlFiles = result.files.filter((file) => file.contentType.startsWith('text/html'));
    const generatedPaths = new Set(result.files.map((file) => file.path));

    expect(htmlFiles).toHaveLength(site.documents.length);
    expect(result.files).toHaveLength(site.documents.length + 2);

    for (const file of htmlFiles) {
      expect(file.content).toContain('UNCLASSIFIED');
      expect(file.content).toContain('Platform Engineering Handbook');

      const links = [...file.content.matchAll(/<a\s[^>]*href="([^"]+)"/gu)].map(
        (match) => match[1] ?? '',
      );
      for (const link of links) {
        if (/^(?:https?:|mailto:|#)/iu.test(link)) continue;
        const [linkPath] = link.split('#', 1);
        const target = posix.normalize(posix.join(posix.dirname(file.path), linkPath ?? ''));
        expect(generatedPaths, `${file.path} links to missing ${target}`).toContain(target);
      }
    }

    const home = result.files.find((file) => file.path === 'index.html');
    const operations = result.files.find((file) => file.path === 'guides/advanced/operations.html');
    const security = result.files.find((file) => file.path === 'decisions/security.html');

    expect(home?.content).toContain('href="guides/getting-started.html"');
    expect(home?.content).toContain(
      'href="https://modelcontextprotocol.io/docs" target="_blank" rel="noopener noreferrer"',
    );
    expect(operations?.content).toContain('href="../../reference/api.html#health-endpoints"');
    expect(operations?.content).toContain('href="mailto:platform@example.test"');
    expect(security?.content).not.toContain('<script>');
    expect(security?.content).not.toContain('javascript:');
  });

  it('rejects a broken link between Markdown documents', () => {
    const site = SiteManifestSchema.parse({
      siteId: 'broken-link-site',
      displayName: 'Broken links',
      documents: [{ path: 'index.md', content: '[Missing](guide/missing.md)' }],
    });

    expect(() => generateSite(site)).toThrow('Broken Markdown link in index.md: guide/missing.md');
  });
});
