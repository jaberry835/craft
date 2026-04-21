import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceIndexer } from './workspaceIndexer';

interface SemanticChunk {
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
    termFreq: Map<string, number>;
    termCount: number;
}

/** Serializable form written to disk (Maps are stored as plain objects). */
interface CachedChunk {
    filePath: string;
    startLine: number;
    endLine: number;
    text: string;
    termFreq: Record<string, number>;
    termCount: number;
}

const CACHE_VERSION = 1;
const CACHE_FILENAME = 'semanticIndex.json';
/** Number of concurrent file reads during semantic indexing. */
const READ_CONCURRENCY = 10;
const CACHE_SAVE_DEBOUNCE_MS = 1000;

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'where', 'what',
    'your', 'their', 'there', 'here', 'have', 'has', 'had', 'are', 'was', 'were', 'will',
    'shall', 'should', 'can', 'could', 'would', 'about', 'after', 'before', 'while', 'then',
    'else', 'null', 'true', 'false', 'const', 'let', 'var', 'function', 'class', 'return',
    'public', 'private', 'protected', 'static', 'void', 'string', 'number', 'boolean',
    'import', 'export', 'default', 'async', 'await', 'type', 'interface'
]);

export class SemanticIndexer {
    private chunks: SemanticChunk[] = [];
    private docFreq: Map<string, number> = new Map();
    /**
     * Inverted index: term → sorted array of chunk indices that contain the term.
     * Lets `search()` skip the linear scan over all chunks; we only score the union
     * of postings for the query terms. Rebuilt from `chunks` whenever the corpus changes.
     */
    private termIndex: Map<string, number[]> = new Map();
    private storagePath: string | undefined;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;

    /** Set the directory used for persisting the semantic index cache. */
    setStoragePath(dir: string) {
        this.storagePath = dir;
    }

    async indexWorkspace(
        workspaceIndexer: WorkspaceIndexer,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken,
        changedFiles?: Set<string>
    ): Promise<void> {
        const files = workspaceIndexer.getFiles();
        const total = files.length;

        // Load cached chunks grouped by file
        const cachedByFile = this.loadCache();

        // Determine which files actually need re-chunking.
        // A file needs re-chunking if it's in changedFiles OR it isn't in the cache yet.
        // The second case matters on first run after the semantic cache was added/cleared,
        // when the file index reports 0 changed files but the semantic cache is empty.
        const currentFilePaths = new Set(files.map(f => f.relativePath));
        const changed = changedFiles ?? currentFilePaths;
        const needsRechunk = new Set<string>();
        for (const f of files) {
            if (changed.has(f.relativePath) || !cachedByFile.has(f.relativePath)) {
                needsRechunk.add(f.relativePath);
            }
        }

        // Start with cached chunks for files that haven't changed
        const newChunks: SemanticChunk[] = [];
        for (const [filePath, chunks] of cachedByFile) {
            if (currentFilePaths.has(filePath) && !needsRechunk.has(filePath)) {
                newChunks.push(...chunks);
            }
        }

        // Process only files that changed (or all files if no cache)
        const filesToProcess = files.filter(f => needsRechunk.has(f.relativePath));
        let done = 0;

        // Batch file reads with concurrency for speed
        for (let batchStart = 0; batchStart < filesToProcess.length; batchStart += READ_CONCURRENCY) {
            if (token?.isCancellationRequested) { break; }
            const batchEnd = Math.min(batchStart + READ_CONCURRENCY, filesToProcess.length);
            const batch = filesToProcess.slice(batchStart, batchEnd);

            const results = await Promise.allSettled(
                batch.map(async (file) => {
                    const bytes = await vscode.workspace.fs.readFile(file.uri);
                    const content = Buffer.from(bytes).toString('utf8');
                    return { file, content };
                })
            );

            for (const result of results) {
                if (result.status !== 'fulfilled') { continue; }
                const { file, content } = result.value;
                if (!content || content.indexOf('\u0000') >= 0) { continue; }

                const fileChunks = this.chunkFile(file.relativePath, content);
                newChunks.push(...fileChunks);
            }

            done += batch.length;
            if (progress) {
                progress.report({
                    message: `${done}/${filesToProcess.length} semantic files`,
                    increment: filesToProcess.length > 0 ? (batch.length / filesToProcess.length) * 100 : 0
                });
            }
        }

        this.chunks = newChunks;

        // Rebuild document-frequency table and inverted term index in a single pass.
        this.rebuildIndexes();

        // Persist for next activation (full rebuild — immediate write)
        this.saveCacheNow();
    }

    getChunkCount(): number {
        return this.chunks.length;
    }

