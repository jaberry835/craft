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

interface CopilotCliByokConfig {
    hasSignal: boolean;
    type: 'openai' | 'azure' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey: string;
    bearerToken: string;
}

export function buildCopilotCliProcessEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const configuredHome = (getSetting<string>('copilotCli.home') || '').trim();
    if (configuredHome) {
        env.COPILOT_HOME = configuredHome;
    }
    return env;
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
        if ((byokConfig.type === 'azure' || byokConfig.type === 'anthropic') && !byokConfig.apiKey && !byokConfig.bearerToken) {
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

function getByokConfig(env: NodeJS.ProcessEnv): CopilotCliByokConfig {
    const type = ((getSetting<string>('copilotCli.providerType') || env.COPILOT_PROVIDER_TYPE || '').trim().toLowerCase() || 'openai') as 'openai' | 'azure' | 'anthropic';
    const baseUrl = (getSetting<string>('copilotCli.providerBaseUrl') || env.COPILOT_PROVIDER_BASE_URL || '').trim();
    const model = (getSetting<string>('copilotCli.model') || env.COPILOT_MODEL || '').trim();
    const apiKey = (getSetting<string>('copilotCli.providerApiKey') || env.COPILOT_PROVIDER_API_KEY || '').trim();
    const bearerToken = (getSetting<string>('copilotCli.providerBearerToken') || env.COPILOT_PROVIDER_BEARER_TOKEN || '').trim();
    const wireApi = (getSetting<string>('copilotCli.providerWireApi') || env.COPILOT_PROVIDER_WIRE_API || '').trim();
    const azureApiVersion = (getSetting<string>('copilotCli.providerAzureApiVersion') || env.COPILOT_PROVIDER_AZURE_API_VERSION || '').trim();
    const hasSignal = [baseUrl, model, apiKey, bearerToken, wireApi, azureApiVersion].some(Boolean);

    return {
        hasSignal,
        type,
        baseUrl,
        model,
        apiKey,
        bearerToken,
    };
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