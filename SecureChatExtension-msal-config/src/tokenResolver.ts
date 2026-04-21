/**
 * Unified bearer-token resolver for Junior.
 *
 * Junior supports two distinct bearer-token sources today:
 *   1. `vscode-auth-session`  — delegates to vscode.authentication.getSession
 *                               (best path for commercial + USGov where the
 *                               first-party VS Code app reg already exists).
 *   2. `msal`                 — uses our own MSAL Public Client app reg
 *                               (required for custom sovereign tenants like
 *                               also useful for device-code
 *                               flow on remote-SSH / headless setups).
 *
 * Both the local Azure agent path (`aoaiClient`) and the Copilot CLI BYOK
 * path (`copilotSdkRuntime`) call into this module so behaviour, logging,
 * and error handling stay identical across them.
 */
import * as vscode from 'vscode';
import {
    acquireMsalToken,
    MsalConfig,
    MsalInteractionRequiredError,
    MsalInteractiveFlow,
    ResolvedAccessToken,
} from './msalAuthProvider';
import { getSetting } from './config';

/**
 * Which Junior config namespace a token is being resolved for. The two
 * namespaces have separate `authMode` / scopes / source settings but share
 * the global `junior.msal.*` MSAL configuration block.
 */
export type AuthNamespace = 'azureOpenAI' | 'copilotCli';

export type AuthSource = 'vscode-auth-session' | 'msal';

export interface VsCodeAuthSessionConfig {
    providerId: string;
    scopes: string[];
}

export interface ResolvedBearerToken {
    accessToken: string;
    source: AuthSource;
    accountLabel?: string;
    expiresOn?: Date;
    /** For msal source — the resolved authority URL the token was minted under. */
    authority?: string;
    /** For msal source — the clientId used. */
    clientId?: string;
}

export interface ResolveOptions {
    /** Allow interactive prompts. False for background request paths. */
    interactive?: boolean;
    /** Force a fresh token (bypass MSAL silent cache). */
    forceRefresh?: boolean;
    cancellationToken?: vscode.CancellationToken;
}

function normalizeStringArray(values: string[] | undefined): string[] {
    if (!Array.isArray(values)) { return []; }
    return values
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter((v): v is string => v.length > 0);
}

/**
 * Read the configured token source for a namespace. Returns undefined when
 * the namespace is not using a session/MSAL flow at all (e.g. raw api-key).
 */
export function getConfiguredAuthSource(ns: AuthNamespace): AuthSource | undefined {
    if (ns === 'azureOpenAI') {
        const authMode = (getSetting<string>('azureOpenAI.authMode') || '').trim().toLowerCase();
        if (authMode === 'msal') {
            return 'msal';
        }
        if (authMode !== 'vscode-auth-session') {
            return undefined;
        }
        const source = (getSetting<string>('azureOpenAI.bearerTokenSource') || 'vscode-auth-session')
            .trim().toLowerCase();
        if (source === 'msal') { return 'msal'; }
        if (source === 'vscode-auth-session' || source === '') { return 'vscode-auth-session'; }
        return undefined;
    }

    // copilotCli namespace
    const source = (getSetting<string>('copilotCli.providerBearerTokenSource') || '').trim().toLowerCase();
    if (source === 'msal') { return 'msal'; }
    if (source === 'vscode-auth-session') { return 'vscode-auth-session'; }
    return undefined;
}

/**
 * Read the scopes the namespace will request. Used both at acquire time and
 * by sign-in UI commands.
 */
export function getConfiguredScopes(ns: AuthNamespace): string[] {
    const key = ns === 'azureOpenAI' ? 'azureOpenAI.authScopes' : 'copilotCli.providerAuthScopes';
    return normalizeStringArray(getSetting<string[]>(key));
}

/**
 * Read the VS Code authentication provider id for the namespace. Defaults to
 * "microsoft" so existing configs continue to work.
 */
export function getConfiguredVsCodeProviderId(ns: AuthNamespace): string {
    const key = ns === 'azureOpenAI' ? 'azureOpenAI.authProviderId' : 'copilotCli.providerAuthProviderId';
    return (getSetting<string>(key) || 'microsoft').trim() || 'microsoft';
}

