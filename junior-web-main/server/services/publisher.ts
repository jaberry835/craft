import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PublishResult } from '../types.js';
import { LocalWorkspaceStorage } from './localWorkspaceStorage.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function markdownToStaticHtml(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) {
        return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      }
      if (line.startsWith('## ')) {
        return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      }
      if (line.startsWith('### ')) {
        return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      }
      if (line.startsWith('- [ ] ')) {
        return `<li class="task">${escapeHtml(line.slice(6))}</li>`;
      }
      if (line.startsWith('- ')) {
        return `<li>${escapeHtml(line.slice(2))}</li>`;
      }
      if (line.trim() === '') {
        return '';
      }
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join('\n');
}

export class Publisher {
  constructor(
    private readonly storage: LocalWorkspaceStorage,
    private readonly outputRoot: string
  ) {}

  async publish(): Promise<PublishResult> {
    const files = await this.storage.readMarkdownPackageFiles();
    const body = files
      .map((file) => `<section><p class="source">${escapeHtml(file.path)}</p>${markdownToStaticHtml(file.content)}</section>`)
      .join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Junior Security Approval Package</title>
  <style>
    body { margin: 0; font: 16px/1.55 system-ui, Segoe UI, sans-serif; color: #172033; background: #f6f8fb; }
    main { max-width: 920px; margin: 0 auto; padding: 40px 24px 72px; }
    header { border-bottom: 1px solid #d9e0ea; margin-bottom: 28px; padding-bottom: 16px; }
    section { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 24px; margin: 16px 0; }
    h1, h2, h3 { color: #0f172a; line-height: 1.2; }
    .source { color: #526070; font-size: 13px; margin: 0 0 16px; }
    li { margin: 6px 0; }
    .task::before { content: '☐ '; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Junior Security Approval Package</h1>
      <p>Published from Junior Workbench on ${new Date().toLocaleString()}.</p>
    </header>
    ${body}
  </main>
</body>
</html>`;

    await mkdir(this.outputRoot, { recursive: true });
    const outputPath = path.join(this.outputRoot, 'index.html');
    await writeFile(outputPath, html, 'utf8');

    return {
      url: '/published/default/index.html',
      outputPath,
      publishedAt: new Date().toISOString()
    };
  }
}
