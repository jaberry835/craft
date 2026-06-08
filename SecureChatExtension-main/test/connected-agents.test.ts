import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    ConnectedAgentDef,
    ConnectedAgentStore,
    acquireConnectedAgentEntraToken,
    connectedAgentToolName,
    slugifyConnectedAgentName,
    validateConnectedAgent,
    __test,
} from '../src/connectedAgents';

class FakeMemento {
    private store = new Map<string, unknown>();
    get<T>(key: string, defaultValue?: T): T | undefined {
        return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue);
    }
    update(key: string, value: unknown): Thenable<void> {
        if (value === undefined) { this.store.delete(key); }
        else { this.store.set(key, value); }
        return Promise.resolve();
    }
    keys(): readonly string[] { return [...this.store.keys()]; }
}

class FakeSecretStorage {
    private data = new Map<string, string>();
    get(key: string) { return Promise.resolve(this.data.get(key)); }
    store(key: string, value: string) { this.data.set(key, value); return Promise.resolve(); }
    delete(key: string) { this.data.delete(key); return Promise.resolve(); }
    onDidChange = () => ({ dispose: () => {} });
    has(key: string) { return this.data.has(key); }
}

function makeTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'junior-connected-'));
}

function makeStore(tmpDir?: string) {
    const memento = new FakeMemento();
    const secrets = new FakeSecretStorage();
    const folder = tmpDir ? { uri: { fsPath: tmpDir }, name: 'tmp', index: 0 } as any : undefined;
    const store = new ConnectedAgentStore(folder, memento as any, secrets as any);
    return { store, memento, secrets, folder };
}

describe('slugifyConnectedAgentName', () => {
    it('lowercases, hyphenates and trims', () => {
        expect(slugifyConnectedAgentName('  Billing Bot  ')).toBe('billing-bot');
        expect(slugifyConnectedAgentName('A2A!! Helper')).toBe('a2a-helper');
    });
    it('falls back when input is empty', () => {
        expect(slugifyConnectedAgentName('   ')).toMatch(/^agent-\d+$/);
    });
});

describe('connectedAgentToolName', () => {
    it('builds a safe identifier prefixed with delegate_to_', () => {
        expect(connectedAgentToolName('billing-bot')).toBe('delegate_to_billing_bot');
        expect(connectedAgentToolName('Weird.Name!')).toBe('delegate_to_weird_name');
    });
    it('falls back to agent for empty ids', () => {
        expect(connectedAgentToolName('')).toBe('delegate_to_agent');
    });
});

describe('validateConnectedAgent', () => {
    const base = { name: 'Billing', endpoint: 'https://agent.example.com/', auth: 'none' as const };

    it('normalizes name, derives id and strips a trailing slash', () => {
        const v = validateConnectedAgent({ ...base, name: ' Billing ' });
        expect(v.id).toBe('billing');
        expect(v.name).toBe('Billing');
        expect(v.endpoint).toBe('https://agent.example.com');
        expect(v.auth).toBe('none');
    });

    it('requires a name', () => {
        expect(() => validateConnectedAgent({ ...base, name: '' })).toThrow(/name/i);
    });

    it('rejects non-https endpoints', () => {
        expect(() => validateConnectedAgent({ ...base, endpoint: 'http://insecure.example' })).toThrow(/https/);
    });

    it('allows plain http for loopback hosts', () => {
        expect(validateConnectedAgent({ ...base, endpoint: 'http://localhost:5000/a2a/abc' }).endpoint).toBe('http://localhost:5000/a2a/abc');
        expect(validateConnectedAgent({ ...base, endpoint: 'http://127.0.0.1:5000' }).endpoint).toBe('http://127.0.0.1:5000');
        expect(validateConnectedAgent({ ...base, endpoint: 'http://[::1]:8080/a2a' }).endpoint).toBe('http://[::1]:8080/a2a');
    });


    it('defaults the apiKey header to x-api-key', () => {
        const v = validateConnectedAgent({ ...base, auth: 'apiKey' });
        expect(v.auth).toBe('apiKey');
        expect(v.headerName).toBe('x-api-key');
    });

    it('honours a custom apiKey header name', () => {
        const v = validateConnectedAgent({ ...base, auth: 'apiKey', headerName: 'X-Custom-Key' });
        expect(v.headerName).toBe('X-Custom-Key');
    });

    it('rejects embedded credential fields', () => {
        expect(() => validateConnectedAgent({ ...base, auth: 'bearer', token: 'leaked' } as any)).toThrow(/SecretStorage/);
        expect(() => validateConnectedAgent({ ...base, apiKey: 'leaked' } as any)).toThrow(/SecretStorage/);
    });

    it('requires an Entra scope for interactive bearer auth', () => {
        expect(() => validateConnectedAgent({ ...base, auth: 'entra' })).toThrow(/scope/i);
    });

    it('defaults the Entra auth provider to microsoft', () => {
        const v = validateConnectedAgent({ ...base, auth: 'entra', entraScope: 'api://abc/.default' });
        expect(v.auth).toBe('entra');
        expect(v.entraScope).toBe('api://abc/.default');
        expect(v.authProviderId).toBe('microsoft');
        expect(v.headerName).toBeUndefined();
    });

    it('honours a custom Entra auth provider', () => {
        const v = validateConnectedAgent({
            ...base,
            auth: 'entra',
            entraScope: 'api://abc/.default',
            authProviderId: 'microsoft-sovereign-cloud',
        });
        expect(v.authProviderId).toBe('microsoft-sovereign-cloud');
    });
});

