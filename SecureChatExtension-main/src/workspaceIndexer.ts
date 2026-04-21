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
/** Number of concurrent stat() calls during indexing. */
const STAT_CONCURRENCY = 20;
const DEFAULT_MAX_FIND_FILES = 50000;
/** Debounce window for coalescing cache writes during incremental updates. */
const CACHE_SAVE_DEBOUNCE_MS = 1000;

export class WorkspaceIndexer {
    private files: Map<string, FileEntry> = new Map();
    private treeCache: string | undefined;
    private treeDirty: boolean = true;
    private storagePath: string | undefined;
    /** Files that were new or modified during the last indexWorkspace() call. */
    private lastChangedFiles: Set<string> = new Set();
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private warnedFindCap: boolean = false;

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
        const userExcludes = getSetting<string[]>('workspace.excludePatterns') || [];
        const maxFindFiles = getSetting<number>('workspace.maxIndexedFiles') || DEFAULT_MAX_FIND_FILES;
        const respectGitignore = getSetting<boolean>('workspace.respectGitignore') === true;

        const allExcludes = [...userExcludes];
        if (respectGitignore) {
            for (const folder of folders) {
                allExcludes.push(...readGitignorePatterns(folder.uri.fsPath));
            }
        }

        const exclude = allExcludes.length > 0
            ? `{${allExcludes.join(',')}}`
            : undefined;

        // Load cached entries (if any)
        const cached = this.loadCache();

        const uris = await vscode.workspace.findFiles('**/*', exclude, maxFindFiles, token);
        const total = uris.length;

        // Surface a clear warning if we hit the discovery cap — the index is silently incomplete.
        if (total >= maxFindFiles && !this.warnedFindCap) {
            this.warnedFindCap = true;
            const msg = `Junior workspace indexer hit the file-count cap of ${maxFindFiles}. Some files were not indexed. Increase 'junior.workspace.maxIndexedFiles' or tighten 'junior.workspace.excludePatterns'.`;
            try { vscode.window.showWarningMessage(msg); } catch { /* non-fatal */ }
        }
        let done = 0;
        let cacheHits = 0;

        const newFiles = new Map<string, FileEntry>();
        const changedFiles = new Set<string>();

        // Process stat() calls in concurrent batches for speed
        for (let batchStart = 0; batchStart < total; batchStart += STAT_CONCURRENCY) {
            if (token?.isCancellationRequested) { break; }
            const batchEnd = Math.min(batchStart + STAT_CONCURRENCY, total);
            const batch = uris.slice(batchStart, batchEnd);

            const results = await Promise.allSettled(
                batch.map(async (uri) => {
                    const stat = await vscode.workspace.fs.stat(uri);
                    return { uri, stat };
                })
            );

            for (const result of results) {
                if (result.status !== 'fulfilled') { continue; }
                const { uri, stat } = result.value;
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
            }

            done += batch.length;
            if (progress) {
                progress.report({ message: `${done}/${total} files`, increment: (batch.length / total) * 100 });
            }
        }

        this.files = newFiles;
        this.lastChangedFiles = changedFiles;
        this.treeDirty = true;

        // Persist cache for next activation (full rebuild — write immediately, not debounced)
        this.saveCacheNow();
    }

    /** Returns the set of file paths that changed since the last cached index. */
    getChangedFiles(): Set<string> {
        return this.lastChangedFiles;
    }

    getFileCount(): number {
        return this.files.size;
    }

    getFileTree(): string {
        if (this.treeDirty || this.treeCache === undefined) {
            this.treeCache = this.buildTree();
            this.treeDirty = false;
        }
        return this.treeCache || '(workspace not indexed)';
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
            this.treeDirty = true;
            this.scheduleSave();
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
            this.treeDirty = true;
            this.scheduleSave();
        }
        return removed;
    }

    /** Flush any pending debounced cache write. Call on extension shutdown. */
    flush(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
            this.saveCacheNow();
        }
    }

    dispose(): void {
        this.flush();
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

    /** Schedule a debounced cache write — coalesces rapid incremental updates. */
    private scheduleSave(): void {
        if (this.saveTimer) { return; }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveCacheNow();
        }, CACHE_SAVE_DEBOUNCE_MS);
    }

    private saveCacheNow(): void {
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
            // Atomic write: tmp file then rename, so partial writes don't corrupt the cache.
            const tmp = cachePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
            fs.renameSync(tmp, cachePath);
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

/**
 * Read a workspace folder's root .gitignore and convert simple entries to VS Code glob patterns.
 *
 * Intentionally minimal and conservative:
 *   - Comments (#) and blank lines are skipped.
 *   - Negation entries (!pattern) are skipped \u2014 partial honoring would over- or under-exclude.
 *   - Trailing-slash entries are treated as directories (`**\/dir\/**`).
 *   - Leading-slash entries are root-anchored relative to the workspace folder.
 *   - Other entries get a `**\/` prefix so they match anywhere in the tree.
 *
 * Only the root .gitignore is read; nested .gitignore files are not parsed.
 */
function readGitignorePatterns(folderFsPath: string): string[] {
    const out: string[] = [];
    const gitignorePath = path.join(folderFsPath, '.gitignore');
    let raw: string;
    try {
        if (!fs.existsSync(gitignorePath)) { return out; }
        raw = fs.readFileSync(gitignorePath, 'utf8');
    } catch {
        return out;
    }
    for (const lineRaw of raw.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) { continue; }
        const isDir = line.endsWith('/');
        let pat = isDir ? line.slice(0, -1) : line;
        const rooted = pat.startsWith('/');
        if (rooted) { pat = pat.slice(1); }
        if (!pat) { continue; }
        if (rooted) {
            out.push(isDir ? `${pat}/**` : pat);
        } else {
            out.push(isDir ? `**/${pat}/**` : `**/${pat}`);
        }
    }
    return out;
}
