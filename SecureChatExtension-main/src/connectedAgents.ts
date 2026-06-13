/**
 * Connected Agents — remote agents (e.g. Agent2Agent / A2A endpoints) that the
 * active persona can *delegate* to for specialized knowledge or actions.
 *
 * A connected agent is NOT a persona you switch into. It is a reusable helper
 * that gets surfaced to whichever persona is active (plain Local, a custom
 * agent, or a Dev Team member) as a `delegate_to_<agent>` tool, so Junior keeps
 * all of its local powers and "phones a friend" when useful.
 *
 * Storage:
 *   - Workspace agents:  `.vscode/junior-connected-agents.json` (committable; secrets MUST NOT live here)
 *   - Global agents:     vscode.Memento globalState key `junior.connectedAgents.global`
 *   - Secrets:           vscode.SecretStorage keyed `junior.connectedAgent.<id>.key`
 *
 * Workspace agents win over global agents on id collision.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { isValidConnectedAgentEndpoint } from './customAgents';

const WORKSPACE_FILE = path.join('.vscode', 'junior-connected-agents.json');
const GLOBAL_STATE_KEY = 'junior.connectedAgents.global';
const SECRET_KEY_PREFIX = 'junior.connectedAgent.';

export type ConnectedAgentScope = 'workspace' | 'global';
/**
 * Auth modes:
 *  - 'none':   public agent, no auth header.
 *  - 'bearer': a static bearer token kept in SecretStorage.
 *  - 'apiKey': a static secret sent under a configurable header.
 *  - 'entra':  an interactive VS Code auth session (Microsoft Entra ID by
 *              default) acquires a bearer token on demand. No secret is stored;
 *              VS Code prompts the user to sign in the first time and caches
 *              the session afterwards.
 */
export type ConnectedAgentAuth = 'none' | 'bearer' | 'apiKey' | 'entra';

export interface ConnectedAgentDef {
    /** Stable id (slug). Used as the secret key and to derive the tool name. */
    id: string;
    /** Display name shown in the picker and used in the delegation tool description. */
    name: string;
    /** Optional capability hint surfaced to the model (what this agent is good at). */
    description?: string;
    /** A2A endpoint. May be the JSON-RPC service URL or an Agent Card URL
     *  (e.g. https://host/.well-known/agent-card.json). Discovery is attempted
     *  automatically; if it fails the endpoint is used as the JSON-RPC URL. */
    endpoint: string;
    /** How to authenticate to the remote agent. */
    auth: ConnectedAgentAuth;
    /** Header name to carry the secret when auth === 'apiKey' (default 'x-api-key'). */
    headerName?: string;
    /** VS Code auth provider id when auth === 'entra' (default 'microsoft';
     *  use 'microsoft-sovereign-cloud' for Gov/sovereign clouds). */
    authProviderId?: string;
    /** OAuth scope / audience requested when auth === 'entra', e.g.
     *  'api://<app-id>/.default'. Controls the token's `aud` claim.
     *  Back-compat single-scope field; mirrors `entraScopes[0]`. */
    entraScope?: string;
    /** Full ordered list of scopes / directives passed to
     *  `vscode.authentication.getSession` when auth === 'entra'. Supports the
     *  Microsoft provider's advanced directives alongside resource scopes, e.g.
     *  `VSCODE_CLIENT_ID:<app-id>`, `VSCODE_TENANT:<tenant-id>`,
     *  `api://<app-id>/MCPaccess`. When unset, `[entraScope]` is used. */
    entraScopes?: string[];

    /** Where this agent lives. Set by the store at load time. */
    scope?: ConnectedAgentScope;
}

/** Convert a display name into a stable slug. */
export function slugifyConnectedAgentName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `agent-${Date.now()}`;
}

/** Build the function-tool name for a connected agent (safe identifier). */
export function connectedAgentToolName(id: string): string {
    const slug = id.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'agent';
    return `delegate_to_${slug}`;
}