describe('ConnectedAgentStore', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = makeTempWorkspace(); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('round-trips a global agent', async () => {
        const { store } = makeStore(tmpDir);
        const saved = await store.save(validateConnectedAgent({ name: 'Global Bot', endpoint: 'https://g.example.com', auth: 'none' }), 'global');
        expect(saved.scope).toBe('global');
        const fetched = await store.get(saved.id);
        expect(fetched?.name).toBe('Global Bot');
        expect(fetched?.scope).toBe('global');
    });

    it('round-trips a workspace agent and writes the json file', async () => {
        const { store } = makeStore(tmpDir);
        await store.save(validateConnectedAgent({ name: 'WS Bot', endpoint: 'https://ws.example.com', auth: 'none' }), 'workspace');
        const file = path.join(tmpDir, __test.WORKSPACE_FILE);
        expect(fs.existsSync(file)).toBe(true);
        const list = await store.list();
        expect(list.map(a => a.name)).toContain('WS Bot');
        expect(list.find(a => a.name === 'WS Bot')?.scope).toBe('workspace');
    });

    it('lets workspace agents shadow global agents with the same id', async () => {
        const { store } = makeStore(tmpDir);
        await store.save(validateConnectedAgent({ id: 'dup', name: 'Dup', endpoint: 'https://global.example.com', auth: 'none' }), 'global');
        await store.save(validateConnectedAgent({ id: 'dup', name: 'Dup', endpoint: 'https://workspace.example.com', auth: 'none' }), 'workspace');
        const fetched = await store.get('dup');
        expect(fetched?.endpoint).toBe('https://workspace.example.com');
        expect(fetched?.scope).toBe('workspace');
    });

    it('stores and deletes secrets without persisting them to json', async () => {
        const { store, secrets } = makeStore(tmpDir);
        const saved = await store.save(validateConnectedAgent({ name: 'Key Bot', endpoint: 'https://k.example.com', auth: 'apiKey' }), 'workspace');
        await store.setKey(saved.id, 'super-secret');
        expect(await store.getKey(saved.id)).toBe('super-secret');
        const fileRaw = fs.readFileSync(path.join(tmpDir, __test.WORKSPACE_FILE), 'utf8');
        expect(fileRaw).not.toContain('super-secret');
        await store.delete(saved.id, 'workspace');
        expect(secrets.has(__test.SECRET_KEY_PREFIX + saved.id + '.key')).toBe(false);
        expect(await store.get(saved.id)).toBeUndefined();
    });
});

describe('acquireConnectedAgentEntraToken', () => {
    const getSession = vscode.authentication.getSession as unknown as ReturnType<typeof vi.fn>;
    beforeEach(() => { getSession.mockReset(); });

    it('returns undefined for non-entra agents without calling getSession', async () => {
        const token = await acquireConnectedAgentEntraToken({ auth: 'bearer' });
        expect(token).toBeUndefined();
        expect(getSession).not.toHaveBeenCalled();
    });

    it('requests an interactive session with the configured provider and scope', async () => {
        getSession.mockResolvedValueOnce({ accessToken: 'tok-123' });
        const token = await acquireConnectedAgentEntraToken({
            auth: 'entra',
            authProviderId: 'microsoft',
            entraScope: 'api://abc/.default',
        });
        expect(token).toBe('tok-123');
        expect(getSession).toHaveBeenCalledWith('microsoft', ['api://abc/.default'], { createIfNone: true });
    });

    it('uses silent mode when not interactive', async () => {
        getSession.mockResolvedValueOnce({ accessToken: 'tok-silent' });
        await acquireConnectedAgentEntraToken({ auth: 'entra', entraScope: 'api://abc/.default' }, false);
        expect(getSession).toHaveBeenCalledWith('microsoft', ['api://abc/.default'], { silent: true });
    });

    it('returns undefined when sign-in fails', async () => {
        getSession.mockRejectedValueOnce(new Error('user declined'));
        const token = await acquireConnectedAgentEntraToken({ auth: 'entra', entraScope: 'api://abc/.default' });
        expect(token).toBeUndefined();
    });
});
