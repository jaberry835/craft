/**
 * Workspace indexer — scans the workspace and builds a file tree + content cache
 * so the agent can reason about the codebase without repeated file reads.
 *
 * Supports persistent caching: on subsequent activations only files whose
 * mtime or size changed are re-processed.  The cache is stored under the
 * extension's globalStorage directory.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getSetting } from './config';

interface FileEntry {
    relativePath: string;
    uri: vscode.Uri;
    size: number;
    language: string;
    /** Last-modified time in milliseconds (used for cache staleness checks). */
    mtime: number;
}

/** Serializable form written to disk. */
interface CachedFileEntry {
    relativePath: string;
    fsPath: string;
    size: number;
    language: string;
    mtime: number;
}

const CACHE_VERSION = 1;
const CACHE_FILENAME = 'fileIndex.json';

export class WorkspaceIndexer {
    private files: Map<string, FileEntry> = new Map();
    private tree: string = '';
    private storagePath: string | undefined;
    /** Files that were new or modified during the last indexWorkspace() call. */
    private lastChangedFiles: Set<string> = new Set();

    /** Set the directory used for persisting the index cache. */
    setStoragePath(dir: string) {
        this.storagePath = dir;
    }

    async indexWorkspace(
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) { return; }

        const maxFileSize = getSetting<number>('workspace.maxFileSize') || 100000;
        const excludePatterns = getSetting<string[]>('workspace.excludePatterns') || [];

        const exclude = excludePatterns.length > 0
            ? `{${excludePatterns.join(',')}}`
            : undefined;

        // Load cached entries (if any)
        const cached = this.loadCache();

        const uris = await vscode.workspace.findFiles('**/*', exclude, 10000, token);
        const total = uris.length;
        let done = 0;
        let cacheHits = 0;

        const newFiles = new Map<string, FileEntry>();
        const changedFiles = new Set<string>();

        for (const uri of uris) {
            if (token?.isCancellationRequested) { break; }
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > maxFileSize) { continue; }

                const relativePath = vscode.workspace.asRelativePath(uri, false);
                const mtime = stat.mtime;

