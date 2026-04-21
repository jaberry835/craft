import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { ChatViewProvider } from './chatViewProvider';
import { McpClient } from './mcpClient';
import { TokenTracker } from './tokenTracker';
import { getSetting, updateSetting } from './config';
import {
    AuthNamespace,
    getConfiguredAuthSource,
    getConfiguredScopes,
    getMsalConfig,
    resolveBearerToken,
} from './tokenResolver';
import {
    listMsalAccounts,
    signOutMsalAccount,
} from './msalAuthProvider';
import { storeCopilotCliApiKey, clearCopilotCliApiKey } from './copilotCliSecrets';

interface CommandRegistrarDeps {
    context: vscode.ExtensionContext;
    aoaiClient: AzureOpenAIClient;
    workspaceIndexer: WorkspaceIndexer;
    symbolIndexer: SymbolIndexer;
    semanticIndexer: SemanticIndexer;
    chatViewProvider: ChatViewProvider;
    mcpClient: McpClient;
    tokenTracker: TokenTracker;
    log: (msg: string) => void;
    logError: (msg: string) => void;
}

export function registerCommands(deps: CommandRegistrarDeps): void {
    const {
        context,
        aoaiClient,
        workspaceIndexer,
        symbolIndexer,
        semanticIndexer,
        chatViewProvider,
        mcpClient,
        tokenTracker,
        log,
        logError
    } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.openChat', () => {
            vscode.commands.executeCommand('junior.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.openChatTab', () => {
            chatViewProvider.openInTab();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.newSession', () => {
            chatViewProvider.newSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.toggleHistory', () => {
            chatViewProvider.toggleHistory();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.cancelAgent', () => {
            chatViewProvider.cancelAgent();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your Azure OpenAI API key',
                password: true,
                placeHolder: 'Paste API key here (stored securely in VS Code SecretStorage)'
            });
            if (key) {
                await aoaiClient.storeApiKey(key);
                vscode.window.showInformationMessage('API key stored securely. You can remove it from settings.json if present.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.setCopilotCliApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter the Copilot CLI BYOK provider API key',
                password: true,
                placeHolder: 'Paste API key here (stored securely in VS Code SecretStorage). Leave empty to clear.'
            });
            if (key === undefined) { return; } // user cancelled
            if (key === '') {
                await clearCopilotCliApiKey();
                vscode.window.showInformationMessage('Copilot CLI provider API key cleared.');
            } else {
                await storeCopilotCliApiKey(key);
                vscode.window.showInformationMessage('Copilot CLI provider API key stored securely. You can remove junior.copilotCli.providerApiKey from settings.json if present.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.signInAzureOpenAIBearer', async () => {
            await runSignInForNamespace({
                namespace: 'azureOpenAI',
                friendlyName: 'local Azure/APIM bearer mode',
                notConfiguredHelpSetting: 'junior.azureOpenAI.authMode',
                logError,
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.signInCopilotCliBearer', async () => {
            await runSignInForNamespace({
                namespace: 'copilotCli',
                friendlyName: 'Copilot CLI bearer mode',
                notConfiguredHelpSetting: 'junior.copilotCli.providerBearerTokenSource',
                logError,
                onSuccess: () => chatViewProvider.refreshProviderAvailability(),
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.msal.signIn', async () => {
            await runMsalSignInPicker(logError, () => chatViewProvider.refreshProviderAvailability());
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.msal.signOut', async () => {
            await runMsalSignOutPicker(logError, () => chatViewProvider.refreshProviderAvailability());
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.msal.showAccounts', async () => {
            await runMsalShowAccounts(logError);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.indexWorkspace', async () => {
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Junior: Indexing workspace...',
                        cancellable: true
                    },
                    async (progress, token) => {
                        await workspaceIndexer.indexWorkspace(progress, token);
                        const changed = workspaceIndexer.getChangedFiles();
                        progress.report({ message: 'Indexing symbols...' });
                        await symbolIndexer.indexWorkspace(workspaceIndexer, progress, token);
                        progress.report({ message: 'Indexing semantic chunks...' });
                        await semanticIndexer.indexWorkspace(workspaceIndexer, progress, token, changed);
                        vscode.window.showInformationMessage(
                            `Junior: Indexed ${workspaceIndexer.getFileCount()} files, ${symbolIndexer.getSymbolFileCount()} symbol files, ${semanticIndexer.getChunkCount()} semantic chunks.`
                        );
                    }
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`indexWorkspace error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`Junior: Indexing failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.selectModel', async () => {
            try {
                log('selectModel command invoked');

                const deployments = getSetting<Array<{ name: string; deploymentId: string; apiVersion?: string }>>('azureOpenAI.deployments') || [];
                log(`Found ${deployments.length} deployments: ${JSON.stringify(deployments)}`);

                if (deployments.length === 0) {
                    const action = await vscode.window.showWarningMessage(
                        'No deployments configured. Add deployments in Settings.',
                        'Open Settings'
                    );
                    if (action === 'Open Settings') {
                        vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'junior.azureOpenAI.deployments'
                        );
                    }
                    return;
                }

                const items = deployments.map(d => ({
                    label: d.name || d.deploymentId,
                    description: d.deploymentId,
                    deploymentId: d.deploymentId
                }));
                log(`Showing QuickPick with items: ${JSON.stringify(items.map(i => i.label))}`);

                const picked = await vscode.window.showQuickPick(
                    items,
                    { placeHolder: 'Select a model deployment' }
                );

                if (picked) {
                    log(`User picked: ${picked.label} (${picked.deploymentId})`);
                    await updateSetting('azureOpenAI.activeDeployment', picked.deploymentId, vscode.ConfigurationTarget.Global);
                    chatViewProvider.notifyModelChanged(picked.label);
                    vscode.window.showInformationMessage(`Junior: Switched to ${picked.label}`);
                } else {
                    log('QuickPick dismissed without selection');
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`selectModel error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`Junior: Select Model failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.manageMcpServers', async () => {
            try {
                const connected = mcpClient.getConnectedServers();
                const items: vscode.QuickPickItem[] = [
                    { label: '$(add) Connect All Configured Servers', description: 'Read from settings and connect' },
                    { label: '$(close-all) Disconnect All', description: `${connected.length} connected` },
                    ...connected.map(name => ({ label: `$(debug-disconnect) Disconnect: ${name}`, description: 'Running' }))
                ];
                const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Manage MCP Servers' });
                if (!pick) { return; }
                if (pick.label.includes('Connect All')) {
                    await mcpClient.connectConfiguredServers();
                    vscode.window.showInformationMessage(`Junior: ${mcpClient.getToolCount()} MCP tools available.`);
                } else if (pick.label.includes('Disconnect All')) {
                    mcpClient.disconnectAll();
                    vscode.window.showInformationMessage('Junior: All MCP servers disconnected.');
                } else {
                    const name = pick.label.replace('$(debug-disconnect) Disconnect: ', '');
                    mcpClient.disconnectServer(name);
                    vscode.window.showInformationMessage(`Junior: Disconnected ${name}.`);
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`manageMcpServers error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`Junior: MCP server operation failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.triggerInlineCompletion', () => {
            vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.showTokenUsage', () => {
            tokenTracker.showDetailedUsage();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.resetTokenUsage', () => {
            tokenTracker.reset();
            vscode.window.showInformationMessage('Junior: Token usage counters reset.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.explainSelection', () => {
            sendSelectionToChat(chatViewProvider, 'Explain this code in detail:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.reviewSelection', () => {
            sendSelectionToChat(chatViewProvider, 'Review this code for bugs, security issues, and improvements:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.fixSelection', () => {
            sendSelectionToChat(chatViewProvider, 'Fix any issues in this code and explain what was wrong:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.showWelcome', () => {
            vscode.commands.executeCommand('junior.chatView.focus');
            chatViewProvider.showSplash();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.selectAgentProvider', async () => {
            const providerOptions = chatViewProvider.getAvailableAgentProviderOptions();
            const pick = await vscode.window.showQuickPick(
                providerOptions.map(option => ({
                    label: option.value === 'local' ? '$(server) Local' : '$(terminal) Copilot CLI',
                    description: option.value === 'local'
                        ? 'Built-in Azure OpenAI agent loop'
                        : 'GitHub Copilot CLI via SDK',
                    value: option.value,
                })),
                { placeHolder: 'Select agent provider' }
            );
            if (pick) {
                chatViewProvider.setAgentProvider(pick.value);
            }
        })
    );
}

function sendSelectionToChat(chatViewProvider: ChatViewProvider, prefix: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const selection = editor.document.getText(editor.selection);
    const lang = editor.document.languageId;
    const file = vscode.workspace.asRelativePath(editor.document.uri);

    const message = `${prefix}\`\`\`${lang}\n// File: ${file}\n${selection}\n\`\`\``;
    chatViewProvider.sendMessageFromExtension(message);
    vscode.commands.executeCommand('junior.chatView.focus');
}

interface SignInForNamespaceOptions {
    namespace: AuthNamespace;
    friendlyName: string;
    notConfiguredHelpSetting: string;
    logError: (msg: string) => void;
    onSuccess?: () => void;
}

/**
 * Drives the unified sign-in flow for a namespace. Routes through MSAL or
 * vscode-auth-session depending on the user's configured `authMode` /
 * `providerBearerTokenSource`.
 */
async function runSignInForNamespace(opts: SignInForNamespaceOptions): Promise<void> {
    const source = getConfiguredAuthSource(opts.namespace);
    if (!source) {
        const action = await vscode.window.showWarningMessage(
            `${capitalize(opts.friendlyName)} is not enabled. Set ${opts.notConfiguredHelpSetting} to "vscode-auth-session" or "msal" first.`,
            'Open Settings'
        );
        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', opts.notConfiguredHelpSetting);
        }
        return;
    }

    if (source === 'msal' && !getMsalConfig()) {
        const action = await vscode.window.showWarningMessage(
            `MSAL is selected for ${opts.friendlyName} but junior.msal.clientId is not set.`,
            'Open Settings'
        );
        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.msal');
        }
        return;
    }

    const scopes = getConfiguredScopes(opts.namespace);
    if (scopes.length === 0) {
        const settingKey = opts.namespace === 'azureOpenAI'
            ? 'junior.azureOpenAI.authScopes'
            : 'junior.copilotCli.providerAuthScopes';
        const action = await vscode.window.showWarningMessage(
            `No scopes are configured for ${opts.friendlyName}. Set ${settingKey} to at least one scope (e.g. "https://cognitiveservices.azure.com/.default").`,
            'Open Settings'
        );
        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', settingKey);
        }
        return;
    }

    try {
        const resolved = await resolveBearerToken(opts.namespace, { interactive: true, forceRefresh: true });
        if (!resolved) {
            return;
        }
        const detail = resolved.source === 'msal'
            ? `MSAL (${resolved.authority})`
            : `VS Code (${resolved.source})`;
        vscode.window.showInformationMessage(
            `Junior: Signed in for ${opts.friendlyName} as ${resolved.accountLabel ?? 'unknown user'} via ${detail}.`
        );
        opts.onSuccess?.();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        opts.logError(`signIn[${opts.namespace}] error: ${message}\n${stack}`);
        vscode.window.showErrorMessage(`Junior: ${capitalize(opts.friendlyName)} sign-in failed — ${message}`);
    }
}

/**
 * Generic "Junior: MSAL Sign In" command — picks scopes from whichever
 * namespace is configured for MSAL, or asks the user when both are.
 */
async function runMsalSignInPicker(
    logError: (msg: string) => void,
    onSuccess?: () => void,
): Promise<void> {
    const msalConfig = getMsalConfig();
    if (!msalConfig) {
        const action = await vscode.window.showWarningMessage(
            'MSAL is not configured. Set junior.msal.clientId and junior.msal.tenantId first.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.msal');
        }
        return;
    }

    const candidates: AuthNamespace[] = [];
    if (getConfiguredAuthSource('azureOpenAI') === 'msal') { candidates.push('azureOpenAI'); }
    if (getConfiguredAuthSource('copilotCli') === 'msal') { candidates.push('copilotCli'); }

    if (candidates.length === 0) {
        const action = await vscode.window.showWarningMessage(
            'No Junior namespace is configured to use MSAL. Set junior.azureOpenAI.authMode = "msal" or junior.copilotCli.providerBearerTokenSource = "msal".',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.azureOpenAI.authMode');
        }
        return;
    }

    let target: AuthNamespace;
    if (candidates.length === 1) {
        target = candidates[0];
    } else {
        const pick = await vscode.window.showQuickPick(
            candidates.map(c => ({
                label: c === 'azureOpenAI' ? 'Local Azure / APIM bearer mode' : 'Copilot CLI BYOK bearer mode',
                value: c,
            })),
            { placeHolder: 'Both namespaces use MSAL — choose which set of scopes to sign in for' }
        );
        if (!pick) { return; }
        target = pick.value;
    }

    await runSignInForNamespace({
        namespace: target,
        friendlyName: target === 'azureOpenAI' ? 'local Azure/APIM bearer mode' : 'Copilot CLI bearer mode',
        notConfiguredHelpSetting: target === 'azureOpenAI' ? 'junior.azureOpenAI.authMode' : 'junior.copilotCli.providerBearerTokenSource',
        logError,
        onSuccess,
    });
}

/**
 * "Junior: MSAL Sign Out" — lists accounts in the cache and removes the
 * picked one. Does not revoke tokens server-side.
 */
async function runMsalSignOutPicker(
    logError: (msg: string) => void,
    onSuccess?: () => void,
): Promise<void> {
    const msalConfig = getMsalConfig();
    if (!msalConfig) {
        vscode.window.showInformationMessage('Junior: MSAL is not configured.');
        return;
    }

    try {
        const accounts = await listMsalAccounts(msalConfig);
        if (accounts.length === 0) {
            vscode.window.showInformationMessage('Junior: No MSAL accounts are signed in.');
            return;
        }

        const pick = await vscode.window.showQuickPick(
            accounts.map(a => ({
                label: a.username,
                description: a.tenantId,
                detail: a.environment,
                value: a.homeAccountId,
            })),
            { placeHolder: 'Select an MSAL account to sign out' }
        );
        if (!pick) { return; }

        const removed = await signOutMsalAccount(msalConfig, pick.value);
        if (removed) {
            vscode.window.showInformationMessage(`Junior: Signed out MSAL account ${pick.label}.`);
            onSuccess?.();
        } else {
            vscode.window.showWarningMessage(`Junior: Could not find MSAL account ${pick.label}.`);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        logError(`msalSignOut error: ${message}\n${stack}`);
        vscode.window.showErrorMessage(`Junior: MSAL sign-out failed — ${message}`);
    }
}

/** "Junior: Show MSAL Accounts" — read-only diagnostic view. */
async function runMsalShowAccounts(logError: (msg: string) => void): Promise<void> {
    const msalConfig = getMsalConfig();
    if (!msalConfig) {
        vscode.window.showInformationMessage('Junior: MSAL is not configured.');
        return;
    }

    try {
        const accounts = await listMsalAccounts(msalConfig);
        if (accounts.length === 0) {
            vscode.window.showInformationMessage('Junior: No MSAL accounts are currently signed in.');
            return;
        }
        const summary = accounts
            .map(a => `${a.username}  (tenant=${a.tenantId}, env=${a.environment ?? 'unknown'})`)
            .join('\n');
        await vscode.window.showInformationMessage(
            `Junior MSAL accounts (${accounts.length}):\n${summary}`,
            { modal: true }
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        logError(`msalShowAccounts error: ${message}\n${stack}`);
        vscode.window.showErrorMessage(`Junior: Listing MSAL accounts failed — ${message}`);
    }
}

function capitalize(text: string): string {
    if (!text) { return text; }
    return text.charAt(0).toUpperCase() + text.slice(1);
}
