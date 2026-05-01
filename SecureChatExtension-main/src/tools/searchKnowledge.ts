/**
 * searchKnowledge — Azure AI Search grounding tool registered for custom agents
 * that have a configured `search` block.
 *
 * The model decides when to call this; results are returned as untrusted data
 * (wrapped with the JUNIOR_UNTRUSTED_TOOL_OUTPUT delimiters) so persona
 * instructions about prompt-injection apply.
 *
 * Auth modes:
 *   - 'key':   uses the per-agent secret stored in vscode.SecretStorage
 *              (set via the custom agent editor; never persisted to disk).
 *   - 'entra': uses VS Code's Microsoft auth provider. Provider id and scope
 *              are derived from the endpoint cloud (sovereign-aware) and can
 *              be overridden per-agent via `search.authProviderId` and
 *              `search.entraScope`.
 *
 * Endpoint allow-listing: enforced by `isValidSearchEndpoint` in customAgents.ts;
 * we re-check at call time so a hand-edited agent JSON cannot trick us into
 * sending bearer tokens to an arbitrary host.
 */
import * as vscode from 'vscode';
import * as https from 'https';
import { URL } from 'url';
import { ToolEntry } from './types';
import { CustomAgentDef, CustomAgentSearchConfig, CustomAgentEmbeddingConfig, isValidHttpsEndpoint } from '../customAgents';

export interface Citation {
    /** 1-based result index for footnote numbering. */
    index: number;
    title: string;
    url?: string;
    snippet?: string;
    score?: number;
    rerankerScore?: number;
}

export interface SearchKnowledgeDeps {
    /** Resolves the Azure AI Search admin/query key for this agent (key auth). */
    getSearchKey(): Promise<string | undefined>;
    /** Acquires an Entra bearer token for AI Search (entra auth). */
    getEntraToken(): Promise<string | undefined>;
    /** Resolves the embedding endpoint API key (for hybrid + key embedding auth). */
    getEmbeddingKey?(): Promise<string | undefined>;
    /** Acquires an Entra bearer token for the embedding endpoint (for hybrid + entra embedding auth). */
    getEmbeddingEntraToken?(): Promise<string | undefined>;
    /** UI sink: invoked once per successful search call so the chat view can
     *  render a "Sources" card alongside the assistant's response. */
    onCitations?(payload: { agentName: string; query: string; citations: Citation[] }): void;
}

export const SEARCH_KNOWLEDGE_TOOL_NAME = 'search_knowledge';

/** Build the per-agent searchKnowledge tool entry. Returns undefined if no search config. */
export function createSearchKnowledgeTool(
    agent: CustomAgentDef,
    deps: SearchKnowledgeDeps,
): ToolEntry | undefined {
    if (!agent.search) { return undefined; }
    const cfg = agent.search;

    return {
        definition: {
            type: 'function',
            function: {
                name: SEARCH_KNOWLEDGE_TOOL_NAME,
                description:
                    `Search the "${agent.name}" knowledge base (Azure AI Search index "${cfg.indexName}") ` +
                    `for documents relevant to a query. Returns the top results with their fields. ` +
                    `Use this when you need authoritative information from the agent's grounded knowledge.`,
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Natural-language query to search for.' },
                        topK: { type: 'number', description: `How many documents to return (1-25, default ${cfg.topK ?? 5}).` },
                    },
                    required: ['query'],
                },
            },
        },
        handler: async (args) => {
            const query = String(args.query ?? '').trim();
            if (!query) { return { success: false, result: 'query is required.' }; }
            const topK = clamp(toNumber(args.topK) ?? cfg.topK ?? 5, 1, 25);

            try {
                const docs = await runSearch(cfg, deps, query, topK);
                if (docs.length === 0) {
                    // agentLoop wraps every successful tool result with the
                    // JUNIOR_UNTRUSTED_TOOL_OUTPUT markers, so we return raw text here.
                    return { success: true, result: 'No documents matched the query.' };
                }
                const citations = extractCitations(docs);
                if (deps.onCitations) {
                    try { deps.onCitations({ agentName: agent.name, query, citations }); }
                    catch { /* never let UI errors break the tool call */ }
                }
                const body = formatResults(docs, citations);
                return { success: true, result: body };
            } catch (err: any) {
                const msg = err?.message || String(err);
                return { success: false, result: `search_knowledge failed: ${msg}` };
            }
        },
    };
}

