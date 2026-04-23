import * as fs from 'fs';
import * as path from 'path';

interface RepoPatternData {
    version: number;
    relevantFiles: Record<string, number>;
    successfulCommands: Record<string, number>;
}

const STORE_VERSION = 1;
const STORE_FILE = 'learnedPatterns.json';

export class RepoPatternStore {
    private filePath: string;
    private data: RepoPatternData = {
        version: STORE_VERSION,
        relevantFiles: {},
        successfulCommands: {}
    };
    private revision = 0;

    constructor(storageDir: string) {
        fs.mkdirSync(storageDir, { recursive: true });
        this.filePath = path.join(storageDir, STORE_FILE);
        this.load();
    }

    getVersion(): number {
        return this.revision;
    }

    noteRelevantFile(filePath: string) {
        const normalized = this.normalizePath(filePath);
        if (!normalized) { return; }
        this.data.relevantFiles[normalized] = (this.data.relevantFiles[normalized] || 0) + 1;
        this.bump();
    }

    noteSuccessfulCommand(command: string) {
        const normalized = this.normalizeCommand(command);
        if (!normalized || !this.looksLikeValidationCommand(normalized)) { return; }
        this.data.successfulCommands[normalized] = (this.data.successfulCommands[normalized] || 0) + 1;
        this.bump();
    }

    buildSystemMessage(options?: { maxFiles?: number; maxCommands?: number }): string {
        const maxFiles = options?.maxFiles ?? 4;
        const maxCommands = options?.maxCommands ?? 2;

        const topFiles = Object.entries(this.data.relevantFiles)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxFiles);
        const topCommands = Object.entries(this.data.successfulCommands)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxCommands);

        const sections: string[] = [];
        if (topFiles.length > 0) {
            sections.push('Common relevant files in this repo:\n' + topFiles.map(([filePath]) => `- ${filePath}`).join('\n'));
        }
        if (topCommands.length > 0) {
            sections.push('Previously successful validation commands:\n' + topCommands.map(([command]) => `- ${command}`).join('\n'));
        }

        if (sections.length === 0) { return ''; }
        return '[Repo Memory]\nUse these repo-specific patterns when they fit the current task, but verify before relying on them.\n\n' + sections.join('\n\n');
    }

    private load() {
        try {
            if (!fs.existsSync(this.filePath)) { return; }
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as RepoPatternData;
            if (parsed.version !== STORE_VERSION) { return; }
            this.data = parsed;
        } catch {
            // Ignore corrupt stores and start fresh.
        }
    }

    private save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
    }

    private bump() {
        this.revision++;
        this.save();
    }

    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    }

    private normalizeCommand(command: string): string {
        return command.replace(/\s+/g, ' ').trim();
    }

    private looksLikeValidationCommand(command: string): boolean {
        return /(build|test|lint|compile|pytest|tsc|npm run|pnpm |yarn |dotnet test|cargo test|go test|mvn test|gradle test)/i.test(command);
    }
}