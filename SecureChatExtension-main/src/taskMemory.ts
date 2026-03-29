export class AgentTaskMemory {
    private objective = '';
    private relevantFiles: Map<string, string> = new Map();
    private findings: string[] = [];
    private diagnostics: string[] = [];
    private failedActions: string[] = [];
    private searchQueries: string[] = [];
    private version = 0;

    reset() {
        this.objective = '';
        this.relevantFiles.clear();
        this.findings = [];
        this.diagnostics = [];
        this.failedActions = [];
        this.searchQueries = [];
        this.version = 0;
    }

    getVersion(): number {
        return this.version;
    }

    noteUserRequest(text: string) {
        const cleaned = this.compact(text, 240);
        if (cleaned) {
            this.objective = cleaned;
            this.bump();
        }
        for (const filePath of this.extractLikelyPaths(text)) {
            this.noteRelevantFile(filePath, 'mentioned by the user');
        }
    }

    noteRelevantFile(filePath: string, reason?: string) {
        const normalized = this.normalizePath(filePath);
        if (!normalized) { return; }
        if (!this.relevantFiles.has(normalized)) {
            this.relevantFiles.set(normalized, reason || 'observed during investigation');
            this.bump();
        }
    }

    noteRelevantFiles(filePaths: string[], reason?: string) {
        for (const filePath of filePaths) {
            this.noteRelevantFile(filePath, reason);
        }
    }

    noteFinding(text: string) {
        const cleaned = this.compact(text, 220);
        if (!cleaned || this.findings.includes(cleaned)) { return; }
        this.findings.push(cleaned);
        this.findings = this.findings.slice(-8);
        this.bump();
    }

    noteDiagnostics(lines: string[]) {
        for (const line of lines) {
            const cleaned = this.compact(line, 220);
            if (!cleaned || this.diagnostics.includes(cleaned)) { continue; }
            this.diagnostics.push(cleaned);
            this.bump();
        }
        this.diagnostics = this.diagnostics.slice(-10);
    }

    noteSearchQuery(query: string) {
        const cleaned = this.compact(query, 140);
        if (!cleaned || this.searchQueries.includes(cleaned)) { return; }
        this.searchQueries.push(cleaned);
        this.searchQueries = this.searchQueries.slice(-6);
        this.bump();
    }

    noteFailedAction(toolName: string, result: string) {
        const cleaned = this.compact(`${toolName}: ${result}`, 220);
        if (!cleaned || this.failedActions.includes(cleaned)) { return; }
        this.failedActions.push(cleaned);
        this.failedActions = this.failedActions.slice(-6);
        this.bump();
    }

    noteToolResult(toolName: string, args: Record<string, unknown>, result: string, success: boolean) {
        const text = result || '';

        if (typeof args.path === 'string') {
            this.noteRelevantFile(args.path, `${toolName} target`);
        }

        switch (toolName) {
            case 'read_file':
            case 'get_document_symbols':
                if (typeof args.path === 'string') {
                    this.noteFinding(`${toolName} inspected ${args.path}`);
                }
                break;
            case 'search_files':
                if (typeof args.query === 'string') {
                    this.noteSearchQuery(args.query);
                }
                this.noteRelevantFiles(this.extractLinePaths(text), 'matched file search');
                break;
            case 'semantic_search':
                if (typeof args.query === 'string') {
                    this.noteSearchQuery(args.query);
                }
                this.noteRelevantFiles(this.extractSemanticMatchPaths(text), 'semantic match');
                break;
            case 'grep_search':
                if (typeof args.pattern === 'string') {
                    this.noteSearchQuery(args.pattern);
                }
                this.noteRelevantFiles(this.extractColonPaths(text), 'grep match');
                break;
            case 'go_to_definition':
            case 'find_references':
            case 'find_symbol':
                this.noteRelevantFiles(this.extractColonPaths(text), `${toolName} result`);
                break;
            case 'get_diagnostics':
                this.noteDiagnostics(this.extractDiagnosticLines(text));
                this.noteRelevantFiles(this.extractColonPaths(text), 'diagnostic location');
                break;
        }

        if (!success) {
            this.noteFailedAction(toolName, text);
        }
    }

    buildSystemMessage(options?: { maxRelevantFiles?: number; maxDiagnostics?: number; maxFindings?: number; maxSearches?: number; maxFailures?: number }): string {
        const sections: string[] = [];
        const maxRelevantFiles = options?.maxRelevantFiles ?? 8;
        const maxDiagnostics = options?.maxDiagnostics ?? 8;
        const maxFindings = options?.maxFindings ?? 6;
        const maxSearches = options?.maxSearches ?? 4;
        const maxFailures = options?.maxFailures ?? 4;

        if (this.objective) {
            sections.push(`Objective: ${this.objective}`);
        }

        if (this.relevantFiles.size > 0) {
            const lines = Array.from(this.relevantFiles.entries())
                .slice(0, maxRelevantFiles)
                .map(([filePath, reason]) => `- ${filePath}${reason ? ` (${reason})` : ''}`);
            sections.push('Relevant files:\n' + lines.join('\n'));
        }

        if (this.diagnostics.length > 0) {
            sections.push('Observed diagnostics:\n' + this.diagnostics.slice(0, maxDiagnostics).map(line => `- ${line}`).join('\n'));
        }

        if (this.findings.length > 0) {
            sections.push('Findings so far:\n' + this.findings.slice(0, maxFindings).map(line => `- ${line}`).join('\n'));
        }

        if (this.searchQueries.length > 0) {
            sections.push('Searches already attempted:\n' + this.searchQueries.slice(0, maxSearches).map(line => `- ${line}`).join('\n'));
        }

        if (this.failedActions.length > 0) {
            sections.push('Recent failed actions:\n' + this.failedActions.slice(0, maxFailures).map(line => `- ${line}`).join('\n'));
        }

        if (sections.length === 0) { return ''; }
        return '[Task Memory]\nUse this memory to avoid re-discovering the same context and to continue from prior findings.\n\n' + sections.join('\n\n');
    }

    private extractLikelyPaths(text: string): string[] {
        const matches = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|ps1)\b/g) || [];
        return this.dedupe(matches);
    }

    private extractLinePaths(text: string): string[] {
        const out: string[] = [];
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.includes('No matches found')) { continue; }
            if (/^[\w./-]+\/?$/.test(line)) {
                out.push(line.replace(/\/$/, ''));
            }
        }
        return this.dedupe(out);
    }

    private extractColonPaths(text: string): string[] {
        const out: string[] = [];
        for (const rawLine of text.split(/\r?\n/)) {
            const match = rawLine.match(/^([\w./-]+\.[\w]+):(\d+)/);
            if (match) {
                out.push(match[1]);
            }
        }
        return this.dedupe(out);
    }

    private extractSemanticMatchPaths(text: string): string[] {
        const out: string[] = [];
        for (const rawLine of text.split(/\r?\n/)) {
            const match = rawLine.match(/^Match \d+: ([\w./-]+\.[\w]+):(\d+)-/);
            if (match) {
                out.push(match[1]);
            }
        }
        return this.dedupe(out);
    }

    private extractDiagnosticLines(text: string): string[] {
        return text
            .split(/\r?\n/)
            .filter(line => /\[(?:Error|Warning|Info|Hint)\]/.test(line))
            .map(line => this.compact(line.trim(), 220))
            .filter(Boolean) as string[];
    }

    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    }

    private compact(text: string, maxLength: number): string {
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (!cleaned) { return ''; }
        return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
    }

    private dedupe(values: string[]): string[] {
        return Array.from(new Set(values.map(value => this.normalizePath(value)).filter(Boolean)));
    }

    private bump() {
        this.version++;
    }
}