import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ProviderRouter } from '../src/providerRouter';
import { ExtensionMessage } from '../src/types';
import * as copilotCliSupport from '../src/copilotCliSupport';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string) => values[path],
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }));
}

function makeRouter() {
    const sent: ExtensionMessage[] = [];
    const router = new ProviderRouter(
        msg => sent.push(msg),
        () => {},
    );
    return { router, sent };
}

describe('ProviderRouter — initialization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: false });
        vi.spyOn(copilotCliSupport, 'normalizeCopilotCliConfiguredModels').mockReturnValue([]);
    });

    it('defaults to "local" when no setting is present', () => {
        const { router } = makeRouter();
        expect(router.activeProvider).toBe('local');
    });

    it('reads activeProvider from configuration', () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: true });
        setConfiguration({ agentProvider: 'copilot-cli' });
        const { router } = makeRouter();
        expect(router.activeProvider).toBe('copilot-cli');
    });
});

describe('ProviderRouter — getAgentProviderOptions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
    });

    it('lists only "local" when Copilot CLI is unavailable', () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: false });
        const { router } = makeRouter();
        const opts = router.getAgentProviderOptions();
        expect(opts).toHaveLength(1);
        expect(opts[0].value).toBe('local');
    });

    it('lists both when Copilot CLI is available', () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: true });
        const { router } = makeRouter();
        const opts = router.getAgentProviderOptions();
        expect(opts.map(o => o.value)).toEqual(['local', 'copilot-cli']);
    });
});

describe('ProviderRouter — getModelConfig (local)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: false });
    });

    it('returns Azure OpenAI deployments when provider is local', () => {
        setConfiguration({
            'azureOpenAI.deployments': [
                { name: 'GPT-4o', deploymentId: 'gpt-4o' },
                { deploymentId: 'gpt-4o-mini' }, // name fallback
            ],
            'azureOpenAI.activeDeployment': 'gpt-4o',
        });
        const { router } = makeRouter();
        const cfg = router.getModelConfig();
        expect(cfg.models).toEqual([
            { name: 'GPT-4o', deploymentId: 'gpt-4o' },
            { name: 'gpt-4o-mini', deploymentId: 'gpt-4o-mini' },
        ]);
        expect(cfg.activeDeployment).toBe('gpt-4o');
    });

    it('returns empty model list with no activeDeployment when nothing configured', () => {
        setConfiguration({});
        const { router } = makeRouter();
        const cfg = router.getModelConfig();
        expect(cfg.models).toEqual([]);
        expect(cfg.activeDeployment).toBeUndefined();
    });

    it('surfaces reasoning config for reasoning-capable local models', () => {
        setConfiguration({
            'azureOpenAI.deployments': [
                { name: 'GPT-5', deploymentId: 'gpt-5-chat' },
            ],
            'azureOpenAI.activeDeployment': 'gpt-5-chat',
            'azureOpenAI.wireApi': 'responses',
            'azureOpenAI.reasoningEffort': 'medium',
            'azureOpenAI.reasoningSummary': 'detailed',
        });
        const { router } = makeRouter();
        const cfg = router.getModelConfig();
        expect(cfg.models[0].supportsReasoning).toBe(true);
        expect(cfg.reasoning).toMatchObject({
            visible: true,
            supported: true,
            effort: 'medium',
            summary: 'detailed',
            wireApi: 'responses',
            modelId: 'gpt-5-chat',
        });
    });

    it('accepts GHCP-style none and xhigh reasoning effort values', () => {
        setConfiguration({
            'azureOpenAI.deployments': [
                { name: 'GPT-5', deploymentId: 'gpt-5-chat' },
            ],
            'azureOpenAI.activeDeployment': 'gpt-5-chat',
            'azureOpenAI.reasoningEffort': 'xhigh',
        });
        const { router } = makeRouter();
        expect(router.getModelConfig().reasoning?.effort).toBe('xhigh');

        setConfiguration({
            'azureOpenAI.deployments': [
                { name: 'GPT-5', deploymentId: 'gpt-5-chat' },
            ],
            'azureOpenAI.activeDeployment': 'gpt-5-chat',
            'azureOpenAI.reasoningEffort': 'none',
        });
        const { router: routerWithNone } = makeRouter();
        expect(routerWithNone.getModelConfig().reasoning?.effort).toBe('none');
    });

    it('lets deployment config override inferred reasoning support', () => {
        setConfiguration({
            'azureOpenAI.deployments': [
                { name: 'GPT-5', deploymentId: 'gpt-5-chat', supportsReasoning: false },
            ],
            'azureOpenAI.activeDeployment': 'gpt-5-chat',
        });
        const { router } = makeRouter();
        const cfg = router.getModelConfig();
        expect(cfg.models[0].supportsReasoning).not.toBe(true);
        expect(cfg.reasoning?.visible).toBe(false);
    });
});

