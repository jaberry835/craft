/**
 * Inline completion provider — delivers ghost-text code suggestions
 * using the configured Azure OpenAI deployment.
 *
 * Features beyond the Phase 1 MVP:
 * - Single-line vs multi-line detection (adjusts maxTokens & prompt)
 * - Cooldown after dismissed suggestions (reduces API waste)
 * - Neighboring-tab context (open editors inform the model)
 * - Smart suppression in comments
 * - Hard request timeout
 * - Type-ahead cache reuse (instant completions when user types into a suggestion)
 * - Status bar indicator (spinner while fetching)
 * - Manual trigger (Alt+\) bypasses cooldown
 * - Multi-candidate cycling (Alt+] / Alt+[)
 */
import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { AoaiResponsesClient } from './aoaiResponsesClient';
import { getSetting } from './config';
import { TokenTracker } from './tokenTracker';

// ── Tuning constants ──
const MAX_PREFIX_CHARS = 8000;
const MAX_SUFFIX_CHARS = 2000;
const MAX_NEIGHBOR_CHARS = 2000;   // per neighbor tab
const MAX_NEIGHBORS = 3;
const DEBOUNCE_MS = 150;
const DEFAULT_TIMEOUT_MS = 5000;
// Responses API often takes longer (server-side reasoning, larger SSE preamble),
// so give it more headroom by default. Users can still override via
// junior.inlineCompletions.timeoutMs.
const DEFAULT_TIMEOUT_MS_RESPONSES = 15000;
const COOLDOWN_MS = 2500;
const SINGLE_LINE_TOKENS = 64;
const MULTI_LINE_TOKENS = 256;

// ── Prompts ──
const SYSTEM_PROMPT =
    'You are a code completion engine. ' +
    'Output ONLY the code that continues from the cursor position. ' +
    'Do not repeat the prefix. Do not include markdown fences, explanations, or comments about the completion. ' +
    'If there is a suffix, make sure the completion logically connects to it. ' +
    'Output nothing if no useful completion exists.';

const SINGLE_LINE_HINT = ' Complete only the current line — do not add newlines.';

// ── Comment detection heuristic ──
const COMMENT_PREFIXES: Record<string, string[]> = {
    javascript: ['//', '/*', '*'],
    typescript: ['//', '/*', '*'],
    typescriptreact: ['//', '/*', '*'],
    javascriptreact: ['//', '/*', '*'],
    python: ['#', '"""', "'''"],
    ruby: ['#'],
    shellscript: ['#'],
    yaml: ['#'],
    csharp: ['//', '/*', '*', '///'],
    java: ['//', '/*', '*'],
    c: ['//', '/*', '*'],
    cpp: ['//', '/*', '*'],
    go: ['//', '/*', '*'],
    rust: ['//', '/*', '*'],
    html: ['<!--'],
    css: ['/*', '*'],
    scss: ['//', '/*', '*'],
    sql: ['--'],
    lua: ['--'],
    powershell: ['#'],
};

