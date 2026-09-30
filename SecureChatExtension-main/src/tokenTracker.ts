/**
 * Token Usage Tracker — displays cumulative session token usage
 * via a status bar item with a rich GHCP-style markdown tooltip,
 * plus a lightweight badge in the chat panel.
 */
import * as vscode from 'vscode';
import { TokenUsage, ExtensionMessage } from './types';
import { resolveContextWindow } from './modelContextWindow';

type UsageSource = 'chat' | 'inline';

interface SourceUsage {
    promptTokens: number;
    completionTokens: number;
    uncachedPromptTokens: number;
    cachedPromptTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    providerRequests: number;
    estimatedRequests: number;
    requests: number;
}

function emptySourceUsage(): SourceUsage {
    return {
        promptTokens: 0,
        completionTokens: 0,
        uncachedPromptTokens: 0,
        cachedPromptTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        providerRequests: 0,
        estimatedRequests: 0,
        requests: 0,
    };
}

export class TokenTracker {
    private readonly statusBar: vscode.StatusBarItem;
    private readonly usage: Record<UsageSource, SourceUsage> = {
        chat: emptySourceUsage(),
        inline: emptySourceUsage(),
    };
    /** Current context size in tokens (set by the agent loop after each API call). */
    private currentContextTokens = 0;
    /** Optional dynamic context window reported by the active runtime. */
    private currentContextWindowOverride?: number;
    private log: (msg: string) => void;
    private webviewSender?: (msg: ExtensionMessage) => void;

    constructor(log?: (msg: string) => void) {
        this.log = log || (() => {});
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        this.statusBar.name = 'Junior Token Usage';
        this.updateStatusBar();
        this.statusBar.show();
        this.log('TokenTracker: initialized');
    }

    /** Set the callback to push updates to the webview badge. */
    setWebviewSender(sender: (msg: ExtensionMessage) => void) {
        this.webviewSender = sender;
        this.pushToWebview();
    }

    /** Record token usage from a completed API call. */
    record(source: UsageSource, usage: TokenUsage) {
        const s = this.usage[source];
        s.promptTokens += usage.prompt_tokens;
        s.completionTokens += usage.completion_tokens;
        s.cachedPromptTokens += usage.cached_prompt_tokens ?? 0;
        s.uncachedPromptTokens += usage.uncached_prompt_tokens
            ?? Math.max(0, usage.prompt_tokens - (usage.cached_prompt_tokens ?? 0));
        s.cacheWriteTokens += usage.cache_write_tokens ?? 0;
        s.reasoningTokens += usage.reasoning_tokens ?? 0;
        if (usage.source === 'estimated') { s.estimatedRequests += 1; }
        else { s.providerRequests += 1; }
        s.requests += 1;
        this.log(`TokenTracker: ${source} +${usage.prompt_tokens}p/${usage.completion_tokens}c (${usage.cached_prompt_tokens ?? 0} cached, ${usage.cache_write_tokens ?? 0} cache-write, ${usage.reasoning_tokens ?? 0} reasoning, ${usage.source ?? 'provider'}) — total ${this.totalTokens()}`);
        this.updateStatusBar();
        this.pushToWebview();
    }

    /** Reset all counters. */
    reset() {
        for (const key of Object.keys(this.usage) as UsageSource[]) {
            this.usage[key] = emptySourceUsage();
        }
        this.currentContextTokens = 0;
        this.currentContextWindowOverride = undefined;
        this.updateStatusBar();
        this.pushToWebview();
    }

    /** Update the current context size (estimated tokens in the message array). */
    setContextSize(tokens: number, contextWindow?: number) {
        this.currentContextTokens = tokens;
        this.currentContextWindowOverride = contextWindow ?? undefined;
        this.updateStatusBar();
        this.pushToWebview();
    }