/** Throws if the def is malformed. Returns a normalized copy. */
export function validateConnectedAgent(def: Partial<ConnectedAgentDef>): ConnectedAgentDef {
    if (!def.name || typeof def.name !== 'string' || !def.name.trim()) {
        throw new Error('Connected agent name is required.');
    }
    if (!def.endpoint || !isValidConnectedAgentEndpoint(def.endpoint)) {
        throw new Error('Connected agent URL must be an https:// URL (http:// is allowed only for localhost).');
    }
    const id = (def.id && typeof def.id === 'string' && def.id.trim()) ? def.id.trim() : slugifyConnectedAgentName(def.name);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) {
        throw new Error(`Invalid connected agent id "${id}". Use lowercase letters, numbers and hyphens.`);
    }
    const auth: ConnectedAgentAuth = def.auth === 'bearer' || def.auth === 'apiKey' || def.auth === 'entra' ? def.auth : 'none';
    let headerName: string | undefined;
    let authProviderId: string | undefined;
    let entraScope: string | undefined;
    let entraScopes: string[] | undefined;
    if (auth === 'apiKey') {
        headerName = (typeof def.headerName === 'string' && def.headerName.trim()) ? def.headerName.trim() : 'x-api-key';
        if (!/^[A-Za-z0-9-]+$/.test(headerName)) {
            throw new Error('Connected agent header name must contain only letters, numbers and hyphens.');
        }
    }
    if (auth === 'entra') {
        // Accept either the multi-scope `entraScopes` array or the legacy
        // single `entraScope` string. Normalize into a deduped ordered list.
        const rawScopes: string[] = Array.isArray(def.entraScopes)
            ? def.entraScopes
            : (typeof def.entraScope === 'string' ? [def.entraScope] : []);
        const seen = new Set<string>();
        const scopes: string[] = [];
        for (const raw of rawScopes) {
            if (typeof raw !== 'string') { continue; }
            const s = raw.trim();
            if (!s) { continue; }
            if (/\s/.test(s)) {
                throw new Error(`Invalid Entra scope "${s}". Each scope must be a single whitespace-free entry (one per line).`);
            }
            if (seen.has(s)) { continue; }
            seen.add(s);
            scopes.push(s);
        }
        if (scopes.length === 0) {
            throw new Error('Interactive bearer auth requires at least one Entra scope (audience), e.g. "api://<app-id>/.default".');
        }
        entraScopes = scopes;
        entraScope = scopes[0];
        authProviderId = (typeof def.authProviderId === 'string' && def.authProviderId.trim()) ? def.authProviderId.trim() : 'microsoft';
        if (!/^[A-Za-z0-9._-]+$/.test(authProviderId)) {
            throw new Error('Connected agent auth provider id must contain only letters, numbers, dots, dashes and underscores.');
        }
    }

    // Reject any embedded credential fields that may have been set in JSON.
    // Secrets must live in SecretStorage — never on disk.
    for (const forbidden of ['apiKey', 'key', 'token', 'secret']) {
        if ((def as any)[forbidden]) {
            throw new Error(`Connected agent credential "${forbidden}" must not be stored in JSON. Use SecretStorage.`);
        }
    }
    return {
        id,
        name: def.name.trim(),
        description: typeof def.description === 'string' && def.description.trim() ? def.description.trim() : undefined,
        endpoint: def.endpoint.replace(/\/+$/, ''),
        auth,
        headerName,
        authProviderId,
        entraScope,
        entraScopes,
    };
}

/** Strip transient fields before persisting. */
function serializeForDisk(def: ConnectedAgentDef): ConnectedAgentDef {
    const { scope: _scope, ...rest } = def;
    return rest as ConnectedAgentDef;
}

export class ConnectedAgentStore {
    /** One-shot guard so we only show the parse-failure toast once per session. */
    private static warnedWorkspaceLoad = false;

    constructor(
        private workspaceFolder: vscode.WorkspaceFolder | undefined,
        private globalState: vscode.Memento,
        private secrets: vscode.SecretStorage,
    ) {}

    static fromContext(context: vscode.ExtensionContext): ConnectedAgentStore {
        return new ConnectedAgentStore(
            vscode.workspace.workspaceFolders?.[0],
            context.globalState,
            context.secrets,
        );
    }

    private workspaceFilePath(): string | undefined {
        if (!this.workspaceFolder) { return undefined; }
        return path.join(this.workspaceFolder.uri.fsPath, WORKSPACE_FILE);
    }

    private async loadWorkspaceAgents(): Promise<ConnectedAgentDef[]> {
        const file = this.workspaceFilePath();
        if (!file || !fs.existsSync(file)) { return []; }
        try {
            const raw = await fs.promises.readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : [];
            return arr.map((d: any) => ({ ...validateConnectedAgent(d), scope: 'workspace' as const }));
        } catch (err: any) {
            const msg = err?.message || String(err);
            console.warn(`[junior] Failed to load ${WORKSPACE_FILE}: ${msg}`);
            if (!ConnectedAgentStore.warnedWorkspaceLoad) {
                ConnectedAgentStore.warnedWorkspaceLoad = true;
                vscode.window.showWarningMessage(
                    `Junior: ${WORKSPACE_FILE} could not be parsed (${msg}). Connected workspace agents are unavailable until the file is fixed.`,
                );
            }
            return [];
        }
    }

