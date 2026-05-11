/**
 * ProviderRouter — manages agent provider selection, model configuration,
 * and CLI availability for the chat view.
 *
 * Extracted from ChatViewProvider to keep provider-switching logic in one place.
 */
import * as vscode from 'vscode';
import { AgentProvider, AgentProviderOption, ExtensionMessage, ReasoningEffort, ReasoningSummary } from './types';
import { getSetting, updateSetting } from './config';
import {
    CopilotCliAvailability,
    getCopilotCliAvailability,
    normalizeCopilotCliConfiguredModels,
} from './copilotCliSupport';

export interface ModelConfig {
    models: Array<{ name: string; deploymentId: string; supportsReasoning?: boolean }>;
    activeDeployment?: string;
    disabled?: boolean;
    title?: string;
    reasoning?: {
        visible: boolean;
        supported: boolean;
        effort: ReasoningEffort;
        summary: ReasoningSummary;
        wireApi: string;
        modelId?: string;
        title?: string;
    };
}

type DeploymentConfig = {
    name?: string;
    deploymentId: string;
    supportsReasoning?: boolean;
};

function modelLooksReasoningCapable(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    return /(^|[-_./])o\d/.test(normalized)
        || normalized.startsWith('o') && /^o\d/.test(normalized)
        || normalized.includes('gpt-5')
        || normalized.includes('gpt5');
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : 'high';
}

function normalizeReasoningSummary(value: unknown): ReasoningSummary {
    return value === 'auto' || value === 'detailed' || value === 'none' ? value : 'auto';
}

export class ProviderRouter {
    activeProvider: AgentProvider;
    private _copilotCliAvailability: CopilotCliAvailability = { available: false };

    constructor(
        private sendToWebview: (msg: ExtensionMessage) => void,
        private log: (msg: string) => void,
    ) {
        this.activeProvider = (getSetting<string>('agentProvider') as AgentProvider) || 'local';
        this._copilotCliAvailability = getCopilotCliAvailability();
    }

    get copilotCliAvailability(): CopilotCliAvailability {
        return this._copilotCliAvailability;
    }

    getModelConfig(): ModelConfig {
        if (this.activeProvider === 'copilot-cli') {
            return this.getCopilotCliModelConfig();
        }
        const deployments = getSetting<DeploymentConfig[]>('azureOpenAI.deployments') || [];
        const activeDeployment = getSetting<string>('azureOpenAI.activeDeployment') || undefined;
        const models = deployments.map(d => {
            const label = d.name || d.deploymentId;
            const supportsReasoning = d.supportsReasoning ?? modelLooksReasoningCapable(`${label} ${d.deploymentId}`);
            return supportsReasoning
                ? { name: label, deploymentId: d.deploymentId, supportsReasoning: true }
                : { name: label, deploymentId: d.deploymentId };
        });
        const activeModel = models.find(m => m.deploymentId === activeDeployment) ?? models[0];
        const wireApi = (getSetting<string>('azureOpenAI.wireApi') || 'chat-completions').toLowerCase();
        const supported = !!activeModel?.supportsReasoning;
        return {
            models,
            activeDeployment,
            reasoning: {
                visible: supported,
                supported,
                effort: normalizeReasoningEffort(getSetting<string>('azureOpenAI.reasoningEffort')),
                summary: normalizeReasoningSummary(getSetting<string>('azureOpenAI.reasoningSummary')),
                wireApi,
                modelId: activeModel?.deploymentId,
                title: wireApi === 'responses'
                    ? 'Reasoning settings for this model'
                    : 'Reasoning controls apply when Azure OpenAI Wire API is set to responses'
            }
        };
    }

    private getCopilotCliModelConfig(): ModelConfig {
        const configuredModels = getSetting<Array<{ name?: string; id?: string; deploymentId?: string }>>('copilotCli.models') || [];
        const activeModel = getSetting<string>('copilotCli.model') || process.env.COPILOT_MODEL || '';

        const models = normalizeCopilotCliConfiguredModels(configuredModels);

        if (models.length === 0) {
            models.push({ name: 'Copilot CLI default', deploymentId: '__copilot_cli_default__' });
        }

        const activeId = activeModel || '__copilot_cli_default__';
        if (!models.some(m => m.deploymentId === activeId)) {
            models.push({ name: activeModel, deploymentId: activeModel });
        }

        return {
            models,
            activeDeployment: activeId,
            disabled: false,
            title: activeModel
                ? `Model: ${activeModel}`
                : 'Using the Copilot CLI default model'
        };
    }