                // Check cache: if size and mtime match, reuse the cached entry
                const prev = cached.get(relativePath);
                if (prev && prev.size === stat.size && prev.mtime === mtime) {
                    newFiles.set(relativePath, {
                        relativePath,
                        uri,
                        size: prev.size,
                        language: prev.language,
                        mtime: prev.mtime,
                    });
                    cacheHits++;
                } else {
                    const ext = path.extname(uri.fsPath).toLowerCase();
                    const language = this.guessLanguage(ext);
                    newFiles.set(relativePath, { relativePath, uri, size: stat.size, language, mtime });
                    changedFiles.add(relativePath);
                }
            } catch {
                // skip unreadable files
            }
            done++;
            if (progress && done % 50 === 0) {
                progress.report({ message: `${done}/${total} files`, increment: (50 / total) * 100 });
            }
        }

        this.files = newFiles;
        this.lastChangedFiles = changedFiles;
        this.tree = this.buildTree();

        // Persist cache for next activation
        this.saveCache();
    }

    /** Returns the set of file paths that changed since the last cached index. */
    getChangedFiles(): Set<string> {
        return this.lastChangedFiles;
    }

    getFileCount(): number {
        return this.files.size;
    }

    getFileTree(): string {
        return this.tree || '(workspace not indexed)';
    }

    getFiles(): FileEntry[] {
        return Array.from(this.files.values());
    }

    hasFile(relativePath: string): boolean {
        return this.files.has(relativePath);
    }

    /** Search file paths by glob-like pattern */
    searchFiles(query: string): string[] {
        const lower = query.toLowerCase();
        return Array.from(this.files.keys()).filter(p => p.toLowerCase().includes(lower));
    }

    /** Incrementally update a single file in the index (called on save). Returns true if the file was new or changed. */
    async updateFile(uri: vscode.Uri): Promise<boolean> {
        const maxFileSize = getSetting<number>('workspace.maxFileSize') || 100000;
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > maxFileSize) { return false; }

            const relativePath = vscode.workspace.asRelativePath(uri, false);
            const existing = this.files.get(relativePath);

            // Skip if unchanged
            if (existing && existing.size === stat.size && existing.mtime === stat.mtime) {
                return false;
            }

            const ext = path.extname(uri.fsPath).toLowerCase();
            const language = this.guessLanguage(ext);
            this.files.set(relativePath, {
                relativePath,
                uri,
                size: stat.size,
                language,
                mtime: stat.mtime,
            });
            this.lastChangedFiles = new Set([relativePath]);
            this.tree = this.buildTree();
            this.saveCache();
            return true;
        } catch {
            return false;
        }
    }

    /** Remove a file from the index (called on delete) */
    removeFile(uri: vscode.Uri): boolean {
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        const removed = this.files.delete(relativePath);
        if (removed) {
            this.tree = this.buildTree();
            this.saveCache();
        }
        return removed;
    }

    // ── Cache persistence ──

    private getCachePath(): string | undefined {
        if (!this.storagePath) { return undefined; }
        return path.join(this.storagePath, CACHE_FILENAME);
    }

    private loadCache(): Map<string, CachedFileEntry> {
        const map = new Map<string, CachedFileEntry>();
        const cachePath = this.getCachePath();
        if (!cachePath) { return map; }
        try {
            if (!fs.existsSync(cachePath)) { return map; }
            const raw = fs.readFileSync(cachePath, 'utf8');
            const data = JSON.parse(raw);
            if (data?.version !== CACHE_VERSION) { return map; }
            for (const entry of data.files as CachedFileEntry[]) {
                map.set(entry.relativePath, entry);
            }
        } catch {
            // Corrupt cache — ignore and rebuild
        }
        return map;
    }

    private saveCache(): void {
        const cachePath = this.getCachePath();
        if (!cachePath) { return; }
        try {
            const dir = path.dirname(cachePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            const entries: CachedFileEntry[] = [];
            for (const entry of this.files.values()) {
                entries.push({
                    relativePath: entry.relativePath,
                    fsPath: entry.uri.fsPath,
                    size: entry.size,
                    language: entry.language,
                    mtime: entry.mtime,
                });
            }
            const data = { version: CACHE_VERSION, files: entries };
            fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
        } catch {
            // Non-fatal — indexing still works without cache
        }
    }

    private buildTree(): string {
        const paths = Array.from(this.files.keys()).sort();
        if (paths.length === 0) { return '(empty workspace)'; }

        // Build a compact tree representation
        const lines: string[] = [];
        const folders = vscode.workspace.workspaceFolders;
        const rootName = folders?.[0]?.name || 'workspace';
        lines.push(rootName + '/');

        const dirSet = new Set<string>();
        for (const p of paths) {
            const parts = p.split('/');
            let built = '';
            for (let i = 0; i < parts.length - 1; i++) {
                built += (built ? '/' : '') + parts[i];
                dirSet.add(built);
            }
        }

        const dirs = Array.from(dirSet).sort();
        const allEntries = [...dirs.map(d => d + '/'), ...paths].sort();

        for (const entry of allEntries) {
            const depth = entry.split('/').length - 1;
            const indent = '  '.repeat(depth);
            const name = entry.endsWith('/')
                ? entry.split('/').filter(Boolean).pop() + '/'
                : path.basename(entry);

            if (!entry.endsWith('/')) {
                lines.push(`${indent}${name}`);
            } else {
                lines.push(`${indent}${name}`);
            }
        }

        // Cap tree output
        if (lines.length > 200) {
            return lines.slice(0, 200).join('\n') + `\n... and ${lines.length - 200} more entries`;
        }
        return lines.join('\n');
    }

    private guessLanguage(ext: string): string {
        const map: Record<string, string> = {
            '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript',
            '.jsx': 'javascriptreact', '.py': 'python', '.cs': 'csharp',
            '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
            '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
            '.swift': 'swift', '.kt': 'kotlin', '.dart': 'dart',
            '.html': 'html', '.css': 'css', '.scss': 'scss',
            '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
            '.md': 'markdown', '.sql': 'sql', '.sh': 'shellscript',
            '.ps1': 'powershell', '.dockerfile': 'dockerfile',
            '.tf': 'terraform', '.bicep': 'bicep', '.r': 'r',
        };
        return map[ext] || 'plaintext';
    }
}