// Temperature offsets for multi-candidate diversity
const CANDIDATE_TEMP_OFFSETS = [0, 0.3, 0.5];

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private pendingAbort: AbortController | undefined;

    // Exact-match cache
    private lastRequestKey: string | undefined;
    private lastResult: vscode.InlineCompletionItem[] | undefined;

    // Type-ahead cache — lets us serve the remaining tail instantly
    private lastCompletionText: string | undefined;
    private lastCompletionUri: string | undefined;
    private lastCompletionOffset: number | undefined;

    // Cooldown tracking
    private lastSuggestionTime = 0;
    private suggestionWasConsumed = false;

    // Status bar
    private readonly statusBar: vscode.StatusBarItem;

    // Lazy responses-API client (used when junior.azureOpenAI.wireApi === 'responses')
    private responsesClient: AoaiResponsesClient | undefined;

    constructor(
        private readonly aoaiClient: AzureOpenAIClient,
        private readonly log: (msg: string) => void,
        private readonly tokenTracker?: TokenTracker
    ) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBar.command = 'junior.triggerInlineCompletion';
        this.setStatusIdle();
        this.statusBar.show();
    }

    private setStatusIdle() {
        this.statusBar.text = '$(sparkle) Junior';
        this.statusBar.tooltip = 'Junior inline completions — click or Alt+\\ to trigger';
    }

    private setStatusFetching() {
        this.statusBar.text = '$(loading~spin) Junior';
        this.statusBar.tooltip = 'Junior: fetching completion…';
    }

    // ── Main entry point ──

    provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlineCompletionList> {
        // Gate: feature toggle
        if (!getSetting<boolean>('inlineCompletions.enabled')) {
            return;
        }

        const manualTrigger = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

        // Gate: skip very large files (>500 KB)
        if (document.getText().length > 500_000) {
            return;
        }

        // Gate: skip when IntelliSense completion widget is active (unless manually triggered)
        if (context.selectedCompletionInfo && !manualTrigger) {
            return;
        }

        // Gate: smart suppression — skip when cursor is in a comment (unless manually triggered)
        if (this.isInComment(document, position) && !manualTrigger) {
            return;
        }

        // ── Type-ahead cache reuse ──
        const typeAhead = this.tryTypeAheadReuse(document, position);
        if (typeAhead) {
            return new vscode.InlineCompletionList(typeAhead);
        }

        // ── Exact-match cache ──
        const requestKey = `${document.uri.toString()}:${document.version}:${position.line}:${position.character}`;
        if (requestKey === this.lastRequestKey && this.lastResult) {
            return new vscode.InlineCompletionList(this.lastResult);
        }

        // Cancel any in-flight request
        this.cancelPending();

        // ── Cooldown after dismissed suggestion ──
        // Manual triggers always bypass cooldown
        let effectiveDebounce = DEBOUNCE_MS;
        if (!manualTrigger && this.lastSuggestionTime > 0 && !this.suggestionWasConsumed) {
            const elapsed = Date.now() - this.lastSuggestionTime;
            if (elapsed < COOLDOWN_MS) {
                effectiveDebounce = Math.max(DEBOUNCE_MS, COOLDOWN_MS - elapsed);
            }
        }

        // Manual trigger: skip debounce entirely
        if (manualTrigger) {
            effectiveDebounce = 0;
        }

        return this.debouncedFetch(document, position, token, requestKey, effectiveDebounce);
    }

    // ── Debounced fetch wrapper ──

    private debouncedFetch(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        requestKey: string,
        debounceMs: number
    ): Promise<vscode.InlineCompletionList | undefined> {
        return new Promise<vscode.InlineCompletionList | undefined>((resolve) => {
            const run = async () => {
                if (token.isCancellationRequested) { resolve(undefined); return; }

                const abortController = new AbortController();
                this.pendingAbort = abortController;

                // Hard timeout — bump the default when the responses wire API is in use.
                const wireApi = (getSetting<string>('azureOpenAI.wireApi') || 'chat-completions').toLowerCase();
                const defaultTimeout = wireApi === 'responses' ? DEFAULT_TIMEOUT_MS_RESPONSES : DEFAULT_TIMEOUT_MS;
                const timeoutMs = getSetting<number>('inlineCompletions.timeoutMs') || defaultTimeout;
                let timedOut = false;
                const timeoutId = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs);

                const onCancel = token.onCancellationRequested(() => abortController.abort());

                this.setStatusFetching();

                try {
                    const candidateCount = Math.min(getSetting<number>('inlineCompletions.candidates') || 1, 3);
                    const t0 = Date.now();
                    const results = await this.fetchCandidates(document, position, abortController.signal, candidateCount);
                    const elapsed = Date.now() - t0;

                    if (results.length > 0 && !token.isCancellationRequested) {
                        const items = results.map(r =>
                            new vscode.InlineCompletionItem(r, new vscode.Range(position, position))
                        );

                        // Exact-match cache
                        this.lastRequestKey = requestKey;
                        this.lastResult = items;

                        // Type-ahead cache (use first candidate)
                        this.lastCompletionText = results[0];
                        this.lastCompletionUri = document.uri.toString();
                        this.lastCompletionOffset = document.offsetAt(position);

                        // Cooldown tracking
                        this.lastSuggestionTime = Date.now();
                        this.suggestionWasConsumed = false;

                        resolve(new vscode.InlineCompletionList(items));
                    } else {
                        if (!token.isCancellationRequested && !abortController.signal.aborted) {
                            this.log(`Inline completion: no suggestion returned (elapsed ${elapsed}ms, candidates=${candidateCount}).`);
                        }
                        resolve(undefined);
                    }
                } catch (err: any) {
                    if (err.message !== 'Aborted' && !abortController.signal.aborted) {
                        this.log(`Inline completion error: ${err.message}`);
                    } else if (timedOut) {
                        this.log(`Inline completion timed out after ${timeoutMs}ms (wireApi=${wireApi}). Increase junior.inlineCompletions.timeoutMs if your model needs more time.`);
                    }
                    resolve(undefined);
                } finally {
                    clearTimeout(timeoutId);
                    onCancel.dispose();
                    this.setStatusIdle();
                }
            };

            if (debounceMs <= 0) {
                run();
            } else {
                this.debounceTimer = setTimeout(run, debounceMs);
            }
        });
    }

    // ── Multi-candidate fetch ──

    /**
     * Fetch one or more completion candidates in parallel.
     * Temperature is varied across candidates for diversity.
     */
    private async fetchCandidates(
        document: vscode.TextDocument,
        position: vscode.Position,
        abortSignal: AbortSignal,
        count: number
    ): Promise<string[]> {
        if (count <= 1) {
            const result = await this.fetchCompletion(document, position, abortSignal);
            return result ? [result] : [];
        }

        // Set deployment override once for all parallel calls
        const completionDeployment = getSetting<string>('inlineCompletions.deployment');
        if (completionDeployment) {
            this.aoaiClient.setDeploymentOverride(completionDeployment);
        }

        try {
            const promises = [];
            for (let i = 0; i < count; i++) {
                const tempOffset = CANDIDATE_TEMP_OFFSETS[i] || 0;
                promises.push(this.fetchCompletionCore(document, position, abortSignal, tempOffset));
            }
            const settled = await Promise.allSettled(promises);

            // Collect unique, non-empty results
            const seen = new Set<string>();
            const results: string[] = [];
            for (const outcome of settled) {
                if (outcome.status === 'fulfilled' && outcome.value) {
                    if (!seen.has(outcome.value)) {
                        seen.add(outcome.value);
                        results.push(outcome.value);
                    }
                }
            }
            return results;
        } finally {
            if (completionDeployment) {
                this.aoaiClient.setDeploymentOverride(undefined);
            }
        }
    }

    // ── Type-ahead cache ──

    private tryTypeAheadReuse(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.InlineCompletionItem[] | undefined {
        if (!this.lastCompletionText || !this.lastCompletionUri || this.lastCompletionOffset === undefined) {
            return undefined;
        }
        if (document.uri.toString() !== this.lastCompletionUri) {
            return undefined;
        }

        const currentOffset = document.offsetAt(position);
        const charsTyped = currentOffset - this.lastCompletionOffset;

        if (charsTyped <= 0 || charsTyped >= this.lastCompletionText.length) {
            return undefined;
        }

        const expectedPrefix = this.lastCompletionText.substring(0, charsTyped);
        const actualTyped = document.getText(
            new vscode.Range(document.positionAt(this.lastCompletionOffset), position)
        );

        if (actualTyped !== expectedPrefix) {
            this.lastCompletionText = undefined;
            return undefined;
        }

        const tail = this.lastCompletionText.substring(charsTyped);
        this.suggestionWasConsumed = true;
        return [new vscode.InlineCompletionItem(tail, new vscode.Range(position, position))];
    }

    // ── Smart suppression ──

    private isInComment(document: vscode.TextDocument, position: vscode.Position): boolean {
        const line = document.lineAt(position.line);
        const textBefore = line.text.substring(0, position.character).trimStart();
        const prefixes = COMMENT_PREFIXES[document.languageId];
        if (!prefixes) { return false; }
        return prefixes.some(p => textBefore.startsWith(p));
    }

    // ── Single-line vs multi-line detection ──

    private isSingleLineContext(document: vscode.TextDocument, position: vscode.Position): boolean {
        const textBefore = document.lineAt(position.line).text.substring(0, position.character);
        return textBefore.trim().length > 0;
    }

    // ── Neighboring-tab context ──

    private getNeighborContext(): string {
        const snippets: string[] = [];
        const activeUri = vscode.window.activeTextEditor?.document.uri.toString();

        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (snippets.length >= MAX_NEIGHBORS) { break; }
                if (!(tab.input instanceof vscode.TabInputText)) { continue; }

                const uri = (tab.input as vscode.TabInputText).uri;
                if (uri.toString() === activeUri) { continue; }

                const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                if (!doc || doc.isClosed) { continue; }

                const relPath = vscode.workspace.asRelativePath(uri);
                const text = doc.getText().substring(0, MAX_NEIGHBOR_CHARS);
                snippets.push(`--- ${relPath} (${doc.languageId}) ---\n${text}`);
            }
        }

        return snippets.length > 0
            ? '\n\n--- OPEN TABS (for context) ---\n' + snippets.join('\n')
            : '';
    }

    // ── Cancellation ──

    private cancelPending() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        if (this.pendingAbort) {
            this.pendingAbort.abort();
            this.pendingAbort = undefined;
        }
    }

    // ── Core completion fetch (single candidate, manages deployment override) ──

    private async fetchCompletion(
        document: vscode.TextDocument,
        position: vscode.Position,
        abortSignal: AbortSignal
    ): Promise<string | undefined> {
        const completionDeployment = getSetting<string>('inlineCompletions.deployment');
        if (completionDeployment) {
            this.aoaiClient.setDeploymentOverride(completionDeployment);
        }
        try {
            return await this.fetchCompletionCore(document, position, abortSignal, 0);
        } finally {
            if (completionDeployment) {
                this.aoaiClient.setDeploymentOverride(undefined);
            }
        }
    }

    // ── Core completion fetch (no deployment override — caller manages it) ──

    private async fetchCompletionCore(
        document: vscode.TextDocument,
        position: vscode.Position,
        abortSignal: AbortSignal,
        temperatureOffset: number
    ): Promise<string | undefined> {
        const fullText = document.getText();
        const offset = document.offsetAt(position);

        const prefixStart = Math.max(0, offset - MAX_PREFIX_CHARS);
        const prefix = fullText.substring(prefixStart, offset);
        const suffix = fullText.substring(offset, offset + MAX_SUFFIX_CHARS);

        if (prefix.trim().length === 0) {
            return undefined;
        }

        const lang = document.languageId;
        const filename = vscode.workspace.asRelativePath(document.uri);
        const singleLine = this.isSingleLineContext(document, position);
        const maxTokens = singleLine ? SINGLE_LINE_TOKENS : MULTI_LINE_TOKENS;

        const neighborCtx = this.getNeighborContext();
        const userContent =
            `File: ${filename} (${lang})\n` +
            `\n--- PREFIX ---\n${prefix}` +
            (suffix.trim() ? `\n--- SUFFIX ---\n${suffix}` : '') +
            neighborCtx;

        const systemContent = SYSTEM_PROMPT + (singleLine ? SINGLE_LINE_HINT : '');

        const messages = [
            { role: 'system' as const, content: systemContent },
            { role: 'user' as const, content: userContent }
        ];

        const temperature = Math.min((getSetting<number>('temperature') || 0.3) + temperatureOffset, 1.0);

        // Route to the same wire API as the main agent loop. When the deployment / APIM
        // route only exposes /v1/responses, hitting /chat/completions returns 404.
        const wireApi = (getSetting<string>('azureOpenAI.wireApi') || 'chat-completions').toLowerCase();
        const stream = wireApi === 'responses'
            ? this.streamViaResponses(messages, abortSignal, maxTokens, temperature)
            : this.aoaiClient.streamChat(messages, [], abortSignal, { maxTokens, temperature });

        let result = '';
        try {
            for await (const chunk of stream) {
                if (abortSignal.aborted) { return undefined; }
                if (chunk.type === 'text') {
                    result += chunk.text;
                }
                if (chunk.type === 'usage' && this.tokenTracker) {
                    this.tokenTracker.record('inline', chunk.usage);
                }
                if (chunk.type === 'done') { break; }
            }
        } catch (err) {
            if (abortSignal.aborted) { return undefined; }
            throw err;
        }

        // Post-process: for single-line mode, truncate at first newline
        if (singleLine) {
            const nl = result.indexOf('\n');
            if (nl >= 0) { result = result.substring(0, nl); }
        }

        result = result.trimEnd();
        return result.length > 0 ? result : undefined;
    }

    /**
     * Stream a completion via the /v1/responses wire API. Lazily constructs the
     * AoaiResponsesClient on first use so we don't pay the cost when wireApi is
     * the default chat-completions.
     */
    private async *streamViaResponses(
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
        abortSignal: AbortSignal,
        maxTokens: number,
        temperature: number
    ) {
        if (!this.responsesClient) {
            this.responsesClient = new AoaiResponsesClient(this.aoaiClient);
        }
        // Inline completions don't benefit from chain-of-thought; disable
        // reasoning entirely so latency stays low and the token budget goes to
        // visible output instead of hidden thinking. (gpt-5.4 supports 'none'.)
        yield* this.responsesClient.getResponseStream(messages as any, {
            tools: [],
            maxTokens,
            temperature,
            reasoningEffort: 'none',
            reasoningSummary: 'none',
            signal: abortSignal,
        });
    }

    dispose() {
        this.cancelPending();
        this.statusBar.dispose();
    }
}
