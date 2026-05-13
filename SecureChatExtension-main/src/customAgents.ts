/**
 * Custom Agents — user-defined personas with their own system prompt and
 * optional Azure AI Search grounding.
 *
 * Storage:
 *   - Workspace agents:  `.vscode/junior-agents.json` (committable; secrets MUST NOT live here)
 *   - Workspace agent files: `.github/agents/*.agent.md` and `.copilot/agents/*.agent.md` (read-only)
 *   - Global agents:     vscode.Memento globalState key `junior.customAgents.global`
 *   - Secrets:           vscode.SecretStorage keyed `junior.customAgent.<id>.searchKey`
 *
 * Workspace agents win over global agents on id collision.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const WORKSPACE_FILE = path.join('.vscode', 'junior-agents.json');
const WORKSPACE_AGENT_MD_DIRS = [path.join('.github', 'agents'), path.join('.copilot', 'agents')];
const GLOBAL_STATE_KEY = 'junior.customAgents.global';
const SECRET_KEY_PREFIX = 'junior.customAgent.';

export type CustomAgentScope = 'workspace' | 'global';
export type CustomAgentSource = 'junior' | 'agent-md';

export type CustomAgentSearchAuth = 'key' | 'entra';
export type CustomAgentSearchQueryType = 'simple' | 'semantic' | 'hybrid';

export interface CustomAgentEmbeddingConfig {
    /** Azure OpenAI / APIM endpoint that hosts the embedding deployment, e.g. https://my-aoai.openai.azure.com */
    endpoint: string;
    /** Deployment name of the embedding model (e.g. 'text-embedding-3-small'). */
    deployment: string;
    /** REST API version (default 2024-10-21). */
    apiVersion?: string;
    /** How to authenticate to the embedding endpoint. */
    auth: CustomAgentSearchAuth;
    /** Optional auth-provider override (Entra; mirrors search.authProviderId). */
    authProviderId?: string;
    /** Optional Entra scope override (default 'https://cognitiveservices.azure.com/.default'). */
    entraScope?: string;
    /** Comma-separated list of vector field names in the index to match against. */
    vectorFields: string;
}

export interface CustomAgentSearchConfig {
    /** Service endpoint, e.g. https://my-search.search.windows.net */
    endpoint: string;
    /** Index to query. */
    indexName: string;
    /** How to authenticate to AI Search. */
    auth: CustomAgentSearchAuth;
    /** Maximum result documents to return per call (default 5). */
    topK?: number;
    /** Field names to project (defaults to all). */
    select?: string[];
    /** Query mode (default 'semantic'). */
    queryType?: CustomAgentSearchQueryType;
    /** Required when queryType === 'semantic'. */
    semanticConfiguration?: string;
    /** REST API version (default 2024-07-01). */
    apiVersion?: string;
    /** Optional VS Code auth provider id for Entra auth.
     *  Defaults are derived from the endpoint hostname:
     *    - public cloud (*.search.windows.net)             -> 'microsoft'
     *    - any other suffix (sovereign / private cloud)    -> 'microsoft-sovereign-cloud'
     *  Override this to pin a specific provider (e.g. always 'microsoft-sovereign-cloud'
     *  with a `microsoft-sovereign-cloud.environment` setting of 'AzureUSGovernment',
     *  'AzureChinaCloud', or a `customEnvironment` block). */
    authProviderId?: string;
    /** Optional full Entra scope to request for the bearer token, e.g.
     *  'https://search.azure.com/.default', 'https://search.azure.us/.default',
     *  or a custom audience for an isolated cloud. If omitted, derived from
     *  the endpoint hostname. */
    entraScope?: string;
    /** Optional embedding configuration. When present and queryType === 'hybrid',
     *  the tool embeds the user's query and adds vectorQueries to the search
     *  request, producing real hybrid (keyword + vector + semantic-reranker) results. */
    embedding?: CustomAgentEmbeddingConfig;
}

export interface CustomAgentDef {
    /** Stable id (slug). Used as filename and secret key. */
    id: string;
    /** Display name shown in the picker. */
    name: string;
    /** Optional one-line description. */
    description?: string;
    /** Persona system prompt. Used verbatim (the loop appends a small tool-protocol footer). */
    systemPrompt: string;
    /** Optional Azure AI Search grounding. */
    search?: CustomAgentSearchConfig;
    /** Where this agent lives. Set by the store at load time. */
    scope?: CustomAgentScope;
    /** Source format for the agent definition. `.agent.md` files are discovered read-only. */
    source?: CustomAgentSource;
    /** True when the agent should not be edited/deleted through Junior's custom-agent editor. */
    readonly?: boolean;
}