    syncModelsToWebview(): void {
        const { models, activeDeployment, disabled, title, reasoning } = this.getModelConfig();
        this.sendToWebview({ type: 'setModels', models, activeDeployment, disabled, title, reasoning });
    }

    async updateReasoningConfig(config: { effort?: ReasoningEffort; summary?: ReasoningSummary }): Promise<void> {
        if (config.effort) {
            await updateSetting('azureOpenAI.reasoningEffort', config.effort, vscode.ConfigurationTarget.Global);
        }
        if (config.summary) {
            await updateSetting('azureOpenAI.reasoningSummary', config.summary, vscode.ConfigurationTarget.Global);
        }
        this.syncModelsToWebview();
    }

    getAgentProviderOptions(): AgentProviderOption[] {
        const providers: AgentProviderOption[] = [
            { value: 'local', label: '▫ Local' }
        ];

        if (this._copilotCliAvailability.available) {
            providers.push({ value: 'copilot-cli', label: '✦ Copilot CLI' });
        }

        return providers;
    }

    syncProvidersToWebview(): void {
        this.sendToWebview({
            type: 'setAgentProviders',
            providers: this.getAgentProviderOptions(),
            activeProvider: this.activeProvider,
        });
    }

    /**
     * Re-check whether the Copilot CLI is available.
     * If it becomes unavailable while active, falls back to local.
     * @param onFallback Called if provider had to fall back to local (e.g. to dispose runtime).
     */
    refreshAvailability(onFallback?: () => void): void {
        this._copilotCliAvailability = getCopilotCliAvailability();

        if (!this._copilotCliAvailability.available && this.activeProvider === 'copilot-cli') {
            this.activeProvider = 'local';
            onFallback?.();
            void updateSetting('agentProvider', 'local', vscode.ConfigurationTarget.Global);
        }

        this.syncProvidersToWebview();
        this.syncModelsToWebview();
    }

    /**
     * Switch the active model within the current provider.
     * @param onCopilotRuntimeInvalidated Called when a copilot CLI model change requires runtime restart.
     */
    async selectModel(deploymentId: string, onCopilotRuntimeInvalidated?: () => void): Promise<void> {
        if (!deploymentId) { return; }
        if (this.activeProvider === 'copilot-cli') {
            const newModel = deploymentId === '__copilot_cli_default__' ? '' : deploymentId;
            const oldModel = getSetting<string>('copilotCli.model') || '';
            await updateSetting('copilotCli.model', newModel, vscode.ConfigurationTarget.Global);
            this.syncModelsToWebview();
            if (newModel !== oldModel) {
                this.log(`Model changed from "${oldModel || '(default)'}" to "${newModel || '(default)'}" — restarting CLI runtime`);
                onCopilotRuntimeInvalidated?.();
            }
        } else {
            await updateSetting('azureOpenAI.activeDeployment', deploymentId, vscode.ConfigurationTarget.Global);
            this.syncModelsToWebview();
        }
    }

    /**
     * Switch the active agent provider.
     * @param onBeforeSwitch Called before the switch (e.g. to save the current session).
     * @returns true if the provider was switched.
     */
    async selectProvider(provider: AgentProvider, onBeforeSwitch: () => void): Promise<boolean> {
        this.refreshAvailability();

        if (provider === 'copilot-cli' && !this._copilotCliAvailability.available) {
            this.sendToWebview({
                type: 'error',
                message: this._copilotCliAvailability.reason || 'Copilot CLI is not available in this environment.'
            });
            this.syncProvidersToWebview();
            return false;
        }

        if (provider === this.activeProvider) { return false; }
        this.log(`Switching agent provider: ${this.activeProvider} → ${provider}`);

        onBeforeSwitch();

        this.activeProvider = provider;
        await updateSetting('agentProvider', provider, vscode.ConfigurationTarget.Global);
        this.sendToWebview({ type: 'setAgentProvider', provider });
        this.syncModelsToWebview();
        return true;
    }
}
