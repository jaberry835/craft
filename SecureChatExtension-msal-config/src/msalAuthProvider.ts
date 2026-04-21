/**
 * MSAL-based authentication provider for Junior.
 *
 * Provides bearer-token acquisition for Azure / Entra-ID protected endpoints
 * using `@azure/msal-node` `PublicClientApplication`. This is the alternative
 * to `vscode.authentication.getSession` when the built-in providers cannot
 * reach a tenant — e.g. custom sovereign clouds (partner
 * environments) where the first-party VS Code app registration is not
 * present and we must use our own.
 *
 * Acquisition strategy (mirrors the canonical MSAL pattern):
 *   1. acquireTokenSilent against the persisted cache (handles refresh).
 *   2. On `InteractionRequiredAuthError`, fall back to interactive flow:
 *        - "browser":     acquireTokenInteractive with loopback redirect.
 *        - "device-code": acquireTokenByDeviceCode (printed to output channel
 *                         + surfaced to the user via showInformationMessage).
 *
 * The provider holds one `PublicClientApplication` per (clientId, authority)
 * tuple in a process-wide map so that token caches can be reused across
 * call sites within a single VS Code session.
 *
 * Token caches are persisted to SecretStorage via `msalCachePlugin.ts` so
 * sign-in survives extension reloads and VS Code restarts.
 */
import * as vscode from 'vscode';
import {
    AccountInfo,
    AuthenticationResult,
    AzureCloudInstance,
    Configuration,
    DeviceCodeRequest,
    InteractiveRequest,
    LogLevel,
    PublicClientApplication,
    SilentFlowRequest,
} from '@azure/msal-node';
import { buildCacheStorageKey, createSecretStorageCachePlugin } from './msalCachePlugin';

export type MsalInteractiveFlow = 'browser' | 'device-code';

export interface MsalConfig {
    clientId: string;
    /** Tenant id, "common", "organizations", or "consumers". */
    tenantId: string;
    /**
     * Full authority URL, e.g.
     *   https://login.microsoftonline.com/common
     *   https://login.microsoftonline.us/<tenant>
     *   https://login.microsoftonline.<suffix>/<tenant>
     *
     * If unset, derived from `cloudInstance` + `tenantId`.
     */
    authority?: string;
    /** Authorization endpoint host, defaults to the commercial cloud. */
    cloudInstance?: string;
    /**
     * Redirect URI registered on the app reg. Defaults to "http://localhost"
     * which MSAL Node will satisfy with a one-shot loopback listener.
     */
    redirectUri?: string;
    /** Whether to use a system-browser interactive flow or device-code flow. */
    interactiveFlow?: MsalInteractiveFlow;
    /**
     * Additional known authorities (for B2C, ADFS, or sovereign tenants
     * whose hosts MSAL must trust without an OIDC discovery round-trip).
     */
    knownAuthorities?: string[];
}

export interface ResolvedAccessToken {
    accessToken: string;
    expiresOn?: Date;
    account: {
        username: string;
        tenantId: string;
        homeAccountId: string;
        environment?: string;
    };
    authority: string;
    clientId: string;
    fromCache: boolean;
}

export interface AcquireTokenOptions {
    /**
     * If true, prompt interactively when no cached token can be refreshed.
     * If false, throw a typed error so callers can decide whether to prompt.
     */
    interactive?: boolean;
    /** Restrict silent acquire to a specific account (multi-account scenarios). */
    accountHomeId?: string;
    /** Force interactive even if a silent token would succeed. */
    forceRefresh?: boolean;
    /** Optional cancellation signal forwarded to the interactive flow. */
    cancellationToken?: vscode.CancellationToken;
}

/**
 * Thrown by acquireToken when interactive sign-in is required but the caller
 * passed `interactive: false`. Lets request paths short-circuit cleanly.
 */
export class MsalInteractionRequiredError extends Error {
    constructor(public readonly config: MsalConfig, public readonly scopes: string[]) {
        super('Interactive MSAL sign-in is required to acquire a token.');
        this.name = 'MsalInteractionRequiredError';
    }
}

interface PcaEntry {
    pca: PublicClientApplication;
    cacheKey: string;
    config: MsalConfig;
    authority: string;
}

let pcaCache = new Map<string, PcaEntry>();
let secretsHandle: vscode.SecretStorage | undefined;
let logHandle: ((msg: string) => void) | undefined;
let initialized = false;

/**
 * Initialize the provider with the extension's SecretStorage handle and
 * (optionally) a log function. Must be called once during `activate()`
 * before any token acquisition.
 */