// ── internals ──

interface SearchDoc {
    score?: number;
    rerankerScore?: number;
    /** First extractive caption text returned by AI Search, when semantic was used. */
    caption?: string;
    /** First extractive caption with highlights stripped, when present. */
    captionText?: string;
    fields: Record<string, unknown>;
}

export async function runSearch(
    cfg: CustomAgentSearchConfig,
    deps: SearchKnowledgeDeps,
    query: string,
    topK: number,
): Promise<SearchDoc[]> {
    if (!isValidHttpsEndpoint(cfg.endpoint)) {
        throw new Error('Refusing to call non-https search endpoint.');
    }
    // 2024-07-01 is the current GA REST API for Azure AI Search at time of writing.
    // Bump here when newer features (richer vector query shapes etc.) are needed.
    const apiVersion = cfg.apiVersion || '2024-07-01';
    const url = `${cfg.endpoint}/indexes/${encodeURIComponent(cfg.indexName)}/docs/search?api-version=${encodeURIComponent(apiVersion)}`;

    const body: Record<string, unknown> = {
        search: query,
        top: topK,
    };
    if (cfg.select && cfg.select.length > 0) { body.select = cfg.select.join(','); }
    if (cfg.queryType === 'semantic') {
        body.queryType = 'semantic';
        body.semanticConfiguration = cfg.semanticConfiguration || 'default';
        body.captions = 'extractive';
        body.answers = 'extractive|count-1';
    } else if (cfg.queryType === 'hybrid') {
        body.queryType = 'semantic';
        body.semanticConfiguration = cfg.semanticConfiguration || 'default';
        body.captions = 'extractive';
        if (cfg.embedding) {
            // Real hybrid: embed the query and add a vectorQueries entry alongside
            // the keyword search. Semantic ranker re-ranks the merged result set.
            const vector = await embedQuery(cfg.embedding, deps, query);
            if (vector) {
                body.vectorQueries = [{
                    kind: 'vector',
                    vector,
                    fields: cfg.embedding.vectorFields,
                    k: Math.max(topK * 2, 10),
                }];
            }
        }
        // If no embedding is configured we still ship the keyword + semantic-ranker
        // request — a graceful degrade rather than a hard failure.
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth === 'key') {
        const key = await deps.getSearchKey();
        if (!key) { throw new Error('No search key configured for this agent. Set it in the agent editor.'); }
        headers['api-key'] = key;
    } else {
        const token = await deps.getEntraToken();
        if (!token) { throw new Error('No Entra token available for AI Search.'); }
        headers['authorization'] = `Bearer ${token}`;
    }

    const json = await postJson(url, headers, JSON.stringify(body));
    const results = Array.isArray(json?.value) ? json.value : [];
    return results.map((r: Record<string, unknown>) => {
        const score = typeof r['@search.score'] === 'number' ? (r['@search.score'] as number) : undefined;
        const rerankerScore = typeof r['@search.rerankerScore'] === 'number' ? (r['@search.rerankerScore'] as number) : undefined;
        const captionsRaw = r['@search.captions'];
        let caption: string | undefined;
        let captionText: string | undefined;
        if (Array.isArray(captionsRaw) && captionsRaw.length > 0) {
            const first = captionsRaw[0] as Record<string, unknown>;
            if (typeof first?.highlights === 'string') { caption = first.highlights as string; }
            if (typeof first?.text === 'string') { captionText = first.text as string; }
        }
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
            if (k.startsWith('@search.')) { continue; }
            fields[k] = v;
        }
        return { score, rerankerScore, caption, captionText, fields };
    });
}

