import * as vscode from 'vscode';

/**
 * SecretStorage-backed key for the Copilot CLI BYOK provider API key.
 *
 * Mirrors the AzureOpenAIClient key pattern: a single secret slot, a
 * write-through cache for synchronous reads (the BYOK config builder is
 * sync), and onDidChange invalidation so other windows stay in sync.
 *
 * Lookup priority used by callers:
 *   1. SecretStorage (this module's cache)
 *   2. settings.json `junior.copilotCli.providerApiKey`
 *   3. env COPILOT_PROVIDER_API_KEY
 */
const SECRET_KEY = 'junior.copilotCli.providerApiKey';

let secrets: vscode.SecretStorage | undefined;
let cached: string | undefined;
let primed = false;

export function setCopilotCliSecretStorage(s: vscode.SecretStorage): void {
    secrets = s;
    // Prime the cache asynchronously so sync getters work shortly after activation.
    void s.get(SECRET_KEY).then(value => {
        cached = value || undefined;
        primed = true;
    });
    s.onDidChange(e => {
        if (e.key === SECRET_KEY) {
            cached = undefined;
            primed = false;
            void s.get(SECRET_KEY).then(value => {
                cached = value || undefined;
                primed = true;
            });
        }
    });
}

/** Synchronous read of the cached secret. Returns undefined if not yet primed or not set. */
export function getCopilotCliApiKey(): string | undefined {
    return cached;
}

/** Async read that ensures the cache has been primed. */
export async function getCopilotCliApiKeyAsync(): Promise<string | undefined> {
    if (primed) { return cached; }
    if (!secrets) { return undefined; }
    const value = await secrets.get(SECRET_KEY);
    cached = value || undefined;
    primed = true;
    return cached;
}

export async function storeCopilotCliApiKey(key: string): Promise<void> {
    if (!secrets) { return; }
    await secrets.store(SECRET_KEY, key);
    cached = key;
    primed = true;
}

export async function clearCopilotCliApiKey(): Promise<void> {
    if (!secrets) { return; }
    await secrets.delete(SECRET_KEY);
    cached = undefined;
    primed = true;
}