/**
 * Read MSAL configuration. The MSAL block is shared across namespaces — for
 * sovereign-cloud setups you typically have one app registration and one
 * authority that both the local agent and the CLI provider reuse.
 *
 * Returns undefined when MSAL has not been configured. Callers should
 * surface a clear "MSAL not configured" error when source === 'msal'.
 */
export function getMsalConfig(): MsalConfig | undefined {
    const clientId = (getSetting<string>('msal.clientId') || '').trim();
    if (!clientId) { return undefined; }

    const tenantId = (getSetting<string>('msal.tenantId') || 'common').trim() || 'common';
    const authority = (getSetting<string>('msal.authority') || '').trim() || undefined;
    const cloudInstance = (getSetting<string>('msal.cloudInstance') || '').trim() || undefined;
    const redirectUri = (getSetting<string>('msal.redirectUri') || '').trim() || undefined;
    const flowSetting = (getSetting<string>('msal.interactiveFlow') || 'browser').trim().toLowerCase();
    const interactiveFlow: MsalInteractiveFlow = flowSetting === 'device-code' ? 'device-code' : 'browser';
    const knownAuthorities = normalizeStringArray(getSetting<string[]>('msal.knownAuthorities'));

    return {
        clientId,
        tenantId,
        authority,
        cloudInstance,
        redirectUri,
        interactiveFlow,
        knownAuthorities: knownAuthorities.length > 0 ? knownAuthorities : undefined,
    };
}

/**
 * Backwards-compatible accessor: returns a vscode-auth-session config only
 * when that source is actually selected. Used by extension.ts for the
 * `onDidChangeSessions` listener (which only watches VS Code sessions).
 */
export function getVsCodeAuthSessionConfig(ns: AuthNamespace): VsCodeAuthSessionConfig | undefined {
    if (getConfiguredAuthSource(ns) !== 'vscode-auth-session') {
        return undefined;
    }
    return {
        providerId: getConfiguredVsCodeProviderId(ns),
        scopes: getConfiguredScopes(ns),
    };
}

/**
 * Resolve a bearer token for the given namespace. Returns undefined when
 * the namespace is not configured for a session/MSAL flow at all (caller
 * should fall back to api-key / static token paths).
 */
export async function resolveBearerToken(
    ns: AuthNamespace,
    options: ResolveOptions = {},
): Promise<ResolvedBearerToken | undefined> {
    const source = getConfiguredAuthSource(ns);
    if (!source) {
        return undefined;
    }

    const scopes = getConfiguredScopes(ns);

    if (source === 'msal') {
        const msalConfig = getMsalConfig();
        if (!msalConfig) {
            throw new Error(
                `MSAL is selected for ${ns} but junior.msal.clientId is not set. ` +
                `Configure junior.msal.clientId / junior.msal.tenantId, then run "Junior: MSAL Sign In".`,
            );
        }
        if (scopes.length === 0) {
            throw new Error(
                `MSAL acquire requires at least one scope. Set ${ns === 'azureOpenAI' ? 'junior.azureOpenAI.authScopes' : 'junior.copilotCli.providerAuthScopes'}.`,
            );
        }

        try {
            const result = await acquireMsalToken(msalConfig, scopes, {
                interactive: options.interactive ?? true,
                forceRefresh: options.forceRefresh,
                cancellationToken: options.cancellationToken,
            });
            return msalResultToBearer(result);
        } catch (err) {
            if (err instanceof MsalInteractionRequiredError) {
                throw new Error(
                    `MSAL silent token acquisition failed for ${ns}. Run "Junior: MSAL Sign In" to authenticate interactively.`,
                );
            }
            throw err;
        }
    }

    // vscode-auth-session
    const providerId = getConfiguredVsCodeProviderId(ns);
    const session = await vscode.authentication.getSession(providerId, scopes, {
        createIfNone: options.interactive ?? true,
        silent: options.interactive === false ? true : undefined,
    });
    if (!session?.accessToken) {
        return undefined;
    }
    return {
        accessToken: session.accessToken,
        source: 'vscode-auth-session',
        accountLabel: session.account?.label,
    };
}

function msalResultToBearer(result: ResolvedAccessToken): ResolvedBearerToken {
    return {
        accessToken: result.accessToken,
        source: 'msal',
        accountLabel: result.account.username,
        expiresOn: result.expiresOn,
        authority: result.authority,
        clientId: result.clientId,
    };
}
