/**
 * SecretStorage-backed token cache plugin for MSAL Node.
 *
 * MSAL Node serializes its in-memory token cache to a JSON string. We persist
 * that blob in VS Code SecretStorage (which uses the OS credential store),
 * keyed per (clientId, authority) so multiple `PublicClientApplication`
 * instances do not stomp on each other.
 *
 * Concurrency:
 *   MSAL invokes `beforeCacheAccess` → cache mutation → `afterCacheAccess`
 *   sequentially per acquire/sign-out call. We additionally serialize all
 *   accesses for a given storage key with a per-key promise chain so two
 *   concurrent acquire calls cannot interleave reads/writes.
 */
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import type * as vscode from 'vscode';

const SECRET_KEY_PREFIX = 'junior.msal.cache.';

/**
 * Build the SecretStorage key for an MSAL cache. The key intentionally
 * embeds the clientId + authority so different app registrations do not
 * share a cache file.
 */
export function buildCacheStorageKey(clientId: string, authority: string): string {
    const safe = `${clientId}|${authority}`.replace(/[^A-Za-z0-9._:|/-]/g, '_');
    return `${SECRET_KEY_PREFIX}${safe}`;
}

/**
 * Create an MSAL ICachePlugin backed by VS Code SecretStorage.
 *
 * @param secrets   The extension's SecretStorage handle.
 * @param storageKey Key under which the serialized cache blob is stored.
 * @param log       Optional diagnostic logger. Errors are non-fatal — MSAL
 *                  will fall back to an empty in-memory cache rather than
 *                  failing the acquire call.
 */
export function createSecretStorageCachePlugin(
    secrets: vscode.SecretStorage,
    storageKey: string,
    log?: (msg: string) => void,
): ICachePlugin {
    let lastWritten = '';
    let chain: Promise<void> = Promise.resolve();

    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
        const next = chain.then(work, work);
        // Always continue the chain even if `work` throws.
        chain = next.then(() => undefined, () => undefined);
        return next;
    };

    return {
        beforeCacheAccess(context: TokenCacheContext): Promise<void> {
            return serialize(async () => {
                try {
                    const stored = await secrets.get(storageKey);
                    if (stored && stored.length > 0) {
                        context.tokenCache.deserialize(stored);
                        lastWritten = stored;
                    }
                } catch (err) {
                    log?.(`[msal-cache] beforeCacheAccess failed for key=${storageKey}: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
        },

        afterCacheAccess(context: TokenCacheContext): Promise<void> {
            return serialize(async () => {
                if (!context.cacheHasChanged) {
                    return;
                }
                try {
                    const serialized = context.tokenCache.serialize();
                    if (serialized === lastWritten) {
                        return;
                    }
                    if (!serialized || serialized === '{}' || serialized === '') {
                        await secrets.delete(storageKey);
                    } else {
                        await secrets.store(storageKey, serialized);
                    }
                    lastWritten = serialized;
                } catch (err) {
                    log?.(`[msal-cache] afterCacheAccess failed for key=${storageKey}: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
        },
    };
}
