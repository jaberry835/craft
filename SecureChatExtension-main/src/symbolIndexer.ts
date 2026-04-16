import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceIndexer } from './workspaceIndexer';

export interface SymbolEntry {
    name: string;
    kind: string;
    filePath: string;
    line: number;
    character: number;
    containerName?: string;
}

const CACHE_VERSION = 1;
const CACHE_FILENAME = 'symbolIndex.json';

export class SymbolIndexer {
    private symbolsByFile: Map<string, SymbolEntry[]> = new Map();
    private storagePath: string | undefined;

    /** Set the directory used for persisting the symbol index cache. */
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

        // Load cached symbols from disk
        const cached = this.loadCache();
        const currentFilePaths = new Set(files.map(f => f.relativePath));
        const needsReindex = changedFiles ?? currentFilePaths;

        // Start with cached symbols for files that haven't changed
        const newSymbols = new Map<string, SymbolEntry[]>();
        for (const [filePath, symbols] of cached) {
            if (currentFilePaths.has(filePath) && !needsReindex.has(filePath)) {
                newSymbols.set(filePath, symbols);
            }
        }

        let done = 0;
        let reindexed = 0;

        for (const file of files) {
            if (token?.isCancellationRequested) { break; }

            if (needsReindex.has(file.relativePath)) {
                try {
                    const symbols = await this.getDocumentSymbols(file.uri);
                    if (symbols.length > 0) {
                        newSymbols.set(file.relativePath, symbols);
                    }
                    reindexed++;
                } catch {
                    // Skip files whose symbol provider fails
                }
            }

            done++;
            if (progress && done % 50 === 0) {
                progress.report({
                    message: `${done}/${total} symbol files`,
                    increment: total > 0 ? (50 / total) * 100 : 0
                });
            }
        }

        this.symbolsByFile = newSymbols;
        this.saveCache();
    }

    getFileSymbols(relativePath: string): SymbolEntry[] {
        return this.symbolsByFile.get(relativePath) || [];
    }

    findSymbolsByName(nameQuery: string, limit: number = 50): SymbolEntry[] {
        const q = nameQuery.toLowerCase();
        const results: SymbolEntry[] = [];
        for (const entries of this.symbolsByFile.values()) {
            for (const s of entries) {
                if (s.name.toLowerCase().includes(q)) {
                    results.push(s);
                    if (results.length >= limit) {
                        return results;
                    }
                }
            }
        }
        return results;
    }

    getPositionForSymbol(relativePath: string, symbolName: string): vscode.Position | undefined {
        const symbols = this.symbolsByFile.get(relativePath) || [];
        const exact = symbols.find(s => s.name === symbolName);
        if (exact) {
            return new vscode.Position(exact.line - 1, exact.character - 1);
        }
        const ci = symbols.find(s => s.name.toLowerCase() === symbolName.toLowerCase());
        if (ci) {
            return new vscode.Position(ci.line - 1, ci.character - 1);
        }
        const partial = symbols.find(s => s.name.toLowerCase().includes(symbolName.toLowerCase()));
        if (partial) {
            return new vscode.Position(partial.line - 1, partial.character - 1);
        }
        return undefined;
    }

    getSymbolFileCount(): number {
        return this.symbolsByFile.size;
    }

    /** Re-index symbols for a single file (incremental update on save) */
    async indexFile(uri: vscode.Uri, relativePath: string): Promise<void> {
        try {
            const symbols = await this.getDocumentSymbols(uri);
            if (symbols.length > 0) {
                this.symbolsByFile.set(relativePath, symbols);
            } else {
                this.symbolsByFile.delete(relativePath);
            }
        } catch {
            // Skip files whose symbol provider fails
        }
    }

    /** Remove a file from the symbol index */
    removeFile(relativePath: string): void {
        this.symbolsByFile.delete(relativePath);
    }

    // ── Cache persistence ──

    private getCachePath(): string | undefined {
        if (!this.storagePath) { return undefined; }
        return path.join(this.storagePath, CACHE_FILENAME);
    }

    private loadCache(): Map<string, SymbolEntry[]> {
        const map = new Map<string, SymbolEntry[]>();
        const cachePath = this.getCachePath();
        if (!cachePath) { return map; }
        try {
            if (!fs.existsSync(cachePath)) { return map; }
            const raw = fs.readFileSync(cachePath, 'utf8');
            const data = JSON.parse(raw);
            if (data?.version !== CACHE_VERSION) { return map; }
            for (const [filePath, symbols] of Object.entries(data.files as Record<string, SymbolEntry[]>)) {
                map.set(filePath, symbols);
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
            const files: Record<string, SymbolEntry[]> = {};
            for (const [filePath, symbols] of this.symbolsByFile) {
                files[filePath] = symbols;
            }
            const data = { version: CACHE_VERSION, files };
            fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
        } catch {
            // Non-fatal — indexing still works without cache
        }
    }

    private async getDocumentSymbols(uri: vscode.Uri): Promise<SymbolEntry[]> {
        const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol[] | vscode.SymbolInformation[]) | undefined>(
            'vscode.executeDocumentSymbolProvider',
            uri
        );

        if (!symbols || symbols.length === 0) {
            return [];
        }

        const relPath = vscode.workspace.asRelativePath(uri, false);

        if (this.isDocumentSymbolArray(symbols)) {
            const out: SymbolEntry[] = [];
            const walk = (items: vscode.DocumentSymbol[], container?: string) => {
                for (const item of items) {
                    out.push({
                        name: item.name,
                        kind: vscode.SymbolKind[item.kind],
                        filePath: relPath,
                        line: item.selectionRange.start.line + 1,
                        character: item.selectionRange.start.character + 1,
                        containerName: container
                    });
                    if (item.children && item.children.length > 0) {
                        walk(item.children, item.name);
                    }
                }
            };
            walk(symbols as vscode.DocumentSymbol[]);
            return out;
        }

        return (symbols as vscode.SymbolInformation[]).map(s => ({
            name: s.name,
            kind: vscode.SymbolKind[s.kind],
            filePath: vscode.workspace.asRelativePath(s.location.uri, false),
            line: s.location.range.start.line + 1,
            character: s.location.range.start.character + 1,
            containerName: s.containerName
        }));
    }

    private isDocumentSymbolArray(
        symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[]
    ): symbols is vscode.DocumentSymbol[] {
        if (symbols.length === 0) { return false; }
        const first = symbols[0] as vscode.DocumentSymbol;
        return Array.isArray(first.children);
    }
}
