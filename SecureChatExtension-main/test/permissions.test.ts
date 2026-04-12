import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    isAutoApprovePermissionLevel,
    shouldAutoApproveCopilotPermission,
    shouldConfirmLocalCategory,
} from '../src/permissions';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string) => values[path],
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }));
}

describe('permission policy helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
    });

    it('treats bypass as the only auto-approve permission level', () => {
        expect(isAutoApprovePermissionLevel('default')).toBe(false);
        expect(isAutoApprovePermissionLevel('bypass')).toBe(true);
    });

    it('uses local confirmation settings in default mode', () => {
        setConfiguration({
            'agent.confirmWrites': false,
            'agent.confirmTerminal': true,
        });

        expect(shouldConfirmLocalCategory('default', 'write')).toBe(false);
        expect(shouldConfirmLocalCategory('default', 'terminal')).toBe(true);
    });

    it('disables local confirmations in bypass mode', () => {
        setConfiguration({
            'agent.confirmWrites': true,
            'agent.confirmTerminal': true,
        });

        expect(shouldConfirmLocalCategory('bypass', 'write')).toBe(false);
        expect(shouldConfirmLocalCategory('bypass', 'terminal')).toBe(false);
    });

    it('always approves read requests for Copilot CLI', () => {
        expect(shouldAutoApproveCopilotPermission('default', 'read')).toBe(true);
    });

    it('uses Copilot CLI settings in default mode and overrides them in bypass', () => {
        setConfiguration({
            'copilotCli.autoApproveWrites': false,
            'copilotCli.autoApproveTerminal': true,
        });

        expect(shouldAutoApproveCopilotPermission('default', 'write')).toBe(false);
        expect(shouldAutoApproveCopilotPermission('default', 'shell')).toBe(true);
        expect(shouldAutoApproveCopilotPermission('bypass', 'write')).toBe(true);
        expect(shouldAutoApproveCopilotPermission('bypass', 'url')).toBe(true);
    });
});