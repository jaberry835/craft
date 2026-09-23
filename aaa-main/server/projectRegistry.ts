import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError, NotFoundError } from './httpErrors.js';
import type { ProjectSummary, ProjectsResponse } from '../src/types/api.js';

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
    private readonly activeProjectId: string
  ) {}

  static async load(configPath: string): Promise<ProjectRegistry> {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as ProjectsConfig;
    if (!Array.isArray(config.projects) || config.projects.length === 0) {
      throw new Error('At least one configured project is required.');
    }
    const ids = new Set<string>();
    for (const project of config.projects) {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(project.id) || ids.has(project.id)) {
        throw new Error(`Invalid or duplicate project id: ${project.id}`);
      }
      ids.add(project.id);
      const projectStats = await stat(project.rootPath);
      if (!projectStats.isDirectory()) {
        throw new Error(`Configured project root is not a directory: ${project.rootPath}`);
      }
      project.rootPath = await realpath(path.resolve(project.rootPath));
    }
    if (!ids.has(config.activeProjectId)) {
      throw new Error(`Active project is not configured: ${config.activeProjectId}`);
    }
    return new ProjectRegistry(config.projects, config.activeProjectId);
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

  private summary(project: ProjectConfig): ProjectSummary {
    return { ...project, active: project.id === this.activeProjectId };
  }
}