export function initMsalAuthProvider(
    secrets: vscode.SecretStorage,
    log?: (msg: string) => void,
): void {
    secretsHandle = secrets;
    logHandle = log;
    initialized = true;
}

/** For tests — clear the per-(clientId, authority) PCA singleton cache. */
export function resetMsalAuthProviderForTests(): void {
    pcaCache = new Map();
    secretsHandle = undefined;
    logHandle = undefined;
    initialized = false;
}

function ensureInitialized(): void {
    if (!initialized || !secretsHandle) {
        throw new Error('MSAL auth provider is not initialized. Call initMsalAuthProvider() during activate().');
    }
}

function buildAuthorityUrl(config: MsalConfig): string {
    if (config.authority && config.authority.trim().length > 0) {
        return config.authority.replace(/\/+$/, '');
    }
    const instance = (config.cloudInstance && config.cloudInstance.trim().length > 0)
        ? config.cloudInstance.replace(/\/+$/, '')
        : 'https://login.microsoftonline.com';
    const tenant = (config.tenantId || 'common').trim();
    return `${instance}/${tenant}`;
}

/**
 * Extracts the host from an authority URL. Used to seed `knownAuthorities`
 * automatically so MSAL skips its instance-discovery call to
 * `login.microsoftonline.com/common/discovery/instance` — that call fails
 * (with `endpoints_resolution_error`) on networks that can't reach the
 * commercial cloud, e.g. Azure US Gov / China / air-gapped environments.
 */
function authorityHost(authorityUrl: string): string | undefined {
    try {
        return new URL(authorityUrl).host.toLowerCase();
    } catch {
        return undefined;
    }
}

/**
 * Maps well-known sovereign authority hosts to MSAL's hardcoded
 * `AzureCloudInstance` so MSAL uses the correct sovereign metadata. Returns
 * undefined for the commercial public cloud (the MSAL default) and for
 * custom/unknown hosts (those rely on `knownAuthorities`).
 */
function detectAzureCloudInstance(host: string | undefined): AzureCloudInstance | undefined {
    if (!host) { return undefined; }
    if (host === 'login.microsoftonline.us') { return AzureCloudInstance.AzureUsGovernment; }
    if (host === 'login.partner.microsoftonline.cn'
        || host === 'login.chinacloudapi.cn') { return AzureCloudInstance.AzureChina; }
    return undefined;
}

function buildPcaCacheKey(clientId: string, authority: string): string {
    return `${clientId}@${authority}`;
}

function getOrCreatePca(config: MsalConfig): PcaEntry {
    ensureInitialized();
    if (!config.clientId || !config.clientId.trim()) {
        throw new Error('MSAL clientId is required (set junior.msal.clientId).');
    }

    const authority = buildAuthorityUrl(config);
    const key = buildPcaCacheKey(config.clientId, authority);
    const existing = pcaCache.get(key);
    if (existing) {
        return existing;
    }

    const cacheKey = buildCacheStorageKey(config.clientId, authority);
    const cachePlugin = createSecretStorageCachePlugin(secretsHandle!, cacheKey, logHandle);

    // Always include the authority's own host in knownAuthorities. This is
    // required for any non-commercial host (Gov/China/custom/dev
    // tenants); leaving it out causes MSAL to attempt instance discovery
    // against login.microsoftonline.com which fails fast with
    // `endpoints_resolution_error` on isolated networks. Including the host
    // for the commercial cloud is harmless — MSAL still uses its hardcoded
    // metadata for that host.
    const userKnownAuthorities = (config.knownAuthorities ?? []).filter(h => h && h.trim().length > 0);
    const host = authorityHost(authority);
    const knownAuthorities = host && !userKnownAuthorities.includes(host)
        ? [host, ...userKnownAuthorities]
        : userKnownAuthorities;

    // For published sovereign clouds, also pass azureCloudOptions so MSAL uses
    // its built-in sovereign endpoint metadata instead of trying to discover
    // it. This is belt-and-suspenders alongside knownAuthorities.
    const azureCloudInstance = detectAzureCloudInstance(host);

    const msalConfig: Configuration = {
        auth: {
            clientId: config.clientId,
            authority,
            knownAuthorities: knownAuthorities.length > 0 ? knownAuthorities : undefined,
            ...(azureCloudInstance ? {
                azureCloudOptions: {
                    azureCloudInstance,
                    tenant: (config.tenantId || 'common').trim(),
                },
            } : {}),
            // NOTE: msal-node's NodeAuthOptions does not accept redirectUri.
            // For the loopback (browser) flow msal-node listens on
            // http://localhost with an ephemeral port. The configured
            // `junior.msal.redirectUri` is reserved for future flows that
            // accept a custom loopbackClient implementation.
        },
        cache: { cachePlugin },
        system: {
            loggerOptions: {
                logLevel: LogLevel.Warning,
                piiLoggingEnabled: false,
                loggerCallback: (level, message, containsPii) => {
                    if (containsPii) { return; }
                    if (level === LogLevel.Error || level === LogLevel.Warning) {
                        logHandle?.(`[msal] ${LogLevel[level]}: ${message}`);
                    }
                },
            },
        },
    };

    logHandle?.(
        `[msal] PCA created clientId=${config.clientId} authority=${authority} ` +
        `knownAuthorities=${JSON.stringify(knownAuthorities)} ` +
        `azureCloudInstance=${azureCloudInstance ?? 'AzurePublic'}`
    );

    const pca = new PublicClientApplication(msalConfig);
    const entry: PcaEntry = { pca, cacheKey, config, authority };
    pcaCache.set(key, entry);
    return entry;
}

