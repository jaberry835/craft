/**
 * Shared types for extracted tool registration modules.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { ToolDefinition, ToolHandler } from '../types';
import { WorkspaceIndexer } from '../workspaceIndexer';
import { SymbolIndexer } from '../symbolIndexer';
import { SemanticIndexer } from '../semanticIndexer';

/** A tool definition + handler pair returned by each create*Tools function. */
export type ToolEntry = { definition: ToolDefinition; handler: ToolHandler };

/** Tracked background terminal process. */
export interface BackgroundProcessEntry {
    proc: cp.ChildProcess;
    output: string[];
    command: string;
    startedAt: number;
    exited: boolean;
    exitCode: number | null;
}

/** Mutable callbacks forwarded from BuiltinTools setter methods. */
export interface ToolCallbacks {
    onTerminalOutput?: (line: string) => void;
    onSetPlan?: (steps: { id: string; title: string }[]) => void;
    onUpdatePlanStep?: (stepId: string, status: string) => void;
}

/**
 * Context object passed to each tool registration module.
 * Provides access to shared BuiltinTools methods and state without coupling
 * the tool modules to the BuiltinTools class directly.
 */
export interface ToolContext {
    validatePath(filePath: string): string | null;
    getWorkspaceRoot(): string;
    snapshotOriginal(absPath: string, relPath: string): Promise<boolean>;
    notifyFileChanged(absPath: string, relPath: string): void;
    collectDiagnosticsAfterEdit(absPath: string, relPath: string): Promise<string>;
    requestConfirmation(description: string, category?: string): Promise<boolean>;
    resolveSymbolPosition(
        filePath: string,
        symbol: string,
        lineHint?: number
    ): Promise<{ uri: vscode.Uri; position: vscode.Position } | null>;
    workspaceIndexer: WorkspaceIndexer;
    symbolIndexer: SymbolIndexer;
    semanticIndexer: SemanticIndexer;
    callbacks: ToolCallbacks;
    backgroundProcesses: Map<string, BackgroundProcessEntry>;
    maxBackgroundProcesses: number;
}
