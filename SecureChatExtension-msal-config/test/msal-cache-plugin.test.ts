import { describe, expect, it, vi } from 'vitest';
import type { SecretStorage } from 'vscode';
import { buildCacheStorageKey, createSecretStorageCachePlugin } from '../src/msalCachePlugin';

function inMemorySecretStorage(): SecretStorage & { _store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        _store: store,
        get: vi.fn(async (key: string) => store.get(key)),
        store: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
            store.delete(key);
        }),
        // VS Code's onDidChange is required by typing but unused here.
        onDidChange: vi.fn(() => ({ dispose: () => {} })),
    } as unknown as SecretStorage & { _store: Map<string, string> };
}

function makeContext(initial: string | undefined, cacheHasChanged: boolean) {
    let serialized = initial ?? '';
    const tokenCache = {
        deserialize: vi.fn((s: string) => { serialized = s; }),
        serialize: vi.fn(() => serialized),
        setSerialized: (next: string) => { serialized = next; },
    };
    return {
        tokenCache,
        cacheHasChanged,
    };
}

describe('msalCachePlugin', () => {
    it('builds stable keys per (clientId, authority)', () => {
        const k1 = buildCacheStorageKey('client-a', 'https://login.microsoftonline.com/tenant-a');
        const k2 = buildCacheStorageKey('client-a', 'https://login.microsoftonline.com/tenant-b');
        const k3 = buildCacheStorageKey('client-b', 'https://login.microsoftonline.com/tenant-a');
        expect(k1).not.toBe(k2);
        expect(k1).not.toBe(k3);
        expect(k1.startsWith('junior.msal.cache.')).toBe(true);
        // Special characters in URLs should be escaped, keys should remain ascii-safe.
        expect(k1).toMatch(/^[A-Za-z0-9._:|/-]+$/);
    });

    it('beforeCacheAccess loads previously stored cache', async () => {
        const secrets = inMemorySecretStorage();
        const key = buildCacheStorageKey('c', 'https://a.example/t');
        secrets._store.set(key, '{"foo":"bar"}');
        const plugin = createSecretStorageCachePlugin(secrets, key);
        const ctx = makeContext('', false);

        await plugin.beforeCacheAccess(ctx as any);
        expect(ctx.tokenCache.deserialize).toHaveBeenCalledWith('{"foo":"bar"}');
    });

    it('afterCacheAccess writes the serialized cache when it changed', async () => {
        const secrets = inMemorySecretStorage();
        const key = buildCacheStorageKey('c', 'https://a.example/t');
        const plugin = createSecretStorageCachePlugin(secrets, key);
        const ctx = makeContext('{"new":"value"}', true);

        await plugin.afterCacheAccess(ctx as any);
        expect(secrets.store).toHaveBeenCalledWith(key, '{"new":"value"}');
        expect(secrets._store.get(key)).toBe('{"new":"value"}');
    });

    it('afterCacheAccess does not write when cacheHasChanged is false', async () => {
        const secrets = inMemorySecretStorage();
        const key = buildCacheStorageKey('c', 'https://a.example/t');
        const plugin = createSecretStorageCachePlugin(secrets, key);
        const ctx = makeContext('{"new":"value"}', false);

        await plugin.afterCacheAccess(ctx as any);
        expect(secrets.store).not.toHaveBeenCalled();
    });

    it('afterCacheAccess deletes the entry when serialized cache becomes empty', async () => {
        const secrets = inMemorySecretStorage();
        const key = buildCacheStorageKey('c', 'https://a.example/t');
        secrets._store.set(key, '{"prev":"value"}');
        const plugin = createSecretStorageCachePlugin(secrets, key);
        const ctx = makeContext('{}', true);

        await plugin.afterCacheAccess(ctx as any);
        expect(secrets.delete).toHaveBeenCalledWith(key);
        expect(secrets._store.has(key)).toBe(false);
    });

    it('serializes concurrent cache accesses (no interleaved writes)', async () => {
        const secrets = inMemorySecretStorage();
        const key = buildCacheStorageKey('c', 'https://a.example/t');
        const plugin = createSecretStorageCachePlugin(secrets, key);

        const ctx1 = makeContext('A', true);
        const ctx2 = makeContext('B', true);

        await Promise.all([
            plugin.afterCacheAccess(ctx1 as any),
            plugin.afterCacheAccess(ctx2 as any),
        ]);

        // Last writer wins, but both writes must have happened sequentially.
        expect(secrets.store).toHaveBeenCalledTimes(2);
        expect(['A', 'B']).toContain(secrets._store.get(key));
    });

    it('logs (and does not throw) when SecretStorage read fails', async () => {
        const failing = {
            get: vi.fn(async () => { throw new Error('boom'); }),
            store: vi.fn(async () => {}),
            delete: vi.fn(async () => {}),
            onDidChange: vi.fn(() => ({ dispose: () => {} })),
        } as unknown as SecretStorage;
        const log = vi.fn();
        const plugin = createSecretStorageCachePlugin(failing, 'k', log);
        const ctx = makeContext('', false);

        await expect(plugin.beforeCacheAccess(ctx as any)).resolves.toBeUndefined();
        expect(log).toHaveBeenCalled();
    });
});
