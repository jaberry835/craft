/**
 * Minimal vscode module stub for unit tests.
 * Only the symbols that transitive imports resolve through.
 */

import { vi } from 'vitest';

export const workspace = {
    getConfiguration: vi.fn(() => ({
        get: () => undefined,
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    })),
    workspaceFolders: [],
};

export const Uri = {
    file: (path: string) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` }),
    parse: (value: string) => ({ scheme: 'https', path: value, fsPath: value, toString: () => value }),
};

export const languages = {
    getDiagnostics: () => [],
};

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export const window = {
    createStatusBarItem: () => ({
        show: () => {},
        hide: () => {},
        dispose: () => {},
        text: '',
        tooltip: '',
        command: '',
    }),
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    showQuickPick: vi.fn(() => Promise.resolve(undefined)),
};

export const authentication = {
    getSession: vi.fn(() => Promise.resolve(undefined)),
};

export const env = {
    openExternal: vi.fn(() => Promise.resolve(true)),
    clipboard: {
        writeText: vi.fn(() => Promise.resolve()),
        readText: vi.fn(() => Promise.resolve('')),
    },
};

export class CancellationError extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'Cancelled';
    }
}

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

