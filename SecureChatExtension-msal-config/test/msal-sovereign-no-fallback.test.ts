/**
 * Sovereign-cloud no-fallback verification.
 *
 * Uses the literal settings shape a user would put in settings.json when
 * pointing at Azure US Gov, then drives the resolver and inspects the exact
 * `Configuration` object that MSAL receives. The intent is to prove there is
 * NO silent fallback to commercial cloud endpoints anywhere in the chain.
 *
 * If any of these assertions fail, MSAL would either:
 *   - call commercial discovery (https://login.microsoftonline.com/...)
 *   - or open the browser to a commercial sign-in page
 * which would mask sovereign mis-configuration in the field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

// ── Mock MSAL — capture the Configuration the user's settings produce. ──
const mocks = vi.hoisted(() => ({
    pcaConstructorMock: vi.fn(),
    acquireTokenSilentMock: vi.fn(),
    acquireTokenInteractiveMock: vi.fn(),
    getAllAccountsMock: vi.fn(),
}));

vi.mock('@azure/msal-node', () => {
    class PublicClientApplication {
        constructor(config: unknown) {
            mocks.pcaConstructorMock(config);
        }
        acquireTokenSilent(req: unknown) { return mocks.acquireTokenSilentMock(req); }
        acquireTokenInteractive(req: unknown) { return mocks.acquireTokenInteractiveMock(req); }
        getTokenCache() {
            return {
                getAllAccounts: () => mocks.getAllAccountsMock(),
                removeAccount: () => undefined,
            };
        }
    }
    class InteractionRequiredAuthError extends Error {}
    enum LogLevel { Error = 0, Warning = 1, Info = 2, Verbose = 3 }
    enum AzureCloudInstance {
        None = 'none',
        AzurePublic = 'https://login.microsoftonline.com',
        AzureChina = 'https://login.chinacloudapi.cn',
        AzureUsGovernment = 'https://login.microsoftonline.us',
        AzureGermany = 'https://login.microsoftonline.de',
    }
    return { PublicClientApplication, InteractionRequiredAuthError, LogLevel, AzureCloudInstance };
});

import {
    initMsalAuthProvider,
    invalidateMsalProviderCache,
    resetMsalAuthProviderForTests,
} from '../src/msalAuthProvider';
import { resolveBearerToken } from '../src/tokenResolver';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

/** The user's exact Azure US Gov settings, copied from settings.json. */
const USER_GOV_SETTINGS: Record<string, unknown> = {
    'agentProvider': 'copilot-cli',
    'copilotCli.providerType': 'azure',
    'copilotCli.providerBaseUrl': 'https://agentapim.azure-api.us/',
    'copilotCli.providerWireApi': 'responses',
    'copilotCli.providerBearerTokenSource': 'msal',
    'copilotCli.providerAuthScopes': [
        'api://6349498a-a2f9-4081-8b82-d2119ac8f23c/user_impersonation',
    ],
    'msal.clientId': '6349498a-a2f9-4081-8b82-d2119ac8f23c',
    'msal.tenantId': '03f141f3-496d-4319-bbea-a3e9286cab10',
    'msal.cloudInstance': 'https://login.microsoftonline.us',
};

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string) => values[path],
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }) as any);
}

function inMemorySecretStorage() {
    const store = new Map<string, string>();
    return {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        delete: vi.fn(async (k: string) => { store.delete(k); }),
        onDidChange: vi.fn(() => ({ dispose: () => {} })),
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    resetMsalAuthProviderForTests();
    initMsalAuthProvider(inMemorySecretStorage(), () => undefined);
    invalidateMsalProviderCache();
});

afterEach(() => {
    resetMsalAuthProviderForTests();
});

/**
 * Recursively search a value for any commercial-cloud reference. Returns the
 * matching path so a failure tells you exactly which field leaked.
 */
function findCommercialCloudLeak(value: unknown, path = '$'): string | undefined {
    if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower.includes('login.microsoftonline.com')
            || lower.includes('login.windows.net')
            || lower.includes('sts.windows.net')) {
            return `${path} = ${JSON.stringify(value)}`;
        }
        return undefined;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const hit = findCommercialCloudLeak(value[i], `${path}[${i}]`);
            if (hit) { return hit; }
        }
        return undefined;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            const hit = findCommercialCloudLeak(v, `${path}.${k}`);
            if (hit) { return hit; }
        }
    }
    return undefined;
}

