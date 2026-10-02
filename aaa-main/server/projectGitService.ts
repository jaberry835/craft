import { execFile } from 'node:child_process';
import path from 'node:path';
import { BadRequestError, ConflictError, HttpError } from './httpErrors.js';

export interface ProjectGitStatus {
  available: boolean;
  repository: boolean;
  branch?: string;
  remote?: string;
  upstream?: string;
  dirty: boolean;
  changes: number;
  ahead: number;
  behind: number;
}

export interface ConfigureProjectGitRequest {
  remoteUrl: string;
  branch?: string;
}

export interface PushProjectGitRequest {
  message: string;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type GitRunner = (rootPath: string, args: string[]) => Promise<GitResult>;

const gitQueues = new Map<string, Promise<void>>();

const defaultGitRunner: GitRunner = (rootPath, args) => new Promise((resolve) => {
  execFile('git', args, {
    cwd: rootPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never'
    },
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    windowsHide: true
  }, (error, stdout, stderr) => {
    resolve({
      code: error ? typeof error.code === 'number' ? error.code : null : 0,
      stdout: stdout ?? '',
      stderr: stderr ?? (error?.message ?? '')
    });
  });
});

function validateBranch(value: string | undefined): string {
  const branch = value?.trim() || 'main';
  if (
    branch.length > 100
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    || branch.includes('..')
    || branch.includes('@{')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
    || branch.includes('//')
  ) {
    throw new BadRequestError('Enter a valid Git branch name.', 'invalid_git_branch');
  }
  return branch;
}

function validateRemoteUrl(value: string): string {
  const remoteUrl = typeof value === 'string' ? value.trim() : '';
  if (!remoteUrl || remoteUrl.length > 2_000 || /[\0\r\n]/.test(remoteUrl) || remoteUrl.startsWith('-')) {
    throw new BadRequestError('Enter a valid Git remote URL or local repository path.', 'invalid_git_remote');
  }
  if (/^https?:\/\//i.test(remoteUrl)) {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) {
      throw new BadRequestError(
        'Do not include credentials in the Git remote URL. Use an OS credential helper or SSH agent.',
        'git_credentials_not_allowed'
      );
    }
  }
  return remoteUrl;
}

function remoteDisplay(remoteUrl: string): string {
  if (path.isAbsolute(remoteUrl)) {
    return `local:${path.basename(path.resolve(remoteUrl))}`;
  }
  try {
    const parsed = new URL(remoteUrl);
    if (['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return `${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
    }
  } catch {
    // SCP-style and local remotes are not URL-parseable.
  }
  const scpRemote = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(remoteUrl);
  if (scpRemote) return `${scpRemote[1]}:${scpRemote[2]}`;
  return `local:${path.basename(path.resolve(remoteUrl))}`;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function safeGitError(result: GitResult): string {
  const detail = (result.stderr || result.stdout)
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 500);
  return detail || 'Git did not provide an error message.';
}

async function withGitLock<T>(rootPath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(rootPath);
  const previous = gitQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  gitQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (gitQueues.get(key) === queued) gitQueues.delete(key);
  }
}

export class ProjectGitService {
  constructor(
    private readonly rootPath: string,
    private readonly runGit: GitRunner = defaultGitRunner
  ) {}