/** Embed a query string using the agent's embedding deployment. Returns undefined on failure. */
async function embedQuery(
    cfg: CustomAgentEmbeddingConfig,
    deps: SearchKnowledgeDeps,
    query: string,
): Promise<number[] | undefined> {
    if (!isValidHttpsEndpoint(cfg.endpoint)) { return undefined; }
    // 2024-10-21 is the GA AOAI REST API for embeddings (input + dimensions).
    const apiVersion = cfg.apiVersion || '2024-10-21';
    const url = `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.auth === 'key') {
        const key = deps.getEmbeddingKey ? await deps.getEmbeddingKey() : undefined;
        if (!key) { throw new Error('No embedding key configured. Set it in the agent editor.'); }
        headers['api-key'] = key;
    } else {
        const token = deps.getEmbeddingEntraToken ? await deps.getEmbeddingEntraToken() : undefined;
        if (!token) { throw new Error('No Entra token available for the embedding endpoint.'); }
        headers['authorization'] = `Bearer ${token}`;
    }
    const json = await postJson(url, headers, JSON.stringify({ input: query }));
    const vec = json?.data?.[0]?.embedding;
    return Array.isArray(vec) ? vec as number[] : undefined;
}

/** Heuristically pick a title / url / snippet for each result, suitable for a
 *  Sources card and footnote-style citations. */
export function extractCitations(docs: SearchDoc[]): Citation[] {
    return docs.map((doc, i) => {
        const f = doc.fields;
        const title = pickTitle(f) || `Result ${i + 1}`;
        const url = pickUrl(f);
        const snippet = doc.captionText || pickSnippet(f);
        return {
            index: i + 1,
            title,
            url,
            snippet: snippet ? truncate(snippet, 280) : undefined,
            score: doc.score,
            rerankerScore: doc.rerankerScore,
        };
    });
}

function pickTitle(f: Record<string, unknown>): string | undefined {
    for (const k of ['title', 'name', 'displayName', 'metadata_title', 'metadata_storage_name', 'fileName', 'id']) {
        const v = f[k];
        if (typeof v === 'string' && v.trim()) { return v.trim(); }
    }
    // Fall back to a short-ish string field that looks like a phrase (has a
    // letter and some whitespace/punctuation), so we don't pick noise like
    // `language: "en"` or boolean-shaped flags.
    for (const v of Object.values(f)) {
        if (typeof v !== 'string') { continue; }
        const s = v.trim();
        if (!s || s.length >= 200) { continue; }
        if (/[A-Za-z]/.test(s) && /[\s\-_:.,/]/.test(s)) { return s; }
    }
    return undefined;
}

function pickUrl(f: Record<string, unknown>): string | undefined {
    for (const k of ['url', 'uri', 'sourceUrl', 'webUrl', 'metadata_storage_path', 'source']) {
        const v = f[k];
        if (typeof v !== 'string' || !v) { continue; }
        // metadata_storage_path is base64url(blob URL) by convention.
        if (k === 'metadata_storage_path') {
            const decoded = tryDecodeBase64Url(v);
            if (decoded && /^https?:\/\//i.test(decoded)) { return decoded; }
            continue;
        }
        if (/^https?:\/\//i.test(v)) { return v; }
    }
    return undefined;
}

function pickSnippet(f: Record<string, unknown>): string | undefined {
    for (const k of ['content', 'text', 'chunk', 'body', 'description', 'summary']) {
        const v = f[k];
        if (typeof v === 'string' && v.trim()) { return v.trim(); }
    }
    return undefined;
}

function tryDecodeBase64Url(s: string): string | undefined {
    try {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        return Buffer.from(padded, 'base64').toString('utf8');
    } catch { return undefined; }
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatResults(docs: SearchDoc[], citations: Citation[]): string {
    const lines: string[] = [];
    docs.forEach((doc, i) => {
        const cit = citations[i];
        const scoreParts: string[] = [];
        if (typeof doc.rerankerScore === 'number') { scoreParts.push(`reranker=${doc.rerankerScore.toFixed(3)}`); }
        if (typeof doc.score === 'number') { scoreParts.push(`score=${doc.score.toFixed(3)}`); }
        lines.push(`### [${i + 1}] ${cit?.title ?? `Result ${i + 1}`}${scoreParts.length ? ` (${scoreParts.join(', ')})` : ''}`);
        if (cit?.url) { lines.push(`- **source**: ${cit.url}`); }
        if (doc.captionText) { lines.push(`- **caption**: ${truncate(doc.captionText, 500)}`); }
        for (const [k, v] of Object.entries(doc.fields)) {
            const text = formatFieldValue(v);
            lines.push(`- **${k}**: ${text}`);
        }
        lines.push('');
    });
    lines.push('When citing, refer to results by their bracketed number, e.g. "[1]".');
    return lines.join('\n').trim();
}

function formatFieldValue(v: unknown): string {
    if (v == null) { return ''; }
    if (typeof v === 'string') { return v.length > 1000 ? v.slice(0, 1000) + '…' : v; }
    if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
    try { return JSON.stringify(v).slice(0, 1000); } catch { return String(v); }
}

