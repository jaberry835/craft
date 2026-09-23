import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { BadRequestError, ConflictError, PathBoundaryError, UnsupportedFileError } from '../httpErrors.js';
import { ProjectFileService } from '../projectFileService.js';

const fixtureRoot = path.join(process.cwd(), '.test-data', 'project-files');
const outsideRoot = path.join(process.cwd(), '.test-data', 'outside');

test('file tree excludes hidden, dependency, build, and symlink entries and reads UTF-8 text', async () => {
  const root = `${fixtureRoot}-tree`;
  const outside = `${outsideRoot}-tree`;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await mkdir(path.join(root, '.hidden'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'docs', 'scope.md'), '# Scope\nUTF-8: ✓\n', 'utf8');
  await writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored', 'utf8');
  await writeFile(path.join(root, 'dist', 'bundle.js'), 'ignored', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'linked-secret.txt'));

  try {
    const service = new ProjectFileService(root);
    const tree = await service.listTree();
    assert.deepEqual(tree.map((node) => node.name), ['docs']);
    const file = await service.readTextFile('docs/scope.md');
    assert.equal(file.content, '# Scope\nUTF-8: ✓\n');
    await assert.rejects(() => service.readTextFile('../outside/secret.txt'), PathBoundaryError);
    await assert.rejects(() => service.readTextFile('linked-secret.txt'), PathBoundaryError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('file reading rejects invalid UTF-8', async () => {
  const root = `${fixtureRoot}-invalid`;
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00]));
  try {
    await assert.rejects(() => new ProjectFileService(root).readTextFile('binary.bin'), UnsupportedFileError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('text files can be created, conflict-protected, renamed, and deleted', async () => {
  const root = `${fixtureRoot}-lifecycle`;
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const service = new ProjectFileService(root);
  try {
    const created = await service.createTextFile('docs/new.md', '# New\n');
    assert.equal(created.content, '# New\n');
    assert.equal(await readFile(path.join(root, 'docs', 'new.md'), 'utf8'), '# New\n');

    const saved = await service.writeTextFile(created.path, '# Saved\n', created.updatedAt);
    assert.equal(saved.content, '# Saved\n');
    await assert.rejects(
      () => service.writeTextFile(created.path, '# Stale\n', created.updatedAt),
      (error: unknown) => error instanceof ConflictError && error.code === 'file_update_conflict'
    );

    const renamed = await service.renamePath('docs/new.md', 'docs/final.md');
    assert.deepEqual(renamed, { path: 'docs/final.md', type: 'file' });
    assert.equal((await stat(path.join(root, 'docs', 'final.md'))).isFile(), true);

    const deleted = await service.deletePath('docs/final.md');
    assert.deepEqual(deleted, { path: 'docs/final.md', type: 'file' });
    await assert.rejects(() => stat(path.join(root, 'docs', 'final.md')), { code: 'ENOENT' });

    await mkdir(path.join(root, 'remove-me', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'remove-me', 'nested', 'note.txt'), 'note', 'utf8');
    assert.deepEqual(
      await service.renamePath('remove-me', 'renamed-directory'),
      { path: 'renamed-directory', type: 'directory' }
    );
    assert.deepEqual(
      await service.deletePath('renamed-directory'),
      { path: 'renamed-directory', type: 'directory' }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mutations reject traversal, excluded paths, symlinks, unsupported extensions, and invalid content', async () => {
  const root = `${fixtureRoot}-safety`;
  const outside = `${outsideRoot}-safety`;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'outside.md'), '# Outside', 'utf8');
  await symlink(outside, path.join(root, 'linked'));
  const service = new ProjectFileService(root);
  try {
    await assert.rejects(() => service.createTextFile('../outside.md', 'x'), PathBoundaryError);
    await assert.rejects(
      () => service.createTextFile('node_modules/new.md', 'x'),
      (error: unknown) => error instanceof BadRequestError && error.code === 'excluded_path'
    );
    await assert.rejects(() => service.createTextFile('linked/new.md', 'x'), PathBoundaryError);
    await assert.rejects(
      () => service.createTextFile('docs/image.png', 'not an image'),
      (error: unknown) => error instanceof UnsupportedFileError && error.code === 'unsupported_text_extension'
    );
    await assert.rejects(
      () => service.createTextFile('docs/null.txt', 'bad\0content'),
      (error: unknown) => error instanceof UnsupportedFileError && error.code === 'binary_content'
    );
    await assert.rejects(
      () => service.writeTextFile('docs/missing.md', 'x', 'not-a-date'),
      (error: unknown) => error instanceof BadRequestError && error.code === 'updated_at_required'
    );
    await assert.rejects(
      () => service.createTextFile('', 'x'),
      (error: unknown) => error instanceof BadRequestError && error.code === 'path_required'
    );
    await assert.rejects(
      () => service.renamePath('linked/outside.md', 'docs/stolen.md'),
      PathBoundaryError
    );
    await assert.rejects(() => service.deletePath('linked/outside.md'), PathBoundaryError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('published Markdown is rendered as a complete escaped local-only document', async () => {
  const root = `${fixtureRoot}-published`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, 'publish.md'),
    '# Published\n\nA **reviewed** result with <script>alert("x")</script> and [external](https://example.com).\n',
    'utf8'
  );
  const service = new ProjectFileService(root);
  try {
    const html = await service.renderPublishedMarkdown('publish.md');
    assert.match(html, /<!doctype html>/);
    assert.match(html, /<h1>Published<\/h1>/);
    assert.match(html, /<strong>reviewed<\/strong>/);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>|href="https:/);
    assert.match(html, /Content-Security-Policy/);
    await assert.rejects(
      () => service.renderPublishedMarkdown('publish.txt'),
      (error: unknown) => error instanceof UnsupportedFileError && error.code === 'markdown_required'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