    private async saveWorkspaceAgents(agents: ConnectedAgentDef[]): Promise<void> {
        const file = this.workspaceFilePath();
        if (!file) { throw new Error('No workspace folder is open; cannot save workspace connected agent.'); }
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const payload = agents.map(serializeForDisk);
        await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    }

    private loadGlobalAgents(): ConnectedAgentDef[] {
        const raw = this.globalState.get<ConnectedAgentDef[]>(GLOBAL_STATE_KEY) || [];
        const out: ConnectedAgentDef[] = [];
        for (const d of raw) {
            try { out.push({ ...validateConnectedAgent(d), scope: 'global' }); }
            catch { /* skip invalid */ }
        }
        return out;
    }

    private async saveGlobalAgents(agents: ConnectedAgentDef[]): Promise<void> {
        await this.globalState.update(GLOBAL_STATE_KEY, agents.map(serializeForDisk));
    }

    /** List all connected agents. Workspace entries shadow global entries with the same id. */
    async list(): Promise<ConnectedAgentDef[]> {
        const ws = await this.loadWorkspaceAgents();
        const global = this.loadGlobalAgents();
        const map = new Map<string, ConnectedAgentDef>();
        for (const a of global) { map.set(a.id, a); }
        for (const a of ws) { map.set(a.id, a); }
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async get(id: string): Promise<ConnectedAgentDef | undefined> {
        const all = await this.list();
        return all.find(a => a.id === id);
    }

    async save(def: ConnectedAgentDef, scope: ConnectedAgentScope): Promise<ConnectedAgentDef> {
        const validated = (def.id && /^[a-z0-9][a-z0-9-]{0,59}$/.test(def.id)) ? def : validateConnectedAgent(def);
        if (scope === 'workspace') {
            const existing = await this.loadWorkspaceAgents();
            const next = [...existing.filter(a => a.id !== validated.id), validated];
            await this.saveWorkspaceAgents(next);
        } else {
            const existing = this.loadGlobalAgents();
            const next = [...existing.filter(a => a.id !== validated.id), validated];
            await this.saveGlobalAgents(next);
        }
        return { ...validated, scope };
    }

    async delete(id: string, scope: ConnectedAgentScope): Promise<void> {
        if (scope === 'workspace') {
            const existing = await this.loadWorkspaceAgents();
            await this.saveWorkspaceAgents(existing.filter(a => a.id !== id));
        } else {
            const existing = this.loadGlobalAgents();
            await this.saveGlobalAgents(existing.filter(a => a.id !== id));
        }
        try { await this.secrets.delete(SECRET_KEY_PREFIX + id + '.key'); } catch { /* ignore */ }
    }

    // ── Secrets ──

    async getKey(id: string): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEY_PREFIX + id + '.key');
    }

    async setKey(id: string, key: string | undefined): Promise<void> {
        const k = SECRET_KEY_PREFIX + id + '.key';
        if (!key) { await this.secrets.delete(k); }
        else { await this.secrets.store(k, key); }
    }
}

/**
 * Acquire a bearer token for an `auth: 'entra'` connected agent via an
 * interactive VS Code authentication session. VS Code prompts the user to sign
 * in the first time and silently reuses the cached session afterwards.
 *
 * @param interactive When true (default), shows the sign-in prompt if no
 *   session exists (`createIfNone`). Pass false to only reuse a cached session
 *   without prompting (`silent`) — useful for background calls.
 * @returns the access token, or undefined if unavailable / sign-in declined.
 */
export async function acquireConnectedAgentEntraToken(
    agent: Pick<ConnectedAgentDef, 'auth' | 'authProviderId' | 'entraScope' | 'entraScopes'>,
    interactive = true,
): Promise<string | undefined> {
    const scopes = (agent.entraScopes && agent.entraScopes.length)
        ? agent.entraScopes
        : (agent.entraScope ? [agent.entraScope] : []);
    if (agent.auth !== 'entra' || scopes.length === 0) { return undefined; }
    const providerId = (agent.authProviderId || 'microsoft').trim() || 'microsoft';
    try {
        const session = await vscode.authentication.getSession(
            providerId,
            scopes,
            interactive ? { createIfNone: true } : { silent: true },
        );
        return session?.accessToken;
    } catch {
        return undefined;
    }
}

/** Exported for tests. */
export const __test = {
    WORKSPACE_FILE,
    GLOBAL_STATE_KEY,
    SECRET_KEY_PREFIX,
};