function postJson(urlStr: string, headers: Record<string, string>, body: string): Promise<any> {
    const TIMEOUT_MS = 30_000;
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on response body
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({
            method: 'POST',
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
            timeout: TIMEOUT_MS,
        }, (res) => {
            const chunks: Buffer[] = [];
            let total = 0;
            let aborted = false;
            res.on('data', (c: Buffer) => {
                if (aborted) { return; }
                total += c.length;
                if (total > MAX_BYTES) {
                    aborted = true;
                    res.destroy();
                    reject(new Error(`Response exceeded ${MAX_BYTES} bytes; aborting.`));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => {
                if (aborted) { return; }
                const text = Buffer.concat(chunks).toString('utf8');
                const status = res.statusCode || 0;
                if (status < 200 || status >= 300) {
                    reject(new Error(`HTTP ${status}: ${text.slice(0, 500)}`));
                    return;
                }
                try { resolve(text ? JSON.parse(text) : {}); }
                catch (e: any) { reject(new Error(`Invalid JSON from search: ${e?.message || e}`)); }
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function toNumber(v: unknown): number | undefined {
    if (typeof v === 'number' && !Number.isNaN(v)) { return v; }
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/** Acquire an Entra token for AI Search via VS Code's Microsoft auth provider.
 *
 *  Sovereign / Government clouds:
 *    - The audience (scope) varies by cloud, so we derive it from the agent's
 *      endpoint hostname when no explicit `entraScope` is set on the agent.
 *    - The auth provider id also varies — public cloud uses `microsoft`, while
 *      every other cloud uses `microsoft-sovereign-cloud`. Users on Gov / China /
 *      USNat / USSec set `microsoft-sovereign-cloud.environment` (or
 *      `customEnvironment`) in their VS Code settings.
 *    - Both can be overridden per-agent via `search.authProviderId` and
 *      `search.entraScope`.
 *
 *  We attempt the configured provider first, and if a sovereign endpoint was
 *  inferred we fall back to `microsoft` only as a last resort, never the other
 *  way around (we don't want to silently send a public-cloud token to a
 *  sovereign endpoint). */
export async function acquireSearchEntraToken(
    endpoint?: string,
    overrides?: { authProviderId?: string; entraScope?: string },
): Promise<string | undefined> {
    const scope = overrides?.entraScope || searchScopeForEndpoint(endpoint);
    const providerId = overrides?.authProviderId || searchAuthProviderForEndpoint(endpoint);
    try {
        const session = await vscode.authentication.getSession(
            providerId,
            [scope],
            { createIfNone: true },
        );
        return session?.accessToken;
    } catch {
        return undefined;
    }
}

/** Pick the VS Code auth provider id based on the endpoint cloud.
 *  Public cloud uses the built-in `microsoft` provider. Everything else routes
 *  through `microsoft-sovereign-cloud`, which respects the user's
 *  `microsoft-sovereign-cloud.environment` (or `customEnvironment`) setting. */
export function searchAuthProviderForEndpoint(endpoint?: string): string {
    try {
        if (endpoint) {
            const host = new URL(endpoint).hostname.toLowerCase();
            if (host.endsWith('.search.windows.net')) { return 'microsoft'; }
            // For any non-public hostname, route through the sovereign provider.
            return 'microsoft-sovereign-cloud';
        }
    } catch { /* fall through */ }
    return 'microsoft';
}

function searchScopeForEndpoint(endpoint?: string): string {
    try {
        if (endpoint) {
            const host = new URL(endpoint).hostname.toLowerCase();
            // Derive the audience from the hostname when it matches the
            // standard '<svc>.search.<cloud-suffix>' shape used by Azure AI
            // Search across public and sovereign clouds.
            const m = host.match(/^[^.]+\.search\.(.+)$/);
            if (m) {
                const suffix = m[1];
                // Map AI Search hostname suffix -> Entra audience suffix.
                //   windows.net -> azure.com  (public cloud quirk)
                //   azure.us    -> azure.us
                //   azure.cn    -> azure.cn
                //   *           -> use as-is
                const audience = suffix === 'windows.net' ? 'azure.com' : suffix;
                return `https://search.${audience}/.default`;
            }
        }
    } catch { /* fall through */ }
    return 'https://search.azure.com/.default';
}
