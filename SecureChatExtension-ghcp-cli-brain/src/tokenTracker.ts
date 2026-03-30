/**
 * Token Usage Tracker — displays cumulative session token usage
 * via a status bar item with a rich GHCP-style markdown tooltip,
 * plus a lightweight badge in the chat panel.
 */
import * as vscode from 'vscode';
import { TokenUsage, ExtensionMessage } from './types';
import { getSetting } from './config';

type UsageSource = 'chat' | 'inline';

interface SourceUsage {
    promptTokens: number;
    completionTokens: number;
    requests: number;
}

export class TokenTracker {
    private readonly statusBar: vscode.StatusBarItem;
    private readonly usage: Record<UsageSource, SourceUsage> = {
        chat: { promptTokens: 0, completionTokens: 0, requests: 0 },
        inline: { promptTokens: 0, completionTokens: 0, requests: 0 }
    };
    /** Current context size in tokens (set by the agent loop after each API call). */
    private currentContextTokens = 0;
    private log: (msg: string) => void;
    private webviewSender?: (msg: ExtensionMessage) => void;

    constructor(log?: (msg: string) => void) {
        this.log = log || (() => {});
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        this.statusBar.name = 'JuniorGH Token Usage';
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
        s.requests += 1;
        this.log(`TokenTracker: ${source} +${usage.prompt_tokens}p/${usage.completion_tokens}c — total ${this.totalTokens()}`);
        this.updateStatusBar();
        this.pushToWebview();
    }

    /** Reset all counters. */
    reset() {
        for (const key of Object.keys(this.usage) as UsageSource[]) {
            this.usage[key] = { promptTokens: 0, completionTokens: 0, requests: 0 };
        }
        this.currentContextTokens = 0;
        this.updateStatusBar();
        this.pushToWebview();
    }

    /** Update the current context size (estimated tokens in the message array). */
    setContextSize(tokens: number) {
        this.currentContextTokens = tokens;
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
            `  Completion: ${this.formatTokens(chat.completionTokens)}`,
            `  Requests:   ${chat.requests}`,
            ``,
            `── Inline Completions ──`,
            `  Prompt:     ${this.formatTokens(inline.promptTokens)}`,
            `  Completion: ${this.formatTokens(inline.completionTokens)}`,
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
        const contextWindow = getSetting<number>('agent.contextWindow', 128000) ?? 128000;
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
        md.appendMarkdown(`| $(arrow-down) Completion | ${this.formatTokens(chat.completionTokens)} | ${pct(chat.completionTokens)} |\n`);
        md.appendMarkdown(`| $(symbol-number) Requests | ${chat.requests} | |\n\n`);

        // Inline section
        md.appendMarkdown(`**$(sparkle) Inline Completions** &nbsp;&nbsp; ${this.formatTokens(inlineTotal)} &nbsp; ${pct(inlineTotal)}\n\n`);
        md.appendMarkdown(`| | Tokens | % |\n`);
        md.appendMarkdown(`|:--|--:|--:|\n`);
        md.appendMarkdown(`| $(arrow-up) Prompt | ${this.formatTokens(inline.promptTokens)} | ${pct(inline.promptTokens)} |\n`);
        md.appendMarkdown(`| $(arrow-down) Completion | ${this.formatTokens(inline.completionTokens)} | ${pct(inline.completionTokens)} |\n`);
        md.appendMarkdown(`| $(symbol-number) Requests | ${inline.requests} | |\n\n`);

        md.appendMarkdown(`---\n\n`);
        md.appendMarkdown(`[$(trash) Reset Counters](command:juniorgh.resetTokenUsage)`);

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
            windowPct: Math.min(100, Math.round((this.currentContextTokens || total) / ((getSetting<number>('agent.contextWindow', 128000) ?? 128000)) * 100)),
            contextWindow: this.formatTokens(getSetting<number>('agent.contextWindow', 128000) ?? 128000)
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