function toResolvedToken(
    result: AuthenticationResult,
    entry: PcaEntry,
    fromCache: boolean,
): ResolvedAccessToken {
    return {
        accessToken: result.accessToken,
        expiresOn: result.expiresOn ?? undefined,
        account: {
            username: result.account?.username ?? '',
            tenantId: result.account?.tenantId ?? '',
            homeAccountId: result.account?.homeAccountId ?? '',
            environment: result.account?.environment,
        },
        authority: entry.authority,
        clientId: entry.config.clientId,
        fromCache,
    };
}

async function pickAccount(entry: PcaEntry, accountHomeId?: string): Promise<AccountInfo | undefined> {
    const accounts = await entry.pca.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
        return undefined;
    }
    if (accountHomeId) {
        return accounts.find(a => a.homeAccountId === accountHomeId) ?? undefined;
    }
    if (accounts.length === 1) {
        return accounts[0];
    }
    // Multiple accounts: prefer the most recently used (MSAL doesn't track
    // last-use, so fall back to first deterministic ordering by username).
    return [...accounts].sort((a, b) => a.username.localeCompare(b.username))[0];
}

async function acquireSilent(
    entry: PcaEntry,
    scopes: string[],
    options: AcquireTokenOptions,
): Promise<ResolvedAccessToken | undefined> {
    if (options.forceRefresh) {
        return undefined;
    }
    const account = await pickAccount(entry, options.accountHomeId);
    if (!account) {
        return undefined;
    }
    const request: SilentFlowRequest = { account, scopes };
    try {
        const result = await entry.pca.acquireTokenSilent(request);
        if (result?.accessToken) {
            logHandle?.(`[msal] silent acquire OK clientId=${entry.config.clientId} authority=${entry.authority} account=${account.username} scopes=${JSON.stringify(scopes)}`);
            return toResolvedToken(result, entry, true);
        }
        return undefined;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logHandle?.(`[msal] silent acquire failed (will fall back to interactive if allowed): ${message}`);
        return undefined;
    }
}

async function acquireInteractiveBrowser(
    entry: PcaEntry,
    scopes: string[],
    options: AcquireTokenOptions,
): Promise<ResolvedAccessToken> {
    // NOTE: msal-node's InteractiveRequest explicitly Omit's `redirectUri` —
    // the loopback server picks an ephemeral port automatically. The
    // configured `junior.msal.redirectUri` is honored by the PCA constructor
    // (auth.redirectUri) for other flows; for the loopback flow the listener
    // address is determined at runtime.
    const request: InteractiveRequest = {
        scopes,
        openBrowser: async (url) => {
            await vscode.env.openExternal(vscode.Uri.parse(url));
        },
        successTemplate: '<html><body><h2>Sign-in complete.</h2><p>You can close this window and return to VS Code.</p></body></html>',
        errorTemplate: '<html><body><h2>Sign-in failed.</h2><p>Return to VS Code to retry.</p></body></html>',
    };

    if (options.cancellationToken) {
        // MSAL Node does not accept a cancellation token directly. We surface
        // a cancellation by racing against the user-cancellation event so the
        // caller can unblock; the underlying loopback server cleanup happens
        // on next acquire.
        const interactive = entry.pca.acquireTokenInteractive(request);
        const cancelled = new Promise<never>((_, reject) => {
            const sub = options.cancellationToken!.onCancellationRequested(() => {
                sub.dispose();
                reject(new vscode.CancellationError());
            });
        });
        const result = await Promise.race([interactive, cancelled]);
        return toResolvedToken(result, entry, false);
    }

    const result = await entry.pca.acquireTokenInteractive(request);
    return toResolvedToken(result, entry, false);
}

