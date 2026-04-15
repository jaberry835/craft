import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { ChatViewProvider } from './chatViewProvider';
import { McpClient } from './mcpClient';
import { TokenTracker } from './tokenTracker';
import { getSetting, updateSetting } from './config';
import { getAzureOpenAIBearerAuthSessionConfig } from './aoaiClient';
import { getCopilotCliBearerAuthSessionConfig } from './copilotCliSupport';

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
        vscode.commands.registerCommand('junior.signInAzureOpenAIBearer', async () => {
            const authSessionConfig = getAzureOpenAIBearerAuthSessionConfig();
            if (!authSessionConfig) {
                const action = await vscode.window.showWarningMessage(
                    'Local Azure/APIM bearer sign-in is not enabled. Set Junior: Azure Openai Auth Mode to VS Code Auth Session first.',
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    await vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'junior.azureOpenAI.authMode'
                    );
                }
                return;
            }

            try {
                const session = await vscode.authentication.getSession(
                    authSessionConfig.providerId,
                    authSessionConfig.scopes,
                    { createIfNone: true }
                );

                if (!session) {
                    return;
                }

                vscode.window.showInformationMessage(
                    `Junior: Signed in to ${authSessionConfig.providerId} for local Azure/APIM bearer mode as ${session.account.label}.`
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`signInAzureOpenAIBearer error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`Junior: Azure/APIM bearer sign-in failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.signInCopilotCliBearer', async () => {
            const authSessionConfig = getCopilotCliBearerAuthSessionConfig();
            if (!authSessionConfig) {
                const action = await vscode.window.showWarningMessage(
                    'Copilot CLI bearer sign-in is not enabled. Set Junior: Copilot Cli Provider Bearer Token Source to VS Code Auth Session first.',
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    await vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'junior.copilotCli.providerBearerTokenSource'
                    );
                }
                return;
            }

            try {
                const session = await vscode.authentication.getSession(
                    authSessionConfig.providerId,
                    authSessionConfig.scopes,
                    { createIfNone: true }
                );

                if (!session) {
                    return;
                }

                chatViewProvider.refreshProviderAvailability();
                vscode.window.showInformationMessage(
                    `Junior: Signed in to ${authSessionConfig.providerId} for Copilot CLI bearer mode as ${session.account.label}.`
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`signInCopilotCliBearer error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`Junior: Copilot CLI bearer sign-in failed — ${message}`);
            }
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
