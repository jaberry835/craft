import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomInstructionsProvider, WorkspaceContextProvider } from '../src/middleware/contextProviders';
import type { AgentContext } from '../src/framework/middleware';

function context(systemContent = 'base'): AgentContext {
    return {
        messages: [{ role: 'system', content: systemContent }],
        options: {},
        tools: [],
        client: {} as AgentContext['client'],
        editedFiles: new Set(),
        iteration: 0,
        cancelled: false,
        state: new Map(),
    };
}

describe('session-frozen context providers', () => {
    const originalFolders = vscode.workspace.workspaceFolders;
    const temporaryRoots: string[] = [];

    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = originalFolders;
        for (const root of temporaryRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps custom instructions byte-stable until reset', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-context-'));
        temporaryRoots.push(root);
        fs.mkdirSync(path.join(root, '.junior'));
        const instructionsPath = path.join(root, '.junior', 'instructions.md');
        fs.writeFileSync(instructionsPath, 'first instructions');
        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: root }, name: 'repo' }];
        const provider = new CustomInstructionsProvider();

        const first = context();
        await provider.beforeRun(first);
        fs.writeFileSync(instructionsPath, 'changed instructions');
        const second = context();
        await provider.beforeRun(second);

        expect(second.messages[0].content).toBe(first.messages[0].content);
        provider.reset();
        const third = context();
        await provider.beforeRun(third);
        expect(third.messages[0].content).toContain('changed instructions');
    });

    it('keeps the workspace snapshot stable until reset', async () => {
        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: 'C:\\repo' }, name: 'first' }];
        const provider = new WorkspaceContextProvider();
        const first = await provider.beforeRun(context());

        (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: 'C:\\repo' }, name: 'changed' }];
        const second = await provider.beforeRun(context());

        expect(second).toEqual(first);
        provider.reset();
        const third = await provider.beforeRun(context());
        expect(third?.[0].content).toContain('Workspace: changed');
    });
});