    /** Incrementally re-index a single file (called on save). Replaces its chunks in-place. */
    async reindexFile(uri: vscode.Uri, relativePath: string): Promise<void> {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(bytes).toString('utf8');

            // Remove old chunks for this file
            this.chunks = this.chunks.filter(c => c.filePath !== relativePath);

            // Chunk and add new entries
            const newChunks = this.chunkFile(relativePath, content);
            this.chunks.push(...newChunks);

            // Rebuild derived indexes (cheap relative to disk read)
            this.rebuildIndexes();
            this.scheduleSave();
        } catch {
            // File may be unreadable (binary, etc.)
        }
    }

    /** Remove all chunks for a file from the index */
    removeFile(relativePath: string): void {
        const before = this.chunks.length;
        this.chunks = this.chunks.filter(c => c.filePath !== relativePath);
        if (this.chunks.length !== before) {
            this.rebuildIndexes();
            this.scheduleSave();
        }
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

    /** Rebuild docFreq and the inverted term index from the current chunks array. */
    private rebuildIndexes(): void {
        this.docFreq.clear();
        this.termIndex.clear();
        for (let i = 0; i < this.chunks.length; i++) {
            const chunk = this.chunks[i];
            for (const term of chunk.termFreq.keys()) {
                this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
                let postings = this.termIndex.get(term);
                if (!postings) {
                    postings = [];
                    this.termIndex.set(term, postings);
                }
                postings.push(i);
            }
        }
    }

    search(query: string, maxResults: number = 8): Array<{ filePath: string; startLine: number; endLine: number; score: number; text: string }> {
        const terms = this.tokenize(query);
        if (terms.length === 0 || this.chunks.length === 0) {
            return [];
        }

        const chunkCount = this.chunks.length;
        // Use the inverted index: only score chunks that contain at least one query term.
        // Falls back gracefully (empty postings) for terms not in the corpus.
        const candidateScores = new Map<number, number>();

        for (const term of terms) {
            const postings = this.termIndex.get(term);
            if (!postings) { continue; }
            const df = this.docFreq.get(term) || 1;
            const idf = Math.log(1 + chunkCount / df);
            for (const idx of postings) {
                const chunk = this.chunks[idx];
                const tf = chunk.termFreq.get(term) || 0;
                if (tf === 0) { continue; }
                const tfNorm = tf / Math.max(chunk.termCount, 1);
                candidateScores.set(idx, (candidateScores.get(idx) || 0) + tfNorm * idf);
            }
        }

        // Light filename-match boost (cheap — only over candidates we already scored).
        const q = query.toLowerCase();
        const scored: Array<{ chunk: SemanticChunk; score: number }> = [];
        for (const [idx, score] of candidateScores) {
            const chunk = this.chunks[idx];
            const finalScore = chunk.filePath.toLowerCase().includes(q) ? score + 0.25 : score;
            scored.push({ chunk, score: finalScore });
        }

        scored.sort((a, b) => b.score - a.score);

        return scored.slice(0, maxResults).map(s => ({
            filePath: s.chunk.filePath,
            startLine: s.chunk.startLine,
            endLine: s.chunk.endLine,
            score: s.score,
            text: s.chunk.text
        }));
    }

    private chunkFile(filePath: string, content: string): SemanticChunk[] {
        const lines = content.split('\n');
        const chunkSize = 40;
        const overlap = 10;
        const out: SemanticChunk[] = [];

        for (let start = 0; start < lines.length; start += (chunkSize - overlap)) {
            const end = Math.min(lines.length, start + chunkSize);
            const text = lines.slice(start, end).join('\n');
            if (!text.trim()) { continue; }

            const terms = this.tokenize(text);
            const tf = new Map<string, number>();
            for (const t of terms) {
                tf.set(t, (tf.get(t) || 0) + 1);
            }

            out.push({
                filePath,
                startLine: start + 1,
                endLine: end,
                text,
                termFreq: tf,
                termCount: terms.length
            });

            if (end >= lines.length) { break; }
        }

        return out;
    }

    private tokenize(text: string): string[] {
        const raw = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
        return raw.filter(t => !STOP_WORDS.has(t));
    }

    // ── Cache persistence ──

    private getCachePath(): string | undefined {
        if (!this.storagePath) { return undefined; }
        return path.join(this.storagePath, CACHE_FILENAME);
    }

    /**
     * Load cached chunks grouped by filePath.
     * Returns an empty map if no cache exists or it's corrupt/stale.
     */
    private loadCache(): Map<string, SemanticChunk[]> {
        const map = new Map<string, SemanticChunk[]>();
        const cachePath = this.getCachePath();
        if (!cachePath) { return map; }
        try {
            if (!fs.existsSync(cachePath)) { return map; }
            const raw = fs.readFileSync(cachePath, 'utf8');
            const data = JSON.parse(raw);
            if (data?.version !== CACHE_VERSION) { return map; }
            for (const c of data.chunks as CachedChunk[]) {
                const chunk: SemanticChunk = {
                    filePath: c.filePath,
                    startLine: c.startLine,
                    endLine: c.endLine,
                    text: c.text,
                    termFreq: new Map(Object.entries(c.termFreq)),
                    termCount: c.termCount,
                };
                const arr = map.get(c.filePath) || [];
                arr.push(chunk);
                map.set(c.filePath, arr);
            }
        } catch {
            // Corrupt cache — ignore and rebuild
        }
        return map;
    }

    private saveCacheNow(): void {
        const cachePath = this.getCachePath();
        if (!cachePath) { return; }
        try {
            const dir = path.dirname(cachePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            const cached: CachedChunk[] = this.chunks.map(c => ({
                filePath: c.filePath,
                startLine: c.startLine,
                endLine: c.endLine,
                text: c.text,
                termFreq: Object.fromEntries(c.termFreq),
                termCount: c.termCount,
            }));
            const data = { version: CACHE_VERSION, chunks: cached };
            const tmp = cachePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
            fs.renameSync(tmp, cachePath);
        } catch {
            // Non-fatal
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer) { return; }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveCacheNow();
        }, CACHE_SAVE_DEBOUNCE_MS);
    }
}
