/**
 * Search tools — search_files, grep_search, semantic_search, get_file_tree,
 * get_document_symbols, find_symbol, go_to_definition, find_references.
 */
import * as vscode from 'vscode';
import { ToolEntry, ToolContext } from './types';
import { getSetting } from '../config';

export function createSearchTools(ctx: ToolContext): ToolEntry[] {
    return [
        // ── search_files ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'search_files',
                    description: 'Search for files whose path matches a query string. Returns matching file paths.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Substring to search for in file paths' }
                        },
                        required: ['query']
                    }
                }
            },
            handler: async (args) => {
                const query = args.query as string;
                const matches = ctx.workspaceIndexer.searchFiles(query);
                if (matches.length === 0) {
                    return { success: true, result: 'No files match.' };
                }
                return { success: true, result: matches.slice(0, 50).join('\n') };
            }
        },

        // ── grep_search ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'grep_search',
                    description: 'Search for a text pattern (regex or literal) across files in the workspace. Returns matching lines with file paths and line numbers.',
                    parameters: {
                        type: 'object',
                        properties: {
                            pattern: { type: 'string', description: 'Search pattern (text or regex)' },
                            include: { type: 'string', description: 'Optional glob to limit which files to search (e.g. "**/*.ts")' },
                            isRegex: { type: 'string', description: '"true" if pattern is regex, "false" for literal (default: false)' }
                        },
                        required: ['pattern']
                    }
                }
            },
            handler: async (args) => {
                const pattern = args.pattern as string;
                const include = args.include as string | undefined;
                const isRegex = (args.isRegex as string) === 'true';

                try {
                    const regex = isRegex ? new RegExp(pattern, 'i') : null;
                    const excludeConfig = getSetting<string[]>('workspace.excludePatterns') || [];
                    const exclude = excludeConfig.length > 0 ? `{${excludeConfig.join(',')}}` : undefined;

                    const uris = await vscode.workspace.findFiles(include || '**/*', exclude, 5000);
                    const results: string[] = [];
                    const maxResults = 50;

                    for (const uri of uris) {
                        if (results.length >= maxResults) { break; }
                        try {
                            const bytes = await vscode.workspace.fs.readFile(uri);
                            const content = Buffer.from(bytes).toString('utf8');
                            const lines = content.split('\n');
                            const relPath = vscode.workspace.asRelativePath(uri, false);

                            for (let i = 0; i < lines.length; i++) {
                                if (results.length >= maxResults) { break; }
                                const match = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(pattern.toLowerCase());
                                if (match) {
                                    results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                                }
                            }
                        } catch {
                            // skip unreadable
                        }
                    }

                    return {
                        success: true,
                        result: results.length > 0
                            ? results.join('\n')
                            : 'No matches found.'
                    };
                } catch (e: unknown) {
                    return { success: false, result: `Search failed: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── semantic_search ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'semantic_search',
                    description: 'Find conceptually relevant code snippets by meaning (not just exact keyword matches). Best for architecture/questions like "where is model selection handled" or "how does indexing work".',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Natural language or keyword query describing what you need' },
                            maxResults: { type: 'string', description: 'Optional max number of chunks to return (default 8, max 20)' }
                        },
                        required: ['query']
                    }
                }
            },
            handler: async (args) => {
                const query = args.query as string;
                const requested = args.maxResults ? parseInt(args.maxResults as string, 10) : 8;
                const maxResults = Math.max(1, Math.min(20, isNaN(requested) ? 8 : requested));

                const matches = ctx.semanticIndexer.search(query, maxResults);
                if (matches.length === 0) {
                    return { success: true, result: 'No semantic matches found. Try broader wording or run Index Workspace first.' };
                }

                const sections: string[] = [];
                for (let i = 0; i < matches.length; i++) {
                    const m = matches[i];
                    const snippet = m.text.length > 1200 ? `${m.text.slice(0, 1200)}\n... [truncated]` : m.text;
                    sections.push(
                        `Match ${i + 1}: ${m.filePath}:${m.startLine}-${m.endLine} (score ${m.score.toFixed(3)})\n${snippet}`
                    );
                }

                const result = sections.join('\n\n');
                return {
                    success: true,
                    result: result.length > 20000 ? `${result.slice(0, 20000)}\n\n... [truncated]` : result
                };
            }
        },

        // ── get_file_tree ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'get_file_tree',
                    description: 'Get the workspace file tree showing all indexed files and directories.',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            },
            handler: async () => {
                return { success: true, result: ctx.workspaceIndexer.getFileTree() };
            }
        },

        // ── get_document_symbols ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'get_document_symbols',
                    description: 'List symbols (classes, functions, methods, variables, etc.) for a specific file.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative file path from workspace root' }
                        },
                        required: ['path']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                const relPath = vscode.workspace.asRelativePath(vscode.Uri.file(absPath), false);
                const symbols = ctx.symbolIndexer.getFileSymbols(relPath);
                if (symbols.length === 0) {
                    return { success: true, result: `No symbols found for ${relPath}.` };
                }

                const lines = symbols.slice(0, 200).map(s => {
                    const container = s.containerName ? ` (in ${s.containerName})` : '';
                    return `${s.filePath}:${s.line}:${s.character} [${s.kind}] ${s.name}${container}`;
                });
                return { success: true, result: lines.join('\n') };
            }
        },

        // ── find_symbol ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'find_symbol',
                    description: 'Find symbol definitions by name across the indexed workspace.',
                    parameters: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Symbol name or partial name to search for' },
                            includeLocals: { type: 'string', description: 'Optional: "true" to include local variables/properties/parameters (default false)' }
                        },
                        required: ['name']
                    }
                }
            },
            handler: async (args) => {
                const name = args.name as string;
                const includeLocals = (args.includeLocals as string) === 'true';
                const preferredKinds = new Set(['Class', 'Interface', 'Method', 'Function', 'Constructor', 'Namespace', 'Enum']);

                let matches = ctx.symbolIndexer.findSymbolsByName(name, 200);

                if (!includeLocals) {
                    matches = matches.filter(s => preferredKinds.has(s.kind));
                }

                const deduped: typeof matches = [];
                const seen = new Set<string>();
                for (const s of matches) {
                    const key = `${s.filePath}|${s.line}|${s.name}`;
                    if (seen.has(key)) { continue; }
                    seen.add(key);
                    deduped.push(s);
                }

                if (deduped.length === 0) {
                    return { success: true, result: `No symbol matches for "${name}".` };
                }

                const lines = deduped.slice(0, 100).map(s => {
                    const container = s.containerName ? ` (in ${s.containerName})` : '';
                    return `${s.filePath}:${s.line}:${s.character} [${s.kind}] ${s.name}${container}`;
                });
                return { success: true, result: lines.join('\n') };
            }
        },

        // ── go_to_definition ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'go_to_definition',
                    description: 'Find the definition location for a symbol in a file.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative file path containing a symbol usage' },
                            symbol: { type: 'string', description: 'Symbol name to resolve' },
                            lineHint: { type: 'string', description: 'Optional 1-based line number where symbol appears' }
                        },
                        required: ['path', 'symbol']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const symbol = args.symbol as string;
                const lineHint = args.lineHint ? parseInt(args.lineHint as string, 10) : undefined;

                const resolved = await ctx.resolveSymbolPosition(filePath, symbol, lineHint);
                if (!resolved) {
                    return { success: false, result: `Could not resolve symbol position for ${symbol} in ${filePath}.` };
                }

                try {
                    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
                        'vscode.executeDefinitionProvider',
                        resolved.uri,
                        resolved.position
                    );

                    if (!defs || defs.length === 0) {
                        return { success: true, result: `No definition found for ${symbol}.` };
                    }

                    const lines = defs.slice(0, 50).map((d) => {
                        const uri = 'targetUri' in d ? d.targetUri : d.uri;
                        const range = 'targetRange' in d ? d.targetRange : d.range;
                        const rel = vscode.workspace.asRelativePath(uri, false);
                        return `${rel}:${range.start.line + 1}:${range.start.character + 1}`;
                    });
                    return { success: true, result: lines.join('\n') };
                } catch (e: unknown) {
                    return { success: false, result: `Definition lookup failed: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── find_references ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'find_references',
                    description: 'Find references for a symbol in a file.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative file path containing a symbol usage/definition' },
                            symbol: { type: 'string', description: 'Symbol name to find references for' },
                            lineHint: { type: 'string', description: 'Optional 1-based line number where symbol appears' },
                            includeDeclaration: { type: 'string', description: '"true" to include declarations, default false' }
                        },
                        required: ['path', 'symbol']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const symbol = args.symbol as string;
                const lineHint = args.lineHint ? parseInt(args.lineHint as string, 10) : undefined;
                const includeDeclaration = (args.includeDeclaration as string) === 'true';

                const resolved = await ctx.resolveSymbolPosition(filePath, symbol, lineHint);
                if (!resolved) {
                    return { success: false, result: `Could not resolve symbol position for ${symbol} in ${filePath}.` };
                }

                try {
                    const refs = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
                        'vscode.executeReferenceProvider',
                        resolved.uri,
                        resolved.position
                    );

                    if (!refs || refs.length === 0) {
                        return { success: true, result: `No references found for ${symbol}.` };
                    }

                    const currentFile = vscode.workspace.asRelativePath(resolved.uri, false);
                    const currentLine = resolved.position.line + 1;

                    const filtered = includeDeclaration
                        ? refs
                        : refs.filter(r => {
                            const rel = vscode.workspace.asRelativePath(r.uri, false);
                            const line = r.range.start.line + 1;
                            return !(rel === currentFile && line === currentLine);
                        });

                    const lines = filtered.slice(0, 200).map(r => {
                        const rel = vscode.workspace.asRelativePath(r.uri, false);
                        return `${rel}:${r.range.start.line + 1}:${r.range.start.character + 1}`;
                    });
                    return {
                        success: true,
                        result: lines.length > 0 ? lines.join('\n') : `No references found for ${symbol} (after filtering declaration).`
                    };
                } catch (e: unknown) {
                    return { success: false, result: `Reference lookup failed: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },
    ];
}
