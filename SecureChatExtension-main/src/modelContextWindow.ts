import { getConfiguredSetting, getSetting } from './config';

const DEFAULT_CONTEXT_WINDOW = 128000;

type DeploymentConfig = {
    name?: string;
    deploymentId?: string;
    id?: string;
    contextWindow?: number;
};

export interface ContextWindowResolution {
    tokens: number;
    source: 'setting' | 'model-config' | 'model-inference' | 'default';
    modelId?: string;
}

function validTokenWindow(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}

function compactModelId(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, '');
}

export function inferContextWindowFromModel(modelId: string | undefined): number | undefined {
    if (!modelId) { return undefined; }

    const model = compactModelId(modelId);
    if (!model) { return undefined; }

    if (/gpt-5|gpt5/.test(model)) { return 400000; }
    if (/gpt-4\.1|gpt-41|gpt4\.1|gpt41/.test(model)) { return 1047576; }
    if (/\bo[134](?:[-_.]|$)|^o[134](?:[-_.]|$)/.test(model)) { return 200000; }
    if (/gpt-4o|gpt4o/.test(model)) { return 128000; }

    return undefined;
}

function configuredContextWindow(): number | undefined {
    return validTokenWindow(getConfiguredSetting<number>('agent.contextWindow'));
}

function activeAzureDeployment(): DeploymentConfig | undefined {
    const activeDeployment = getSetting<string>('azureOpenAI.activeDeployment') || '';
    const deployments = getSetting<DeploymentConfig[]>('azureOpenAI.deployments') || [];
    return deployments.find(d => d.deploymentId === activeDeployment) ?? deployments[0];
}

function activeCopilotModel(): DeploymentConfig | undefined {
    const configuredModels = getSetting<DeploymentConfig[]>('copilotCli.models') || [];
    const activeModel = getSetting<string>('copilotCli.model') || process.env.COPILOT_MODEL || '';
    const activeId = activeModel || '__copilot_cli_default__';
    return configuredModels.find(m => (m.id || m.deploymentId) === activeId)
        ?? (activeModel ? { id: activeModel, name: activeModel } : undefined);
}

export function resolveContextWindow(): ContextWindowResolution {
    const configured = configuredContextWindow();
    if (configured !== undefined) {
        return { tokens: configured, source: 'setting' };
    }

    const activeProvider = getSetting<string>('agentProvider') || 'local';
    const activeModel = activeProvider === 'copilot-cli'
        ? activeCopilotModel()
        : activeAzureDeployment();

    const configuredModelWindow = validTokenWindow(activeModel?.contextWindow);
    const modelId = activeModel?.deploymentId || activeModel?.id || activeModel?.name;
    if (configuredModelWindow !== undefined) {
        return { tokens: configuredModelWindow, source: 'model-config', modelId };
    }

    const inferred = inferContextWindowFromModel(`${activeModel?.name || ''} ${modelId || ''}`.trim());
    if (inferred !== undefined) {
        return { tokens: inferred, source: 'model-inference', modelId };
    }

    return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default', modelId };
}

export function getContextWindow(): number {
    return resolveContextWindow().tokens;
}