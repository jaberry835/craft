import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock MSAL ────────────────────────────────────────────────────────────────
// We capture instances and silent/interactive calls so we can assert on them
// without performing any real network round-trips. Mocks are hoisted via
// vi.hoisted so the vi.mock factory below can reference them safely.

const mocks = vi.hoisted(() => ({
    acquireTokenSilentMock: vi.fn(),
    acquireTokenInteractiveMock: vi.fn(),
    acquireTokenByDeviceCodeMock: vi.fn(),
    getAllAccountsMock: vi.fn(),
    removeAccountMock: vi.fn(),
    pcaConstructorMock: vi.fn(),
}));

vi.mock('@azure/msal-node', () => {
    class PublicClientApplication {
        constructor(config: unknown) {
            mocks.pcaConstructorMock(config);
        }
        acquireTokenSilent(req: unknown) { return mocks.acquireTokenSilentMock(req); }
        acquireTokenInteractive(req: unknown) { return mocks.acquireTokenInteractiveMock(req); }
        acquireTokenByDeviceCode(req: unknown) { return mocks.acquireTokenByDeviceCodeMock(req); }
        getTokenCache() {
            return {
                getAllAccounts: () => mocks.getAllAccountsMock(),
                removeAccount: (acct: unknown) => mocks.removeAccountMock(acct),
            };
        }
    }
    class InteractionRequiredAuthError extends Error {
        constructor(msg = 'interaction_required') { super(msg); this.name = 'InteractionRequiredAuthError'; }
    }
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

const {
    acquireTokenSilentMock,
    acquireTokenInteractiveMock,
    acquireTokenByDeviceCodeMock,
    getAllAccountsMock,
    removeAccountMock,
    pcaConstructorMock,
} = mocks;

import type { SecretStorage } from 'vscode';
import {
    acquireMsalToken,
    initMsalAuthProvider,
    invalidateMsalProviderCache,
    listMsalAccounts,
    MsalConfig,
    MsalInteractionRequiredError,
    resetMsalAuthProviderForTests,
    signOutMsalAccount,
} from '../src/msalAuthProvider';

function inMemorySecretStorage(): SecretStorage {
    const store = new Map<string, string>();
    return {
        get: vi.fn(async (k: string) => store.get(k)),
        store: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        delete: vi.fn(async (k: string) => { store.delete(k); }),
        onDidChange: vi.fn(() => ({ dispose: () => {} })),
    } as unknown as SecretStorage;
}

const baseConfig: MsalConfig = {
    clientId: 'test-client',
    tenantId: 'test-tenant',
};

const account = {
    homeAccountId: 'home-1',
    username: 'user@example.com',
    tenantId: 'test-tenant',
    environment: 'login.microsoftonline.com',
};

beforeEach(() => {
    resetMsalAuthProviderForTests();
    initMsalAuthProvider(inMemorySecretStorage(), () => undefined);
    pcaConstructorMock.mockClear();
    acquireTokenSilentMock.mockReset();
    acquireTokenInteractiveMock.mockReset();
    acquireTokenByDeviceCodeMock.mockReset();
    getAllAccountsMock.mockReset();
    removeAccountMock.mockReset();
    invalidateMsalProviderCache();
});

afterEach(() => {
    resetMsalAuthProviderForTests();
});

describe('MSAL auth provider — silent path', () => {
    it('returns the cached token when silent acquire succeeds', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({
            accessToken: 'tok-silent',
            account,
            expiresOn: new Date(Date.UTC(2030, 0, 1)),
        });

        const result = await acquireMsalToken(baseConfig, ['scope/.default']);

        expect(result.accessToken).toBe('tok-silent');
        expect(result.fromCache).toBe(true);
        expect(result.account.username).toBe('user@example.com');
        expect(acquireTokenSilentMock).toHaveBeenCalledWith({ account, scopes: ['scope/.default'] });
        expect(acquireTokenInteractiveMock).not.toHaveBeenCalled();
    });

    it('throws MsalInteractionRequiredError when no accounts and interactive=false', async () => {
        getAllAccountsMock.mockResolvedValue([]);

        await expect(acquireMsalToken(baseConfig, ['scope/.default'], { interactive: false }))
            .rejects.toBeInstanceOf(MsalInteractionRequiredError);
        expect(acquireTokenInteractiveMock).not.toHaveBeenCalled();
    });
});

describe('MSAL auth provider — interactive fallback', () => {
    it('falls back to browser interactive when silent fails and interactive=true', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockRejectedValue(new Error('interaction_required'));
        acquireTokenInteractiveMock.mockResolvedValue({
            accessToken: 'tok-interactive',
            account,
            expiresOn: new Date(Date.UTC(2030, 0, 1)),
        });

        const result = await acquireMsalToken(baseConfig, ['scope/.default'], { interactive: true });

        expect(result.accessToken).toBe('tok-interactive');
        expect(result.fromCache).toBe(false);
        expect(acquireTokenInteractiveMock).toHaveBeenCalledTimes(1);
        const req = acquireTokenInteractiveMock.mock.calls[0][0] as { scopes: string[]; openBrowser: (u: string) => Promise<void> };
        expect(req.scopes).toEqual(['scope/.default']);
        expect(typeof req.openBrowser).toBe('function');
    });

    it('uses device-code flow when interactiveFlow is "device-code"', async () => {
        getAllAccountsMock.mockResolvedValue([]);
        acquireTokenByDeviceCodeMock.mockImplementation(async (req: { deviceCodeCallback: (r: { message: string; userCode: string; verificationUri: string }) => void }) => {
            req.deviceCodeCallback({
                message: 'go to url',
                userCode: 'ABCD-1234',
                verificationUri: 'https://microsoft.com/devicelogin',
            });
            return {
                accessToken: 'tok-device',
                account,
                expiresOn: new Date(Date.UTC(2030, 0, 1)),
            };
        });

        const result = await acquireMsalToken(
            { ...baseConfig, interactiveFlow: 'device-code' },
            ['scope/.default'],
            { interactive: true },
        );

        expect(result.accessToken).toBe('tok-device');
        expect(acquireTokenByDeviceCodeMock).toHaveBeenCalledTimes(1);
        expect(acquireTokenInteractiveMock).not.toHaveBeenCalled();
    });

    it('forceRefresh skips silent acquire and goes straight to interactive', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenInteractiveMock.mockResolvedValue({
            accessToken: 'tok-forced',
            account,
        });

        const result = await acquireMsalToken(baseConfig, ['scope/.default'], { interactive: true, forceRefresh: true });

        expect(result.accessToken).toBe('tok-forced');
        expect(acquireTokenSilentMock).not.toHaveBeenCalled();
        expect(acquireTokenInteractiveMock).toHaveBeenCalledTimes(1);
    });
});

