/**
 * Junior Dev Team Editor — webview panel for creating/editing a team composed
 * of custom agents, roles, permissions, routing hints, and model preferences.
 */
import * as vscode from 'vscode';
import { CustomAgentDef } from './customAgents';
import { DevTeamDef, DevTeamScope, DevTeamStore, validateDevTeam } from './devTeams';

export interface DevTeamEditorOptions {
    existing?: DevTeamDef;
    customAgents: CustomAgentDef[];
    models: Array<{ name: string; deploymentId: string }>;
    onSaved?: (team: DevTeamDef) => void;
}

export class DevTeamEditor {
    static readonly viewType = 'junior.devTeamEditor';

    private constructor() {}

    static async open(
        context: vscode.ExtensionContext,
        store: DevTeamStore,
        options: DevTeamEditorOptions,
    ): Promise<void> {
        const isEdit = !!options.existing;
        const panel = vscode.window.createWebviewPanel(
            DevTeamEditor.viewType,
            isEdit ? `Edit Dev Team: ${options.existing!.name}` : 'Create Junior Dev Team',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        panel.webview.html = renderHtml(panel.webview, options);
        panel.webview.onDidReceiveMessage(async (msg: EditorWebviewMessage) => {
            try {
                switch (msg.type) {
                    case 'save': {
                        const def = validateDevTeam({
                            ...msg.payload.team,
                            id: options.existing?.id ?? msg.payload.team.id,
                        });
                        const scope: DevTeamScope = msg.payload.scope === 'global' ? 'global' : 'workspace';
                        if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
                            panel.webview.postMessage({ type: 'error', message: 'No workspace folder is open. Choose Global scope instead.' });
                            return;
                        }
                        const saved = await store.save(def, scope);
                        panel.webview.postMessage({ type: 'saved', id: saved.id });
                        options.onSaved?.(saved);
                        vscode.window.showInformationMessage(`Junior Dev Team "${saved.name}" saved.`);
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

type EditorWebviewMessage =
    | { type: 'save'; payload: { scope: 'workspace' | 'global'; team: DevTeamDef } }
    | { type: 'cancel' };

function renderHtml(webview: vscode.Webview, options: DevTeamEditorOptions): string {
    const nonce = randomNonce();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const initial = options.existing ?? defaultTeam();
    const data = safeJson({
        team: initial,
        scope: options.existing?.scope ?? 'workspace',
        agents: options.customAgents.map(agent => ({ id: agent.id, name: agent.name, description: agent.description, scope: agent.scope })),
        models: options.models,
        isEdit: !!options.existing,
    });

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
    display: flex;
    min-height: 100vh;
}
.sidebar {
    width: 210px;
    background: var(--vscode-sideBar-background);
    border-right: 1px solid var(--vscode-panel-border);
    padding: 18px 14px;
    box-sizing: border-box;
}
.sidebar h1 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.72; margin: 0 0 10px; }
.nav-item { padding: 6px 10px; border-radius: 4px; font-size: 13px; }
.nav-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
main { flex: 1; padding: 28px 36px; max-width: 920px; box-sizing: border-box; }
h2 { font-size: 19px; font-weight: 600; margin: 0 0 4px; }
.subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 22px; font-size: 13px; }
.field { margin-bottom: 16px; }
.field label { display: block; font-weight: 600; font-size: 12px; margin-bottom: 6px; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
input[type="text"], textarea, select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
}
textarea { min-height: 56px; resize: vertical; }
input:focus, textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
.row { display: flex; gap: 12px; }
.row > .field { flex: 1; }
.templates { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-bottom: 18px; }
.template-btn { text-align: left; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; cursor: pointer; }
.template-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.template-title { display: block; font-weight: 600; margin-bottom: 3px; }
.template-desc { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
.section { margin-top: 22px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.section-header { padding: 10px 14px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); }
.section-header h3 { margin: 0; font-size: 13px; }
.section-body { padding: 14px; }
.member-row, .route-row { display: grid; gap: 8px; align-items: end; margin-bottom: 10px; }
.member-row { grid-template-columns: minmax(130px, 1fr) minmax(150px, 1.15fr) 112px minmax(130px, 1fr) 34px; }
.route-row { grid-template-columns: minmax(160px, 1fr) minmax(180px, 1.2fr) 34px; }
.mini-label { display: block; font-size: 10.5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
.icon-btn { height: 30px; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
.icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.add-row { margin-top: 6px; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; }
button { padding: 6px 13px; border-radius: 2px; cursor: pointer; font-size: 13px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 26px; }
.banner { padding: 8px 12px; border-radius: 3px; font-size: 12.5px; margin-bottom: 14px; }
.banner.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.empty-note { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 4px 0 10px; }
@media (max-width: 720px) {
    body { display: block; }
    .sidebar { width: auto; border-right: none; border-bottom: 1px solid var(--vscode-panel-border); }
    main { padding: 22px; }
    .member-row, .route-row, .row { display: block; }
    .member-row > div, .route-row > div { margin-bottom: 8px; }
}
</style>
</head>
<body>
<aside class="sidebar">
    <h1>Dev Team</h1>
    <div class="nav-item active">General</div>
    <div class="nav-item">Members</div>
    <div class="nav-item">Routing</div>
</aside>
<main>
    <h2>${options.existing ? 'Edit Junior Dev Team' : 'Create Junior Dev Team'}</h2>
    <p class="subtitle">Compose custom agents into a coordinated team with roles, model preferences, and safe permissions.</p>
    <div id="banner"></div>

    <div class="templates" id="templates"></div>

    <div class="row">
        <div class="field">
            <label for="name">Name</label>
            <input id="name" type="text" />
        </div>
        <div class="field">
            <label for="scope">Scope</label>
            <select id="scope">
                <option value="workspace">Workspace</option>
                <option value="global">Global</option>
            </select>
            <div class="hint">Workspace teams are saved in .vscode/junior-dev-teams.json.</div>
        </div>
    </div>
    <div class="field">
        <label for="description">Description</label>
        <textarea id="description"></textarea>
    </div>

    <div class="section">
        <div class="section-header"><h3>Members</h3></div>
        <div class="section-body">
            <div id="members"></div>
            <button id="add-member" class="secondary add-row" type="button">Add member</button>
            <div class="hint">Only members marked Can edit should apply file changes. Review-only members contribute critique and findings.</div>
        </div>
    </div>

    <div class="section">
        <div class="section-header"><h3>How They Help</h3></div>
        <div class="section-body">
            <div id="routes"></div>
            <button id="add-route" class="secondary add-row" type="button">Add routing hint</button>
        </div>
    </div>

    <div class="section">
        <div class="section-header"><h3>Team Memory</h3></div>
        <div class="section-body">
            <label><input id="memory" type="checkbox" /> Remember team decisions in this workspace</label>
            <div class="hint">This prepares the team to use inspectable repo notes as the runtime grows.</div>
        </div>
    </div>

    <div class="actions">
        <button id="cancel" class="secondary" type="button">Cancel</button>
        <button id="save" class="primary" type="button">Save Dev Team</button>
    </div>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const state = ${data};
let team = JSON.parse(JSON.stringify(state.team));
let scope = state.scope || 'workspace';

const templates = [
    { id: 'balanced', title: 'Balanced Dev Team', desc: 'Lead, reviewer, tester', members: [
        { id: 'lead-engineer', role: 'Lead Engineer', permission: 'write' },
        { id: 'code-reviewer', role: 'Code Reviewer', permission: 'review' },
        { id: 'test-engineer', role: 'Test Engineer', permission: 'review' },
    ], routing: [
        { id: 'implementation', pattern: 'implement|fix|build|refactor', memberIds: ['lead-engineer', 'code-reviewer', 'test-engineer'] },
        { id: 'tests', pattern: 'test|coverage|regression', memberIds: ['test-engineer'] },
        { id: 'review', pattern: 'review|risk|security', memberIds: ['code-reviewer'] },
    ] },
    { id: 'review', title: 'Review Team', desc: 'Architecture, security, tests', members: [
        { id: 'architecture-reviewer', role: 'Architecture Reviewer', permission: 'review' },
        { id: 'security-reviewer', role: 'Security Reviewer', permission: 'review' },
        { id: 'test-reviewer', role: 'Test Reviewer', permission: 'review' },
    ], routing: [
        { id: 'security', pattern: 'security|auth|permission|secret', memberIds: ['security-reviewer'] },
        { id: 'architecture', pattern: 'architecture|design|dependency|api', memberIds: ['architecture-reviewer'] },
        { id: 'tests', pattern: 'test|coverage|regression', memberIds: ['test-reviewer'] },
    ] },
    { id: 'feature', title: 'Feature Team', desc: 'Plan, build, test, docs', members: [
        { id: 'planner', role: 'Planner', permission: 'review' },
        { id: 'implementer', role: 'Implementer', permission: 'write' },
        { id: 'tester', role: 'Tester', permission: 'review' },
        { id: 'docs-writer', role: 'Docs Writer', permission: 'review' },
    ], routing: [
        { id: 'planning', pattern: 'plan|design|approach', memberIds: ['planner'] },
        { id: 'implementation', pattern: 'implement|build|fix', memberIds: ['implementer', 'tester'] },
        { id: 'docs', pattern: 'docs|readme|guide', memberIds: ['docs-writer'] },
    ] },
];

function el(id) { return document.getElementById(id); }
function showError(message) { el('banner').innerHTML = message ? '<div class="banner error">' + escapeHtml(message) + '</div>' : ''; }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function nextId(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 8); }

function renderTemplates() {
    const host = el('templates');
    if (state.isEdit) { host.style.display = 'none'; return; }
    host.innerHTML = templates.map(t => '<button class="template-btn" type="button" data-template="' + t.id + '"><span class="template-title">' + escapeHtml(t.title) + '</span><span class="template-desc">' + escapeHtml(t.desc) + '</span></button>').join('');
    host.querySelectorAll('[data-template]').forEach(btn => btn.addEventListener('click', () => {
        const selected = templates.find(t => t.id === btn.dataset.template);
        team.name = selected.title;
        team.description = selected.desc;
        team.members = selected.members.map(m => ({ ...m }));
        team.routing = selected.routing.map(r => ({ ...r, memberIds: [...r.memberIds] }));
        syncFields();
        renderMembers();
        renderRoutes();
    }));
}

function agentOptions(selected) {
    const base = ['<option value="">Role only</option>'];
    state.agents.forEach(agent => base.push('<option value="' + escapeHtml(agent.id) + '"' + (agent.id === selected ? ' selected' : '') + '>' + escapeHtml(agent.name) + '</option>'));
    return base.join('');
}

function modelOptions(selected) {
    const base = ['<option value="">Use current model</option>'];
    state.models.forEach(model => base.push('<option value="' + escapeHtml(model.deploymentId) + '"' + (model.deploymentId === selected ? ' selected' : '') + '>' + escapeHtml(model.name || model.deploymentId) + '</option>'));
    return base.join('');
}

function renderMembers() {
    const host = el('members');
    if (!team.members || team.members.length === 0) {
        host.innerHTML = '<div class="empty-note">No members yet.</div>';
        return;
    }
    host.innerHTML = team.members.map((member, index) => '<div class="member-row" data-index="' + index + '">' +
        '<div><span class="mini-label">Role</span><input type="text" data-field="role" value="' + escapeHtml(member.role) + '"></div>' +
        '<div><span class="mini-label">Custom agent</span><select data-field="agentId">' + agentOptions(member.agentId) + '</select></div>' +
        '<div><span class="mini-label">Permission</span><select data-field="permission"><option value="write"' + (member.permission === 'write' ? ' selected' : '') + '>Can edit</option><option value="review"' + (member.permission === 'review' ? ' selected' : '') + '>Review only</option><option value="read"' + (member.permission === 'read' ? ' selected' : '') + '>Read only</option></select></div>' +
        '<div><span class="mini-label">Model</span><select data-field="deploymentId">' + modelOptions(member.deploymentId) + '</select></div>' +
        '<button class="icon-btn" type="button" data-remove-member="' + index + '" title="Remove member">×</button>' +
        '</div>').join('');
    host.querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', onMemberChange));
    host.querySelectorAll('[data-remove-member]').forEach(btn => btn.addEventListener('click', () => {
        const index = Number(btn.dataset.removeMember);
        const removed = team.members.splice(index, 1)[0];
        if (removed) {
            team.routing = (team.routing || []).map(route => ({ ...route, memberIds: route.memberIds.filter(id => id !== removed.id) }));
        }
        renderMembers();
        renderRoutes();
    }));
}

function onMemberChange(event) {
    const row = event.target.closest('.member-row');
    const member = team.members[Number(row.dataset.index)];
    const field = event.target.dataset.field;
    const value = event.target.value;
    if (field === 'role') {
        member.role = value;
        renderRoutes();
    } else if (field === 'agentId') {
        if (value) {
            member.agentId = value;
            const selectedAgent = state.agents.find(agent => agent.id === value);
            if (selectedAgent && (!member.role || member.role === 'New Member' || member.role === 'Member')) {
                member.role = selectedAgent.name;
                renderMembers();
            }
        } else {
            delete member.agentId;
        }
        renderRoutes();
    } else if (value) {
        member[field] = value;
    } else {
        delete member[field];
    }
}

function routeMemberOptions(selectedIds) {
    return (team.members || []).map(member => '<label><input type="checkbox" value="' + escapeHtml(member.id) + '"' + (selectedIds.includes(member.id) ? ' checked' : '') + '> ' + escapeHtml(member.role || member.id) + '</label>').join('<br>');
}

function renderRoutes() {
    const host = el('routes');
    if (!team.routing || team.routing.length === 0) {
        host.innerHTML = '<div class="empty-note">No routing hints yet.</div>';
        return;
    }
    host.innerHTML = team.routing.map((route, index) => '<div class="route-row" data-index="' + index + '">' +
        '<div><span class="mini-label">When task mentions</span><input type="text" data-route-field="pattern" value="' + escapeHtml(route.pattern) + '"></div>' +
        '<div><span class="mini-label">Include</span><div data-route-members>' + routeMemberOptions(route.memberIds || []) + '</div></div>' +
        '<button class="icon-btn" type="button" data-remove-route="' + index + '" title="Remove routing hint">×</button>' +
        '</div>').join('');
    host.querySelectorAll('[data-route-field]').forEach(input => input.addEventListener('input', onRouteChange));
    host.querySelectorAll('[data-route-members] input').forEach(input => input.addEventListener('change', onRouteChange));
    host.querySelectorAll('[data-remove-route]').forEach(btn => btn.addEventListener('click', () => {
        team.routing.splice(Number(btn.dataset.removeRoute), 1);
        renderRoutes();
    }));
}

function onRouteChange(event) {
    const row = event.target.closest('.route-row');
    const route = team.routing[Number(row.dataset.index)];
    route.pattern = row.querySelector('[data-route-field]').value;
    route.memberIds = Array.from(row.querySelectorAll('[data-route-members] input:checked')).map(input => input.value);
}

function syncFields() {
    el('name').value = team.name || '';
    el('description').value = team.description || '';
    el('scope').value = scope;
    el('memory').checked = team.memoryEnabled !== false;
}

function collectTeam() {
    team.name = el('name').value;
    team.description = el('description').value;
    team.memoryEnabled = el('memory').checked;
    team.id = team.id || team.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return team;
}

el('add-member').addEventListener('click', () => {
    team.members = team.members || [];
    team.members.push({ id: nextId('member'), role: 'New Member', permission: 'review' });
    renderMembers();
    renderRoutes();
});
el('add-route').addEventListener('click', () => {
    team.routing = team.routing || [];
    team.routing.push({ id: nextId('route'), pattern: '', memberIds: team.members?.[0] ? [team.members[0].id] : [] });
    renderRoutes();
});
el('scope').addEventListener('change', () => { scope = el('scope').value; });
el('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
el('save').addEventListener('click', () => {
    showError('');
    vscode.postMessage({ type: 'save', payload: { scope: el('scope').value, team: collectTeam() } });
});
window.addEventListener('message', event => {
    if (event.data?.type === 'error') { showError(event.data.message); }
});

renderTemplates();
syncFields();
renderMembers();
renderRoutes();
</script>
</body>
</html>`;
}

function defaultTeam(): DevTeamDef {
    return {
        id: '',
        name: 'Balanced Dev Team',
        description: 'Lead, reviewer, and tester working together under Junior coordination.',
        memoryEnabled: true,
        members: [
            { id: 'lead-engineer', role: 'Lead Engineer', permission: 'write' },
            { id: 'code-reviewer', role: 'Code Reviewer', permission: 'review' },
            { id: 'test-engineer', role: 'Test Engineer', permission: 'review' },
        ],
        routing: [
            { id: 'implementation', pattern: 'implement|fix|build|refactor', memberIds: ['lead-engineer', 'code-reviewer', 'test-engineer'] },
            { id: 'tests', pattern: 'test|coverage|regression', memberIds: ['test-engineer'] },
            { id: 'review', pattern: 'review|risk|security', memberIds: ['code-reviewer'] },
        ],
    };
}

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
