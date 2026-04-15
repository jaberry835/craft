/**
 * Code action tools — rename_symbol, apply_code_action, get_diagnostics, get_open_editors.
 */
import * as vscode from 'vscode';
import { ToolEntry, ToolContext } from './types';

export function createCodeActionTools(ctx: ToolContext): ToolEntry[] {
    return [
        // ── rename_symbol ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'rename_symbol',
                    description: 'Rename a symbol (variable, function, class, etc.) across all files using VS Code\'s rename provider. This is like pressing F2 — it updates all references, imports, and usages project-wide.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to a file containing the symbol' },
                            symbol: { type: 'string', description: 'Current name of the symbol to rename' },
                            newName: { type: 'string', description: 'New name for the symbol' },
                            lineHint: { type: 'number', description: 'Optional 1-based line number where the symbol appears' }
                        },
                        required: ['path', 'symbol', 'newName']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const symbol = args.symbol as string;
                const newName = args.newName as string;
                const lineHint = args.lineHint as number | undefined;

                const approved = await ctx.requestConfirmation(`Rename "${symbol}" → "${newName}" in ${filePath}`, 'write');
                if (!approved) { return { success: false, result: 'User declined the rename.' }; }

                try {
                    const resolved = await ctx.resolveSymbolPosition(filePath, symbol, lineHint);
                    if (!resolved) {
                        return { success: false, result: `Could not find symbol "${symbol}" in ${filePath}` };
                    }

                    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                        'vscode.executeDocumentRenameProvider',
                        resolved.uri,
                        resolved.position,
                        newName
                    );

                    if (!edit || edit.size === 0) {
                        return { success: false, result: `Rename provider returned no edits for "${symbol}". The language server may not support rename at this location.` };
                    }

                    const applied = await vscode.workspace.applyEdit(edit);
                    if (!applied) {
                        return { success: false, result: 'Failed to apply rename edits.' };
                    }

                    const entries = edit.entries();
                    const fileCount = entries.length;
                    let editCount = 0;
                    const changedFiles: string[] = [];
                    for (const [uri, edits] of entries) {
                        editCount += edits.length;
                        changedFiles.push(vscode.workspace.asRelativePath(uri, false));
                    }

                    return {
                        success: true,
                        result: `Renamed "${symbol}" → "${newName}" — ${editCount} edit(s) across ${fileCount} file(s):\n${changedFiles.join('\n')}`
                    };
                } catch (e: unknown) {
                    return { success: false, result: `Rename failed: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── apply_code_action ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'apply_code_action',
                    description: 'List and optionally apply a VS Code code action (quick-fix / auto-fix) for a diagnostic at a given location. Call with apply=false first to see available fixes, then call again with apply=true and the action title.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to the file' },
                            line: { type: 'number', description: 'Line number (1-based) of the diagnostic' },
                            apply: { type: 'boolean', description: 'If false, list available actions. If true, apply the action matching the title.' },
                            title: { type: 'string', description: 'Title of the code action to apply (required when apply=true)' }
                        },
                        required: ['path', 'line']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const line = (args.line as number) - 1;
                const shouldApply = args.apply as boolean ?? false;
                const targetTitle = args.title as string | undefined;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    const range = new vscode.Range(line, 0, line, 1000);
                    const actions: vscode.CodeAction[] = await vscode.commands.executeCommand(
                        'vscode.executeCodeActionProvider', uri, range
                    );

                    if (!actions || actions.length === 0) {
                        return { success: true, result: 'No code actions available at this location.' };
                    }

                    if (!shouldApply) {
                        const listing = actions.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
                        return { success: true, result: `Available code actions:\n${listing}` };
                    }

                    if (!targetTitle) {
                        return { success: false, result: 'Must provide title when apply=true.' };
                    }

                    const match = actions.find(a =>
                        a.title.toLowerCase().includes(targetTitle.toLowerCase())
                    );
                    if (!match) {
                        const listing = actions.map(a => `  - ${a.title}`).join('\n');
                        return { success: false, result: `No action matching "${targetTitle}". Available:\n${listing}` };
                    }

                    const approved = await ctx.requestConfirmation(`Apply code action: ${match.title}`, 'write');
                    if (!approved) { return { success: false, result: 'User declined the code action.' }; }

                    if (match.edit) {
                        await vscode.workspace.applyEdit(match.edit);
                    }
                    if (match.command) {
                        await vscode.commands.executeCommand(
                            match.command.command,
                            ...(match.command.arguments || [])
                        );
                    }

                    return { success: true, result: `Applied code action: ${match.title}` };
                } catch (e: unknown) {
                    return { success: false, result: `Failed: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── get_diagnostics ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'get_diagnostics',
                    description: 'Get compiler errors, warnings and lint issues for a file or all open files from VS Code.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Optional relative path. Leave empty for all diagnostics.' }
                        },
                        required: []
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string | undefined;
                let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

                if (filePath) {
                    const absPath = ctx.validatePath(filePath);
                    if (!absPath) { return { success: false, result: 'Invalid path.' }; }
                    const uri = vscode.Uri.file(absPath);
                    diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
                } else {
                    diagnostics = vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][];
                }

                const results: string[] = [];
                for (const [uri, diags] of diagnostics) {
                    if (diags.length === 0) { continue; }
                    const relPath = vscode.workspace.asRelativePath(uri, false);
                    for (const d of diags) {
                        const severity = ['Error', 'Warning', 'Info', 'Hint'][d.severity] || 'Unknown';
                        results.push(`${relPath}:${d.range.start.line + 1}: [${severity}] ${d.message}`);
                    }
                }

                return {
                    success: true,
                    result: results.length > 0 ? results.join('\n') : 'No diagnostics found.'
                };
            }
        },

        // ── get_open_editors ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'get_open_editors',
                    description: 'List the currently open editor tabs / files in VS Code.',
                    parameters: {
                        type: 'object',
                        properties: {},
                        required: []
                    }
                }
            },
            handler: async () => {
                const tabs = vscode.window.tabGroups.all.flatMap((g: vscode.TabGroup) => g.tabs);
                const files = tabs
                    .map((t: vscode.Tab) => {
                        const input = t.input as { uri?: vscode.Uri } | undefined;
                        return input?.uri ? vscode.workspace.asRelativePath(input.uri, false) : null;
                    })
                    .filter(Boolean);

                return {
                    success: true,
                    result: files.length > 0 ? files.join('\n') : 'No editors open.'
                };
            }
        },
    ];
}
