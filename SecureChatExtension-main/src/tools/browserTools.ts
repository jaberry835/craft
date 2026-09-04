import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import { getSetting } from '../config';
import { ToolContext, ToolEntry } from './types';

interface CdpMessage {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { message?: string };
}

class CdpConnection {
    private nextId = 1;
    private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    private waiters = new Map<string, Array<(params: Record<string, unknown>) => void>>();
    readonly consoleLines: string[] = [];

    private constructor(private socket: WebSocket) {
        socket.on('message', data => this.handleMessage(data.toString()));
        socket.on('close', () => this.rejectPending(new Error('Browser connection closed.')));
        socket.on('error', error => this.rejectPending(error));
    }

    static async connect(url: string): Promise<CdpConnection> {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out connecting to the browser.')), 10_000);
            socket.once('open', () => { clearTimeout(timer); resolve(); });
            socket.once('error', error => { clearTimeout(timer); reject(error); });
        });
        return new CdpConnection(socket);
    }

    send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }), error => {
                if (!error) { return; }
                this.pending.delete(id);
                reject(error);
            });
        });
    }

    waitForEvent(method: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const onEvent = (params: Record<string, unknown>) => { clearTimeout(timer); resolve(params); };
            const timer = setTimeout(() => {
                this.waiters.set(method, (this.waiters.get(method) || []).filter(waiter => waiter !== onEvent));
                reject(new Error(`Timed out waiting for ${method}.`));
            }, timeoutMs);
            this.waiters.set(method, [...(this.waiters.get(method) || []), onEvent]);
        });
    }

    close(): void { this.socket.close(); }

    private handleMessage(raw: string): void {
        let message: CdpMessage;
        try { message = JSON.parse(raw) as CdpMessage; } catch { return; }
        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending) { return; }
            this.pending.delete(message.id);
            if (message.error) { pending.reject(new Error(message.error.message || 'Browser command failed.')); }
            else { pending.resolve(message.result || {}); }
            return;
        }
        if (message.method === 'Runtime.consoleAPICalled') {
            const args = Array.isArray(message.params?.args) ? message.params.args as Array<Record<string, unknown>> : [];
            const text = args.map(arg => String(arg.value ?? arg.description ?? '')).join(' ');
            if (text) {
                this.consoleLines.push(text);
                if (this.consoleLines.length > 200) { this.consoleLines.shift(); }
            }
        }
        if (message.method) {
            const waiters = this.waiters.get(message.method) || [];
            this.waiters.delete(message.method);
            for (const waiter of waiters) { waiter(message.params || {}); }
        }
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) { pending.reject(error); }
        this.pending.clear();
    }
}

interface BrowserSnapshot {
    title: string;
    url: string;
    text: string;
    elements: Array<{ ref: string; tag: string; role: string; name: string }>;
}

interface BrowserSearchResults {
    query: string;
    url: string;
    results: Array<{ title: string; url: string; snippet: string }>;
}

const DEFAULT_SEARCH_URL_TEMPLATES = ['https://html.duckduckgo.com/html/?q={query}'];

