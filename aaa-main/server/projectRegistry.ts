import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError, ConflictError, NotFoundError } from './httpErrors.js';
import type { CreateProjectRequest, ProjectSummary, ProjectsResponse } from '../src/types/api.js';

interface ProjectConfig {
  id: string;
  name: string;
  description?: string;
  rootPath: string;
}

interface ProjectsConfig {
  activeProjectId: string;
  projects: ProjectConfig[];
}

export class ProjectRegistry {
  private constructor(
    private readonly projects: ProjectConfig[],
    private activeProjectId: string,
    private readonly statePath?: string,
    private readonly managedRoot?: string,
    private readonly templateRoot?: string
  ) {}

  static async load(
    configPath: string,
    options: { statePath?: string; managedRoot?: string } = {}
  ): Promise<ProjectRegistry> {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as ProjectsConfig;
    if (!Array.isArray(config.projects) || config.projects.length === 0) {
      throw new Error('At least one configured project is required.');
    }
    let state: ProjectsConfig | undefined;
    if (options.statePath) {
      try {
        state = JSON.parse(await readFile(options.statePath, 'utf8')) as ProjectsConfig;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const merged = [...config.projects];
    for (const project of state?.projects ?? []) {
      if (!merged.some((candidate) => candidate.id === project.id)) merged.push(project);
    }
    const ids = new Set<string>();
    const projects: ProjectConfig[] = [];
    for (const project of merged) {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(project.id) || ids.has(project.id)) {
        throw new Error(`Invalid or duplicate project id: ${project.id}`);
      }
      ids.add(project.id);
      let projectStats;
      try {
        projectStats = await stat(project.rootPath);
      } catch (error) {
        if (state?.projects.some((candidate) => candidate.id === project.id)
          && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      if (!projectStats.isDirectory()) {
        throw new Error(`Configured project root is not a directory: ${project.rootPath}`);
      }
      projects.push({ ...project, rootPath: await realpath(path.resolve(project.rootPath)) });
    }
    const activeProjectId = state?.activeProjectId
      && projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId
      : config.activeProjectId;
    if (!projects.some((project) => project.id === activeProjectId)) {
      throw new Error(`Active project is not configured: ${activeProjectId}`);
    }
    return new ProjectRegistry(
      projects,
      activeProjectId,
      options.statePath,
      options.managedRoot,
      config.projects[0]?.rootPath
    );
  }

  list(): ProjectsResponse {
    return {
      activeProjectId: this.activeProjectId,
      projects: this.projects.map((project) => this.summary(project))
    };
  }

  get(projectId: string): ProjectSummary {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new NotFoundError(`Unknown project: ${projectId}`);
    }
    return this.summary(project);
  }

  root(projectId: string): string {
    return this.get(projectId).rootPath;
  }

  assertProjectId(projectId: string): void {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(projectId)) {
      throw new BadRequestError('Invalid project id.');
    }
  }

  async create(request: CreateProjectRequest): Promise<ProjectSummary> {
    if (!this.statePath || !this.managedRoot || !this.templateRoot) {
      throw new BadRequestError('Project creation is not enabled for this runtime.', 'project_creation_disabled');
    }
    const name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
    if (!name) throw new BadRequestError('A project name is required.', 'project_name_required');
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!baseId) throw new BadRequestError('The project name must contain letters or numbers.', 'invalid_project_name');
    let id = baseId;
    for (let suffix = 2; this.projects.some((project) => project.id === id); suffix += 1) {
      id = `${baseId}-${suffix}`;
    }
    const rootPath = path.join(this.managedRoot, id);
    try {
      await stat(rootPath);
      throw new ConflictError(`Project directory already exists: ${id}`, 'project_path_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(rootPath, { recursive: true });
    await this.seedProject(rootPath, name, request.systemName);
    const project: ProjectConfig = {
      id,
      name,
      description: typeof request.description === 'string' && request.description.trim()
        ? request.description.trim().slice(0, 240)
        : 'Managed AAA authorization project.',
      rootPath: await realpath(rootPath)
    };
    this.projects.push(project);
    this.activeProjectId = id;
    await this.persist();
    return this.summary(project);
  }

  async select(projectId: string): Promise<ProjectSummary> {
    this.assertProjectId(projectId);
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new NotFoundError(`Unknown project: ${projectId}`);
    this.activeProjectId = projectId;
    await this.persist();
    return this.summary(project);
  }

  private async seedProject(rootPath: string, name: string, systemName?: string): Promise<void> {
    const template = path.join(
      this.templateRoot!,
      '.github',
      'skills',
      'initialize-security-package',
      'assets',
      'security-package-template'
    );
    await cp(template, path.join(rootPath, 'security-package'), { recursive: true });
    for (const directory of ['.github', '.vscode']) {
      await cp(path.join(this.templateRoot!, directory), path.join(rootPath, directory), {
        recursive: true,
        force: false
      });
    }
    const configPath = path.join(rootPath, 'security-package', 'package-config.json');
    const packageConfig = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    packageConfig.packageName = name;
    packageConfig.systemName = typeof systemName === 'string' && systemName.trim()
      ? systemName.trim()
      : 'TBD';
    await writeFile(configPath, `${JSON.stringify(packageConfig, null, 2)}\n`, 'utf8');
    await writeFile(
      path.join(rootPath, 'README.md'),
      `# ${name}\n\nManaged locally by AAA — A&A Accelerator.\n`,
      'utf8'
    );
  }

  private async persist(): Promise<void> {
    if (!this.statePath || !this.managedRoot) return;
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const managedRoot = path.resolve(this.managedRoot);
    const managedProjects = this.projects.filter((project) => {
      const relative = path.relative(managedRoot, project.rootPath);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    await writeFile(this.statePath, `${JSON.stringify({
      activeProjectId: this.activeProjectId,
      projects: managedProjects
    }, null, 2)}\n`, 'utf8');
  }

  private summary(project: ProjectConfig): ProjectSummary {
    return { ...project, active: project.id === this.activeProjectId };
  }
}