describe('MSAL auth provider — configuration', () => {
    it('builds authority from cloudInstance + tenantId when authority is empty', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({ accessToken: 't', account });

        await acquireMsalToken(
            { ...baseConfig, cloudInstance: 'https://login.microsoftonline.us', tenantId: 'gov-tenant' },
            ['scope/.default'],
        );

        expect(pcaConstructorMock).toHaveBeenCalledTimes(1);
        const cfg = pcaConstructorMock.mock.calls[0][0] as {
            auth: {
                authority: string;
                knownAuthorities?: string[];
                azureCloudOptions?: { azureCloudInstance: string; tenant: string };
            };
        };
        expect(cfg.auth.authority).toBe('https://login.microsoftonline.us/gov-tenant');
        // Regression guard for endpoints_resolution_error on Gov clouds:
        // MSAL must skip its instance-discovery call to login.microsoftonline.com
        // by trusting the gov host explicitly AND by being told which sovereign
        // cloud's metadata to use.
        expect(cfg.auth.knownAuthorities).toContain('login.microsoftonline.us');
        expect(cfg.auth.azureCloudOptions).toEqual({
            azureCloudInstance: 'https://login.microsoftonline.us',
            tenant: 'gov-tenant',
        });
    });

    it('auto-adds the authority host to knownAuthorities for custom sovereign hosts (no azureCloudOptions)', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({ accessToken: 't', account });

        await acquireMsalToken(
            {
                ...baseConfig,
                authority: 'https://login.custom-sovereign.example/custom-tenant',
            },
            ['scope/.default'],
        );

        const cfg = pcaConstructorMock.mock.calls[0][0] as {
            auth: { knownAuthorities?: string[]; azureCloudOptions?: unknown };
        };
        expect(cfg.auth.knownAuthorities).toContain('login.custom-sovereign.example');
        expect(cfg.auth.azureCloudOptions).toBeUndefined();
    });

    it('preserves user-provided knownAuthorities and prepends the authority host', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({ accessToken: 't', account });

        await acquireMsalToken(
            {
                ...baseConfig,
                authority: 'https://login.custom-sovereign.example/t',
                knownAuthorities: ['extra-host.example'],
            },
            ['scope/.default'],
        );

        const cfg = pcaConstructorMock.mock.calls[0][0] as { auth: { knownAuthorities?: string[] } };
        expect(cfg.auth.knownAuthorities).toEqual([
            'login.custom-sovereign.example',
            'extra-host.example',
        ]);
    });

    it('uses an explicit authority verbatim when provided', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({ accessToken: 't', account });

        await acquireMsalToken(
            {
                ...baseConfig,
                authority: 'https://login.custom-sovereign.example/custom-tenant',
                cloudInstance: 'https://login.microsoftonline.com', // ignored
            },
            ['scope/.default'],
        );

        const cfg = pcaConstructorMock.mock.calls[0][0] as { auth: { authority: string } };
        expect(cfg.auth.authority).toBe('https://login.custom-sovereign.example/custom-tenant');
    });

    it('reuses a single PublicClientApplication per (clientId, authority) tuple', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({ accessToken: 't', account });

        await acquireMsalToken(baseConfig, ['scope/.default']);
        await acquireMsalToken(baseConfig, ['scope/.default']);

        expect(pcaConstructorMock).toHaveBeenCalledTimes(1);
    });

    it('creates a new PCA when authority changes', async () => {
        getAllAccountsMock.mockResolvedValue([account]);
        acquireTokenSilentMock.mockResolvedValue({ accessToken: 't', account });

        await acquireMsalToken(baseConfig, ['scope/.default']);
        await acquireMsalToken({ ...baseConfig, tenantId: 'other-tenant' }, ['scope/.default']);

        expect(pcaConstructorMock).toHaveBeenCalledTimes(2);
    });

    it('rejects when no scopes are provided', async () => {
        await expect(acquireMsalToken(baseConfig, [])).rejects.toThrow(/scope/i);
    });

    it('rejects when clientId is missing', async () => {
        await expect(acquireMsalToken({ ...baseConfig, clientId: '' }, ['s'])).rejects.toThrow(/clientId/);
    });

    it('throws a clear error when init was never called', async () => {
        resetMsalAuthProviderForTests();
        await expect(acquireMsalToken(baseConfig, ['s'])).rejects.toThrow(/not initialized/);
    });
});

describe('MSAL auth provider — account management', () => {
    it('listMsalAccounts surfaces all cache accounts', async () => {
        const accounts = [account, { ...account, homeAccountId: 'home-2', username: 'b@example.com' }];
        getAllAccountsMock.mockResolvedValue(accounts);

        const result = await listMsalAccounts(baseConfig);
        expect(result).toEqual(accounts);
    });

    it('signOutMsalAccount removes the matching account and returns true', async () => {
        getAllAccountsMock.mockResolvedValue([account]);

        const ok = await signOutMsalAccount(baseConfig, 'home-1');
        expect(ok).toBe(true);
        expect(removeAccountMock).toHaveBeenCalledWith(account);
    });

    it('signOutMsalAccount returns false when the account is unknown', async () => {
        getAllAccountsMock.mockResolvedValue([account]);

        const ok = await signOutMsalAccount(baseConfig, 'home-other');
        expect(ok).toBe(false);
        expect(removeAccountMock).not.toHaveBeenCalled();
    });
});
