import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSetting } from './config';

export interface CopilotCliAvailability {
    available: boolean;
    resolvedCliPath?: string;
    reason?: string;
    mode?: 'github' | 'byok';
}

export interface CopilotCliLaunchSpec {
    cliPath: string;
    cliArgs: string[];
    resolvedCliPath?: string;
}

export interface CopilotCliConfiguredModel {
    name?: string;
    id?: string;
    deploymentId?: string;
}

export interface CopilotCliModelOption {
    name: string;
    deploymentId: string;
}

export interface CopilotCliBearerAuthSessionConfig {
    providerId: string;
    scopes: string[];
}

interface CopilotCliByokConfig {
    hasSignal: boolean;
    type: 'openai' | 'azure' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey: string;
    bearerToken: string;
    bearerAuthSession?: CopilotCliBearerAuthSessionConfig;
}

export function buildCopilotCliProcessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const configuredHome = (getSetting<string>('copilotCli.home') || '').trim();
    if (configuredHome) {
        env.COPILOT_HOME = configuredHome;
    }
    return env;
}

/**
 * Secret-storage backed cache for the Copilot CLI provider API key.
 *
 * The cache is populated by `extension.ts` at activation (and refreshed via
 * `vscode.SecretStorage.onDidChange`). Callers in this module are sync, so we
 * expose a sync getter; the actual `SecretStorage` plumbing lives in the
 * extension layer to keep this file free of `vscode` imports.
 */
export const COPILOT_CLI_API_KEY_SECRET_KEY = 'junior.copilotCli.providerApiKey';
let cachedCopilotCliApiKeySecret: string | undefined;

export function setCopilotCliApiKeySecretCache(value: string | undefined): void {
    cachedCopilotCliApiKeySecret = value && value.trim() ? value : undefined;
}

export function getCopilotCliApiKeySecretCache(): string | undefined {
    return cachedCopilotCliApiKeySecret;
}

/**
 * Resolve the Copilot CLI provider API key in priority order:
 * 1. SecretStorage cache (set via "Junior: Set Copilot CLI API Key")
 * 2. `junior.copilotCli.providerApiKey` setting
 * 3. `COPILOT_PROVIDER_API_KEY` environment variable
 */
export function resolveCopilotCliProviderApiKey(env: NodeJS.ProcessEnv = process.env): string {
    const secret = cachedCopilotCliApiKeySecret;
    if (secret) { return secret; }
    return (getSetting<string>('copilotCli.providerApiKey') || env.COPILOT_PROVIDER_API_KEY || '').trim();
}

export function resolveConfiguredCopilotCliPath(env: NodeJS.ProcessEnv = buildCopilotCliProcessEnv()): string | undefined {
    const configuredPath = (getSetting<string>('copilotCli.path') || '').trim() || 'copilot';
    return resolveExecutable(configuredPath, env);
}

export function resolveConfiguredCopilotCliLaunchSpec(
    additionalArgs: string[] = [],
    env: NodeJS.ProcessEnv = buildCopilotCliProcessEnv()
): CopilotCliLaunchSpec {
    const configuredPath = (getSetting<string>('copilotCli.path') || '').trim() || 'copilot';
    const resolvedCliPath = resolveExecutable(configuredPath, env);
    return buildCopilotCliLaunchSpec(configuredPath, resolvedCliPath, additionalArgs, process.platform, env.ComSpec || process.env.ComSpec || 'cmd.exe');
}

export function buildCopilotCliLaunchSpec(
    configuredPath: string,
    resolvedCliPath: string | undefined,
    additionalArgs: string[] = [],
    platform: NodeJS.Platform = process.platform,
    commandShell: string = process.env.ComSpec || 'cmd.exe'
): CopilotCliLaunchSpec {
    const fallbackCliPath = configuredPath.trim() || 'copilot';
    const directCliPath = resolvedCliPath || fallbackCliPath;

    if (platform === 'win32' && resolvedCliPath && isWindowsCommandShim(resolvedCliPath)) {
        return {
            cliPath: commandShell || 'cmd.exe',
            cliArgs: ['/d', '/s', '/c', buildWindowsShellCommand(resolvedCliPath, additionalArgs)],
            resolvedCliPath,
        };
    }

    return {
        cliPath: directCliPath,
        cliArgs: [...additionalArgs],
        resolvedCliPath,
    };
}

export function normalizeCopilotCliConfiguredModels(models: CopilotCliConfiguredModel[]): CopilotCliModelOption[] {
    return models
        .map((model) => {
            const normalizedId = [model.id, model.deploymentId]
                .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
                ?.trim();
            const normalizedName = typeof model.name === 'string' && model.name.trim().length > 0
                ? model.name.trim()
                : normalizedId || 'Unnamed';

            if (!normalizedId) {
                return undefined;
            }

            return {
                name: normalizedName,
                deploymentId: normalizedId,
            };
        })
        .filter((model): model is CopilotCliModelOption => Boolean(model));
}

