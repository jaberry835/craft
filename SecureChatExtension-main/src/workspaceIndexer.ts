/**
 * Workspace indexer — scans the workspace and builds a file tree + content cache
 * so the agent can reason about the codebase without repeated file reads.
 */
import * as vscode from 'vscode';
import * as path from 'path';

interface FileEntry {
    relativePath: string;
    uri: vscode.Uri;
    size: number;
    language: string;
}

export class WorkspaceIndexer {
    private files: Map<string, FileEntry> = new Map();
    private tree: string = '';

    async indexWorkspace(
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        this.files.clear();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) { return; }

        const config = vscode.workspace.getConfiguration('securechat.workspace');
        const maxFileSize = config.get<number>('maxFileSize') || 100000;
        const excludePatterns = config.get<string[]>('excludePatterns') || [];

        const exclude = excludePatterns.length > 0
            ? `{${excludePatterns.join(',')}}`
            : undefined;

        const uris = await vscode.workspace.findFiles('**/*', exclude, 10000, token);
        const total = uris.length;
        let done = 0;

        for (const uri of uris) {
            if (token?.isCancellationRequested) { break; }
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.size > maxFileSize) { continue; }

                const relativePath = vscode.workspace.asRelativePath(uri, false);
                const ext = path.extname(uri.fsPath).toLowerCase();
                const language = this.guessLanguage(ext);

                this.files.set(relativePath, { relativePath, uri, size: stat.size, language });
            } catch {
                // skip unreadable files
            }
            done++;
            if (progress && done % 50 === 0) {
                progress.report({ message: `${done}/${total} files`, increment: (50 / total) * 100 });
            }
        }

        this.tree = this.buildTree();
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
