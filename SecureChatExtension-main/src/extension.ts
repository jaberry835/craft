import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { ChatViewProvider } from './chatViewProvider';
import { SessionManager } from './sessionManager';

let chatViewProvider: ChatViewProvider;
let mcpClient: McpClient;
export const outputChannel = vscode.window.createOutputChannel('SecureChat');

function log(msg: string) {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] ${msg}`);
}

export function activate(context: vscode.ExtensionContext) {
    log('SecureChat extension activating...');
    const aoaiClient = new AzureOpenAIClient();
    const workspaceIndexer = new WorkspaceIndexer();
    const builtinTools = new BuiltinTools(workspaceIndexer);
    mcpClient = new McpClient();
    const sessionManager = new SessionManager(context.globalState);

    chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        aoaiClient,
        builtinTools,
        mcpClient,
        sessionManager,
        log
    );

    // Register the webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'securechat.chatView',
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ── Commands ──

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.openChat', () => {
            vscode.commands.executeCommand('securechat.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.newSession', () => {
            chatViewProvider.newSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.cancelAgent', () => {
            chatViewProvider.cancelAgent();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.indexWorkspace', async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'SecureChat: Indexing workspace...',
                    cancellable: true
                },
                async (progress, token) => {
                    await workspaceIndexer.indexWorkspace(progress, token);
                    vscode.window.showInformationMessage(
                        `SecureChat: Indexed ${workspaceIndexer.getFileCount()} files.`
                    );
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.selectModel', async () => {
            try {
                log('selectModel command invoked');
                const config = vscode.workspace.getConfiguration('securechat.azureOpenAI');
                const deployments = config.get<Array<{ name: string; deploymentId: string; apiVersion?: string }>>('deployments') || [];
                log(`Found ${deployments.length} deployments: ${JSON.stringify(deployments)}`);

                if (deployments.length === 0) {
                    const action = await vscode.window.showWarningMessage(
                        'No deployments configured. Add deployments in Settings.',
                        'Open Settings'
                    );
                    if (action === 'Open Settings') {
                        vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'securechat.azureOpenAI.deployments'
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
                    await config.update('activeDeployment', picked.deploymentId, vscode.ConfigurationTarget.Global);
                    chatViewProvider.notifyModelChanged(picked.label);
                    vscode.window.showInformationMessage(`SecureChat: Switched to ${picked.label}`);
                } else {
                    log('QuickPick dismissed without selection');
                }
            } catch (err: any) {
                log(`selectModel error: ${err.message}\n${err.stack}`);
                vscode.window.showErrorMessage(`SecureChat: Select Model failed — ${err.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.manageMcpServers', async () => {
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
                vscode.window.showInformationMessage(`SecureChat: ${mcpClient.getToolCount()} MCP tools available.`);
            } else if (pick.label.includes('Disconnect All')) {
                mcpClient.disconnectAll();
                vscode.window.showInformationMessage('SecureChat: All MCP servers disconnected.');
            } else {
                const name = pick.label.replace('$(debug-disconnect) Disconnect: ', '');
                mcpClient.disconnectServer(name);
                vscode.window.showInformationMessage(`SecureChat: Disconnected ${name}.`);
            }
        })
    );

    // Context menu commands
    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.explainSelection', () => {
            sendSelectionToChat('Explain this code in detail:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.reviewSelection', () => {
            sendSelectionToChat('Review this code for bugs, security issues, and improvements:\n\n');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('securechat.fixSelection', () => {
            sendSelectionToChat('Fix any issues in this code and explain what was wrong:\n\n');
        })
    );

    // ── Auto-start ──

    // Index workspace on activation
    if (vscode.workspace.workspaceFolders) {
        workspaceIndexer.indexWorkspace().catch((e) => log(`Workspace indexing failed: ${e}`));
    }

    // Connect MCP servers from settings
    mcpClient.connectConfiguredServers().catch((e) => log(`MCP connect failed: ${e}`));

    log('SecureChat extension activated successfully.');
}

function sendSelectionToChat(prefix: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const selection = editor.document.getText(editor.selection);
    const lang = editor.document.languageId;
    const file = vscode.workspace.asRelativePath(editor.document.uri);

    const message = `${prefix}\`\`\`${lang}\n// File: ${file}\n${selection}\n\`\`\``;
    chatViewProvider.sendMessageFromExtension(message);
    vscode.commands.executeCommand('securechat.chatView.focus');
}

export function deactivate() {
    mcpClient?.dispose();
}
