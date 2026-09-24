import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import matter from 'gray-matter';
import { defaultSchema, sanitize } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';
import { toHast } from 'mdast-util-to-hast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type {
  GeneratedFile,
  GeneratedSite,
  MenuNode,
  SiteManifest,
} from '@mcp-sitebuilder/contracts';

const classificationColors: Record<
  SiteManifest['classification'],
  { background: string; foreground: string }
> = {
  UNCLASSIFIED: { background: '#237804', foreground: '#ffffff' },
  CUI: { background: '#502b85', foreground: '#ffffff' },
  CONFIDENTIAL: { background: '#005ea8', foreground: '#ffffff' },
  SECRET: { background: '#c21f39', foreground: '#ffffff' },
  TOP_SECRET: { background: '#f2c94c', foreground: '#111827' },
};

const siteCss = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033;background:#f6f8fb;line-height:1.6}*{box-sizing:border-box}body{margin:0}.classification{padding:.35rem 1rem;text-align:center;font-weight:800;letter-spacing:.12em;font-size:.78rem}.shell{min-height:calc(100vh - 2rem);display:grid;grid-template-columns:280px minmax(0,1fr)}.sidebar{background:#162033;color:#fff;padding:1.5rem;position:sticky;top:0;height:calc(100vh - 2rem);overflow:auto}.brand-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem}.brand{font-size:1.15rem;font-weight:750;margin-bottom:1.5rem}.icon-button{border:1px solid currentColor;background:transparent;color:inherit;border-radius:.35rem;padding:.35rem .55rem;cursor:pointer}.nav-toggle{display:none}.search{margin-bottom:1.25rem}.search input{width:100%;border:1px solid #7590b8;border-radius:.35rem;padding:.55rem;background:#fff;color:#172033}.search-results{list-style:none;padding:0;margin:.5rem 0}.search-results a{color:#fff}.menu,.menu ul{list-style:none;padding-left:0}.menu ul{padding-left:1rem}.menu li{margin:.35rem 0}.menu a{color:#d8e6ff;text-decoration:none;display:block;padding:.28rem .45rem;border-radius:.35rem}.menu a:hover,.menu a[aria-current=page]{background:#2b4773;color:#fff}.folder{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:#93afd6;margin-top:.8rem}.main{padding:2rem min(6vw,5rem)}.page-tools{display:flex;justify-content:flex-end;gap:.5rem;max-width:900px;margin-bottom:.75rem}.crumbs{font-size:.82rem;color:#667085;margin-bottom:1rem}.content-layout{display:grid;grid-template-columns:minmax(0,900px) minmax(160px,220px);gap:2rem;align-items:start}.content{max-width:900px;background:#fff;border:1px solid #dfe4ec;border-radius:12px;padding:clamp(1.5rem,4vw,3rem);box-shadow:0 10px 30px rgba(26,39,66,.06)}.toc{position:sticky;top:1.5rem;font-size:.88rem}.toc ol{list-style:none;padding:0}.toc li{margin:.4rem 0}.toc .toc-level-3{padding-left:1rem}.copy-code{float:right;margin:.5rem .5rem 0 0;border:1px solid #53647d;border-radius:.3rem;background:#fff;color:#172033;padding:.25rem .5rem;cursor:pointer}h1,h2,h3{line-height:1.25;color:#152238}h1{font-size:2.25rem}a{color:#005ea8}pre{overflow:auto;background:#101827;color:#eaf1ff;padding:1rem;border-radius:.5rem}pre.plain-text{white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:"Cascadia Code",Consolas,monospace}img{max-width:100%}blockquote{border-left:4px solid #7aa7dc;margin-left:0;padding-left:1rem;color:#475467}.theme-paper{background:#f7f3ea}.theme-paper .sidebar{background:#31302b}.theme-paper .content{border-color:#ded5c5}.theme-slate{background:#e9edf3}.theme-slate .sidebar{background:#20242c}.theme-reader{background:#15181d;color:#e8edf4}.theme-reader .content{background:#20242b;border-color:#3b424d}.theme-reader .content h1,.theme-reader .content h2,.theme-reader .content h3{color:#f5f7fa}.theme-reader .crumbs,.theme-reader .toc{color:#bdc7d5}@media(max-width:1000px){.content-layout{grid-template-columns:minmax(0,1fr)}.toc{position:static;order:-1}}@media(max-width:760px){.shell{display:block}.sidebar{position:static;height:auto}.nav-toggle{display:block}.sidebar[data-collapsed=true] .search,.sidebar[data-collapsed=true] .menu{display:none}.main{padding:1rem}.content{padding:1.25rem}}
`;

const interactiveDocsScript = String.raw`(() => {
  const body = document.body;
  const sidebar = document.querySelector('.sidebar');
  const navToggle = document.querySelector('[data-nav-toggle]');
  navToggle?.addEventListener('click', () => {
    const collapsed = sidebar?.getAttribute('data-collapsed') === 'true';
    sidebar?.setAttribute('data-collapsed', String(!collapsed));
    navToggle.setAttribute('aria-expanded', String(collapsed));
  });

  const themeToggle = document.querySelector('[data-theme-toggle]');
  themeToggle?.addEventListener('click', () => {
    const enabled = body.classList.toggle('theme-reader');
    themeToggle.setAttribute('aria-pressed', String(enabled));
  });

  const toc = document.querySelector('[data-toc]');
  if (toc) {
    const headings = [...document.querySelectorAll('.content h2, .content h3')];
    if (headings.length > 0) {
      const list = document.createElement('ol');
      for (const heading of headings) {
        const item = document.createElement('li');
        item.className = 'toc-level-' + heading.tagName.slice(1);
        const link = document.createElement('a');
        link.href = '#' + heading.id;
        link.textContent = heading.textContent;
        item.append(link);
        list.append(item);
      }
      toc.append(list);
    } else {
      toc.remove();
    }
  }

  for (const block of document.querySelectorAll('.content pre')) {
    if (!body.hasAttribute('data-copy-code')) break;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code';
    button.textContent = 'Copy';
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(block.textContent ?? '');
      button.textContent = 'Copied';
      window.setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
    block.before(button);
  }

  const searchInput = document.querySelector('[data-search]');
  const searchResults = document.querySelector('[data-search-results]');
  const searchUrl = body.getAttribute('data-search-index');
  if (searchInput && searchResults && searchUrl) {
    let pages;
    const searchIndexUrl = new URL(searchUrl, document.baseURI);
    searchInput.addEventListener('input', async () => {
      pages ??= await fetch(searchUrl).then((response) => response.json());
      const query = searchInput.value.trim().toLocaleLowerCase();
      searchResults.replaceChildren();
      if (query.length < 2) return;
      for (const page of pages.filter((candidate) => candidate.text.toLocaleLowerCase().includes(query)).slice(0, 8)) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = new URL('../' + page.path, searchIndexUrl).href;
        link.textContent = page.title;
        item.append(link);
        searchResults.append(item);
      }
    });
  }
})();`;

interface PageModel {
  sourcePath: string;
  outputPath: string;
  title: string;
  bodyHtml: string;
  searchText: string;
}

interface RenderedDocument {
  title?: string;
  html: string;
  text: string;
}

type MdNode = {
  type?: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string | string[]> };
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-');
}

function textOf(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  return node.children?.map(textOf).join('') ?? '';
}

function outputPathFor(sourcePath: string): string {
  return `${sourcePath.slice(0, -posix.extname(sourcePath).length)}.html`;
}

function prepareMarkdownTree(
  node: MdNode,
  sourcePath: string,
  availablePaths: ReadonlySet<string>,
  usedHeadings = new Map<string, number>(),
): void {
  if (node.type === 'heading') {
    const base = slugify(textOf(node)) || 'section';
    const count = usedHeadings.get(base) ?? 0;
    usedHeadings.set(base, count + 1);
    node.data = { ...node.data, hProperties: { id: count === 0 ? base : `${base}-${count + 1}` } };
  }
  if (node.type === 'link' && typeof node.url === 'string') {
    if (/^https?:/iu.test(node.url)) {
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          target: '_blank',
          rel: ['noopener', 'noreferrer'],
        },
      };
    } else if (!/^[a-z][a-z0-9+.-]*:/iu.test(node.url)) {
      const [pathPart, fragment] = node.url.split('#', 2);
      if (pathPart && /\.(?:md|txt)$/iu.test(pathPart)) {
        const targetSourcePath = posix.normalize(
          pathPart.startsWith('/')
            ? pathPart.slice(1)
            : posix.join(posix.dirname(sourcePath), pathPart),
        );
        if (!availablePaths.has(targetSourcePath.toLocaleLowerCase('en-US'))) {
          throw new Error(`Broken Markdown link in ${sourcePath}: ${node.url}`);
        }
        const currentOutputPath = outputPathFor(sourcePath);
        const targetOutputPath = outputPathFor(targetSourcePath);
        node.url = `${hrefFrom(currentOutputPath, targetOutputPath)}${fragment ? `#${fragment}` : ''}`;
      }
    }
  }
  node.children?.forEach((child) =>
    prepareMarkdownTree(child, sourcePath, availablePaths, usedHeadings),
  );
}

function renderMarkdown(
  content: string,
  sourcePath: string,
  availablePaths: ReadonlySet<string>,
): RenderedDocument {
  const parsed = matter(content);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(parsed.content) as MdNode;
  prepareMarkdownTree(tree, sourcePath, availablePaths);
  const hast = toHast(tree as Parameters<typeof toHast>[0], { allowDangerousHtml: false });
  if (!hast) throw new Error('Markdown did not produce an HTML tree.');
  const safe = sanitize(hast, {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className'],
      a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
      code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-/u]],
    },
  });
  const frontmatterTitle =
    typeof parsed.data.title === 'string' ? parsed.data.title.trim() : undefined;
  return {
    ...(frontmatterTitle ? { title: frontmatterTitle } : {}),
    html: toHtml(safe),
    text: textOf(tree),
  };
}

function renderPlainText(content: string): RenderedDocument {
  return {
    html: renderToStaticMarkup(createElement('pre', { className: 'plain-text' }, content)),
    text: content,
  };
}

function titleFromPath(path: string): string {
  const base = posix.basename(path, posix.extname(path)).replaceAll(/[-_]+/gu, ' ').trim();
  return base.replace(/\b\w/gu, (character) => character.toUpperCase());
}

export function buildMenu(pages: PageModel[]): MenuNode[] {
  const root: MenuNode[] = [];
  for (const page of [...pages].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const segments = page.sourcePath.split('/');
    let nodes = root;
    for (const segment of segments.slice(0, -1)) {
      let folder = nodes.find((node) => node.kind === 'folder' && node.name === segment);
      if (!folder) {
        folder = { kind: 'folder', name: segment, children: [] };
        nodes.push(folder);
      }
      nodes = folder.children ?? [];
    }
    nodes.push({ kind: 'page', name: page.title, path: page.outputPath });
  }
  return root;
}

function hrefFrom(currentPath: string, targetPath: string): string {
  const relative = posix.relative(posix.dirname(currentPath), targetPath);
  return relative || posix.basename(targetPath);
}

function renderMenu(nodes: MenuNode[], currentPath: string): ReactNode {
  return createElement(
    'ul',
    { className: 'menu' },
    nodes.map((node) =>
      node.kind === 'folder'
        ? createElement(
            'li',
            { key: `folder-${node.name}` },
            createElement('div', { className: 'folder' }, node.name),
            renderMenu(node.children ?? [], currentPath),
          )
        : createElement(
            'li',
            { key: node.path },
            createElement(
              'a',
              {
                href: hrefFrom(currentPath, node.path ?? ''),
                ...(node.path === currentPath ? { 'aria-current': 'page' } : {}),
              },
              node.name,
            ),
          ),
    ),
  );
}

function documentHtml(site: SiteManifest, page: PageModel, menu: MenuNode[]): string {
  const themeClass = `theme-${site.themeId}`;
  const colors = classificationColors[site.classification];
  const cssHref = hrefFrom(page.outputPath, 'assets/site.css');
  const interactive = site.templateId === 'interactive-docs-v1';
  const scriptHref = hrefFrom(page.outputPath, 'assets/interactive-docs.js');
  const searchIndexHref = hrefFrom(page.outputPath, 'assets/search-index.json');
  const content = createElement(
    'html',
    { lang: 'en' },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      createElement('meta', { name: 'classification', content: site.classification }),
      createElement('title', null, `${page.title} | ${site.displayName}`),
      createElement('link', { rel: 'stylesheet', href: cssHref }),
      interactive && createElement('script', { src: scriptHref, defer: true }),
    ),
    createElement(
      'body',
      {
        className: themeClass,
        ...(interactive ? { 'data-template': site.templateId } : {}),
        ...(interactive && site.features.copyCode ? { 'data-copy-code': '' } : {}),
        ...(interactive && site.features.search ? { 'data-search-index': searchIndexHref } : {}),
      },
      createElement(
        'div',
        {
          className: 'classification',
          style: { background: colors.background, color: colors.foreground },
        },
        site.classification.replace('_', ' '),
      ),
      createElement(
        'div',
        { className: 'shell' },
        createElement(
          'nav',
          { className: 'sidebar', 'aria-label': 'Site navigation' },
          createElement(
            'div',
            { className: 'brand-row' },
            createElement('div', { className: 'brand' }, site.displayName),
            interactive &&
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'icon-button nav-toggle',
                  'data-nav-toggle': '',
                  'aria-expanded': 'true',
                  'aria-label': 'Toggle navigation',
                },
                'Menu',
              ),
          ),
          interactive &&
            site.features.search &&
            createElement(
              'div',
              { className: 'search' },
              createElement('input', {
                type: 'search',
                placeholder: 'Search documentation',
                'aria-label': 'Search documentation',
                'data-search': '',
              }),
              createElement('ul', { className: 'search-results', 'data-search-results': '' }),
            ),
          renderMenu(menu, page.outputPath),
        ),
        createElement(
          'main',
          { className: 'main' },
          createElement(
            'div',
            { className: 'page-tools' },
            interactive &&
              site.features.themeToggle &&
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'icon-button',
                  'data-theme-toggle': '',
                  'aria-pressed': 'false',
                },
                'Reader theme',
              ),
          ),
          createElement('div', { className: 'crumbs' }, page.sourcePath),
          createElement(
            'div',
            { className: 'content-layout' },
            createElement('article', {
              className: 'content',
              dangerouslySetInnerHTML: { __html: page.bodyHtml },
            }),
            interactive &&
              site.features.tableOfContents &&
              createElement(
                'aside',
                { className: 'toc', 'data-toc': '', 'aria-label': 'On this page' },
                'On this page',
              ),
          ),
        ),
      ),
    ),
  );
  return `<!doctype html>${renderToStaticMarkup(content)}`;
}

function redirectHtml(target: string, title: string): string {
  const escapedTarget = target.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0; url=${escapedTarget}"><title>${title}</title></head><body><p><a href="${escapedTarget}">Open ${title}</a></p></body></html>`;
}