  async status(): Promise<ProjectGitStatus> {
    const version = await this.runGit(this.rootPath, ['--version']);
    if (version.code === null) {
      return { available: false, repository: false, dirty: false, changes: 0, ahead: 0, behind: 0 };
    }
    const repository = await this.isRepository();
    if (!repository) {
      return { available: true, repository: false, dirty: false, changes: 0, ahead: 0, behind: 0 };
    }

    const [branchResult, remoteResult, upstreamResult, worktreeResult] = await Promise.all([
      this.runGit(this.rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.runGit(this.rootPath, ['remote', 'get-url', 'origin']),
      this.runGit(this.rootPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      this.runGit(this.rootPath, ['status', '--porcelain', '--untracked-files=normal'])
    ]);
    const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = await this.runGit(this.rootPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
      if (counts.code === 0) {
        const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
        ahead = Number.isFinite(left) ? left : 0;
        behind = Number.isFinite(right) ? right : 0;
      }
    }
    const changes = worktreeResult.stdout.split(/\r?\n/).filter(Boolean).length;
    return {
      available: true,
      repository: true,
      ...(branchResult.code === 0 ? { branch: branchResult.stdout.trim() } : {}),
      ...(remoteResult.code === 0 ? { remote: remoteDisplay(remoteResult.stdout.trim()) } : {}),
      ...(upstream ? { upstream } : {}),
      dirty: changes > 0,
      changes,
      ahead,
      behind
    };
  }

  async configure(request: ConfigureProjectGitRequest): Promise<ProjectGitStatus> {
    const remoteUrl = validateRemoteUrl(request.remoteUrl);
    const branch = validateBranch(request.branch);
    return withGitLock(this.rootPath, async () => {
      await this.assertGitAvailable();
      if (!await this.isRepository()) {
        await this.requireSuccess(['init', '-b', branch], 'Could not initialize the project Git repository.');
      }
      const existingRemote = await this.runGit(this.rootPath, ['remote', 'get-url', 'origin']);
      await this.requireSuccess(
        existingRemote.code === 0
          ? ['remote', 'set-url', 'origin', remoteUrl]
          : ['remote', 'add', 'origin', remoteUrl],
        'Could not configure the project Git remote.'
      );
      return this.status();
    });
  }

  async pull(): Promise<ProjectGitStatus> {
    return withGitLock(this.rootPath, async () => {
      const status = await this.requireReadyRepository();
      if (status.dirty) {
        throw new ConflictError('Commit or discard local project changes before pulling.', 'git_worktree_dirty');
      }
      const result = await this.runGit(this.rootPath, ['pull', '--ff-only', 'origin', status.branch!]);
      if (result.code !== 0) {
        throw new ConflictError(
          `Git pull could not fast-forward. Resolve the repository outside AAA, then try again. (${safeGitError(result)})`,
          'git_pull_failed'
        );
      }
      return this.status();
    });
  }

  async commitAndPush(request: PushProjectGitRequest): Promise<ProjectGitStatus> {
    const message = typeof request.message === 'string' ? request.message.trim() : '';
    if (!message || message.length > 200 || /[\r\n\0]/.test(message)) {
      throw new BadRequestError('Enter a one-line commit message of 200 characters or fewer.', 'invalid_git_message');
    }
    return withGitLock(this.rootPath, async () => {
      const status = await this.requireReadyRepository();
      await this.requireSuccess(['add', '--all'], 'Could not stage the project files.');
      const staged = await this.runGit(this.rootPath, ['diff', '--cached', '--quiet']);
      if (staged.code !== 0) {
        const commit = await this.runGit(this.rootPath, ['commit', '-m', message]);
        if (commit.code !== 0) {
          const detail = safeGitError(commit);
          const identityHint = /identity|user\.email|user\.name/i.test(detail)
            ? ' Configure Git user.name and user.email, then try again.'
            : '';
          throw new ConflictError(`Git could not create the commit.${identityHint} (${detail})`, 'git_commit_failed');
        }
      }
      const push = await this.runGit(this.rootPath, ['push', '--set-upstream', 'origin', status.branch!]);
      if (push.code !== 0) {
        const detail = safeGitError(push);
        const authHint = /auth|credential|permission denied|could not read username/i.test(detail)
          ? ' Configure an OS credential helper or SSH agent; AAA does not store Git credentials.'
          : '';
        throw new ConflictError(`Git push failed.${authHint} (${detail})`, 'git_push_failed');
      }
      return this.status();
    });
  }

  private async isRepository(): Promise<boolean> {
    const result = await this.runGit(this.rootPath, ['rev-parse', '--show-toplevel']);
    return result.code === 0 && samePath(result.stdout.trim(), this.rootPath);
  }

  private async assertGitAvailable(): Promise<void> {
    const result = await this.runGit(this.rootPath, ['--version']);
    if (result.code === null) {
      throw new HttpError('Git is not installed or is not available on PATH.', 503, 'git_unavailable');
    }
  }

  private async requireReadyRepository(): Promise<ProjectGitStatus> {
    await this.assertGitAvailable();
    const status = await this.status();
    if (!status.repository) {
      throw new ConflictError('Configure Git synchronization for this project first.', 'git_not_configured');
    }
    if (!status.remote) {
      throw new ConflictError('Configure an origin remote before synchronizing.', 'git_remote_missing');
    }
    if (!status.branch) {
      throw new ConflictError('Check out a named branch before synchronizing.', 'git_detached_head');
    }
    return status;
  }

  private async requireSuccess(args: string[], message: string): Promise<void> {
    const result = await this.runGit(this.rootPath, args);
    if (result.code !== 0) {
      throw new ConflictError(`${message} (${safeGitError(result)})`, 'git_command_failed');
    }
  }
}