import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorkspaceFile, WorkspaceIndex, WorkspaceIndexEntry, WorkspaceSearchResult, WorkspaceTreeNode } from '../types.js';
import { LocalWorkspaceStorage } from './localWorkspaceStorage.js';

const indexableExtensions = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv']);
const packageSectionNames = [
  'intake',
  'architecture',
  'data-classification',
  'threat-model',
  'controls',
  'risk-register',
  'approval-summary',
  'evidence',
  'decisions',
  'questions'
];

interface IndexedDocument {
  file: WorkspaceFile;
  entry: WorkspaceIndexEntry;
  terms: Set<string>;
}

export class WorkspaceIndexer {
  private documents = new Map<string, IndexedDocument>();
  private index: WorkspaceIndex = {
    generatedAt: new Date(0).toISOString(),
    fileCount: 0,
    indexedFileCount: 0,
    totalBytes: 0,
    entries: [],
    packageSections: []
  };

  constructor(private readonly storage: LocalWorkspaceStorage) {}

  async refresh(): Promise<WorkspaceIndex> {
    const tree = await this.storage.listTree();
    const fileNodes = this.flattenFiles(tree);
    const documents = new Map<string, IndexedDocument>();
    const entries = await Promise.all(fileNodes.map((node) => this.createEntry(node)));

    for (const entry of entries) {
      if (!entry.indexed) {
        continue;
      }

      const file = await this.storage.readTextFile(entry.path);
      documents.set(entry.path, {
        file,
        entry,
        terms: this.tokenize(`${entry.path} ${file.content}`)
      });
    }

    this.documents = documents;
    this.index = {
      generatedAt: new Date().toISOString(),
      fileCount: fileNodes.length,
      indexedFileCount: documents.size,
      totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
      entries,
      packageSections: this.detectPackageSections(fileNodes)
    };

    return this.index;
  }

  getIndex(): WorkspaceIndex {
    return this.index;
  }

  search(query: string, limit = 5): WorkspaceSearchResult[] {
    const queryTerms = this.tokenize(query);

    if (queryTerms.size === 0) {
      return [];
    }

    return Array.from(this.documents.values())
      .map((document) => {
        const matchedTerms = Array.from(queryTerms).filter((term) => document.terms.has(term));
        const pathScore = matchedTerms.filter((term) => document.entry.path.toLowerCase().includes(term)).length * 2;
        const contentScore = matchedTerms.length;
        return {
          path: document.entry.path,
          score: pathScore + contentScore,
          preview: this.preview(document.file.content, matchedTerms[0] ?? ''),
          matchedTerms
        };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit);
  }

  private async createEntry(node: WorkspaceTreeNode): Promise<WorkspaceIndexEntry> {
    const file = await this.storage.readTextFile(node.path);
    const extension = path.extname(node.path).toLowerCase();
    const contentBytes = Buffer.byteLength(file.content, 'utf8');

    return {
      path: node.path,
      extension,
      modifiedAt: file.updatedAt,
      size: contentBytes,
      hash: createHash('sha256').update(file.content).digest('hex'),
      indexed: indexableExtensions.has(extension)
    };
  }

  private detectPackageSections(fileNodes: WorkspaceTreeNode[]): string[] {
    const normalizedPaths = new Set(fileNodes.map((node) => node.path.toLowerCase()));

    return packageSectionNames.filter((section) => {
      return normalizedPaths.has(`package/${section}.md`) ||
        Array.from(normalizedPaths).some((filePath) => filePath.startsWith(`package/${section}/`) || filePath.includes(`/${section}/`));
    });
  }

  private flattenFiles(nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] {
    return nodes.flatMap((node) => node.type === 'file' ? [node] : this.flattenFiles(node.children ?? []));
  }

  private tokenize(value: string): Set<string> {
    return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
  }

  private preview(content: string, term: string): string {
    const normalizedContent = content.replace(/\s+/g, ' ').trim();
    if (!term) {
      return normalizedContent.slice(0, 220);
    }

    const index = normalizedContent.toLowerCase().indexOf(term);
    const start = Math.max(0, index - 90);
    return normalizedContent.slice(start, start + 240);
  }
}