export function buildSearchUrl(template: string, query: string): string {
    const encoded = encodeURIComponent(query);
    const raw = template.includes('{query}')
        ? template.replace(/\{query\}/g, encoded)
        : `${template}${template.includes('?') ? '&' : '?'}q=${encoded}`;
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error(`Invalid search URL template: ${template}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) { throw new Error('Search URL templates must use http:// or https://.'); }
    return parsed.href;
}

function getSearchUrlTemplates(override?: string): string[] {
    if (override?.trim()) { return [override.trim()]; }
    const configured = getSetting<string[]>('browser.searchUrlTemplates', []);
    const values = Array.isArray(configured) ? configured.map(value => String(value || '').trim()).filter(Boolean) : [];
    return values.length ? values : DEFAULT_SEARCH_URL_TEMPLATES;
}

class ClientCertificateRequiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClientCertificateRequiredError';
    }
}

class BrowserSession {
    private process?: cp.ChildProcess;
    private browserConnection?: CdpConnection;
    private connection?: CdpConnection;
    private userDataDir?: string;

    async open(url: string, showWindow = false): Promise<BrowserSnapshot> {
        this.validateUrl(url);
        if (!this.connection) { await this.launch(showWindow); }
        const loaded = this.connection!.waitForEvent('Page.loadEventFired', showWindow ? 120_000 : 15_000).catch(() => undefined);
        const navigation = await this.connection!.send('Page.navigate', { url });
        const errorText = typeof navigation.errorText === 'string' ? navigation.errorText : '';
        if (/ERR_(?:SSL_CLIENT_AUTH_CERT_NEEDED|BAD_SSL_CLIENT_AUTH_CERT)/i.test(errorText)) {
            throw new ClientCertificateRequiredError(errorText);
        }
        if (errorText) { throw new Error(`Browser navigation failed: ${errorText}`); }
        await loaded;
        return this.snapshot();
    }

    async snapshot(): Promise<BrowserSnapshot> {
        const expression = `(() => {
            const visible = el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0; };
            const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(visible).slice(0, 100);
            const elements = candidates.map((el, index) => {
                const ref = 'e' + (index + 1); el.setAttribute('data-junior-ref', ref);
                return { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || '').trim().slice(0, 200) };
            });
            return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 20000), elements };
        })()`;
        const result = await this.requireConnection().send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        const value = (result.result as Record<string, unknown> | undefined)?.value as BrowserSnapshot | undefined;
        if (!value) { throw new Error('The browser did not return a page snapshot.'); }
        return value;
    }

    async search(query: string, maxResults: number, searchUrlTemplate?: string, showWindow = false): Promise<BrowserSearchResults> {
        const trimmed = query.trim();
        if (!trimmed) { throw new Error('Search query is required.'); }
        const limit = Math.max(1, Math.min(10, Math.floor(maxResults) || 6));
        const errors: string[] = [];
        for (const template of getSearchUrlTemplates(searchUrlTemplate)) {
            try {
                const searchUrl = buildSearchUrl(template, trimmed);
                await this.open(searchUrl, showWindow);
                const results = await this.searchResults(trimmed, limit);
                if (results.results.length > 0) { return results; }
                errors.push(`${searchUrl}: no usable results found`);
            } catch (error) {
                if (error instanceof ClientCertificateRequiredError) { throw error; }
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
        throw new Error(`No configured search page returned usable results. ${errors.join(' | ')}`);
    }

    async searchResults(query: string, maxResults: number): Promise<BrowserSearchResults> {
        const expression = `(() => {
            const maxResults = ${JSON.stringify(maxResults)};
            const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
            const normalizeHref = href => {
                try {
                    const url = new URL(href, location.href);
                    const uddg = url.searchParams.get('uddg');
                    if (uddg) return decodeURIComponent(uddg);
                    if (!/^https?:$/.test(url.protocol)) return '';
                    if (/duckduckgo\\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) return '';
                    return url.href;
                } catch { return ''; }
            };
            const seen = new Set();
            const results = [];
            const containers = Array.from(document.querySelectorAll('.result, .web-result, .links_main, li.b_algo, article'));
            for (const container of containers) {
                const anchor = container.querySelector('a.result__a, h2 a, a[href]');
                const url = normalizeHref(anchor?.getAttribute('href') || anchor?.href || '');
                const title = clean(anchor?.innerText || anchor?.textContent || '');
                if (!url || !title || seen.has(url)) continue;
                seen.add(url);
                const snippetEl = container.querySelector('.result__snippet, .result__body, .b_caption p, p');
                let snippet = clean(snippetEl?.innerText || snippetEl?.textContent || container.innerText || '');
                if (snippet.startsWith(title)) { snippet = clean(snippet.slice(title.length)); }
                results.push({ title: title.slice(0, 240), url, snippet: snippet.slice(0, 500) });
                if (results.length >= maxResults) break;
            }
            if (results.length === 0) {
                for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
                    const url = normalizeHref(anchor.getAttribute('href') || anchor.href || '');
                    const title = clean(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || '');
                    if (!url || !title || seen.has(url)) continue;
                    try {
                        const host = new URL(url).hostname;
                        if (/duckduckgo\\.com$/i.test(host)) continue;
                    } catch { continue; }
                    seen.add(url);
                    results.push({ title: title.slice(0, 240), url, snippet: '' });
                    if (results.length >= maxResults) break;
                }
            }
            return { query: ${JSON.stringify(query)}, url: location.href, results };
        })()`;
        const result = await this.requireConnection().send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        const value = (result.result as Record<string, unknown> | undefined)?.value as BrowserSearchResults | undefined;
        if (!value) { throw new Error('The browser did not return search results.'); }
        return value;
    }

    async click(ref: string): Promise<BrowserSnapshot> {
        const selector = this.selectorForRef(ref);
        await this.evaluateAction(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok:false,error:'Element not found' }; el.scrollIntoView({block:'center'}); el.click(); return {ok:true}; })()`);
        await new Promise(resolve => setTimeout(resolve, 500));
        return this.snapshot();
    }

    async type(ref: string, text: string, submit: boolean): Promise<BrowserSnapshot> {
        const selector = this.selectorForRef(ref);
        const expression = `(() => {
            const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {ok:false,error:'Element not found'}; el.focus();
            if ('value' in el) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)}; } else { el.textContent = ${JSON.stringify(text)}; }
            el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
            if (${submit}) { if (el.form?.requestSubmit) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); }
            return {ok:true};
        })()`;
        await this.evaluateAction(expression);
        await new Promise(resolve => setTimeout(resolve, 500));
        return this.snapshot();
    }

    async screenshot(): Promise<Buffer> {
        const result = await this.requireConnection().send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        if (typeof result.data !== 'string') { throw new Error('The browser did not return screenshot data.'); }
        return Buffer.from(result.data, 'base64');
    }

    getConsoleLines(): string[] { return this.connection?.consoleLines.slice() || []; }

    async close(): Promise<void> {
        const browserConnection = this.browserConnection;
        this.browserConnection = undefined;
        if (browserConnection) {
            await Promise.race([
                browserConnection.send('Browser.close').catch(() => undefined),
                new Promise(resolve => setTimeout(resolve, 1000)),
            ]);
            browserConnection.close();
        }
        this.connection?.close();
        this.connection = undefined;
        if (this.process && !this.process.killed) { this.process.kill(); }
        this.process = undefined;
        if (this.userDataDir) {
            try { await fs.promises.rm(this.userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        this.userDataDir = undefined;
    }

    private async launch(showWindow: boolean): Promise<void> {
        const executable = this.findExecutable();
        const debugPort = await this.reservePort();
        this.userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'junior-browser-'));
        const args = [
            ...(showWindow ? [] : ['--headless=new']),
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${this.userDataDir}`,
            '--no-first-run',
            '--disable-default-apps',
            '--disable-background-networking',
            'about:blank',
        ];
        this.process = cp.spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const debuggerUrl = await new Promise<string>((resolve, reject) => {
            let settled = false;
            const fail = (error: Error) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                reject(error);
            };
            const timer = setTimeout(() => fail(new Error('Timed out starting the browser.')), 15_000);
            const poll = async () => {
                if (settled) { return; }
                try {
                    const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.json()) as Record<string, unknown>;
                    if (typeof version.webSocketDebuggerUrl === 'string') {
                        settled = true;
                        clearTimeout(timer);
                        resolve(version.webSocketDebuggerUrl);
                        return;
                    }
                } catch { /* browser is still starting */ }
                setTimeout(poll, 100);
            };
            void poll();
            this.process!.once('error', fail);
            this.process!.once('exit', code => {
                if (code !== 0 && code !== null) { fail(new Error(`Browser exited during startup (code ${code}).`)); }
            });
        });
        this.browserConnection = await CdpConnection.connect(debuggerUrl);
        const target = await this.browserConnection.send('Target.createTarget', { url: 'about:blank' });
        const targetId = String(target.targetId || '');
        const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json()) as Array<Record<string, unknown>>;
        const page = targets.find(candidate => candidate.id === targetId) || targets.find(candidate => candidate.type === 'page');
        const pageUrl = typeof page?.webSocketDebuggerUrl === 'string' ? page.webSocketDebuggerUrl : '';
        if (!pageUrl) { throw new Error('Could not connect to the browser page target.'); }
        this.connection = await CdpConnection.connect(pageUrl);
        await Promise.all([this.connection.send('Page.enable'), this.connection.send('Runtime.enable'), this.connection.send('Log.enable')]);
    }

    private reservePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    server.close();
                    reject(new Error('Could not reserve a browser debugging port.'));
                    return;
                }
                server.close(error => error ? reject(error) : resolve(address.port));
            });
        });
    }

    private findExecutable(): string {
        const configured = (getSetting<string>('browser.executablePath') || '').trim();
        if (configured) {
            if (!fs.existsSync(configured)) { throw new Error(`Configured browser executable was not found: ${configured}`); }
            return configured;
        }
        const candidates = process.platform === 'win32'
            ? [path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge_proxy.exe'), path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge_proxy.exe'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge_proxy.exe'), path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'), path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'), path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe')]
            : process.platform === 'darwin'
                ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
                : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
        const executable = candidates.find(candidate => candidate && fs.existsSync(candidate));
        if (!executable) { throw new Error('No supported browser was found. Install Edge/Chrome or configure Junior: Browser Executable Path.'); }
        return executable;
    }

    private validateUrl(url: string): void {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error(`Invalid browser URL: ${url}`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) { throw new Error('Browser navigation only supports http:// and https:// URLs.'); }
    }

    private selectorForRef(ref: string): string {
        if (!/^e\d+$/.test(ref)) { throw new Error('Use an element reference from browser_snapshot, such as e1.'); }
        return `[data-junior-ref="${ref}"]`;
    }

    private requireConnection(): CdpConnection {
        if (!this.connection) { throw new Error('No browser is open. Call browser_open first.'); }
        return this.connection;
    }

    private async evaluateAction(expression: string): Promise<void> {
        const result = await this.requireConnection().send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        const value = (result.result as Record<string, unknown> | undefined)?.value as { ok?: boolean; error?: string } | undefined;
        if (!value?.ok) { throw new Error(value?.error || 'Browser action failed.'); }
    }
}

function formatSnapshot(snapshot: BrowserSnapshot): string {
    const elements = snapshot.elements.length
        ? snapshot.elements.map(element => `[${element.ref}] <${element.tag}>${element.role ? ` role=${element.role}` : ''} ${element.name}`.trim()).join('\n')
        : '(no interactive elements found)';
    return `Title: ${snapshot.title}\nURL: ${snapshot.url}\n\nPage text:\n${snapshot.text || '(empty)'}\n\nInteractive elements:\n${elements}`;
}

function formatSearchResults(search: BrowserSearchResults): string {
    const rows = search.results.length
        ? search.results.map((item, index) => `${index + 1}. ${item.title}\n   URL: ${item.url}${item.snippet ? `\n   Snippet: ${item.snippet}` : ''}`).join('\n')
        : '(no usable search results found)';
    return `Search query: ${search.query}\nSearch page URL: ${search.url}\n\nResults:\n${rows}`;
}

export function createBrowserTools(ctx: ToolContext): { entries: ToolEntry[]; dispose: () => Promise<void> } {
    const session = new BrowserSession();
    const result = (operation: () => Promise<string>) => operation().then(value => ({ success: true, result: value })).catch(error => ({ success: false, result: error instanceof Error ? error.message : String(error) }));
    const confirmClientCertificate = async (url: string): Promise<boolean> => {
        if (process.platform !== 'win32') { return false; }
        const answers = await ctx.askUser([{
            header: 'Client certificate',
            question: 'This site requires a client certificate. Open a visible browser window and choose a certificate?',
            detail: `Junior will let Edge/Chrome use your Windows user certificate store for ${url}. Choose the certificate in the browser's native dialog; Junior never reads or exports its private key.`,
            options: [
                { label: 'Continue', description: 'Open the browser certificate chooser.', recommended: true },
                { label: 'Cancel', description: 'Do not open the site.' },
            ],
            allowFreeformInput: false,
        }]);
        return answers?.['Client certificate']?.includes('Continue') === true;
    };
    const openPreview = async (url: string): Promise<string> => {
        if (getSetting<boolean>('browser.openPreview', true) === false) { return 'VS Code preview: disabled.'; }
        try {
            await vscode.commands.executeCommand('simpleBrowser.show', url);
            return 'VS Code preview: opened.';
        } catch {
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
                return 'VS Code preview: opened.';
            } catch (error) {
                return `VS Code preview: unavailable (${error instanceof Error ? error.message : String(error)}).`;
            }
        }
    };
    const entries: ToolEntry[] = [
        {
            definition: { type: 'function', function: { name: 'browser_open', description: 'Open an http(s) URL in Junior\'s isolated browser and return visible page text plus interactive element references. Set clientCertificate when the site uses mutual TLS so the user can choose a certificate from the Windows user certificate store.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full http:// or https:// URL.' }, clientCertificate: { type: 'boolean', description: 'Open a visible Edge/Chrome window and ask the user to choose a client certificate from the Windows user certificate store.' } }, required: ['url'] } } },
            handler: async args => {
                const url = String(args.url || '');
                if (!await ctx.requestConfirmation(`Open browser URL: ${url}`, 'terminal')) { return { success: false, result: 'User declined browser navigation.' }; }
                const clientCertificateRequested = args.clientCertificate === true || getSetting<boolean>('browser.useClientCertificate', false) === true;
                if (clientCertificateRequested) {
                    if (process.platform !== 'win32') { return { success: false, result: 'Client-certificate browser selection is currently supported on Windows only.' }; }
                    if (!await confirmClientCertificate(url)) { return { success: false, result: 'User declined client-certificate browser access.' }; }
                    return result(async () => {
                        await session.close();
                        const snapshot = await session.open(url, true);
                        return `Visible automation browser opened. Select the client certificate in the browser dialog if prompted.\n\n${formatSnapshot(snapshot)}`;
                    });
                }
                try {
                    const snapshot = await session.open(url);
                    const previewStatus = await openPreview(url);
                    return { success: true, result: `${previewStatus}\n\n${formatSnapshot(snapshot)}` };
                } catch (error) {
                    if (!(error instanceof ClientCertificateRequiredError) || process.platform !== 'win32') {
                        return { success: false, result: error instanceof Error ? error.message : String(error) };
                    }
                    if (!await confirmClientCertificate(url)) { return { success: false, result: 'The site requires a client certificate, and the user declined browser access.' }; }
                    return result(async () => {
                        await session.close();
                        const snapshot = await session.open(url, true);
                        return `Visible automation browser opened. Select the client certificate in the browser dialog if prompted.\n\n${formatSnapshot(snapshot)}`;
                    });
                }
            },
        },
        {
            definition: { type: 'function', function: { name: 'web_search', description: 'Search the web or a configured intranet search page and return structured result titles, URLs, and snippets. Use this before browser_open when the user asks for research but does not provide a URL.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query.' }, maxResults: { type: 'number', description: 'Maximum number of results to return, 1-10. Defaults to 6.' }, searchUrlTemplate: { type: 'string', description: 'Optional one-time search URL template. Use {query} where the URL-encoded query should be inserted. If omitted, Junior uses junior.browser.searchUrlTemplates.' }, clientCertificate: { type: 'boolean', description: 'Open a visible Edge/Chrome window and ask the user to choose a client certificate for an intranet search page.' } }, required: ['query'] } } },
            handler: async args => {
                const query = String(args.query || '');
                const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 6;
                if (!await ctx.requestConfirmation(`Search the web for: ${query}`, 'terminal')) { return { success: false, result: 'User declined web search.' }; }
                const searchUrlTemplate = typeof args.searchUrlTemplate === 'string' ? args.searchUrlTemplate : undefined;
                const clientCertificateRequested = args.clientCertificate === true || getSetting<boolean>('browser.useClientCertificate', false) === true;
                if (clientCertificateRequested) {
                    if (process.platform !== 'win32') { return { success: false, result: 'Client-certificate browser selection is currently supported on Windows only.' }; }
                    if (!await confirmClientCertificate(query)) { return { success: false, result: 'User declined client-certificate browser access.' }; }
                    return result(async () => formatSearchResults(await session.search(query, maxResults, searchUrlTemplate, true)));
                }
                try {
                    return { success: true, result: formatSearchResults(await session.search(query, maxResults, searchUrlTemplate)) };
                } catch (error) {
                    if (!(error instanceof ClientCertificateRequiredError) || process.platform !== 'win32') {
                        return { success: false, result: error instanceof Error ? error.message : String(error) };
                    }
                    if (!await confirmClientCertificate(query)) { return { success: false, result: 'The search page requires a client certificate, and the user declined browser access.' }; }
                    return result(async () => formatSearchResults(await session.search(query, maxResults, searchUrlTemplate, true)));
                }
            },
        },
        { definition: { type: 'function', function: { name: 'browser_snapshot', description: 'Inspect the current page and return visible text plus fresh interactive element references.', parameters: { type: 'object', properties: {} } } }, handler: async () => result(async () => formatSnapshot(await session.snapshot())) },
        { definition: { type: 'function', function: { name: 'browser_click', description: 'Click an element reference from the latest browser snapshot and return the updated page.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element reference such as e1.' } }, required: ['ref'] } } }, handler: async args => result(async () => formatSnapshot(await session.click(String(args.ref || '')))) },
        { definition: { type: 'function', function: { name: 'browser_type', description: 'Replace text in an input or editable element and optionally submit its form.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element reference such as e2.' }, text: { type: 'string', description: 'Text to enter.' }, submit: { type: 'boolean', description: 'Submit after entering text.' } }, required: ['ref', 'text'] } } }, handler: async args => result(async () => formatSnapshot(await session.type(String(args.ref || ''), String(args.text || ''), args.submit === true))) },
        {
            definition: { type: 'function', function: { name: 'browser_screenshot', description: 'Capture the current browser viewport as a PNG inside the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative PNG path.' } } } } },
            handler: async args => {
                const relativePath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : `.junior/screenshots/browser-${Date.now()}.png`;
                if (!relativePath.toLowerCase().endsWith('.png')) { return { success: false, result: 'Browser screenshots must use a .png path.' }; }
                const absolutePath = ctx.validatePath(relativePath);
                if (!absolutePath) { return { success: false, result: 'Screenshot path must be inside the workspace.' }; }
                if (!await ctx.requestConfirmation(`Write browser screenshot: ${relativePath}`, 'write')) { return { success: false, result: 'User declined the browser screenshot.' }; }
                return result(async () => {
                    const normalized = relativePath.replace(/\\/g, '/');
                    await ctx.snapshotOriginal(absolutePath, normalized);
                    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
                    await fs.promises.writeFile(absolutePath, await session.screenshot());
                    ctx.notifyFileChanged(absolutePath, normalized);
                    return `Saved browser screenshot to ${normalized}`;
                });
            },
        },
        { definition: { type: 'function', function: { name: 'browser_console', description: 'Return recent console messages from the current browser page.', parameters: { type: 'object', properties: {} } } }, handler: async () => ({ success: true, result: session.getConsoleLines().join('\n') || 'No browser console messages captured.' }) },
        { definition: { type: 'function', function: { name: 'browser_close', description: 'Close Junior\'s browser session and remove its temporary profile.', parameters: { type: 'object', properties: {} } } }, handler: async () => { await session.close(); return { success: true, result: 'Browser session closed.' }; } },
    ];
    return { entries, dispose: () => session.close() };
}