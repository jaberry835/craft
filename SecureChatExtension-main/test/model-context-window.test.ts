import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { inferContextWindowFromModel, resolveContextWindow } from '../src/modelContextWindow';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

function setConfiguration(values: Record<string, unknown>, configured: Record<string, unknown> = {}) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string, def?: unknown) => values[path] ?? def,
        has: () => false,
        inspect: (path: string) => configured[path] !== undefined ? { globalValue: configured[path] } : undefined,
        update: () => Promise.resolve(),
    }));
}

describe('modelContextWindow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
    });

    it('infers common context windows from model names', () => {
        expect(inferContextWindowFromModel('gpt-5.1-codex')).toBe(400000);
        expect(inferContextWindowFromModel('gpt-4.1')).toBe(1047576);
        expect(inferContextWindowFromModel('o3')).toBe(200000);
        expect(inferContextWindowFromModel('gpt-4o')).toBe(128000);
    });

    it('prefers an explicit global context window override', () => {
        setConfiguration(
            {
                'agent.contextWindow': 128000,
                'azureOpenAI.activeDeployment': 'gpt-5.1',
                'azureOpenAI.deployments': [{ name: 'GPT-5.1', deploymentId: 'gpt-5.1' }],
            },
            { 'agent.contextWindow': 32000 }
        );

        expect(resolveContextWindow()).toMatchObject({ tokens: 32000, source: 'setting' });
    });

    it('uses per-model contextWindow when configured', () => {
        setConfiguration({
            'azureOpenAI.activeDeployment': 'internal-model',
            'azureOpenAI.deployments': [{ name: 'Internal Model', deploymentId: 'internal-model', contextWindow: 256000 }],
        });

        expect(resolveContextWindow()).toMatchObject({ tokens: 256000, source: 'model-config', modelId: 'internal-model' });
    });

    it('infers from the active deployment when no override exists', () => {
        setConfiguration({
            'agent.contextWindow': 128000,
            'azureOpenAI.activeDeployment': 'gpt-5-chat',
            'azureOpenAI.deployments': [{ name: 'GPT-5 Chat', deploymentId: 'gpt-5-chat' }],
        });

        expect(resolveContextWindow()).toMatchObject({ tokens: 400000, source: 'model-inference', modelId: 'gpt-5-chat' });
    });

    it('falls back to 128k for unknown models', () => {
        setConfiguration({
            'azureOpenAI.activeDeployment': 'private-model',
            'azureOpenAI.deployments': [{ name: 'Private Model', deploymentId: 'private-model' }],
        });

        expect(resolveContextWindow()).toMatchObject({ tokens: 128000, source: 'default', modelId: 'private-model' });
    });
});