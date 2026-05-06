import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { WorkspaceIndexer } from './workspaceIndexer';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { ChatViewProvider } from './chatViewProvider';
import { SessionManager } from './sessionManager';
import { SymbolIndexer } from './symbolIndexer';
import { SemanticIndexer } from './semanticIndexer';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { TokenTracker } from './tokenTracker';
import { InlineDiffDecorator } from './inlineDiffDecorator';
import { registerCommands } from './commandRegistrar';
import { RetrievalRanker } from './retrievalRanker';
import { RepoPatternStore } from './repoPatternStore';
import { getCopilotCliBearerAuthSessionConfig, COPILOT_CLI_API_KEY_SECRET_KEY, setCopilotCliApiKeySecretCache } from './copilotCliSupport';
import { CustomAgentStore } from './customAgents';
import { CustomAgentEditor } from './customAgentEditor';
import { setNetworkLogger } from './network';

let chatViewProvider: ChatViewProvider;
let mcpClient: McpClient;
let workspaceIndexerRef: WorkspaceIndexer | undefined;
let symbolIndexerRef: SymbolIndexer | undefined;
let semanticIndexerRef: SemanticIndexer | undefined;
export const outputChannel = vscode.window.createOutputChannel('Junior');

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function log(msg: string, level: LogLevel = 'INFO') {
    const ts = new Date().toISOString();
    outputChannel.appendLine(`[${ts}] [${level}] ${msg}`);
}

function logWarn(msg: string) { log(msg, 'WARN'); }
function logError(msg: string) { log(msg, 'ERROR'); }

export function activate(context: vscode.ExtensionContext) {
    log('Junior extension activating...');
    setNetworkLogger((msg, level = 'INFO') => log(`[network] ${msg}`, level));
    const aoaiClient = new AzureOpenAIClient();
    aoaiClient.setSecretStorage(context.secrets);

    // Load the Copilot CLI provider API key from SecretStorage so sync
    // consumers (availability checks, BYOK config) can resolve it without
    // awaiting. Refresh the cache whenever the secret changes.
    void context.secrets.get(COPILOT_CLI_API_KEY_SECRET_KEY).then(value => {
        setCopilotCliApiKeySecretCache(value);
    });
    context.subscriptions.push(context.secrets.onDidChange(async (e) => {
        if (e.key === COPILOT_CLI_API_KEY_SECRET_KEY) {
            const value = await context.secrets.get(COPILOT_CLI_API_KEY_SECRET_KEY);
            setCopilotCliApiKeySecretCache(value);
        }
    }));
    const workspaceIndexer = new WorkspaceIndexer();
    const symbolIndexer = new SymbolIndexer();
    const semanticIndexer = new SemanticIndexer();
    workspaceIndexerRef = workspaceIndexer;
    symbolIndexerRef = symbolIndexer;
    semanticIndexerRef = semanticIndexer;

    // Set up persistent index storage under globalStorage
    const indexStorageDir = vscode.Uri.joinPath(context.globalStorageUri, 'index').fsPath;
    workspaceIndexer.setStoragePath(indexStorageDir);
    symbolIndexer.setStoragePath(indexStorageDir);
    semanticIndexer.setStoragePath(indexStorageDir);

    const builtinTools = new BuiltinTools(workspaceIndexer, symbolIndexer, semanticIndexer);
    const retrievalRanker = new RetrievalRanker(workspaceIndexer, symbolIndexer, semanticIndexer);
    mcpClient = new McpClient();
    const sessionStorageDir = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'sessions').fsPath;
    const repoMemoryDir = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'agent').fsPath;
    const sessionManager = new SessionManager(sessionStorageDir, context.workspaceState);
    const repoPatternStore = new RepoPatternStore(repoMemoryDir);
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
        retrievalRanker,
        repoPatternStore,
        sessionManager,
        log,
        tokenTracker,
        inlineDiffDecorator,
        context.globalState,
        CustomAgentStore.fromContext(context),
        context,
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'junior.chatView',
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

    // ── Custom Agents: command palette entry to open the editor ──
    const customAgentStore = CustomAgentStore.fromContext(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('junior.createCustomAgent', () => {
            void CustomAgentEditor.open(context, customAgentStore);
        })
    );

    // ── Auto-start: phased indexing ──
    // Phase 1 runs immediately: fast file index (stat-only, cached).
    // Phase 2 runs after a short yield: symbol + semantic indexing in background.
    // The agent is usable after Phase 1 — users can start chatting immediately.

    if (vscode.workspace.workspaceFolders) {
        const startMs = Date.now();
        (async () => {
            // ── Phase 1: file index (fast — stat-only with disk cache) ──
            log(`Starting workspace index (storage: ${indexStorageDir})...`);
            await workspaceIndexer.indexWorkspace();
            const changed = workspaceIndexer.getChangedFiles();
            const phase1Ms = Date.now() - startMs;
            log(`Phase 1 done in ${phase1Ms}ms: ${workspaceIndexer.getFileCount()} files, ${changed.size} changed. Agent ready.`);

            // ── Phase 2: symbol + semantic index (background, doesn't block chat) ──
            // Yield to the event loop so the webview can render and the user can interact.
            await new Promise(r => setTimeout(r, 100));

            const phase2Start = Date.now();
            log(`Phase 2: starting symbol + semantic index (${changed.size} files to re-index)...`);
            await symbolIndexer.indexWorkspace(workspaceIndexer, undefined, undefined, changed);
            await semanticIndexer.indexWorkspace(workspaceIndexer, undefined, undefined, changed);
            const phase2Ms = Date.now() - phase2Start;
            log(`Phase 2 done in ${phase2Ms}ms: ${symbolIndexer.getSymbolFileCount()} symbol files, ${semanticIndexer.getChunkCount()} semantic chunks. Total startup: ${Date.now() - startMs}ms.`);
        })().catch((e) => logError(`Workspace indexing failed: ${e}`));
    }

    mcpClient.connectConfiguredServers().catch((e) => logError(`MCP connect failed: ${e}`));

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('junior.copilotCli') || event.affectsConfiguration('junior.agentProvider')) {
                chatViewProvider.refreshProviderAvailability();
            }
        })
    );

    context.subscriptions.push(
        vscode.authentication.onDidChangeSessions((event) => {
            const authSessionConfig = getCopilotCliBearerAuthSessionConfig();
            if (!authSessionConfig || event.provider.id !== authSessionConfig.providerId) {
                return;
            }

            chatViewProvider.refreshProviderAvailability();
        })
    );

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

    log('Junior extension activated successfully.');
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
    // Flush any pending debounced cache writes so we don't lose recent incremental updates.
    try { workspaceIndexerRef?.dispose(); } catch { /* best-effort */ }
    try { symbolIndexerRef?.dispose(); } catch { /* best-effort */ }
    try { semanticIndexerRef?.dispose(); } catch { /* best-effort */ }
}
