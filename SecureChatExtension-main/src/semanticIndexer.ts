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
    private storagePath: string | undefined;

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

        // Determine which files actually need re-chunking
        const currentFilePaths = new Set(files.map(f => f.relativePath));
        const needsRechunk = changedFiles ?? currentFilePaths; // if no diff info, rechunk everything

        // Start with cached chunks for files that haven't changed
        const newChunks: SemanticChunk[] = [];
        for (const [filePath, chunks] of cachedByFile) {
            if (currentFilePaths.has(filePath) && !needsRechunk.has(filePath)) {
                newChunks.push(...chunks);
            }
        }

        // Process only files that changed (or all files if no cache)
        let done = 0;
        let rechunked = 0;
        for (const file of files) {
            if (token?.isCancellationRequested) { break; }

            if (needsRechunk.has(file.relativePath)) {
                try {
                    const bytes = await vscode.workspace.fs.readFile(file.uri);
                    const content = Buffer.from(bytes).toString('utf8');
                    if (!content || content.indexOf('\u0000') >= 0) {
                        done++;
                        continue;
                    }

                    const fileChunks = this.chunkFile(file.relativePath, content);
                    newChunks.push(...fileChunks);
                    rechunked++;
                } catch {
                    // ignore unreadable files
                }
            }

            done++;
            if (progress && done % 50 === 0) {
                progress.report({
                    message: `${done}/${total} semantic files`,
                    increment: total > 0 ? (50 / total) * 100 : 0
                });
            }
        }

        this.chunks = newChunks;

        // Rebuild document-frequency table
        this.docFreq.clear();
        for (const chunk of this.chunks) {
            const seen = new Set<string>(chunk.termFreq.keys());
            for (const term of seen) {
                this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
            }
        }

        // Persist for next activation
        this.saveCache();
    }

    getChunkCount(): number {
        return this.chunks.length;
    }

    search(query: string, maxResults: number = 8): Array<{ filePath: string; startLine: number; endLine: number; score: number; text: string }> {
        const terms = this.tokenize(query);
        if (terms.length === 0 || this.chunks.length === 0) {
            return [];
        }

        const chunkCount = this.chunks.length;
        const scored: Array<{ chunk: SemanticChunk; score: number }> = [];

        for (const chunk of this.chunks) {
            let score = 0;

            for (const term of terms) {
                const tf = chunk.termFreq.get(term) || 0;
                if (tf === 0) { continue; }

                const df = this.docFreq.get(term) || 1;
                const idf = Math.log(1 + chunkCount / df);
                const tfNorm = tf / Math.max(chunk.termCount, 1);
                score += tfNorm * idf;
            }

            const q = query.toLowerCase();
            if (chunk.filePath.toLowerCase().includes(q)) {
                score += 0.25;
            }

            if (score > 0) {
                scored.push({ chunk, score });
            }
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

    private saveCache(): void {
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
            fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
        } catch {
            // Non-fatal
        }
    }
}
