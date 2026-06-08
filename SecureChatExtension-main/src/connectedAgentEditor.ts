/**
 * Connected Agent Editor — webview panel for creating/editing a connected
 * (remote A2A) agent that personas can delegate to.
 *
 * Form fields:
 *   - Name (required)
 *   - Capability hint (optional, surfaced to the model)
 *   - Scope: Workspace (committable) | Global (this user)
 *   - Agent URL (required, https — JSON-RPC service or Agent Card URL)
 *   - Auth: None | Bearer token (stored) | Bearer token (Microsoft sign-in) |
 *           API key header (+ header name + secret)
 *
 * Styled with VS Code theme tokens to feel native.
 */
import * as vscode from 'vscode';
import {
    ConnectedAgentDef,
    ConnectedAgentScope,
    ConnectedAgentStore,
    slugifyConnectedAgentName,
    validateConnectedAgent,
} from './connectedAgents';

export interface ConnectedAgentEditorOptions {
    /** When provided, edits an existing agent; otherwise creates a new one. */
    existing?: ConnectedAgentDef;
    /** Called after a successful save. */
    onSaved?: (agent: ConnectedAgentDef) => void;
}

export class ConnectedAgentEditor {
    static readonly viewType = 'junior.connectedAgentEditor';

    private constructor() {}

    static async open(
        context: vscode.ExtensionContext,
        store: ConnectedAgentStore,
        options: ConnectedAgentEditorOptions = {},
    ): Promise<void> {
        const isEdit = !!options.existing;
        const panel = vscode.window.createWebviewPanel(
            ConnectedAgentEditor.viewType,
            isEdit ? `Edit Connected Agent: ${options.existing!.name}` : 'Connect Cloud Agent',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        const initial = options.existing;
        const initialKey = initial ? await store.getKey(initial.id) : undefined;

        panel.webview.html = renderHtml(panel.webview, initial, initialKey);

        panel.webview.onDidReceiveMessage(async (msg: EditorWebviewMessage) => {
            try {
                switch (msg.type) {
                    case 'save': {
                        const def = validateConnectedAgent({
                            id: initial?.id ?? slugifyConnectedAgentName(msg.payload.name),
                            name: msg.payload.name,
                            description: msg.payload.description,
                            endpoint: msg.payload.endpoint,
                            auth: msg.payload.auth,
                            headerName: msg.payload.headerName,
                            authProviderId: msg.payload.authProviderId,
                            entraScope: msg.payload.entraScope,
                        });
                        const scope: ConnectedAgentScope = msg.payload.scope === 'global' ? 'global' : 'workspace';
                        if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
                            panel.webview.postMessage({ type: 'error', message: 'No workspace folder is open. Choose Global scope instead.' });
                            return;
                        }
                        const saved = await store.save(def, scope);
                        // Only the static secret modes ('bearer'/'apiKey') persist a secret;
                        // 'entra' acquires tokens interactively and stores nothing.
                        if ((def.auth === 'bearer' || def.auth === 'apiKey') && typeof msg.payload.key === 'string') {
                            await store.setKey(saved.id, msg.payload.key || undefined);
                        }
                        panel.webview.postMessage({ type: 'saved', id: saved.id });
                        options.onSaved?.(saved);
                        vscode.window.showInformationMessage(`Connected agent "${saved.name}" saved.`);
                        panel.dispose();
                        break;
                    }
                    case 'cancel':
                        panel.dispose();
                        break;
                }
            } catch (err: any) {
                panel.webview.postMessage({ type: 'error', message: err?.message || String(err) });
            }
        }, undefined, context.subscriptions);
    }
}

// ── Webview message contract ──

type EditorWebviewMessage =
    | {
        type: 'save';
        payload: {
            name: string;
            description?: string;
            scope: 'workspace' | 'global';
            endpoint: string;
            auth: 'none' | 'bearer' | 'apiKey' | 'entra';
            headerName?: string;
            key?: string;
            authProviderId?: string;
            entraScope?: string;
        };
    }
    | { type: 'cancel' };

// ── HTML ──

