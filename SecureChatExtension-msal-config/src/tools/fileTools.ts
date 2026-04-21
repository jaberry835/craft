/**
 * File tools — read_file, write_file, edit_file, replace_lines, delete_file, list_directory.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { ToolEntry, ToolContext } from './types';

export function createFileTools(ctx: ToolContext): ToolEntry[] {
    return [
        // ── read_file ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read the contents of a file in the workspace. Returns the file content as text. Use relative paths from workspace root.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to the file from workspace root' },
                            startLine: { type: 'string', description: 'Optional start line (1-based)' },
                            endLine: { type: 'string', description: 'Optional end line (1-based, inclusive)' }
                        },
                        required: ['path']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                    let content = openDoc
                        ? openDoc.getText()
                        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

                    const allLines = content.split('\n');
                    const totalLines = allLines.length;
                    const startLine = args.startLine ? parseInt(args.startLine as string, 10) : undefined;
                    const endLine = args.endLine ? parseInt(args.endLine as string, 10) : undefined;

                    const s = (startLine || 1) - 1;
                    const e = endLine ? Math.min(endLine, totalLines) : totalLines;
                    const slice = allLines.slice(s, e);

                    const numbered = slice.map((line, i) => `${s + i + 1}: ${line}`).join('\n');
                    let result = numbered;
                    let wasTruncated = false;

                    if (result.length > 100000) {
                        const truncated = result.slice(0, 100000);
                        const capLine = truncated.split('\n').length + s;
                        result = truncated + `\n\n... [truncated at ~line ${capLine} of ${totalLines}. Use startLine/endLine to read remaining sections.]`;
                        wasTruncated = true;
                    }

                    let rangeNote = '';
                    if (startLine || endLine) {
                        rangeNote = `\n[Showing lines ${s + 1}-${e} of ${totalLines}]`;
                    } else if (!wasTruncated && totalLines > 500) {
                        rangeNote = `\n[Read all ${totalLines} lines]`;
                    }

                    return { success: true, result: result + rangeNote };
                } catch (e: unknown) {
                    return { success: false, result: `Failed to read file: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── write_file ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'write_file',
                    description: 'Create or overwrite a file in the workspace with the given content. Parent directories are created automatically.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to the file from workspace root' },
                            content: { type: 'string', description: 'Full content to write to the file' }
                        },
                        required: ['path', 'content']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const content = args.content as string;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    await ctx.snapshotOriginal(absPath, filePath);

                    try {
                        await vscode.workspace.fs.stat(uri);
                    } catch {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
                    }

                    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

                    ctx.notifyFileChanged(absPath, filePath);
                    const diag = await ctx.collectDiagnosticsAfterEdit(absPath, filePath);
                    return { success: true, result: `File written: ${filePath}${diag}` };
                } catch (e: unknown) {
                    return { success: false, result: `Failed to write file: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── edit_file ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'edit_file',
                    description: 'Replace an exact string in a file with a new string. The old_string must match exactly (including whitespace). Use this for targeted edits.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to the file' },
                            old_string: { type: 'string', description: 'The exact text to find and replace (must match exactly once)' },
                            new_string: { type: 'string', description: 'The replacement text' }
                        },
                        required: ['path', 'old_string', 'new_string']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const oldStr = args.old_string as string;
                const newStr = args.new_string as string;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    await ctx.snapshotOriginal(absPath, filePath);

                    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                    const content = openDoc
                        ? openDoc.getText()
                        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

                    let matchStr = oldStr;
                    let count = content.split(oldStr).length - 1;

                    // Fast path: CRLF normalization
                    if (count === 0 && content.includes('\r\n') && !oldStr.includes('\r\n')) {
                        const crlfOld = oldStr.replace(/\n/g, '\r\n');
                        const crlfCount = content.split(crlfOld).length - 1;
                        if (crlfCount === 1) {
                            matchStr = crlfOld;
                            count = 1;
                        }
                    }

                    // Fallback 1: indentation-normalized line-by-line matching
                    if (count === 0) {
                        const contentLines = content.split('\n');
                        const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
                        const trimLine = (s: string) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
                        const trimmedOld = oldLines.map(trimLine);

                        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
                            let matches = true;
                            for (let j = 0; j < oldLines.length; j++) {
                                if (trimLine(contentLines[i + j]) !== trimmedOld[j]) {
                                    matches = false;
                                    break;
                                }
                            }
                            if (matches) {
                                const candidate = contentLines.slice(i, i + oldLines.length).join('\n');
                                let otherMatch = false;
                                for (let k = i + 1; k <= contentLines.length - oldLines.length; k++) {
                                    let m2 = true;
                                    for (let j = 0; j < oldLines.length; j++) {
                                        if (trimLine(contentLines[k + j]) !== trimmedOld[j]) {
                                            m2 = false;
                                            break;
                                        }
                                    }
                                    if (m2) { otherMatch = true; break; }
                                }
                                if (!otherMatch) {
                                    matchStr = candidate;
                                    count = 1;
                                }
                                break;
                            }
                        }
                    }

                    // Fallback 2: whitespace-collapsed matching
                    if (count === 0) {
                        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n/g, '\n');
                        const normContent = normalize(content);
                        const normOld = normalize(oldStr);
                        const normIdx = normContent.indexOf(normOld);
                        if (normIdx >= 0 && normContent.indexOf(normOld, normIdx + 1) === -1) {
                            const origToNorm: number[] = new Array(content.length);
                            let normLen = 0;
                            let prevWasSpace = false;
                            for (let oi = 0; oi < content.length; oi++) {
                                const ch = content[oi];
                                if (ch === '\r') {
                                    // skip
                                } else if (ch === '\n') {
                                    normLen++;
                                    prevWasSpace = false;
                                } else if (ch === ' ' || ch === '\t') {
                                    if (!prevWasSpace) {
                                        normLen++;
                                        prevWasSpace = true;
                                    }
                                } else {
                                    normLen++;
                                    prevWasSpace = false;
                                }
                                origToNorm[oi] = normLen;
                            }
                            let origStart = 0;
                            for (let oi = 0; oi < content.length; oi++) {
                                if (origToNorm[oi] > normIdx) {
                                    origStart = oi;
                                    break;
                                }
                            }
                            const normEnd = normIdx + normOld.length;
                            for (let end = origStart + normOld.length; end <= content.length; end++) {
                                const candidate = content.slice(origStart, end);
                                if (normalize(candidate) === normOld) {
                                    matchStr = candidate;
                                    count = 1;
                                    break;
                                }
                            }
                        }
                    }

                    if (count === 0) {
                        const lines = content.split('\n');
                        const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
                        const oldFirstLine = oldLines[0].trim();
                        const oldLastLine = oldLines[oldLines.length - 1].trim();
                        let bestLine = -1;
                        let bestScore = 0;
                        for (let i = 0; i < lines.length; i++) {
                            const trimmed = lines[i].trim();
                            if (trimmed.length === 0) { continue; }
                            if (trimmed.includes(oldFirstLine) || oldFirstLine.includes(trimmed)) {
                                let score = Math.min(trimmed.length, oldFirstLine.length);
                                if (oldLastLine && i + oldLines.length - 1 < lines.length) {
                                    const endTrimmed = lines[i + oldLines.length - 1].trim();
                                    if (endTrimmed.includes(oldLastLine) || oldLastLine.includes(endTrimmed)) {
                                        score += Math.min(endTrimmed.length, oldLastLine.length);
                                    }
                                }
                                if (score > bestScore) { bestScore = score; bestLine = i; }
                            }
                        }
                        let snippet: string;
                        if (bestLine >= 0) {
                            const from = Math.max(0, bestLine - 3);
                            const to = Math.min(lines.length, bestLine + oldLines.length + 5);
                            snippet = lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
                            snippet = `Closest match near line ${bestLine + 1}:\n${snippet}`;
                        } else {
                            snippet = `First 30 lines:\n` + lines.slice(0, Math.min(30, lines.length)).map((l, i) => `${i + 1}: ${l}`).join('\n');
                        }
                        return {
                            success: false,
                            result: `old_string not found in the file (${lines.length} lines). Re-read the file to get exact current content, then retry. ${snippet}`
                        };
                    }
                    if (count > 1) {
                        const lines = content.split('\n');
                        const matchLines: number[] = [];
                        const searchStr = matchStr;
                        let searchFrom = 0;
                        while (matchLines.length < 5) {
                            const idx = content.indexOf(searchStr, searchFrom);
                            if (idx < 0) { break; }
                            const lineNum = content.slice(0, idx).split('\n').length;
                            matchLines.push(lineNum);
                            searchFrom = idx + 1;
                        }
                        const locations = matchLines.length > 0
                            ? ` Found at lines: ${matchLines.join(', ')}${count > 5 ? ` (and ${count - 5} more)` : ''}.`
                            : '';
                        return { success: false, result: `old_string found ${count} times. Must match exactly once. Add more surrounding lines for context to make the match unique.${locations}` };
                    }
                    let effectiveNewStr = newStr;
                    if (matchStr.includes('\r\n') && !newStr.includes('\r\n')) {
                        effectiveNewStr = newStr.replace(/\n/g, '\r\n');
                    }
                    const updated = content.replace(matchStr, effectiveNewStr);

                    await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

                    ctx.notifyFileChanged(absPath, filePath);
                    const diag = await ctx.collectDiagnosticsAfterEdit(absPath, filePath);
                    return { success: true, result: `File edited: ${filePath}${diag}` };
                } catch (e: unknown) {
                    return { success: false, result: `Failed to edit file: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── replace_lines ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'replace_lines',
                    description: 'Replace a range of lines in a file with new content. Use this for larger edits like refactoring a function, rewriting a code block, or replacing 10+ lines where edit_file (exact string match) is fragile. Line numbers are 1-based and inclusive — use the line numbers from read_file output.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to the file' },
                            start_line: { type: 'number', description: '1-based first line to replace (inclusive)' },
                            end_line: { type: 'number', description: '1-based last line to replace (inclusive)' },
                            new_content: { type: 'string', description: 'The replacement content (replaces lines start_line through end_line)' }
                        },
                        required: ['path', 'start_line', 'end_line', 'new_content']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const startLine = Math.max(1, Math.round(Number(args.start_line)));
                const endLine = Math.max(startLine, Math.round(Number(args.end_line)));
                const newContent = args.new_content as string;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    await ctx.snapshotOriginal(absPath, filePath);

                    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === absPath);
                    const content = openDoc
                        ? openDoc.getText()
                        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

                    const lines = content.split('\n');
                    const totalLines = lines.length;

                    if (startLine > totalLines) {
                        return { success: false, result: `start_line ${startLine} is beyond end of file (${totalLines} lines).` };
                    }

                    const clampedEnd = Math.min(endLine, totalLines);
                    const before = lines.slice(0, startLine - 1);
                    const after = lines.slice(clampedEnd);
                    const newLines = newContent.split('\n');
                    const updated = [...before, ...newLines, ...after].join('\n');

                    await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));

                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

                    ctx.notifyFileChanged(absPath, filePath);

                    const removed = clampedEnd - startLine + 1;
                    const added = newLines.length;
                    const diag = await ctx.collectDiagnosticsAfterEdit(absPath, filePath);
                    return {
                        success: true,
                        result: `Replaced lines ${startLine}-${clampedEnd} in ${filePath} (removed ${removed}, added ${added} lines).${diag}`
                    };
                } catch (e: unknown) {
                    return { success: false, result: `Failed to replace lines: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── delete_file ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'delete_file',
                    description: 'Delete a file from the workspace.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to the file to delete' }
                        },
                        required: ['path']
                    }
                }
            },
            handler: async (args) => {
                const filePath = args.path as string;
                const absPath = ctx.validatePath(filePath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    const approved = await ctx.requestConfirmation(`Delete file: ${filePath}`, 'write');
                    if (!approved) { return { success: false, result: 'User declined the delete.' }; }
                    await vscode.workspace.fs.delete(uri);
                    return { success: true, result: `Deleted: ${filePath}` };
                } catch (e: unknown) {
                    return { success: false, result: `Failed to delete: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },

        // ── list_directory ──
        {
            definition: {
                type: 'function',
                function: {
                    name: 'list_directory',
                    description: 'List files and subdirectories in a directory. Returns names with / suffix for directories.',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'Relative path to directory (use "" or "." for workspace root)' }
                        },
                        required: ['path']
                    }
                }
            },
            handler: async (args) => {
                const dirPath = (args.path as string) || '.';
                const absPath = ctx.validatePath(dirPath);
                if (!absPath) { return { success: false, result: 'Invalid path or outside workspace.' }; }

                try {
                    const uri = vscode.Uri.file(absPath);
                    const entries = await vscode.workspace.fs.readDirectory(uri);
                    const listing = entries.map(([name, type]: [string, vscode.FileType]) =>
                        type === vscode.FileType.Directory ? name + '/' : name
                    ).sort();
                    return { success: true, result: listing.join('\n') };
                } catch (e: unknown) {
                    return { success: false, result: `Failed to list directory: ${e instanceof Error ? e.message : String(e)}` };
                }
            }
        },
    ];
}