describe('ProviderRouter — getModelConfig (copilot-cli)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: true });
        vi.spyOn(copilotCliSupport, 'normalizeCopilotCliConfiguredModels').mockReturnValue([]);
    });

    it('always includes a synthetic default entry when no models are configured', () => {
        setConfiguration({ agentProvider: 'copilot-cli' });
        const { router } = makeRouter();
        const cfg = router.getModelConfig();
        expect(cfg.models.some(m => m.deploymentId === '__copilot_cli_default__')).toBe(true);
        expect(cfg.activeDeployment).toBe('__copilot_cli_default__');
    });

    it('appends an unconfigured-but-active model so the dropdown can show it', () => {
        vi.spyOn(copilotCliSupport, 'normalizeCopilotCliConfiguredModels').mockReturnValue([
            { name: 'GPT-5', deploymentId: 'gpt-5' },
        ]);
        setConfiguration({
            agentProvider: 'copilot-cli',
            'copilotCli.model': 'gpt-6-preview',
        });
        const { router } = makeRouter();
        const cfg = router.getModelConfig();
        expect(cfg.models.some(m => m.deploymentId === 'gpt-6-preview')).toBe(true);
        expect(cfg.activeDeployment).toBe('gpt-6-preview');
    });
});

describe('ProviderRouter — selectProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
    });

    it('rejects switch to copilot-cli when unavailable, sends an error, no switch', async () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({
            available: false,
            reason: 'Copilot CLI not on PATH',
        });
        const { router, sent } = makeRouter();
        const beforeSwitch = vi.fn();

        const switched = await router.selectProvider('copilot-cli', beforeSwitch);
        expect(switched).toBe(false);
        expect(beforeSwitch).not.toHaveBeenCalled();
        expect(router.activeProvider).toBe('local');
        const err = sent.find(m => m.type === 'error');
        expect(err).toBeTruthy();
        if (err && err.type === 'error') {
            expect(err.message).toMatch(/Copilot CLI not on PATH/);
        }
    });

    it('returns false (no-op) when target provider is already active', async () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: false });
        const { router } = makeRouter();
        const switched = await router.selectProvider('local', vi.fn());
        expect(switched).toBe(false);
    });

    it('switches and invokes onBeforeSwitch when target is available', async () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: true });
        vi.spyOn(copilotCliSupport, 'normalizeCopilotCliConfiguredModels').mockReturnValue([]);
        const { router, sent } = makeRouter();
        const beforeSwitch = vi.fn();

        const switched = await router.selectProvider('copilot-cli', beforeSwitch);
        expect(switched).toBe(true);
        expect(beforeSwitch).toHaveBeenCalledOnce();
        expect(router.activeProvider).toBe('copilot-cli');
        expect(sent.some(m => m.type === 'setAgentProvider')).toBe(true);
    });
});

describe('ProviderRouter — refreshAvailability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfiguration({});
    });

    it('falls back to local and invokes onFallback when Copilot CLI was active but disappeared', () => {
        // Start with CLI available + active
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: true });
        vi.spyOn(copilotCliSupport, 'normalizeCopilotCliConfiguredModels').mockReturnValue([]);
        setConfiguration({ agentProvider: 'copilot-cli' });
        const { router } = makeRouter();
        expect(router.activeProvider).toBe('copilot-cli');

        // Now CLI disappears
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({
            available: false,
            reason: 'gone',
        });
        const onFallback = vi.fn();
        router.refreshAvailability(onFallback);

        expect(router.activeProvider).toBe('local');
        expect(onFallback).toHaveBeenCalledOnce();
    });

    it('does not call onFallback if active provider is already local', () => {
        vi.spyOn(copilotCliSupport, 'getCopilotCliAvailability').mockReturnValue({ available: false });
        const { router } = makeRouter();
        const onFallback = vi.fn();
        router.refreshAvailability(onFallback);
        expect(onFallback).not.toHaveBeenCalled();
    });
});