/** Validate that an endpoint is an https URL with a hostname.
 *  Used for both AI Search endpoints and Azure OpenAI embedding endpoints —
 *  the only transport-level requirement is https + hostname; sovereign /
 *  private-cloud suffixes are intentionally allowed. */
export function isValidHttpsEndpoint(endpoint: string): boolean {
    try {
        const u = new URL(endpoint);
        if (u.protocol !== 'https:') { return false; }
        if (!u.hostname || u.hostname.includes(' ')) { return false; }
        return true;
    } catch {
        return false;
    }
}

/** @deprecated Use isValidHttpsEndpoint. Kept for callers prior to the rename. */
export const isValidSearchEndpoint = isValidHttpsEndpoint;

/** Convert a display name into a stable slug. */
export function slugifyAgentName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `agent-${Date.now()}`;
}

/** Throws if the def is malformed. Returns a normalized copy. */
export function validateCustomAgent(def: Partial<CustomAgentDef>): CustomAgentDef {
    if (!def.name || typeof def.name !== 'string' || !def.name.trim()) {
        throw new Error('Custom agent name is required.');
    }
    if (!def.systemPrompt || typeof def.systemPrompt !== 'string' || !def.systemPrompt.trim()) {
        throw new Error('Custom agent system prompt is required.');
    }
    const id = (def.id && typeof def.id === 'string' && def.id.trim()) ? def.id.trim() : slugifyAgentName(def.name);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) {
        throw new Error(`Invalid agent id "${id}". Use lowercase letters, numbers and hyphens.`);
    }
    const out: CustomAgentDef = {
        id,
        name: def.name.trim(),
        description: def.description?.trim() || undefined,
        systemPrompt: def.systemPrompt,
    };
    if (def.search) {
        const s = def.search;
        if (!s.endpoint || !isValidHttpsEndpoint(s.endpoint)) {
            throw new Error('Search endpoint must be an https:// URL.');
        }
        if (!s.indexName || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(s.indexName)) {
            throw new Error('Search indexName is required and must be a valid Azure AI Search index name.');
        }
        if (s.auth !== 'key' && s.auth !== 'entra') {
            throw new Error('Search auth must be "key" or "entra".');
        }
        const queryType: CustomAgentSearchQueryType = s.queryType ?? 'semantic';
        if (queryType === 'semantic' && !s.semanticConfiguration) {
            // Fall back to "default" — this is the standard semantic config name in many indexes.
            // We don't throw, just normalize.
        }
        out.search = {
            endpoint: s.endpoint.replace(/\/+$/, ''),
            indexName: s.indexName,
            auth: s.auth,
            topK: typeof s.topK === 'number' && s.topK > 0 ? Math.min(s.topK, 25) : 5,
            select: Array.isArray(s.select) ? s.select.filter(x => typeof x === 'string') : undefined,
            queryType,
            semanticConfiguration: s.semanticConfiguration || (queryType === 'semantic' ? 'default' : undefined),
            apiVersion: s.apiVersion || '2024-07-01',
            authProviderId: typeof s.authProviderId === 'string' && s.authProviderId.trim() ? s.authProviderId.trim() : undefined,
            entraScope: typeof s.entraScope === 'string' && s.entraScope.trim() ? s.entraScope.trim() : undefined,
        };
        // Reject any embedded credential fields that may have been set in JSON.
        // Secrets must live in SecretStorage — never on disk.
        for (const forbidden of ['apiKey', 'key', 'adminKey', 'queryKey']) {
            if ((s as any)[forbidden]) {
                throw new Error(`Search credential "${forbidden}" must not be stored in the agent JSON. Use SecretStorage.`);
            }
        }
        if (s.embedding) {
            const e = s.embedding;
            if (!e.endpoint || !isValidHttpsEndpoint(e.endpoint)) {
                throw new Error('Embedding endpoint must be an https:// URL.');
            }
            if (!e.deployment || typeof e.deployment !== 'string' || !e.deployment.trim()) {
                throw new Error('Embedding deployment is required.');
            }
            if (e.auth !== 'key' && e.auth !== 'entra') {
                throw new Error('Embedding auth must be "key" or "entra".');
            }
            if (!e.vectorFields || typeof e.vectorFields !== 'string' || !e.vectorFields.trim()) {
                throw new Error('Embedding vectorFields is required (comma-separated index field names).');
            }
            for (const forbidden of ['apiKey', 'key']) {
                if ((e as any)[forbidden]) {
                    throw new Error(`Embedding credential "${forbidden}" must not be stored in the agent JSON. Use SecretStorage.`);
                }
            }
            out.search!.embedding = {
                endpoint: e.endpoint.replace(/\/+$/, ''),
                deployment: e.deployment.trim(),
                apiVersion: e.apiVersion || '2024-10-21',
                auth: e.auth,
                authProviderId: typeof e.authProviderId === 'string' && e.authProviderId.trim() ? e.authProviderId.trim() : undefined,
                entraScope: typeof e.entraScope === 'string' && e.entraScope.trim() ? e.entraScope.trim() : undefined,
                vectorFields: e.vectorFields.split(',').map(x => x.trim()).filter(Boolean).join(','),
            };
        }
    }
    return out;
}