function renderHtml(webview: vscode.Webview, initial: ConnectedAgentDef | undefined, initialKey: string | undefined): string {
    const nonce = randomNonce();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        `img-src ${webview.cspSource} data:`,
    ].join('; ');

    const data = {
        name: initial?.name ?? '',
        description: initial?.description ?? '',
        scope: initial?.scope ?? 'workspace',
        endpoint: initial?.endpoint ?? '',
        auth: initial?.auth ?? 'none',
        headerName: initial?.headerName ?? '',
        authProviderId: initial?.authProviderId ?? '',
        entraScope: initial?.entraScope ?? '',
        hasKey: !!initialKey,
        isEdit: !!initial,
    };

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
:root { color-scheme: light dark; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 0;
}
main { padding: 28px 36px; max-width: 680px; margin: 0 auto; }
h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 24px; font-size: 13px; }
.field { margin-bottom: 18px; }
.field label { display: block; font-weight: 600; font-size: 12px; margin-bottom: 6px; }
.field .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
input[type="text"], input[type="password"], select {
    width: 100%;
    box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
}
input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
.row { display: flex; gap: 12px; }
.row > .field { flex: 1; }
.actions { margin-top: 28px; display: flex; gap: 8px; justify-content: flex-end; }
button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 14px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.banner { padding: 8px 12px; border-radius: 3px; font-size: 12.5px; margin-bottom: 14px; }
.banner.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.has-key-note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
</style>
</head>
<body>
<main>
    <h2>${data.isEdit ? 'Edit Connected Agent' : 'Connect Cloud Agent'}</h2>
    <p class="subtitle">Register a remote Agent2Agent (A2A) agent that Junior can <strong>delegate</strong> to. Enable it from the mode menu and the active persona gains a tool to hand tasks or questions to it. Junior keeps all of its local powers; the remote reply is treated as untrusted data.</p>

    <div id="banner" class="banner error" style="display:none"></div>

    <div class="field">
        <label for="name">Name</label>
        <input id="name" type="text" placeholder="e.g. Billing Specialist" value="${escapeHtml(data.name)}" ${data.isEdit ? 'readonly' : ''}/>
        <div class="hint">${data.isEdit ? 'The agent id is fixed once created.' : 'A short display name. Used to derive the delegation tool name.'}</div>
    </div>

    <div class="field">
        <label for="description">Capability hint (optional)</label>
        <input id="description" type="text" placeholder="What the remote agent is good at — surfaced to the model" value="${escapeHtml(data.description)}" />
        <div class="hint">Helps Junior decide when to delegate, e.g. "answers billing and invoicing questions".</div>
    </div>

    <div class="field">
        <label for="scope">Scope</label>
        <select id="scope">
            <option value="workspace" ${data.scope === 'workspace' ? 'selected' : ''}>Workspace (.vscode/junior-connected-agents.json — shareable via git)</option>
            <option value="global" ${data.scope === 'global' ? 'selected' : ''}>Global (this VS Code user only)</option>
        </select>
    </div>

    <div class="field">
        <label for="endpoint">Agent URL</label>
        <input id="endpoint" type="text" placeholder="https://my-agent.example.com  (or .../.well-known/agent-card.json)" value="${escapeHtml(data.endpoint)}" />
        <div class="hint">The A2A JSON-RPC service URL, or an Agent Card URL. Junior auto-discovers the card at <code>/.well-known/agent-card.json</code> when given a base URL. Use <code>https://</code> — plain <code>http://</code> is allowed only for <code>localhost</code> dev agents.</div>
    </div>

    <div class="field">
        <label for="auth">Authentication</label>
        <select id="auth">
            <option value="none" ${data.auth === 'none' ? 'selected' : ''}>None (public agent)</option>
            <option value="bearer" ${data.auth === 'bearer' ? 'selected' : ''}>Bearer token (paste &amp; store)</option>
            <option value="entra" ${data.auth === 'entra' ? 'selected' : ''}>Bearer token (Microsoft sign-in — interactive)</option>
            <option value="apiKey" ${data.auth === 'apiKey' ? 'selected' : ''}>API key header</option>
        </select>
        <div class="hint">Choose <strong>Microsoft sign-in</strong> to let VS Code acquire the bearer token interactively — nothing is stored on disk.</div>
    </div>

    <div class="field" id="headerNameField" style="display:none">
        <label for="headerName">Header name</label>
        <input id="headerName" type="text" placeholder="x-api-key" value="${escapeHtml(data.headerName)}" />
        <div class="hint">Header the API key is sent under. Defaults to <code>x-api-key</code>.</div>
    </div>

    <div class="field" id="keyField" style="display:none">
        <label for="key">Token / API key</label>
        <input id="key" type="password" placeholder="${data.hasKey ? '•••••••• (saved — leave blank to keep)' : 'Paste the bearer token or API key'}" />
        <div class="has-key-note">Stored only in VS Code SecretStorage; never written to JSON.</div>
    </div>

    <div class="field" id="entraScopeField" style="display:none">
        <label for="entraScope">Sign-in scope (audience)</label>
        <input id="entraScope" type="text" placeholder="api://&lt;app-id&gt;/.default" value="${escapeHtml(data.entraScope)}" />
        <div class="hint">The OAuth scope requested at sign-in; controls the token's <code>aud</code> claim. Usually the remote agent's App ID URI followed by <code>/.default</code>.</div>
    </div>

    <div class="field" id="authProviderField" style="display:none">
        <label for="authProviderId">Auth provider (optional)</label>
        <input id="authProviderId" type="text" placeholder="microsoft" value="${escapeHtml(data.authProviderId)}" />
        <div class="hint">VS Code auth provider id. Defaults to <code>microsoft</code>; use <code>microsoft-sovereign-cloud</code> for Gov / sovereign clouds.</div>
    </div>

    <button type="button" class="secondary" id="btnTest">Validate URL</button>
    <span id="testResult" style="margin-left:10px; font-size:12px;"></span>

    <div class="actions">
        <button type="button" class="secondary" id="btnCancel">Cancel</button>
        <button type="button" id="btnSave">${data.isEdit ? 'Save Changes' : 'Connect Agent'}</button>
    </div>
