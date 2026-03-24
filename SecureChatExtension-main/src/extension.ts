import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { ChatViewProvider } from './chatViewProvider';
import { SessionManager } from './sessionManager';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { getSetting, updateSetting } from './config';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { TokenTracker } from './tokenTracker';
import { InlineDiffDecorator } from './inlineDiffDecorator';

let chatViewProvider: ChatViewProvider;
let mcpClient: McpClient;
export const outputChannel = vscode.window.createOutputChannel('Junior');

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function log(msg: string, level: LogLevel = 'INFO') {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] [${level}] ${msg}`);
}

function logInfo(msg: string) { log(msg, 'INFO'); }
function logWarn(msg: string) { log(msg, 'WARN'); }
function logError(msg: string) { log(msg, 'ERROR'); }

export function activate(context: vscode.ExtensionContext) {
    log('Junior extension activating...');
    const aoaiClient = new AzureOpenAIClient();
    aoaiClient.setSecretStorage(context.secrets);
    const workspaceIndexer = new WorkspaceIndexer();
    const symbolIndexer = new SymbolIndexer();
    const semanticIndexer = new SemanticIndexer();

    // Set up persistent index storage under globalStorage
    const indexStorageDir = vscode.Uri.joinPath(context.globalStorageUri, 'index').fsPath;
    workspaceIndexer.setStoragePath(indexStorageDir);
    semanticIndexer.setStoragePath(indexStorageDir);

    const builtinTools = new BuiltinTools(workspaceIndexer, symbolIndexer, semanticIndexer);
    mcpClient = new McpClient();
    const sessionStorageDir = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'sessions').fsPath;
    const sessionManager = new SessionManager(sessionStorageDir, context.workspaceState);
    const tokenTracker = new TokenTracker(log);

    // ── Inline Diff Decorator ──
    const inlineDiffDecorator = new InlineDiffDecorator();

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineDiffDecorator)
    );
    context.subscriptions.push({ dispose: () => inlineDiffDecorator.dispose() });

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.inlineDiff.acceptHunk', (fsPath: string, hunkIndex: number) => {
            inlineDiffDecorator.acceptHunk(fsPath, hunkIndex);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('junior.inlineDiff.rejectHunk', async (fsPath: string, hunkIndex: number) => {
            await inlineDiffDecorator.rejectHunk(fsPath, hunkIndex);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('junior.inlineDiff.acceptFile', (fsPath: string) => {
            inlineDiffDecorator.acceptFile(fsPath);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('junior.inlineDiff.rejectFile', async (fsPath: string) => {
            await inlineDiffDecorator.rejectFile(fsPath);
        })
    );

    chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        aoaiClient,
        builtinTools,
        mcpClient,
        sessionManager,
        log,
        tokenTracker,
        inlineDiffDecorator
    );

    // Register the webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'junior.chatView',
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ── Commands ──

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
            } catch (err: any) {
                logError(`indexWorkspace error: ${err.message}\n${err.stack}`);
                vscode.window.showErrorMessage(`Junior: Indexing failed — ${err.message}`);
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
                    { placeHolder: 'Select an Azure OpenAI model deployment' }
                );

                if (picked) {
                    log(`User picked: ${picked.label} (${picked.deploymentId})`);
                    await updateSetting('azureOpenAI.activeDeployment', picked.deploymentId, vscode.ConfigurationTarget.Global);
                    chatViewProvider.notifyModelChanged(picked.label);
                    vscode.window.showInformationMessage(`Junior: Switched to ${picked.label}`);
                } else {
                    log('QuickPick dismissed without selection');
                }
            } catch (err: any) {
                logError(`selectModel error: ${err.message}\n${err.stack}`);
                vscode.window.showErrorMessage(`Junior: Select Model failed — ${err.message}`);
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
            } catch (err: any) {
                logError(`manageMcpServers error: ${err.message}\n${err.stack}`);
                vscode.window.showErrorMessage(`Junior: MCP server operation failed — ${err.message}`);
            }
        })
    );

    // ── Inline Completions ──

    const inlineProvider = new InlineCompletionProvider(aoaiClient, log, tokenTracker);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
    );
    context.subscriptions.push({ dispose: () => inlineProvider.dispose() });

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.triggerInlineCompletion', () => {
            vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        })
    );

    // Token usage commands
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
    context.subscriptions.push({ dispose: () => tokenTracker.dispose() });

    // Context menu commands
    context.subscriptions.push(
        vscode.commands.registerCommand('junior.explainSelection', () => {
            sendSelectionToChat('Explain this code in detail:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.reviewSelection', () => {
            sendSelectionToChat('Review this code for bugs, security issues, and improvements:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('junior.fixSelection', () => {
            sendSelectionToChat('Fix any issues in this code and explain what was wrong:\n\n');
        })
    );

    // ── Auto-start ──

    // Index workspace on activation
    if (vscode.workspace.workspaceFolders) {
        (async () => {
            log(`Starting workspace index (storage: ${indexStorageDir})...`);
            await workspaceIndexer.indexWorkspace();
            const changed = workspaceIndexer.getChangedFiles();
            log(`File index done: ${workspaceIndexer.getFileCount()} files, ${changed.size} changed. Starting symbol + semantic index...`);
            await symbolIndexer.indexWorkspace(workspaceIndexer);
            await semanticIndexer.indexWorkspace(workspaceIndexer, undefined, undefined, changed);
            log(`Index loaded: ${workspaceIndexer.getFileCount()} files (${changed.size} changed), ${semanticIndexer.getChunkCount()} semantic chunks.`);
        })().catch((e) => logError(`Workspace/symbol/semantic indexing failed: ${e}`));
    }

    // Connect MCP servers from settings
    mcpClient.connectConfiguredServers().catch((e) => logError(`MCP connect failed: ${e}`));

    // ── File watchers for incremental indexing ──
    if (vscode.workspace.workspaceFolders) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');

        // Debounce: collect changed URIs and flush periodically
        let pendingUpdates = new Set<string>();
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;

        const scheduleFlush = () => {
            if (debounceTimer) { return; }
            debounceTimer = setTimeout(async () => {
                debounceTimer = undefined;
                const uris = [...pendingUpdates];
                pendingUpdates.clear();
                for (const fsPath of uris) {
                    const uri = vscode.Uri.file(fsPath);
                    const relPath = vscode.workspace.asRelativePath(uri, false);
                    try {
                        const changed = await workspaceIndexer.updateFile(uri);
                        if (changed) {
                            await symbolIndexer.indexFile(uri, relPath);
                            await semanticIndexer.reindexFile(uri, relPath);
                        }
                    } catch (e) {
                        logWarn(`Incremental index failed for ${relPath}: ${e}`);
                    }
                }
            }, 1500);
        };

        const onFileChanged = (uri: vscode.Uri) => {
            pendingUpdates.add(uri.fsPath);
            scheduleFlush();
        };

        watcher.onDidChange(onFileChanged);
        watcher.onDidCreate(onFileChanged);
        watcher.onDidDelete((uri) => {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            workspaceIndexer.removeFile(uri);
            symbolIndexer.removeFile(relPath);
            semanticIndexer.removeFile(relPath);
        });

        context.subscriptions.push(watcher);
    }

    log('Junior extension activated successfully.');
}

function sendSelectionToChat(prefix: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const selection = editor.document.getText(editor.selection);
    const lang = editor.document.languageId;
    const file = vscode.workspace.asRelativePath(editor.document.uri);

    const message = `${prefix}\`\`\`${lang}\n// File: ${file}\n${selection}\n\`\`\``;
    chatViewProvider.sendMessageFromExtension(message);
    vscode.commands.executeCommand('junior.chatView.focus');
}

export function deactivate() {
    try {
        chatViewProvider?.saveCurrentSession();
    } catch (e) {
        // Best-effort — extension host may be shutting down
    }
    try {
        mcpClient?.dispose();
    } catch (e) {
        // Best-effort — extension host may be shutting down
    }
}