export function generateSite(site: SiteManifest): GeneratedSite {
  const generatorRevision = createHash('sha256')
    .update(siteCss)
    .update(interactiveDocsScript)
    .digest('hex')
    .slice(0, 12);
  const version = createHash('sha256')
    .update(JSON.stringify({ site, generatorRevision }))
    .digest('hex')
    .slice(0, 16);
  const availablePaths = new Set(
    site.documents.map((document) => document.path.toLocaleLowerCase('en-US')),
  );
  const pages: PageModel[] = site.documents.map((document) => {
    const rendered = document.path.toLowerCase().endsWith('.txt')
      ? renderPlainText(document.content)
      : renderMarkdown(document.content, document.path, availablePaths);
    return {
      sourcePath: document.path,
      outputPath: outputPathFor(document.path),
      title: rendered.title ?? titleFromPath(document.path),
      bodyHtml: rendered.html,
      searchText: rendered.text,
    };
  });
  const menu = buildMenu(pages);
  const firstPage = pages[0];
  if (!firstPage) throw new Error('At least one document is required.');
  const files: GeneratedFile[] = pages.map((page) => ({
    path: page.outputPath,
    content: documentHtml(site, page, menu),
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'public, max-age=300',
  }));
  files.push({
    path: 'assets/site.css',
    content: siteCss,
    contentType: 'text/css; charset=utf-8',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  if (site.templateId === 'interactive-docs-v1') {
    files.push({
      path: 'assets/interactive-docs.js',
      content: interactiveDocsScript,
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    if (site.features.search) {
      files.push({
        path: 'assets/search-index.json',
        content: JSON.stringify(
          pages.map((page) => ({
            title: page.title,
            path: page.outputPath,
            text: page.searchText,
          })),
        ),
        contentType: 'application/json',
        cacheControl: 'public, max-age=31536000, immutable',
      });
    }
  }
  if (!files.some((file) => file.path === 'index.html')) {
    files.push({
      path: 'index.html',
      content: redirectHtml(firstPage.outputPath, site.displayName),
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'no-cache',
    });
  }
  files.push({
    path: 'site.json',
    content: JSON.stringify({
      siteId: site.siteId,
      displayName: site.displayName,
      classification: site.classification,
      themeId: site.themeId,
      templateId: site.templateId,
      features: site.features,
      version,
      pages: pages.map(({ sourcePath, outputPath, title }) => ({ sourcePath, outputPath, title })),
    }),
    contentType: 'application/json',
    cacheControl: 'no-cache',
  });
  return { siteId: site.siteId, version, files, entryPath: firstPage.outputPath };
}
