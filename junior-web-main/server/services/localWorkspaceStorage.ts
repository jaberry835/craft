import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';

const seedFiles: Record<string, string> = {
  'package/index.md': `# Contoso Payments Security Approval Package

## Executive Summary

This package is a working draft. Use Junior Workbench to collect evidence, draft controls, and publish the approval package.

## Current Approval Status

- Owner: Unassigned
- System criticality: Medium
- Data classification: Confidential
- Review state: Draft
`,
  'package/system-overview.md': `# System Overview

## Business Purpose

Describe what the system does, who uses it, and what approval is being requested.

## Architecture

Document the Azure services, identities, data stores, and external integrations involved.
`,
  'package/security-controls.md': `# Security Controls

## Identity And Access

- Define managed identities and human access paths.
- Record least-privilege role assignments.

## Data Protection

- Identify sensitive data stores.
- Document encryption, retention, and backup expectations.
`,
  'package/approval-checklist.md': `# Approval Checklist

- [ ] Business owner identified
- [ ] Data classification confirmed
- [ ] Threat model reviewed
- [ ] Required Azure RBAC assignments listed
- [ ] Monitoring and incident response documented
`
};

export class LocalWorkspaceStorage {
  constructor(private readonly rootPath: string) {}

  async ensureSeedWorkspace(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });

    for (const [relativePath, content] of Object.entries(seedFiles)) {
      const absolutePath = this.resolvePath(relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });

      try {
        await stat(absolutePath);
      } catch {
        await writeFile(absolutePath, content, 'utf8');
      }
    }
  }

  async listTree(): Promise<WorkspaceTreeNode[]> {
    return this.readDirectory('');
  }

  async readTextFile(relativePath: string): Promise<WorkspaceFile> {
    const absolutePath = this.resolvePath(relativePath);
    const [content, stats] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);

    return {
      path: this.normalizeRelativePath(relativePath),
      content,
      updatedAt: stats.mtime.toISOString()
    };
  }

  async writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile> {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const absolutePath = this.resolvePath(normalizedPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
    return this.readTextFile(normalizedPath);
  }

  async readMarkdownPackageFiles(): Promise<WorkspaceFile[]> {
    const tree = await this.listTree();
    const markdownPaths = this.flattenTree(tree)
      .filter((node) => node.type === 'file' && node.path.endsWith('.md'))
      .map((node) => node.path);

    return Promise.all(markdownPaths.map((filePath) => this.readTextFile(filePath)));
  }

  getAbsoluteRoot(): string {
    return this.rootPath;
  }

  private async readDirectory(relativePath: string): Promise<WorkspaceTreeNode[]> {
    const absolutePath = this.resolvePath(relativePath);
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const nodes = await Promise.all(entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry) => {
        const childPath = this.normalizeRelativePath(path.posix.join(relativePath.replaceAll('\\', '/'), entry.name));
        const node: WorkspaceTreeNode = {
          name: entry.name,
          path: childPath,
          type: entry.isDirectory() ? 'directory' : 'file'
        };

        if (entry.isDirectory()) {
          node.children = await this.readDirectory(childPath);
        }

        return node;
      }));

    return nodes.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }

  private flattenTree(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
    return nodes.flatMap((node) => [node, ...this.flattenTree(node.children ?? [])]);
  }

  private resolvePath(relativePath: string): string {
    const normalizedPath = this.normalizeRelativePath(relativePath);
    const absolutePath = path.resolve(this.rootPath, normalizedPath);
    const root = path.resolve(this.rootPath);

    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error('Workspace path escapes the configured root.');
    }

    return absolutePath;
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  }
}