async function acquireDeviceCode(
    entry: PcaEntry,
    scopes: string[],
    options: AcquireTokenOptions,
): Promise<ResolvedAccessToken> {
    let cancellationDisposable: vscode.Disposable | undefined;
    let resolveResult: AuthenticationResult | undefined;
    try {
        const request: DeviceCodeRequest = {
            scopes,
            deviceCodeCallback: (response) => {
                logHandle?.(`[msal] device-code: ${response.message}`);
                // Surface the verification URL + code as a copyable info popup.
                void vscode.window.showInformationMessage(
                    `Junior MSAL sign-in: open ${response.verificationUri} and enter code ${response.userCode}.`,
                    'Open page',
                    'Copy code',
                ).then(async (choice) => {
                    if (choice === 'Open page') {
                        await vscode.env.openExternal(vscode.Uri.parse(response.verificationUri));
                    } else if (choice === 'Copy code') {
                        await vscode.env.clipboard.writeText(response.userCode);
                        void vscode.window.showInformationMessage('Device code copied to clipboard.');
                    }
                });
            },
        };

        if (options.cancellationToken) {
            (request as DeviceCodeRequest & { cancel?: boolean }).cancel = false;
            cancellationDisposable = options.cancellationToken.onCancellationRequested(() => {
                (request as DeviceCodeRequest & { cancel?: boolean }).cancel = true;
            });
        }

        resolveResult = (await entry.pca.acquireTokenByDeviceCode(request)) ?? undefined;
        if (!resolveResult) {
            throw new Error('Device-code acquisition returned no result.');
        }
        return toResolvedToken(resolveResult, entry, false);
    } finally {
        cancellationDisposable?.dispose();
    }
}

/**
 * Acquire an access token for the given config + scopes.
 * Tries silent first, then falls back to interactive when allowed.
 */
export async function acquireMsalToken(
    config: MsalConfig,
    scopes: string[],
    options: AcquireTokenOptions = {},
): Promise<ResolvedAccessToken> {
    const entry = getOrCreatePca(config);
    const normalizedScopes = (scopes ?? []).map(s => s.trim()).filter(s => s.length > 0);
    if (normalizedScopes.length === 0) {
        throw new Error('At least one scope is required to acquire an MSAL token.');
    }

    const silent = await acquireSilent(entry, normalizedScopes, options);
    if (silent) {
        return silent;
    }

    if (!options.interactive) {
        throw new MsalInteractionRequiredError(config, normalizedScopes);
    }

    const flow = config.interactiveFlow ?? 'browser';
    logHandle?.(`[msal] interactive acquire start flow=${flow} clientId=${entry.config.clientId} authority=${entry.authority} scopes=${JSON.stringify(normalizedScopes)}`);
    const acquired = flow === 'device-code'
        ? await acquireDeviceCode(entry, normalizedScopes, options)
        : await acquireInteractiveBrowser(entry, normalizedScopes, options);
    logHandle?.(`[msal] interactive acquire OK account=${acquired.account.username}`);
    return acquired;
}

/** Returns all accounts known to the cache for a given config (for sign-out / picker UIs). */
export async function listMsalAccounts(config: MsalConfig): Promise<AccountInfo[]> {
    const entry = getOrCreatePca(config);
    return entry.pca.getTokenCache().getAllAccounts();
}

/** Remove an account from the persisted cache (does not revoke tokens server-side). */
export async function signOutMsalAccount(config: MsalConfig, homeAccountId: string): Promise<boolean> {
    const entry = getOrCreatePca(config);
    const cache = entry.pca.getTokenCache();
    const accounts = await cache.getAllAccounts();
    const target = accounts.find(a => a.homeAccountId === homeAccountId);
    if (!target) {
        return false;
    }
    await cache.removeAccount(target);
    logHandle?.(`[msal] signed out account=${target.username} clientId=${entry.config.clientId} authority=${entry.authority}`);
    return true;
}

/** Drop all in-memory PCA singletons. Useful when settings change at runtime. */
export function invalidateMsalProviderCache(): void {
    pcaCache = new Map();
}