/** Strip transient fields and credential-shaped extras before persisting. */
function serializeForDisk(def: CustomAgentDef): CustomAgentDef {
    const { scope: _scope, source: _source, readonly: _readonly, ...rest } = def;
    return rest as CustomAgentDef;
}

interface AgentMarkdownFrontmatter {
    name?: string;
    description?: string;
}

function parseAgentMarkdown(raw: string): { metadata: AgentMarkdownFrontmatter; body: string } {
    if (!raw.startsWith('---')) {
        return { metadata: {}, body: raw.trimStart() };
    }

    const end = raw.indexOf('\n---', 3);
    if (end === -1) {
        return { metadata: {}, body: raw.trimStart() };
    }

    const frontmatter = raw.slice(3, end).trim();
    const after = raw.indexOf('\n', end + 4);
    const body = after === -1 ? '' : raw.slice(after + 1).trimStart();
    const metadata: AgentMarkdownFrontmatter = {};

    for (const line of frontmatter.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) { continue; }
        const key = match[1].toLowerCase();
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'name') { metadata.name = value; }
        if (key === 'description') { metadata.description = value; }
    }

    return { metadata, body };
}

function buildAgentMdCompatibilityPrompt(systemPrompt: string, relPath: string): string {
    const compatibility = `\n\n## Junior compatibility\nThis agent was discovered from \`${relPath}\`. Follow that agent definition as your primary persona.\n\nJunior provides a \`runSubagent\` tool for delegated teammate work when this agent is active. Use \`runSubagent\` for Squad spawns instead of platform-specific tools such as \`task\`. Include the Squad member name in \`agentName\` or \`name\`, and include the visible working label in \`description\`. Multiple \`runSubagent\` calls in one turn can run concurrently. Junior ignores Squad template model labels such as Claude/Sonnet names and runs every coordinator/subagent call through the currently selected Junior model; do not display those template labels as if they are active. For Squad projects, preserve the file-backed workflow: read and update \`.squad/\` files, keep agent decisions inspectable, and summarize each squad member's work clearly by name.`;
    return `${systemPrompt.trim()}${compatibility}`;
}

export class CustomAgentStore {
    /** One-shot guard so we only show the parse-failure toast once per session. */
    private static warnedWorkspaceLoad = false;

    constructor(
        private workspaceFolder: vscode.WorkspaceFolder | undefined,
        private globalState: vscode.Memento,
        private secrets: vscode.SecretStorage,
    ) {}

    static fromContext(context: vscode.ExtensionContext): CustomAgentStore {
        return new CustomAgentStore(
            vscode.workspace.workspaceFolders?.[0],
            context.globalState,
            context.secrets,
        );
    }

    private workspaceFilePath(): string | undefined {
        if (!this.workspaceFolder) { return undefined; }
        return path.join(this.workspaceFolder.uri.fsPath, WORKSPACE_FILE);
    }