</main>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const auth = $('auth');
const keyField = $('keyField');
const headerNameField = $('headerNameField');
const entraScopeField = $('entraScopeField');
const authProviderField = $('authProviderField');
function syncAuthFields() {
    const v = auth.value;
    keyField.style.display = (v === 'bearer' || v === 'apiKey') ? '' : 'none';
    headerNameField.style.display = v === 'apiKey' ? '' : 'none';
    entraScopeField.style.display = v === 'entra' ? '' : 'none';
    authProviderField.style.display = v === 'entra' ? '' : 'none';
}
auth.addEventListener('change', syncAuthFields);
syncAuthFields();

function showError(msg) {
    const b = $('banner');
    b.textContent = msg;
    b.style.display = 'block';
    b.className = 'banner error';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('btnSave').addEventListener('click', () => {
    const authVal = $('auth').value;
    const payload = {
        name: $('name').value.trim(),
        description: $('description').value.trim() || undefined,
        scope: $('scope').value,
        endpoint: $('endpoint').value.trim(),
        auth: authVal,
        headerName: authVal === 'apiKey' ? ($('headerName').value.trim() || undefined) : undefined,
        key: (authVal === 'bearer' || authVal === 'apiKey') ? $('key').value : undefined,
        entraScope: authVal === 'entra' ? ($('entraScope').value.trim() || undefined) : undefined,
        authProviderId: authVal === 'entra' ? ($('authProviderId').value.trim() || undefined) : undefined,
    };
    vscode.postMessage({ type: 'save', payload });
});

$('btnCancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
$('btnTest').addEventListener('click', () => {
    const el = $('testResult');
    let ok = false;
    try {
        const u = new URL($('endpoint').value.trim());
        const loopback = u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(u.hostname);
        ok = !!u.hostname && (u.protocol === 'https:' || (u.protocol === 'http:' && loopback));
    } catch (e) { ok = false; }
    el.textContent = ok ? 'URL looks valid.' : 'URL must be an https:// URL (http:// only for localhost).';
    el.style.color = ok ? 'var(--vscode-testing-iconPassed, var(--vscode-foreground))' : 'var(--vscode-errorForeground)';
});

window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'error') { showError(msg.message); }
});
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) { s += chars[Math.floor(Math.random() * chars.length)]; }
    return s;
}
