import * as path from 'path';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';

export interface RetrievalCandidate {
    filePath: string;
    score: number;
    reasons: string[];
}

export interface RankQueryOptions {
    activeFile?: string;
    mentionedFiles?: string[];
    diagnostics?: Array<{ filePath: string; severity: 'Error' | 'Warning'; message: string }>;
    maxCandidates?: number;
}

interface MutableCandidate {
    filePath: string;
    score: number;
    reasons: Set<string>;
}

export class RetrievalRanker {
    constructor(
        private workspaceIndexer: WorkspaceIndexer,
        private symbolIndexer: SymbolIndexer,
        private semanticIndexer: SemanticIndexer
    ) {}

    rank(query: string, options: RankQueryOptions = {}): RetrievalCandidate[] {
        const candidateMap = new Map<string, MutableCandidate>();
        const maxCandidates = Math.max(1, Math.min(options.maxCandidates ?? 6, 12));
        const mentionedFiles = this.normalizeUnique(options.mentionedFiles || []);
        const activeFile = this.normalizePath(options.activeFile || '');
        const diagnostics = options.diagnostics || [];

        for (const filePath of mentionedFiles) {
            this.addScore(candidateMap, filePath, 12, 'explicitly mentioned by the user');
        }

        if (activeFile) {
            this.addScore(candidateMap, activeFile, 7, 'currently open in the editor');
        }

        for (const diag of diagnostics) {
            const weight = diag.severity === 'Error' ? 10 : 6;
            this.addScore(candidateMap, diag.filePath, weight, `${diag.severity.toLowerCase()} diagnostic present`);
        }

        const semanticMatches = this.semanticIndexer.search(query, Math.max(8, maxCandidates * 2));
        for (const match of semanticMatches) {
            const score = Math.max(1, Math.round(match.score * 20));
            this.addScore(candidateMap, match.filePath, score, `semantic match around lines ${match.startLine}-${match.endLine}`);
        }

        const searchTerms = this.extractSearchTerms(query);
        for (const term of searchTerms) {
            const fileMatches = this.workspaceIndexer.searchFiles(term).slice(0, 12);
            for (const filePath of fileMatches) {
                const normalized = this.normalizePath(filePath);
                const bonus = this.fileNameContains(normalized, term) ? 6 : 3;
                this.addScore(candidateMap, normalized, bonus, `path matched "${term}"`);
            }

            const symbolMatches = this.symbolIndexer.findSymbolsByName(term, 24);
            for (const symbol of symbolMatches) {
                const normalized = this.normalizePath(symbol.filePath);
                const kindBonus = ['Class', 'Interface', 'Function', 'Method', 'Constructor'].includes(symbol.kind) ? 6 : 4;
                this.addScore(candidateMap, normalized, kindBonus, `symbol match: ${symbol.name}`);
            }
        }

        const ranked = Array.from(candidateMap.values())
            .sort((a, b) => {
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                return a.filePath.localeCompare(b.filePath);
            })
            .slice(0, maxCandidates)
            .map(candidate => ({
                filePath: candidate.filePath,
                score: candidate.score,
                reasons: Array.from(candidate.reasons).slice(0, 3)
            }));

        return ranked;
    }

    private addScore(map: Map<string, MutableCandidate>, rawFilePath: string, points: number, reason: string) {
        const filePath = this.normalizePath(rawFilePath);
        if (!filePath) { return; }
        const existing = map.get(filePath) || { filePath, score: 0, reasons: new Set<string>() };
        existing.score += points;
        existing.reasons.add(reason);
        map.set(filePath, existing);
    }

    private extractSearchTerms(query: string): string[] {
        const fileNames = this.normalizeUnique(query.match(/\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|ps1)\b/g) || []);
        const symbolLike = this.normalizeUnique(query.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [])
            .filter(term => !this.isStopWord(term))
            .slice(0, 8);

        const baseNames = fileNames.map(file => path.basename(file, path.extname(file)));
        return this.normalizeUnique([...fileNames, ...baseNames, ...symbolLike]);
    }

    private fileNameContains(filePath: string, term: string): boolean {
        return path.basename(filePath).toLowerCase().includes(term.toLowerCase());
    }

    private normalizeUnique(values: string[]): string[] {
        return Array.from(new Set(values.map(value => this.normalizePath(value)).filter(Boolean)));
    }

    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    }

    private isStopWord(term: string): boolean {
        return new Set([
            'there', 'issue', 'problem', 'error', 'warning', 'broken', 'failing', 'fails', 'failure',
            'not', 'working', 'with', 'from', 'that', 'this', 'have', 'need', 'please', 'look', 'into',
            'what', 'where', 'when', 'does', 'doesnt', 'something', 'wrong'
        ]).has(term.toLowerCase());
    }
}