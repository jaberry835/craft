import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { McpClient } from './mcpClient';
import { ChatViewProvider } from './chatViewProvider';
import { SessionManager } from './sessionManager';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { TokenTracker } from './tokenTracker';
import { registerCommands } from './commandRegistrar';

let chatViewProvider: ChatViewProvider;
let mcpClient: McpClient;
export const outputChannel = vscode.window.createOutputChannel('JuniorGH');

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function log(msg: string, level: LogLevel = 'INFO') {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] [${level}] ${msg}`);
}

function logWarn(msg: string) { log(msg, 'WARN'); }
function logError(msg: string) { log(msg, 'ERROR'); }

export function activate(context: vscode.ExtensionContext) {
    log('JuniorGH extension activating...');
    const aoaiClient = new AzureOpenAIClient();
    aoaiClient.setSecretStorage(context.secrets);
    const workspaceIndexer = new WorkspaceIndexer();
    const symbolIndexer = new SymbolIndexer();
    const semanticIndexer = new SemanticIndexer();

    // Set up persistent index storage under globalStorage
    const indexStorageDir = vscode.Uri.joinPath(context.globalStorageUri, 'index').fsPath;
    workspaceIndexer.setStoragePath(indexStorageDir);
    semanticIndexer.setStoragePath(indexStorageDir);

    mcpClient = new McpClient();
    const sessionStorageDir = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'sessions').fsPath;
    const sessionManager = new SessionManager(sessionStorageDir, context.workspaceState);
    const tokenTracker = new TokenTracker(log);

    chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        sessionManager,
        log,
        tokenTracker,
        mcpClient
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'juniorgh.chatView',
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    const inlineProvider = new InlineCompletionProvider(aoaiClient, log, tokenTracker);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider)
    );
    context.subscriptions.push({ dispose: () => inlineProvider.dispose() });

    registerCommands({
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
    });
    context.subscriptions.push({ dispose: () => tokenTracker.dispose() });

    // ── Auto-start ──

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

    mcpClient.connectConfiguredServers().catch((e) => logError(`MCP connect failed: ${e}`));

    if (vscode.workspace.workspaceFolders) {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');

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

    log('JuniorGH extension activated successfully.');
}

export function deactivate() {
    try {
        chatViewProvider?.saveCurrentSession();
    } catch {
        // Best-effort — extension host may be shutting down
    }
    try {
        mcpClient?.dispose();
    } catch {
        // Best-effort — extension host may be shutting down
    }
}
