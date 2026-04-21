import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
    acquireMsalTokenMock: vi.fn(),
}));

vi.mock('../src/msalAuthProvider', () => {
    class MsalInteractionRequiredError extends Error {
        constructor(public readonly config: unknown, public readonly scopes: string[]) {
            super('Interactive MSAL sign-in is required to acquire a token.');
            this.name = 'MsalInteractionRequiredError';
        }
    }
    return {
        acquireMsalToken: mocks.acquireMsalTokenMock,
        MsalInteractionRequiredError,
    };
});

const acquireMsalTokenMock = mocks.acquireMsalTokenMock;

import {
    getConfiguredAuthSource,
    getMsalConfig,
    getVsCodeAuthSessionConfig,
    resolveBearerToken,
} from '../src/tokenResolver';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);
const getSessionMock = vi.mocked(vscode.authentication.getSession);

function setConfiguration(values: Record<string, unknown>) {
    getConfigurationMock.mockImplementation(() => ({
        get: (path: string) => values[path],
        has: () => false,
        inspect: () => undefined,
        update: () => Promise.resolve(),
    }) as any);
}

beforeEach(() => {
    vi.clearAllMocks();
    setConfiguration({});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('tokenResolver — source detection', () => {
    it('returns undefined when authMode is api-key', () => {
        setConfiguration({ 'azureOpenAI.authMode': 'api-key' });
        expect(getConfiguredAuthSource('azureOpenAI')).toBeUndefined();
    });

    it('returns vscode-auth-session for the AOAI vscode-auth-session mode', () => {
        setConfiguration({ 'azureOpenAI.authMode': 'vscode-auth-session' });
        expect(getConfiguredAuthSource('azureOpenAI')).toBe('vscode-auth-session');
    });

    it('returns msal when AOAI authMode is "msal"', () => {
        setConfiguration({ 'azureOpenAI.authMode': 'msal' });
        expect(getConfiguredAuthSource('azureOpenAI')).toBe('msal');
    });

    it('returns msal when AOAI bearerTokenSource overrides to "msal"', () => {
        setConfiguration({
            'azureOpenAI.authMode': 'vscode-auth-session',
            'azureOpenAI.bearerTokenSource': 'msal',
        });
        expect(getConfiguredAuthSource('azureOpenAI')).toBe('msal');
    });

    it('returns msal for the CLI namespace when providerBearerTokenSource is "msal"', () => {
        setConfiguration({ 'copilotCli.providerBearerTokenSource': 'msal' });
        expect(getConfiguredAuthSource('copilotCli')).toBe('msal');
    });

    it('returns vscode-auth-session for the CLI namespace when configured', () => {
        setConfiguration({ 'copilotCli.providerBearerTokenSource': 'vscode-auth-session' });
        expect(getConfiguredAuthSource('copilotCli')).toBe('vscode-auth-session');
    });

    it('returns undefined when CLI bearer source is unset', () => {
        expect(getConfiguredAuthSource('copilotCli')).toBeUndefined();
    });
});

describe('tokenResolver — getVsCodeAuthSessionConfig', () => {
    it('returns the provider/scopes pair only when source is vscode-auth-session', () => {
        setConfiguration({
            'azureOpenAI.authMode': 'vscode-auth-session',
            'azureOpenAI.authProviderId': 'microsoft-sovereign-cloud',
            'azureOpenAI.authScopes': ['https://cognitiveservices.azure.us/.default'],
        });
        expect(getVsCodeAuthSessionConfig('azureOpenAI')).toEqual({
            providerId: 'microsoft-sovereign-cloud',
            scopes: ['https://cognitiveservices.azure.us/.default'],
        });
    });

    it('returns undefined when source is msal', () => {
        setConfiguration({ 'azureOpenAI.authMode': 'msal' });
        expect(getVsCodeAuthSessionConfig('azureOpenAI')).toBeUndefined();
    });
});

describe('tokenResolver — getMsalConfig', () => {
    it('returns undefined when clientId is missing', () => {
        expect(getMsalConfig()).toBeUndefined();
    });

    it('reads clientId, tenantId, authority and other fields', () => {
        setConfiguration({
            'msal.clientId': 'cid',
            'msal.tenantId': 'tid',
            'msal.authority': 'https://login.custom-sovereign.example/tid',
            'msal.cloudInstance': 'https://login.microsoftonline.com',
            'msal.redirectUri': 'http://localhost:8400',
            'msal.interactiveFlow': 'device-code',
            'msal.knownAuthorities': ['login.custom-sovereign.example'],
        });
        const cfg = getMsalConfig();
        expect(cfg).toEqual({
            clientId: 'cid',
            tenantId: 'tid',
            authority: 'https://login.custom-sovereign.example/tid',
            cloudInstance: 'https://login.microsoftonline.com',
            redirectUri: 'http://localhost:8400',
            interactiveFlow: 'device-code',
            knownAuthorities: ['login.custom-sovereign.example'],
        });
    });

    it('defaults interactiveFlow to "browser" when unset', () => {
        setConfiguration({ 'msal.clientId': 'cid' });
        expect(getMsalConfig()?.interactiveFlow).toBe('browser');
    });
});

describe('tokenResolver — resolveBearerToken (vscode-auth-session)', () => {
    it('calls vscode.authentication.getSession with the configured providerId + scopes', async () => {
        setConfiguration({
            'azureOpenAI.authMode': 'vscode-auth-session',
            'azureOpenAI.authProviderId': 'microsoft',
            'azureOpenAI.authScopes': ['api://app/user_impersonation'],
        });
        getSessionMock.mockResolvedValue({
            accessToken: 'session-tok',
            account: { label: 'user@example.com' },
        } as any);

        const result = await resolveBearerToken('azureOpenAI');

        expect(getSessionMock).toHaveBeenCalledWith('microsoft', ['api://app/user_impersonation'], expect.objectContaining({ createIfNone: true }));
        expect(result).toEqual({
            accessToken: 'session-tok',
            source: 'vscode-auth-session',
            accountLabel: 'user@example.com',
        });
    });

    it('passes silent: true and createIfNone: false when interactive=false', async () => {
        setConfiguration({
            'azureOpenAI.authMode': 'vscode-auth-session',
            'azureOpenAI.authProviderId': 'microsoft',
            'azureOpenAI.authScopes': ['s'],
        });
        getSessionMock.mockResolvedValue(undefined);

        await resolveBearerToken('azureOpenAI', { interactive: false });

        const opts = getSessionMock.mock.calls[0][2] as { createIfNone: boolean; silent: boolean };
        expect(opts.createIfNone).toBe(false);
        expect(opts.silent).toBe(true);
    });

    it('returns undefined when the session is unavailable', async () => {
        setConfiguration({
            'azureOpenAI.authMode': 'vscode-auth-session',
            'azureOpenAI.authScopes': ['s'],
        });
        getSessionMock.mockResolvedValue(undefined);

        await expect(resolveBearerToken('azureOpenAI')).resolves.toBeUndefined();
    });
});

describe('tokenResolver — resolveBearerToken (msal)', () => {
    it('routes through MSAL acquire when source is "msal"', async () => {
        setConfiguration({
            'azureOpenAI.authMode': 'msal',
            'azureOpenAI.authScopes': ['https://cognitiveservices.azure.us/.default'],
            'msal.clientId': 'cid',
            'msal.tenantId': 'tid',
            'msal.authority': 'https://login.custom-sovereign.example/tid',
        });
        acquireMsalTokenMock.mockResolvedValue({
            accessToken: 'msal-tok',
            account: { username: 'user@gov', tenantId: 'tid', homeAccountId: 'h1' },
            authority: 'https://login.custom-sovereign.example/tid',
            clientId: 'cid',
            fromCache: false,
            expiresOn: new Date(Date.UTC(2030, 0, 1)),
        });

        const result = await resolveBearerToken('azureOpenAI');

        expect(acquireMsalTokenMock).toHaveBeenCalledTimes(1);
        const [cfg, scopes, opts] = acquireMsalTokenMock.mock.calls[0];
        expect(cfg).toMatchObject({ clientId: 'cid', tenantId: 'tid' });
        expect(scopes).toEqual(['https://cognitiveservices.azure.us/.default']);
        expect(opts.interactive).toBe(true);
        expect(result?.source).toBe('msal');
        expect(result?.accessToken).toBe('msal-tok');
        expect(result?.accountLabel).toBe('user@gov');
        expect(result?.authority).toBe('https://login.custom-sovereign.example/tid');
    });

    it('throws a configuration error when MSAL is selected but clientId is missing', async () => {
        setConfiguration({
            'azureOpenAI.authMode': 'msal',
            'azureOpenAI.authScopes': ['s'],
        });

        await expect(resolveBearerToken('azureOpenAI')).rejects.toThrow(/junior\.msal\.clientId is not set/);
    });

    it('throws a clear error when MSAL is selected but no scopes are configured', async () => {
        setConfiguration({
            'azureOpenAI.authMode': 'msal',
            'msal.clientId': 'cid',
        });

        await expect(resolveBearerToken('azureOpenAI')).rejects.toThrow(/at least one scope/i);
    });

    it('translates MsalInteractionRequiredError into a sign-in instruction', async () => {
        setConfiguration({
            'copilotCli.providerBearerTokenSource': 'msal',
            'copilotCli.providerAuthScopes': ['https://cognitiveservices.azure.us/.default'],
            'msal.clientId': 'cid',
            'msal.tenantId': 'tid',
        });
        const { MsalInteractionRequiredError } = await import('../src/msalAuthProvider');
        acquireMsalTokenMock.mockRejectedValue(new MsalInteractionRequiredError({ clientId: 'cid', tenantId: 'tid' }, ['s']));

        await expect(resolveBearerToken('copilotCli')).rejects.toThrow(/MSAL Sign In/i);
    });
});

describe('tokenResolver — resolveBearerToken when source is unset', () => {
    it('returns undefined when neither vscode-auth-session nor msal are configured', async () => {
        setConfiguration({});
        await expect(resolveBearerToken('azureOpenAI')).resolves.toBeUndefined();
    });
});
