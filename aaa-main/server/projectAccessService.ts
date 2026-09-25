import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthIdentity, ProjectAccessPolicy, ProjectAccessPolicyRequest } from '../src/types/api.js';
import { AuthorizationError, BadRequestError } from './httpErrors.js';
import type { AppAuthMode } from './appAuth.js';

interface AccessState {
  projects: Record<string, ProjectAccessPolicy>;
}

const emptyState = (): AccessState => ({ projects: {} });

export class ProjectAccessService {
  private state: AccessState;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly mode: AppAuthMode,
    private readonly statePath: string,
    private readonly adminRoles: string[] = []
  ) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as AccessState;
      this.state = parsed && parsed.projects && typeof parsed.projects === 'object' ? parsed : emptyState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = emptyState();
    }
  }

  canAccess(projectId: string, identity?: AuthIdentity): boolean {
    if (this.mode === 'none') return true;
    if (!identity) return false;
    const policy = this.state.projects[projectId];
    if (!policy) return true;
    return this.isAdmin(identity)
      || policy.ownerId === identity.userId
      || policy.userIds.includes(identity.userId)
      || policy.roles.some((role) => identity.roles.includes(role));
  }

  assertAccess(projectId: string, identity?: AuthIdentity): void {
    if (!this.canAccess(projectId, identity)) {
      throw new AuthorizationError('You do not have access to this project.', 'project_forbidden');
    }
  }

  get(projectId: string, identity?: AuthIdentity): ProjectAccessPolicy {
    this.assertManage(projectId, identity);
    return this.state.projects[projectId] ?? {
      projectId,
      ownerId: identity?.userId ?? 'local',
      userIds: identity ? [identity.userId] : [],
      roles: [],
      unrestricted: true
    };
  }

  async assignOwner(projectId: string, identity?: AuthIdentity): Promise<void> {
    if (this.mode === 'none' || !identity) return;
    this.state.projects[projectId] = {
      projectId,
      ownerId: identity.userId,
      userIds: [identity.userId],
      roles: [],
      unrestricted: false
    };
    await this.persist();
  }

  async update(
    projectId: string,
    identity: AuthIdentity | undefined,
    request: ProjectAccessPolicyRequest
  ): Promise<ProjectAccessPolicy> {
    this.assertManage(projectId, identity);
    if (!identity && this.mode === 'entra') throw new AuthorizationError();
    const current = this.state.projects[projectId];
    const ownerId = current?.ownerId ?? identity?.userId ?? 'local';
    const userIds = normalizeList(request.userIds, 'userIds');
    const roles = normalizeList(request.roles, 'roles');
    const policy: ProjectAccessPolicy = {
      projectId,
      ownerId,
      userIds: [...new Set([ownerId, ...userIds])],
      roles,
      unrestricted: false
    };
    this.state.projects[projectId] = policy;
    await this.persist();
    return policy;
  }

  remove(projectId: string): Promise<void> {
    if (!this.state.projects[projectId]) return Promise.resolve();
    delete this.state.projects[projectId];
    return this.persist();
  }

  private assertManage(projectId: string, identity?: AuthIdentity): void {
    if (this.mode === 'none') return;
    if (!identity) throw new AuthorizationError();
    const policy = this.state.projects[projectId];
    if (this.isAdmin(identity) || policy?.ownerId === identity.userId) return;
    if (!policy) {
      throw new AuthorizationError(
        'Only a project administrator can establish access for this legacy project.',
        'project_access_forbidden'
      );
    }
    throw new AuthorizationError('Only the project owner or a project administrator can manage access.', 'project_access_forbidden');
  }

  private isAdmin(identity: AuthIdentity): boolean {
    return this.adminRoles.some((role) => identity.roles.includes(role));
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, this.statePath);
    });
    return this.writeQueue;
  }
}

function normalizeList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BadRequestError(`${name} must be an array of strings.`, 'invalid_project_access');
  }
  const values = value.map((item) => item.trim()).filter(Boolean);
  if (values.length > 200 || values.some((item) => item.length > 200)) {
    throw new BadRequestError(`${name} contains too many or overly long entries.`, 'invalid_project_access');
  }
  return [...new Set(values)];
}
