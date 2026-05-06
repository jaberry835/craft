import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { getSetting } from './config';

interface CachedCaCertificate {
    configuredPath: string;
    resolvedPath: string;
    mtimeMs: number;
    pem: string;
}

type NetworkLogLevel = 'INFO' | 'WARN';
type NetworkLogger = (msg: string, level?: NetworkLogLevel) => void;

let cachedCaCertificate: CachedCaCertificate | undefined;
let lastLoadedResolvedPath: string | undefined;
let lastWarnedKey: string | undefined;
let logger: NetworkLogger = (msg) => console.warn(`[junior.network] ${msg}`);

/** Register the output channel sink used for one-time CA load notices and warnings. */
export function setNetworkLogger(fn: NetworkLogger): void {
    logger = fn;
}

/** Test hook: clear cached PEM state and one-time log keys. */
export function resetNetworkStateForTests(): void {
    cachedCaCertificate = undefined;
    lastLoadedResolvedPath = undefined;
    lastWarnedKey = undefined;
}

export function getConfiguredCaCertPath(): string | undefined {
    const configuredPath = (getSetting<string>('network.caCertPath') || '').trim();
    return configuredPath || undefined;
}

/**
 * Resolve and read the configured PEM file. Returns `undefined` when the setting
 * is not configured OR when the file cannot be read; the caller falls back to
 * default Node trust. Read failures are logged once per unique error so a bad
 * configuration is visible in the Junior output channel without spamming logs
 * or breaking outbound calls.
 */
export function getConfiguredCaCertificate(): string | undefined {
    const configuredPath = getConfiguredCaCertPath();
    if (!configuredPath) {
        return undefined;
    }

    const resolvedPath = resolveCaCertPath(configuredPath);

    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolvedPath);
    } catch (err: any) {
        warnOnce(`stat:${resolvedPath}`, `junior.network.caCertPath could not be read: ${resolvedPath} (${err?.message || err}). Falling back to default trust.`);
        return undefined;
    }

    if (!stat.isFile()) {
        warnOnce(`notfile:${resolvedPath}`, `junior.network.caCertPath must point to a PEM file: ${resolvedPath}. Falling back to default trust.`);
        return undefined;
    }

    if (cachedCaCertificate
        && cachedCaCertificate.configuredPath === configuredPath
        && cachedCaCertificate.resolvedPath === resolvedPath
        && cachedCaCertificate.mtimeMs === stat.mtimeMs) {
        return cachedCaCertificate.pem;
    }

    let pem: string;
    try {
        pem = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err: any) {
        warnOnce(`read:${resolvedPath}`, `junior.network.caCertPath could not be read: ${resolvedPath} (${err?.message || err}). Falling back to default trust.`);
        return undefined;
    }

    if (!pem.trim()) {
        warnOnce(`empty:${resolvedPath}`, `junior.network.caCertPath points to an empty PEM file: ${resolvedPath}. Falling back to default trust.`);
        return undefined;
    }

    cachedCaCertificate = {
        configuredPath,
        resolvedPath,
        mtimeMs: stat.mtimeMs,
        pem,
    };

    if (lastLoadedResolvedPath !== resolvedPath) {
        lastLoadedResolvedPath = resolvedPath;
        // Clear stale warnings for this path so a fixed file logs again if it breaks later.
        lastWarnedKey = undefined;
        logger(`Loaded additional CA certificates from ${resolvedPath} for local Junior HTTPS calls.`);
    }

    return pem;
}

export function getConfiguredTlsOptions(): { ca?: string[] } {
    const pem = getConfiguredCaCertificate();
    return pem ? { ca: [...tls.rootCertificates, pem] } : {};
}

function resolveCaCertPath(configuredPath: string): string {
    if (path.isAbsolute(configuredPath)) {
        return configuredPath;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return workspaceRoot ? path.resolve(workspaceRoot, configuredPath) : path.resolve(configuredPath);
}

function warnOnce(key: string, msg: string): void {
    if (lastWarnedKey === key) { return; }
    lastWarnedKey = key;
    logger(msg, 'WARN');
}
