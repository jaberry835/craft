import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { ChatViewProvider } from './chatViewProvider';
import { McpClient } from './mcpClient';
import { TokenTracker } from './tokenTracker';
import { getSetting, updateSetting } from './config';

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
        vscode.commands.registerCommand('juniorgh.openChat', () => {
            vscode.commands.executeCommand('juniorgh.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.openChatTab', () => {
            chatViewProvider.openInTab();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.newSession', () => {
            chatViewProvider.newSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.toggleHistory', () => {
            chatViewProvider.toggleHistory();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.cancelAgent', () => {
            chatViewProvider.cancelAgent();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.setApiKey', async () => {
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
        vscode.commands.registerCommand('juniorgh.indexWorkspace', async () => {
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'JuniorGH: Indexing workspace...',
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
                            `JuniorGH: Indexed ${workspaceIndexer.getFileCount()} files, ${symbolIndexer.getSymbolFileCount()} symbol files, ${semanticIndexer.getChunkCount()} semantic chunks.`
                        );
                    }
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`indexWorkspace error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`JuniorGH: Indexing failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.selectModel', async () => {
            try {
                log('selectModel command invoked');

                const currentModel = getSetting<string>('copilotCli.model') || '';
                const configuredModels = getSetting<Array<{ name: string; id: string }>>('copilotCli.models') || [];

                // Build QuickPick items from the configured models list
                const items: (vscode.QuickPickItem & { modelId: string })[] = configuredModels.map(m => ({
                    label: m.name || m.id || 'Unnamed',
                    description: m.id || '(Copilot default)',
                    modelId: m.id || '',
                    picked: (m.id || '') === currentModel
                }));

                // Add a "Custom..." option at the end for manual entry
                items.push({
                    label: '$(edit) Enter custom model name...',
                    description: '',
                    modelId: '__custom__'
                });

                // Mark the active model
                const activeItem = items.find(i => i.modelId === currentModel);
                if (activeItem && activeItem.modelId !== '__custom__') {
                    activeItem.description = (activeItem.description || '') + '  $(check) active';
                }

                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: currentModel
                        ? `Current model: ${currentModel}  —  Select a model`
                        : 'Select a model (currently using Copilot CLI default)'
                });

                if (!pick) {
                    log('Model picker dismissed without selection');
                    return;
                }

                let selectedModel = pick.modelId;

                if (selectedModel === '__custom__') {
                    const model = await vscode.window.showInputBox({
                        prompt: 'Enter the Copilot CLI model name',
                        value: currentModel,
                        placeHolder: 'For example: claude-sonnet-4.6'
                    });
                    if (model === undefined) {
                        log('Custom model input dismissed');
                        return;
                    }
                    selectedModel = model.trim();
                }

                await updateSetting('copilotCli.model', selectedModel, vscode.ConfigurationTarget.Global);
                const displayName = pick.modelId === '__custom__'
                    ? (selectedModel || 'Copilot CLI default')
                    : (pick.label || selectedModel || 'Copilot CLI default');
                chatViewProvider.notifyModelChanged(displayName);
                vscode.window.showInformationMessage(
                    selectedModel
                        ? `JuniorGH: Model set to ${displayName}`
                        : 'JuniorGH: Using the Copilot CLI default model.'
                );
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`selectModel error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`JuniorGH: Select Model failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.manageMcpServers', async () => {
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
                    vscode.window.showInformationMessage(`JuniorGH: ${mcpClient.getToolCount()} MCP tools available.`);
                } else if (pick.label.includes('Disconnect All')) {
                    mcpClient.disconnectAll();
                    vscode.window.showInformationMessage('JuniorGH: All MCP servers disconnected.');
                } else {
                    const name = pick.label.replace('$(debug-disconnect) Disconnect: ', '');
                    mcpClient.disconnectServer(name);
                    vscode.window.showInformationMessage(`JuniorGH: Disconnected ${name}.`);
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : '';
                logError(`manageMcpServers error: ${message}\n${stack}`);
                vscode.window.showErrorMessage(`JuniorGH: MCP server operation failed — ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.triggerInlineCompletion', () => {
            vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.showTokenUsage', () => {
            tokenTracker.showDetailedUsage();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.resetTokenUsage', () => {
            tokenTracker.reset();
            vscode.window.showInformationMessage('JuniorGH: Token usage counters reset.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.explainSelection', () => {
            sendSelectionToChat(chatViewProvider, 'Explain this code in detail:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.reviewSelection', () => {
            sendSelectionToChat(chatViewProvider, 'Review this code for bugs, security issues, and improvements:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('juniorgh.fixSelection', () => {
            sendSelectionToChat(chatViewProvider, 'Fix any issues in this code and explain what was wrong:\n\n');
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
    vscode.commands.executeCommand('juniorgh.chatView.focus');
}

