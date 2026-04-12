/**
 * AutofixMiddleware — AgentMiddleware that re-runs the agent
 * when edited files have diagnostics errors after the agent stops.
 *
 * Extracted from AgentLoop auto-fix cycle logic:
 * - After the core agent finishes (no more tool calls), checks edited files
 * - If Error-level diagnostics found, injects them and continues the loop
 * - Up to MAX_AUTOFIX_CYCLES = 3 attempts
 */

import * as vscode from 'vscode';
import type { AgentMiddleware, AgentContext } from '../framework/middleware';
import type { AgentResponse, ChatMessage } from '../framework/types';

export interface AutofixMiddlewareOptions {
    /** Maximum auto-fix cycles. Default: 3. */
    maxCycles?: number;
    /** Delay in ms before collecting diagnostics (language server lag). Default: 800. */
    diagnosticDelayMs?: number;
    /** Maximum number of errors to inject per cycle. Default: 20. */
    maxErrors?: number;
    /** Callback for status updates during autofix. */
    onAutofixCycle?: (cycle: number, maxCycles: number) => void;
}

export class AutofixMiddleware implements AgentMiddleware {
    readonly name = 'autofix';
    private maxCycles: number;
    private diagnosticDelayMs: number;
    private maxErrors: number;
    private onAutofixCycle?: (cycle: number, maxCycles: number) => void;

    constructor(private options?: AutofixMiddlewareOptions) {
        this.maxCycles = options?.maxCycles ?? 3;
        this.diagnosticDelayMs = options?.diagnosticDelayMs ?? 800;
        this.maxErrors = options?.maxErrors ?? 20;
        this.onAutofixCycle = options?.onAutofixCycle;
    }

    /** Maximum auto-fix cycles allowed. */
    getMaxCycles(): number { return this.maxCycles; }

    async process(context: AgentContext, next: () => Promise<AgentResponse>): Promise<AgentResponse> {
        let response = await next();
        let autofixCycles = 0;

        while (autofixCycles < this.maxCycles && !context.cancelled) {
            if (context.editedFiles.size === 0) { break; }

            // Wait for language servers to update
            await this.delay(this.diagnosticDelayMs);

            const errors = this.collectDiagnostics(context.editedFiles);
            if (errors.length === 0) { break; }

            // Inject auto-fix message
            const errorSummary = errors.slice(0, this.maxErrors).join('\n');
            const fixMessage: ChatMessage = {
                role: 'system',
                content: `[Auto-fix] The following errors were found in files you edited. Fix them before finishing:\n\n${errorSummary}`,
            };
            context.messages.push(fixMessage);

            autofixCycles++;
            this.onAutofixCycle?.(autofixCycles, this.maxCycles);
            response = await next();
        }

        return response;
    }

    /**
     * Standalone check for the streaming agent loop.
     *
     * Waits for language servers, collects diagnostics from edited files,
     * and returns an error summary string ready to inject as a system
     * message — or null if no errors were found.
     *
     * @param editedFiles   Set of absolute or relative file paths that were edited.
     * @param workspaceRoot Workspace root path used to resolve relative paths.
     */
    async checkForErrors(editedFiles: Set<string>, workspaceRoot?: string): Promise<string | null> {
        if (editedFiles.size === 0) { return null; }

        await this.delay(this.diagnosticDelayMs);

        const errors = this.collectDiagnosticsFromPaths(editedFiles, workspaceRoot);
        if (errors.length === 0) { return null; }

        const capped = errors.slice(0, this.maxErrors);
        if (errors.length > this.maxErrors) {
            capped.push(`... and ${errors.length - this.maxErrors} more errors.`);
        }
        return capped.join('\n');
    }

    private collectDiagnosticsFromPaths(editedFiles: Set<string>, workspaceRoot?: string): string[] {
        const path = require('path');
        const errors: string[] = [];
        for (const filePath of editedFiles) {
            try {
                const absPath = workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath;
                const uri = vscode.Uri.file(absPath);
                const diagnostics = vscode.languages.getDiagnostics(uri);
                for (const d of diagnostics) {
                    if (d.severity !== vscode.DiagnosticSeverity.Error) { continue; }
                    errors.push(`${filePath}:${d.range.start.line + 1}: [Error] ${d.message}`);
                }
            } catch { /* skip */ }
        }
        return errors;
    }

    private collectDiagnostics(editedFiles: Set<string>): string[] {
        const errors: string[] = [];
        for (const filePath of editedFiles) {
            try {
                const uri = vscode.Uri.file(filePath);
                const diagnostics = vscode.languages.getDiagnostics(uri);
                for (const d of diagnostics) {
                    if (d.severity !== vscode.DiagnosticSeverity.Error) { continue; }
                    errors.push(`${filePath}:${d.range.start.line + 1}: [Error] ${d.message}`);
                }
            } catch {
                // Ignore files we can't inspect
            }
        }
        return errors;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