export function getCopilotCliAvailability(env: NodeJS.ProcessEnv = buildCopilotCliProcessEnv()): CopilotCliAvailability {
    const resolvedCliPath = resolveConfiguredCopilotCliPath(env);
    if (!resolvedCliPath) {
        return {
            available: false,
            reason: 'Copilot CLI is not installed or junior.copilotCli.path does not point to a valid executable.'
        };
    }

    const byokConfig = getByokConfig(env);
    if (byokConfig.hasSignal) {
        const missing: string[] = [];
        if (!byokConfig.baseUrl) {
            missing.push('provider base URL');
        }
        if (!byokConfig.model) {
            missing.push('model');
        }
        if ((byokConfig.type === 'azure' || byokConfig.type === 'anthropic') && !byokConfig.apiKey && !byokConfig.bearerToken && !byokConfig.bearerAuthSession) {
            missing.push('provider credentials');
        }

        if (missing.length > 0) {
            return {
                available: false,
                resolvedCliPath,
                reason: `Copilot CLI BYOK configuration is incomplete: missing ${missing.join(', ')}.`
            };
        }

        return {
            available: true,
            resolvedCliPath,
            mode: 'byok'
        };
    }

    if (hasGitHubTokenEnv(env) || hasCopilotHomeState(env)) {
        return {
            available: true,
            resolvedCliPath,
            mode: 'github'
        };
    }

    return {
        available: false,
        resolvedCliPath,
        reason: 'Copilot CLI is installed but no GitHub token, Copilot home state, or complete BYOK configuration was found.'
    };
}

export function getCopilotCliBearerAuthSessionConfig(): CopilotCliBearerAuthSessionConfig | undefined {
    const source = (getSetting<string>('copilotCli.providerBearerTokenSource') || '').trim().toLowerCase();
    if (source !== 'vscode-auth-session') {
        return undefined;
    }

    const providerId = (getSetting<string>('copilotCli.providerAuthProviderId') || 'microsoft').trim() || 'microsoft';
    const scopes = normalizeStringArray(getSetting<string[]>('copilotCli.providerAuthScopes'));

    return {
        providerId,
        scopes,
    };
}

function getByokConfig(env: NodeJS.ProcessEnv): CopilotCliByokConfig {
    const type = ((getSetting<string>('copilotCli.providerType') || env.COPILOT_PROVIDER_TYPE || '').trim().toLowerCase() || 'openai') as 'openai' | 'azure' | 'anthropic';
    const baseUrl = (getSetting<string>('copilotCli.providerBaseUrl') || env.COPILOT_PROVIDER_BASE_URL || '').trim();
    const model = (getSetting<string>('copilotCli.model') || env.COPILOT_MODEL || '').trim();
    const apiKey = resolveCopilotCliProviderApiKey(env);
    const bearerToken = (getSetting<string>('copilotCli.providerBearerToken') || env.COPILOT_PROVIDER_BEARER_TOKEN || '').trim();
    const wireApi = (getSetting<string>('copilotCli.providerWireApi') || env.COPILOT_PROVIDER_WIRE_API || '').trim();
    const azureApiVersion = (getSetting<string>('copilotCli.providerAzureApiVersion') || env.COPILOT_PROVIDER_AZURE_API_VERSION || '').trim();
    const bearerAuthSession = getCopilotCliBearerAuthSessionConfig();
    const hasSignal = [baseUrl, model, apiKey, bearerToken, wireApi, azureApiVersion, bearerAuthSession?.providerId].some(Boolean);

    return {
        hasSignal,
        type,
        baseUrl,
        model,
        apiKey,
        bearerToken,
        bearerAuthSession,
    };
}

function normalizeStringArray(values: string[] | undefined): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return values
        .map(value => typeof value === 'string' ? value.trim() : '')
        .filter((value): value is string => value.length > 0);
}

function hasGitHubTokenEnv(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN);
}

function hasCopilotHomeState(env: NodeJS.ProcessEnv): boolean {
    const homeDir = env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
    try {
        const stat = fs.statSync(homeDir);
        if (!stat.isDirectory()) {
            return false;
        }
        return fs.readdirSync(homeDir).length > 0;
    } catch {
        return false;
    }
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
    if (looksLikePath(command)) {
        return resolveExecutablePath(command, env);
    }

    const pathEntries = (env.PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
        const candidate = resolveExecutablePath(path.join(entry, command), env);
        if (candidate) {
            return candidate;
        }
    }

    return undefined;
}

function resolveExecutablePath(basePath: string, env: NodeJS.ProcessEnv): string | undefined {
    const ext = path.extname(basePath);
    const candidates = ext ? [basePath] : buildExecutableCandidates(basePath, env);
    return candidates.find(candidate => {
        try {
            return fs.existsSync(candidate);
        } catch {
            return false;
        }
    });
}

function buildExecutableCandidates(basePath: string, env: NodeJS.ProcessEnv): string[] {
    if (process.platform !== 'win32') {
        return [basePath];
    }

    const pathExt = (env.PATHEXT || process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
        .map(ext => ext.toLowerCase());

    return [...pathExt.map(ext => `${basePath}${ext}`), basePath];
}

function looksLikePath(command: string): boolean {
    return command.includes('\\') || command.includes('/') || /^[a-zA-Z]:/.test(command);
}

function isWindowsCommandShim(commandPath: string): boolean {
    const ext = path.extname(commandPath).toLowerCase();
    return ext === '.cmd' || ext === '.bat';
}

function buildWindowsShellCommand(commandPath: string, args: string[]): string {
    return [commandPath, ...args].map(quoteWindowsShellArg).join(' ');
}

function quoteWindowsShellArg(arg: string): string {
    if (!arg.length) {
        return '""';
    }

    const escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
    return /[\s"&()^<>|]/.test(arg) ? `"${escaped}"` : escaped;
}