describe('MSAL — Azure US Gov settings produce no commercial-cloud fallback', () => {
    it('user Gov settings build only Gov endpoints in the MSAL Configuration', async () => {
        setConfiguration(USER_GOV_SETTINGS);

        // No accounts cached → silent fails → resolver attempts interactive.
        // We don't need it to actually succeed; we only care which authority
        // MSAL was configured against, which is captured at PCA construction.
        mocks.getAllAccountsMock.mockResolvedValue([]);
        mocks.acquireTokenInteractiveMock.mockResolvedValue({
            accessToken: 'fake',
            account: { username: 'u@gov', tenantId: 't', homeAccountId: 'h', environment: 'login.microsoftonline.us' },
        });

        await resolveBearerToken('copilotCli');

        expect(mocks.pcaConstructorMock).toHaveBeenCalledTimes(1);
        const cfg = mocks.pcaConstructorMock.mock.calls[0][0] as {
            auth: {
                clientId: string;
                authority: string;
                knownAuthorities?: string[];
                azureCloudOptions?: { azureCloudInstance: string; tenant: string };
            };
        };

        // 1. Authority is the Gov host.
        expect(cfg.auth.authority).toBe(
            'https://login.microsoftonline.us/03f141f3-496d-4319-bbea-a3e9286cab10'
        );

        // 2. knownAuthorities trusts the Gov host (so MSAL skips discovery
        //    against login.microsoftonline.com — the original bug).
        expect(cfg.auth.knownAuthorities).toContain('login.microsoftonline.us');

        // 3. azureCloudOptions points at the Gov sovereign metadata, NOT
        //    AzurePublic. This is the key anti-fallback assertion: if MSAL
        //    received AzurePublic here it would override the authority.
        expect(cfg.auth.azureCloudOptions?.azureCloudInstance).toBe(
            'https://login.microsoftonline.us'
        );
        expect(cfg.auth.azureCloudOptions?.tenant).toBe(
            '03f141f3-496d-4319-bbea-a3e9286cab10'
        );

        // 4. Hard fail if ANY string anywhere in the MSAL Configuration
        //    references a commercial-cloud authority host.
        const leak = findCommercialCloudLeak(cfg);
        expect(leak, `commercial-cloud reference leaked into MSAL config at ${leak}`)
            .toBeUndefined();
    });

    it('the interactive request also targets the Gov authority (no commercial leak)', async () => {
        setConfiguration(USER_GOV_SETTINGS);

        mocks.getAllAccountsMock.mockResolvedValue([]);
        mocks.acquireTokenInteractiveMock.mockResolvedValue({
            accessToken: 'fake',
            account: { username: 'u@gov', tenantId: 't', homeAccountId: 'h', environment: 'login.microsoftonline.us' },
        });

        await resolveBearerToken('copilotCli');

        expect(mocks.acquireTokenInteractiveMock).toHaveBeenCalledTimes(1);
        const interactiveReq = mocks.acquireTokenInteractiveMock.mock.calls[0][0];
        const leak = findCommercialCloudLeak(interactiveReq);
        expect(leak, `commercial-cloud reference leaked into InteractiveRequest at ${leak}`)
            .toBeUndefined();
    });

    it('the resolved token records the Gov authority (proves we acquired against Gov)', async () => {
        setConfiguration(USER_GOV_SETTINGS);

        mocks.getAllAccountsMock.mockResolvedValue([]);
        mocks.acquireTokenInteractiveMock.mockResolvedValue({
            accessToken: 'fake',
            account: { username: 'u@gov', tenantId: 't', homeAccountId: 'h', environment: 'login.microsoftonline.us' },
        });

        const result = await resolveBearerToken('copilotCli');

        expect(result?.source).toBe('msal');
        expect(result?.authority).toBe(
            'https://login.microsoftonline.us/03f141f3-496d-4319-bbea-a3e9286cab10'
        );
        expect(result?.authority).not.toContain('microsoftonline.com');
    });

    it('the only commercial default fires ONLY when the user provides no MSAL cloud config at all', async () => {
        // Sanity check: the documented fallback at buildAuthorityUrl line ~155
        // only kicks in when BOTH `authority` and `cloudInstance` are empty.
        // Here we deliberately omit both to confirm the fallback exists, so we
        // know the Gov test above is meaningful.
        setConfiguration({
            'azureOpenAI.authMode': 'msal',
            'azureOpenAI.authScopes': ['api://x/.default'],
            'msal.clientId': 'cid',
            'msal.tenantId': 'tid',
            // intentionally NO cloudInstance, NO authority
        });
        mocks.getAllAccountsMock.mockResolvedValue([]);
        mocks.acquireTokenInteractiveMock.mockResolvedValue({
            accessToken: 'x',
            account: { username: '', tenantId: '', homeAccountId: '', environment: '' },
        });

        await resolveBearerToken('azureOpenAI');

        const cfg = mocks.pcaConstructorMock.mock.calls[0][0] as { auth: { authority: string } };
        // Confirms the fallback exists for empty config — and ONLY there.
        expect(cfg.auth.authority).toBe('https://login.microsoftonline.com/tid');
    });
});