    /** Show a detailed breakdown in a modal dialog (called from webview click). */
    showDetailedUsage() {
        const chat = this.usage.chat;
        const inline = this.usage.inline;
        const totalTokens = chat.promptTokens + chat.completionTokens +
            inline.promptTokens + inline.completionTokens;
        const totalRequests = chat.requests + inline.requests;

        const lines: string[] = [
            `Session Token Usage`,
            ``,
            `Total: ${this.formatTokens(totalTokens)} tokens (${totalRequests} requests)`,
            ``,
            `── Chat ──`,
            `  Prompt:     ${this.formatTokens(chat.promptTokens)}`,
            `    Uncached: ${this.formatTokens(chat.uncachedPromptTokens)}`,
            `    Cached:   ${this.formatTokens(chat.cachedPromptTokens)}`,
            `    Written:  ${this.formatTokens(chat.cacheWriteTokens)}`,
            `  Completion: ${this.formatTokens(chat.completionTokens)}`,
            `    Reasoning: ${this.formatTokens(chat.reasoningTokens)}`,
            `  Reported:   ${chat.providerRequests} provider, ${chat.estimatedRequests} estimated`,
            `  Requests:   ${chat.requests}`,
            ``,
            `── Inline Completions ──`,
            `  Prompt:     ${this.formatTokens(inline.promptTokens)}`,
            `    Uncached: ${this.formatTokens(inline.uncachedPromptTokens)}`,
            `    Cached:   ${this.formatTokens(inline.cachedPromptTokens)}`,
            `  Completion: ${this.formatTokens(inline.completionTokens)}`,
            `    Reasoning: ${this.formatTokens(inline.reasoningTokens)}`,
            `  Reported:   ${inline.providerRequests} provider, ${inline.estimatedRequests} estimated`,
            `  Requests:   ${inline.requests}`,
        ];

        vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, 'Reset Counters')
            .then(choice => {
                if (choice === 'Reset Counters') { this.reset(); }
            });
    }

    // ── Status bar with rich GHCP-style tooltip ──

    /** Unicode circle characters representing fill level (0%, 25%, 50%, 75%, 100%). */
    private circleForPct(pct: number): string {
        if (pct <= 0) { return '○'; }
        if (pct <= 25) { return '◔'; }
        if (pct <= 50) { return '◑'; }
        if (pct <= 75) { return '◕'; }
        return '●';
    }

    private updateStatusBar() {
        const total = this.totalTokens();
        const requests = this.usage.chat.requests + this.usage.inline.requests;
        const contextWindow = this.currentContextWindowOverride ?? resolveContextWindow().tokens;
        // Ring shows current context burden, not cumulative total
        const contextTokens = this.currentContextTokens || total;
        const windowPct = Math.min(100, Math.round(contextTokens / contextWindow * 100));
        const circle = this.circleForPct(windowPct);
        this.statusBar.text = `${circle} ${this.formatTokens(contextTokens)} · ${windowPct}%`;

        const chat = this.usage.chat;
        const inline = this.usage.inline;
        const chatTotal = chat.promptTokens + chat.completionTokens;
        const inlineTotal = inline.promptTokens + inline.completionTokens;
        const pct = (n: number) => total > 0 ? `${Math.round(n / total * 100)}%` : '—';

        const md = new vscode.MarkdownString('', true);
        md.isTrusted = true;
        md.supportThemeIcons = true;

        md.appendMarkdown(`**Session Token Usage**\n\n`);
        md.appendMarkdown(`${circle} **${this.formatTokens(contextTokens)} context** &nbsp;&nbsp; ${windowPct}% of ${this.formatTokens(contextWindow)} window &nbsp;&nbsp; ${this.formatTokens(total)} total &nbsp;&nbsp; ${requests} requests\n\n`);
        md.appendMarkdown(`---\n\n`);

        // Chat section
        md.appendMarkdown(`**$(comment-discussion) Chat** &nbsp;&nbsp; ${this.formatTokens(chatTotal)} &nbsp; ${pct(chatTotal)}\n\n`);
        md.appendMarkdown(`| | Tokens | % |\n`);
        md.appendMarkdown(`|:--|--:|--:|\n`);
        md.appendMarkdown(`| $(arrow-up) Prompt | ${this.formatTokens(chat.promptTokens)} | ${pct(chat.promptTokens)} |\n`);
        md.appendMarkdown(`| &nbsp;&nbsp; Uncached | ${this.formatTokens(chat.uncachedPromptTokens)} | |\n`);
        md.appendMarkdown(`| &nbsp;&nbsp; Cached | ${this.formatTokens(chat.cachedPromptTokens)} | |\n`);
        md.appendMarkdown(`| &nbsp;&nbsp; Cache writes | ${this.formatTokens(chat.cacheWriteTokens)} | |\n`);
        md.appendMarkdown(`| $(arrow-down) Completion | ${this.formatTokens(chat.completionTokens)} | ${pct(chat.completionTokens)} |\n`);
        md.appendMarkdown(`| &nbsp;&nbsp; Reasoning | ${this.formatTokens(chat.reasoningTokens)} | |\n`);
        md.appendMarkdown(`| $(symbol-number) Requests | ${chat.requests} | |\n\n`);

        // Inline section
        md.appendMarkdown(`**$(sparkle) Inline Completions** &nbsp;&nbsp; ${this.formatTokens(inlineTotal)} &nbsp; ${pct(inlineTotal)}\n\n`);
        md.appendMarkdown(`| | Tokens | % |\n`);
        md.appendMarkdown(`|:--|--:|--:|\n`);
        md.appendMarkdown(`| $(arrow-up) Prompt | ${this.formatTokens(inline.promptTokens)} | ${pct(inline.promptTokens)} |\n`);
        md.appendMarkdown(`| $(arrow-down) Completion | ${this.formatTokens(inline.completionTokens)} | ${pct(inline.completionTokens)} |\n`);
        md.appendMarkdown(`| $(symbol-number) Requests | ${inline.requests} | |\n\n`);

        md.appendMarkdown(`---\n\n`);
        md.appendMarkdown(`[$(trash) Reset Counters](command:junior.resetTokenUsage)`);

        this.statusBar.tooltip = md;
    }

    // ── Webview badge (lightweight text update) ──

    private pushToWebview() {
        if (!this.webviewSender) { return; }
        const chat = this.usage.chat;
        const inline = this.usage.inline;
        const chatTotal = chat.promptTokens + chat.completionTokens;
        const inlineTotal = inline.promptTokens + inline.completionTokens;
        const total = chatTotal + inlineTotal;
        const contextWindow = this.currentContextWindowOverride ?? resolveContextWindow().tokens;
        const pct = (n: number) => total > 0 ? `${Math.round(n / total * 100)}%` : '0%';

        this.webviewSender({
            type: 'tokenUsage',
            totalTokens: this.formatTokens(total),
            chatTokens: this.formatTokens(chatTotal),
            inlineTokens: this.formatTokens(inlineTotal),
            chatPct: pct(chatTotal),
            inlinePct: pct(inlineTotal),
            requests: chat.requests + inline.requests,
            chatPrompt: this.formatTokens(chat.promptTokens),
            chatCompletion: this.formatTokens(chat.completionTokens),
            inlinePrompt: this.formatTokens(inline.promptTokens),
            inlineCompletion: this.formatTokens(inline.completionTokens),
            chatPromptPct: pct(chat.promptTokens),
            chatCompletionPct: pct(chat.completionTokens),
            inlinePromptPct: pct(inline.promptTokens),
            inlineCompletionPct: pct(inline.completionTokens),
            chatRequests: chat.requests,
            inlineRequests: inline.requests,
            uncachedPrompt: this.formatTokens(chat.uncachedPromptTokens + inline.uncachedPromptTokens),
            cachedPrompt: this.formatTokens(chat.cachedPromptTokens + inline.cachedPromptTokens),
            cacheWrite: this.formatTokens(chat.cacheWriteTokens + inline.cacheWriteTokens),
            reasoning: this.formatTokens(chat.reasoningTokens + inline.reasoningTokens),
            providerRequests: chat.providerRequests + inline.providerRequests,
            estimatedRequests: chat.estimatedRequests + inline.estimatedRequests,
            windowPct: Math.min(100, Math.round((this.currentContextTokens || total) / contextWindow * 100)),
            contextWindow: this.formatTokens(contextWindow)
        });
    }

    private totalTokens(): number {
        let total = 0;
        for (const key of Object.keys(this.usage) as UsageSource[]) {
            total += this.usage[key].promptTokens + this.usage[key].completionTokens;
        }
        return total;
    }

    private formatTokens(n: number): string {
        if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
        if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
        return `${n}`;
    }

    dispose() {
        this.statusBar.dispose();
    }
}
