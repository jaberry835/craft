import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    CustomAgentDef,
    CustomAgentStore,
    isValidSearchEndpoint,
    slugifyAgentName,
    validateCustomAgent,
} from '../src/customAgents';

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
}

function makeTempWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'junior-agents-'));
}

function makeStore(tmpDir?: string) {
    const memento = new FakeMemento();
    const secrets = new FakeSecretStorage();
    const folder = tmpDir ? { uri: { fsPath: tmpDir }, name: 'tmp', index: 0 } as any : undefined;
    const store = new CustomAgentStore(folder, memento as any, secrets as any);
    return { store, memento, secrets, folder };
}

describe('isValidSearchEndpoint', () => {
    it('accepts azure ai search hostnames', () => {
        expect(isValidSearchEndpoint('https://my-svc.search.windows.net')).toBe(true);
        expect(isValidSearchEndpoint('https://my-svc.search.windows.net/')).toBe(true);
        expect(isValidSearchEndpoint('https://gov.search.azure.us')).toBe(true);
        expect(isValidSearchEndpoint('https://cn.search.azure.cn')).toBe(true);
        expect(isValidSearchEndpoint('https://search.internal.contoso.example')).toBe(true);
    });
    it('rejects http and malformed urls', () => {
        expect(isValidSearchEndpoint('http://my-svc.search.windows.net')).toBe(false);
        expect(isValidSearchEndpoint('ftp://my-svc.search.windows.net')).toBe(false);
        expect(isValidSearchEndpoint('not a url')).toBe(false);
        expect(isValidSearchEndpoint('')).toBe(false);
    });
});

describe('slugifyAgentName', () => {
    it('lowercases, hyphenates and trims', () => {
        expect(slugifyAgentName('  Payments Expert  ')).toBe('payments-expert');
        expect(slugifyAgentName('MCP!! Helper')).toBe('mcp-helper');
    });
    it('falls back when input is empty', () => {
        expect(slugifyAgentName('   ')).toMatch(/^agent-\d+$/);
    });
});

describe('validateCustomAgent', () => {
    const base = { name: 'Test', systemPrompt: 'You are helpful.' };

    it('requires name and prompt', () => {
        expect(() => validateCustomAgent({ name: '', systemPrompt: 'x' })).toThrow();
        expect(() => validateCustomAgent({ name: 'x', systemPrompt: '' })).toThrow();
    });

    it('normalizes id from name', () => {
        const v = validateCustomAgent(base);
        expect(v.id).toBe('test');
    });

    it('rejects embedded credential fields', () => {
        expect(() => validateCustomAgent({
            ...base,
            search: {
                endpoint: 'https://x.search.windows.net',
                indexName: 'idx',
                auth: 'key',
                apiKey: 'leaked',
            } as any,
        })).toThrow(/SecretStorage/);
    });

    it('rejects non-https search endpoints', () => {
        expect(() => validateCustomAgent({
            ...base,
            search: { endpoint: 'http://insecure.example', indexName: 'idx', auth: 'key' },
        })).toThrow(/https/);
    });

    it('defaults search query type to semantic with default config name', () => {
        const v = validateCustomAgent({
            ...base,
            search: { endpoint: 'https://x.search.windows.net', indexName: 'idx', auth: 'key' },
        });
        expect(v.search?.queryType).toBe('semantic');
        expect(v.search?.semanticConfiguration).toBe('default');
        expect(v.search?.topK).toBe(5);
    });
});

describe('CustomAgentStore', () => {
    let tmpDir: string;
    beforeEach(() => { tmpDir = makeTempWorkspace(); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('round-trips workspace agents to .vscode/junior-agents.json', async () => {
        const { store } = makeStore(tmpDir);
        const def: CustomAgentDef = { id: 'a', name: 'A', systemPrompt: 'p' };
        await store.save(def, 'workspace');
        const file = path.join(tmpDir, '.vscode', 'junior-agents.json');
        expect(fs.existsSync(file)).toBe(true);
        const list = await store.list();
        expect(list.map(a => a.id)).toEqual(['a']);
        expect(list[0].scope).toBe('workspace');
    });

    it('round-trips global agents via Memento', async () => {
        const { store, memento } = makeStore(undefined);
        await store.save({ id: 'g', name: 'G', systemPrompt: 'p' }, 'global');
        expect(memento.get<unknown[]>('junior.customAgents.global')?.length).toBe(1);
        const list = await store.list();
        expect(list[0].scope).toBe('global');
    });

    it('workspace agents shadow global agents on id collision', async () => {
        const { store } = makeStore(tmpDir);
        await store.save({ id: 'shared', name: 'Global Version', systemPrompt: 'p' }, 'global');
        await store.save({ id: 'shared', name: 'WS Version', systemPrompt: 'p' }, 'workspace');
        const list = await store.list();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('WS Version');
        expect(list[0].scope).toBe('workspace');
    });

    it('discovers read-only workspace agents from .github/agents/*.agent.md', async () => {
        const { store } = makeStore(tmpDir);
        const dir = path.join(tmpDir, '.github', 'agents');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'squad.agent.md'), `---
name: Squad
description: "Your AI team."
---

You are Squad. Use runSubagent for teammate work.
`, 'utf8');

        const list = await store.list();
        const squad = list.find(a => a.id === 'agent-md-squad');
        expect(squad).toBeTruthy();
        expect(squad?.name).toBe('Squad');
        expect(squad?.description).toBe('Your AI team.');
        expect(squad?.scope).toBe('workspace');
        expect(squad?.source).toBe('agent-md');
        expect(squad?.readonly).toBe(true);
        expect(squad?.systemPrompt).toContain('You are Squad.');
        expect(squad?.systemPrompt).toContain('Junior compatibility');
        expect(squad?.systemPrompt).toContain('Junior provides a `runSubagent` tool');
    });

    it('isolates secrets per agent id and clears them on delete', async () => {
        const { store, secrets } = makeStore(tmpDir);
        await store.save({ id: 'a', name: 'A', systemPrompt: 'p' }, 'workspace');
        await store.setSearchKey('a', 'sekret');
        expect(await store.getSearchKey('a')).toBe('sekret');
        // Verify the key is namespaced.
        expect(await (secrets as any).get('junior.customAgent.a.searchKey')).toBe('sekret');
        await store.delete('a', 'workspace');
        expect(await store.getSearchKey('a')).toBeUndefined();
    });

    it('refuses to save workspace agent when no folder is open', async () => {
        const { store } = makeStore(undefined);
        await expect(store.save({ id: 'a', name: 'A', systemPrompt: 'p' }, 'workspace')).rejects.toThrow();
    });

    it('does not persist credential fields to disk', async () => {
        const { store } = makeStore(tmpDir);
        await store.save({ id: 'a', name: 'A', systemPrompt: 'p' }, 'workspace');
        await store.setSearchKey('a', 'sekret');
        const file = path.join(tmpDir, '.vscode', 'junior-agents.json');
        const raw = fs.readFileSync(file, 'utf8');
        expect(raw).not.toContain('sekret');
        expect(raw).not.toContain('apiKey');
    });
});