    private async loadWorkspaceAgents(): Promise<CustomAgentDef[]> {
        const file = this.workspaceFilePath();
        if (!file || !fs.existsSync(file)) { return []; }
        try {
            const raw = await fs.promises.readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.agents) ? parsed.agents : [];
            return arr.map((d: any) => ({ ...validateCustomAgent(d), scope: 'workspace' as const, source: 'junior' as const }));
        } catch (err: any) {
            const msg = err?.message || String(err);
            console.warn(`[junior] Failed to load ${WORKSPACE_FILE}: ${msg}`);
            if (!CustomAgentStore.warnedWorkspaceLoad) {
                CustomAgentStore.warnedWorkspaceLoad = true;
                vscode.window.showWarningMessage(
                    `Junior: ${WORKSPACE_FILE} could not be parsed (${msg}). Custom workspace agents are unavailable until the file is fixed.`,
                );
            }
            return [];
        }
    }

    private async loadWorkspaceAgentMarkdown(): Promise<CustomAgentDef[]> {
        if (!this.workspaceFolder) { return []; }
        const out: CustomAgentDef[] = [];

        for (const relDir of WORKSPACE_AGENT_MD_DIRS) {
            const absDir = path.join(this.workspaceFolder.uri.fsPath, relDir);
            if (!fs.existsSync(absDir)) { continue; }
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(absDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.agent.md')) { continue; }
                const absPath = path.join(absDir, entry.name);
                const relPath = path.join(relDir, entry.name).replace(/\\/g, '/');
                try {
                    const raw = await fs.promises.readFile(absPath, 'utf8');
                    const { metadata, body } = parseAgentMarkdown(raw);
                    const name = metadata.name || entry.name.replace(/\.agent\.md$/i, '').replace(/[-_]+/g, ' ');
                    const validated = validateCustomAgent({
                        id: `agent-md-${slugifyAgentName(name)}`,
                        name,
                        description: metadata.description || `${relPath} workspace agent`,
                        systemPrompt: buildAgentMdCompatibilityPrompt(body || raw, relPath),
                    });
                    out.push({
                        ...validated,
                        scope: 'workspace',
                        source: 'agent-md',
                        readonly: true,
                    });
                } catch (err: any) {
                    console.warn(`[junior] Failed to load ${relPath}: ${err?.message || String(err)}`);
                }
            }
        }

        return out;
    }

    private async saveWorkspaceAgents(agents: CustomAgentDef[]): Promise<void> {
        const file = this.workspaceFilePath();
        if (!file) { throw new Error('No workspace folder is open; cannot save workspace agent.'); }
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const payload = agents.map(serializeForDisk);
        await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    }

    private loadGlobalAgents(): CustomAgentDef[] {
        const raw = this.globalState.get<CustomAgentDef[]>(GLOBAL_STATE_KEY) || [];
        const out: CustomAgentDef[] = [];
        for (const d of raw) {
            try { out.push({ ...validateCustomAgent(d), scope: 'global', source: 'junior' }); }
            catch { /* skip invalid */ }
        }
        return out;
    }

    private async saveGlobalAgents(agents: CustomAgentDef[]): Promise<void> {
        await this.globalState.update(GLOBAL_STATE_KEY, agents.map(serializeForDisk));
    }

    /** List all agents. Workspace entries shadow global entries with the same id. */
    async list(): Promise<CustomAgentDef[]> {
        const ws = await this.loadWorkspaceAgents();
        const agentMd = await this.loadWorkspaceAgentMarkdown();
        const global = this.loadGlobalAgents();
        const map = new Map<string, CustomAgentDef>();
        for (const a of global) { map.set(a.id, a); }
        for (const a of ws) { map.set(a.id, a); }
        for (const a of agentMd) { map.set(a.id, a); }
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async get(id: string): Promise<CustomAgentDef | undefined> {
        const all = await this.list();
        return all.find(a => a.id === id);
    }

    async save(def: CustomAgentDef, scope: CustomAgentScope): Promise<CustomAgentDef> {
        // Callers (the editor) typically pass an already-validated def. We only
        // re-validate when the def doesn't already carry a normalized id, which
        // catches direct programmatic callers without paying the cost twice.
        const validated = (def.id && /^[a-z0-9][a-z0-9-]{0,59}$/.test(def.id)) ? def : validateCustomAgent(def);
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

    async delete(id: string, scope: CustomAgentScope): Promise<void> {
        if (scope === 'workspace') {
            const existing = await this.loadWorkspaceAgents();
            await this.saveWorkspaceAgents(existing.filter(a => a.id !== id));
        } else {
            const existing = this.loadGlobalAgents();
            await this.saveGlobalAgents(existing.filter(a => a.id !== id));
        }
        // Best-effort: drop the secrets too.
        try { await this.secrets.delete(SECRET_KEY_PREFIX + id + '.searchKey'); } catch { /* ignore */ }
        try { await this.secrets.delete(SECRET_KEY_PREFIX + id + '.embeddingKey'); } catch { /* ignore */ }
    }

    // ── Secrets ──

    async getSearchKey(id: string): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEY_PREFIX + id + '.searchKey');
    }

    async setSearchKey(id: string, key: string | undefined): Promise<void> {
        const k = SECRET_KEY_PREFIX + id + '.searchKey';
        if (!key) { await this.secrets.delete(k); }
        else { await this.secrets.store(k, key); }
    }

    async getEmbeddingKey(id: string): Promise<string | undefined> {
        return this.secrets.get(SECRET_KEY_PREFIX + id + '.embeddingKey');
    }

    async setEmbeddingKey(id: string, key: string | undefined): Promise<void> {
        const k = SECRET_KEY_PREFIX + id + '.embeddingKey';
        if (!key) { await this.secrets.delete(k); }
        else { await this.secrets.store(k, key); }
    }
}

/** Exported for tests. */
export const __test = {
    WORKSPACE_FILE,
    GLOBAL_STATE_KEY,
    SECRET_KEY_PREFIX,
};
