import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findDefaultFile,
  flattenFiles,
  flattenVisibleNodes,
  formatFileSize,
  formatRelativeTime,
  initials,
  isPreviewImage,
  movedFilePath
} from '../../src/appUtils.js';
import type { FileTreeNode } from '../../src/types/api.js';

const tree: FileTreeNode[] = [
  {
    name: 'docs',
    path: 'docs',
    type: 'directory',
    children: [
      { name: 'guide.md', path: 'docs/guide.md', type: 'file' },
      { name: 'README.md', path: 'docs/README.md', type: 'file' }
    ]
  },
  { name: 'validation-report.md', path: 'validation-report.md', type: 'file' },
  { name: 'logo.PNG', path: 'logo.PNG', type: 'file' }
];

test('file tree helpers flatten files, preserve visible depth, and choose the preferred default', () => {
  assert.deepEqual(flattenFiles(tree).map((node) => node.path), [
    'docs/guide.md',
    'docs/README.md',
    'validation-report.md',
    'logo.PNG'
  ]);
  assert.deepEqual(
    flattenVisibleNodes(tree, new Set(['docs'])).map(({ node, depth }) => [node.path, depth]),
    [
      ['docs', 0],
      ['docs/guide.md', 1],
      ['docs/README.md', 1],
      ['validation-report.md', 0],
      ['logo.PNG', 0]
    ]
  );
  assert.equal(findDefaultFile(tree)?.path, 'validation-report.md');
  assert.equal(findDefaultFile(tree.slice(0, 1))?.path, 'docs/README.md');
  assert.equal(findDefaultFile([]), undefined);
  assert.equal(movedFilePath('docs/guide.md', 'archive'), 'archive/guide.md');
  assert.equal(movedFilePath('docs/guide.md', ''), 'guide.md');
  assert.equal(movedFilePath('guide.md', 'docs/nested'), 'docs/nested/guide.md');
});

test('display helpers format file metadata, identities, and relative times consistently', () => {
  assert.equal(isPreviewImage('evidence/SCREENSHOT.JPEG'), true);
  assert.equal(isPreviewImage('evidence/report.pdf'), false);
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('ada@example.gov'), 'AG');
  assert.equal(initials('---'), '?');
  assert.equal(formatFileSize(900), '900 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.0 MB');

  const now = Date.parse('2026-09-30T13:00:00.000Z');
  assert.equal(formatRelativeTime('2026-09-30T12:59:30.000Z', now), 'Just now');
  assert.equal(formatRelativeTime('2026-09-30T12:45:00.000Z', now), '15m ago');
  assert.equal(formatRelativeTime('2026-09-30T11:00:00.000Z', now), '2h ago');
  assert.equal(formatRelativeTime('2026-09-29T12:00:00.000Z', now), 'Yesterday');
  assert.equal(formatRelativeTime('2026-09-27T12:00:00.000Z', now), '3d ago');
});
