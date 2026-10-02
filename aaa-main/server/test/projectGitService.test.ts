import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ProjectGitService } from '../projectGitService.js';

const execFileAsync = promisify(execFile);
const testRoot = path.join(process.cwd(), '.test-data', 'project-git');

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

test('project Git service configures, pushes, pulls, and protects dirty worktrees', async (t) => {
  await rm(testRoot, { recursive: true, force: true });
  const projectRoot = path.join(testRoot, 'project');
  const remoteRoot = path.join(testRoot, 'remote.git');
  const otherRoot = path.join(testRoot, 'other');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  t.after(() => rm(testRoot, { recursive: true, force: true }));

  await git(remoteRoot, 'init', '--bare');
  await writeFile(path.join(projectRoot, 'README.md'), '# Project\n', 'utf8');
  const service = new ProjectGitService(projectRoot);

  assert.deepEqual(await service.status(), {
    available: true,
    repository: false,
    dirty: false,
    changes: 0,
    ahead: 0,
    behind: 0
  });
  const configured = await service.configure({ remoteUrl: remoteRoot, branch: 'main' });
  assert.equal(configured.repository, true);
  assert.equal(configured.branch, 'main');
  assert.equal(configured.remote, 'local:remote.git');

  await git(projectRoot, 'config', 'user.name', 'AAA Test');
  await git(projectRoot, 'config', 'user.email', 'aaa@example.invalid');
  const pushed = await service.commitAndPush({ message: 'Initial package' });
  assert.equal(pushed.dirty, false);
  assert.equal(pushed.upstream, 'origin/main');

  await git(testRoot, 'clone', remoteRoot, otherRoot);
  await git(otherRoot, 'config', 'user.name', 'AAA Test');
  await git(otherRoot, 'config', 'user.email', 'aaa@example.invalid');
  await writeFile(path.join(otherRoot, 'evidence.md'), '# Evidence\n', 'utf8');
  await git(otherRoot, 'add', '--all');
  await git(otherRoot, 'commit', '-m', 'Add evidence');
  await git(otherRoot, 'push');

  const pulled = await service.pull();
  assert.equal(pulled.dirty, false);
  assert.equal((await readFile(path.join(projectRoot, 'evidence.md'), 'utf8')).replace(/\r\n/g, '\n'), '# Evidence\n');

  await writeFile(path.join(projectRoot, 'local.md'), '# Local\n', 'utf8');
  await assert.rejects(() => service.pull(), { code: 'git_worktree_dirty' });
});

test('project Git service rejects credentials embedded in remote URLs', async () => {
  const service = new ProjectGitService(testRoot);
  await assert.rejects(
    () => service.configure({ remoteUrl: 'https://user:secret@example.test/repo.git' }),
    { code: 'git_credentials_not_allowed' }
  );
});