import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { getSetting, updateSetting } from './config';

interface CachedCaCertificate {
    configuredPath: string;
    resolvedPath: string;
    mtimeMs: number;
    pem: string;
}

type NetworkLogLevel = 'INFO' | 'WARN';
type NetworkLogger = (msg: string, level?: NetworkLogLevel) => void;

const GLOBAL_CA_BUNDLE_FILE = 'ca-bundle.pem';
const GLOBAL_CA_REFRESH_SCRIPT_FILE = 'junior-refresh-ca.ps1';
const CA_REFRESH_TIMEOUT_MS = 60_000;
const RUN_REFRESH = 'Run CA refresh script';
const ADD_REFRESH_SCRIPT = 'Add CA refresh script';
const OPEN_SETTINGS = 'Open Settings';

let cachedCaCertificate: CachedCaCertificate | undefined;
let lastLoadedResolvedPath: string | undefined;
let lastWarnedKey: string | undefined;
let logger: NetworkLogger = (msg) => console.warn(`[junior.network] ${msg}`);
let activeRefresh: Promise<boolean> | undefined;
const declinedRefreshKeys = new Set<string>();
let globalNetworkStorageDir: string | undefined;

/** Register the output channel sink used for one-time CA load notices and warnings. */
export function setNetworkLogger(fn: NetworkLogger): void {
    logger = fn;
}

export function setNetworkStorageUri(globalStorageUri: vscode.Uri): void {
    globalNetworkStorageDir = path.join(globalStorageUri.fsPath, 'network');
}

/** Test hook: clear cached PEM state and one-time log keys. */
export function resetNetworkStateForTests(): void {
    cachedCaCertificate = undefined;
    lastLoadedResolvedPath = undefined;
    lastWarnedKey = undefined;
    activeRefresh = undefined;
    declinedRefreshKeys.clear();
    globalNetworkStorageDir = undefined;
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

export function clearConfiguredCaCertificateCache(): void {
    cachedCaCertificate = undefined;
    lastLoadedResolvedPath = undefined;
}

export function isTlsCertificateError(err: unknown): boolean {
    const anyErr = err as { code?: unknown; message?: unknown } | undefined;
    const code = typeof anyErr?.code === 'string' ? anyErr.code.toUpperCase() : '';
    const message = typeof anyErr?.message === 'string' ? anyErr.message.toLowerCase() : String(err ?? '').toLowerCase();
    return [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
    ].includes(code)
        || message.includes('unable to verify the first certificate')
        || message.includes('unable to get local issuer certificate')
        || message.includes('self signed certificate in certificate chain')
        || message.includes('certificate verify failed');
}

export async function withCaRefreshRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    try {
        return await operation();
    } catch (err) {
        if (await maybeRefreshCaBundleAfterTlsError(err, context)) {
            return operation();
        }
        throw err;
    }
}

export async function maybeRefreshCaBundleAfterTlsError(err: unknown, context: string): Promise<boolean> {
    if (!isTlsCertificateError(err)) { return false; }

    const caCertPath = getConfiguredCaCertPath();
    if (!caCertPath) {
        const action = await vscode.window.showWarningMessage(
            `Junior could not connect because TLS certificate validation failed while ${context}. Configure junior.network.caCertPath to use an additional CA bundle.`,
            OPEN_SETTINGS
        );
        if (action === OPEN_SETTINGS) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.network.caCertPath');
        }
        return false;
    }

    const script = resolveCaRefreshScriptPath(getConfiguredCaRefreshScriptPath());
    const refreshKey = `${script.resolvedPath || script.configuredPath}|${caCertPath}`;
    if (declinedRefreshKeys.has(refreshKey)) { return false; }

    if (!script.ok) {
        logger(`TLS certificate validation failed while ${context}. CA refresh script is not runnable: ${script.reason}`, 'WARN');
        const action = await vscode.window.showWarningMessage(
            'Junior could not connect because TLS certificate validation failed. A user-level CA refresh script is not configured or not valid.',
            ADD_REFRESH_SCRIPT,
            OPEN_SETTINGS,
            'Dismiss'
        );
        if (action === ADD_REFRESH_SCRIPT) {
            await vscode.commands.executeCommand('junior.addCaRefreshScript');
        } else if (action === OPEN_SETTINGS) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.network.caCertRefreshScriptPath');
        } else {
            declinedRefreshKeys.add(refreshKey);
        }
        return false;
    }

    if (!fs.existsSync(script.resolvedPath)) {
        const action = await vscode.window.showWarningMessage(
            `Junior could not connect because TLS certificate validation failed. CA refresh script ${script.configuredPath} was not found.`,
            ADD_REFRESH_SCRIPT,
            OPEN_SETTINGS,
            'Dismiss'
        );
        if (action === ADD_REFRESH_SCRIPT) {
            await vscode.commands.executeCommand('junior.addCaRefreshScript');
        } else if (action === OPEN_SETTINGS) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.network.caCertRefreshScriptPath');
        } else {
            declinedRefreshKeys.add(refreshKey);
        }
        return false;
    }

    const action = await vscode.window.showWarningMessage(
        `Junior could not connect because TLS certificate validation failed while ${context}. Your configured CA bundle may be missing or stale.`,
        RUN_REFRESH,
        OPEN_SETTINGS,
        'Dismiss'
    );
    if (action === OPEN_SETTINGS) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'junior.network.caCertPath');
        return false;
    }
    if (action !== RUN_REFRESH) {
        declinedRefreshKeys.add(refreshKey);
        return false;
    }

    activeRefresh ??= runCaRefreshScript(script.cwd, script.resolvedPath, caCertPath)
        .finally(() => { activeRefresh = undefined; });
    return activeRefresh;
}

export async function installCaRefreshScriptToUserProfile(extensionUri: vscode.Uri, globalStorageUri: vscode.Uri): Promise<void> {
    setNetworkStorageUri(globalStorageUri);
    const networkDir = path.join(globalStorageUri.fsPath, 'network');
    const scriptPath = path.join(networkDir, GLOBAL_CA_REFRESH_SCRIPT_FILE);
    const caCertPath = path.join(networkDir, GLOBAL_CA_BUNDLE_FILE);

    const action = await vscode.window.showInformationMessage(
        'Junior can create a user-level CA refresh script and PEM cache in VS Code extension storage, then configure Junior User settings so all workspaces can use them.',
        'Create',
        'Cancel'
    );
    if (action !== 'Create') { return; }

    fs.mkdirSync(networkDir, { recursive: true });
    if (fs.existsSync(scriptPath)) {
        const existing = await vscode.window.showWarningMessage(
            'Junior: A user-level CA refresh script already exists.',
            'Open Existing',
            'Overwrite',
            'Cancel'
        );
        if (existing === 'Open Existing') {
            await configureCaRefreshUserSettings(scriptPath, caCertPath);
            await openFile(scriptPath);
            return;
        }
        if (existing !== 'Overwrite') { return; }
    }

    fs.writeFileSync(scriptPath, readCaRefreshScriptTemplate(extensionUri), 'utf8');
    await configureCaRefreshUserSettings(scriptPath, caCertPath);
    await openFile(scriptPath);
    vscode.window.showInformationMessage('Junior: User-level CA refresh script added. Review and customize it before running it.');
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

function getConfiguredCaRefreshScriptPath(): string {
    return (getSetting<string>('network.caCertRefreshScriptPath') || '').trim();
}

function resolveCaRefreshScriptPath(configuredPath: string): { ok: true; configuredPath: string; resolvedPath: string; cwd: string } | { ok: false; configuredPath: string; resolvedPath?: string; reason: string } {
    if (!configuredPath) {
        return { ok: false, configuredPath, reason: 'junior.network.caCertRefreshScriptPath is not configured. Run Junior: Add CA Refresh Script to create a user-level script.' };
    }
    if (path.isAbsolute(configuredPath)) {
        if (path.extname(configuredPath).toLowerCase() !== '.ps1') {
            return { ok: false, configuredPath, reason: 'junior.network.caCertRefreshScriptPath must point to a .ps1 file.' };
        }
        if (!globalNetworkStorageDir || !isPathEqualOrInside(configuredPath, ensureTrailingSep(globalNetworkStorageDir), globalNetworkStorageDir)) {
            return { ok: false, configuredPath, resolvedPath: configuredPath, reason: 'Absolute junior.network.caCertRefreshScriptPath values must be inside Junior extension storage. Run Junior: Add CA Refresh Script to create a trusted user-level script.' };
        }
        return { ok: true, configuredPath, resolvedPath: configuredPath, cwd: globalNetworkStorageDir };
    }

    return { ok: false, configuredPath, reason: 'junior.network.caCertRefreshScriptPath must be the absolute user-level script path created by Junior: Add CA Refresh Script.' };
}

function ensureTrailingSep(value: string): string {
    return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function isPathEqualOrInside(candidate: string, rootWithSep: string, root: string): boolean {
    const normalizeCase = process.platform === 'win32'
        ? (value: string) => value.toLowerCase()
        : (value: string) => value;
    const candidateNorm = normalizeCase(path.normalize(candidate));
    const rootNorm = normalizeCase(path.normalize(root));
    const rootWithSepNorm = normalizeCase(path.normalize(rootWithSep));
    return candidateNorm === rootNorm || candidateNorm.startsWith(rootWithSepNorm);
}

function runCaRefreshScript(workspaceRoot: string, scriptPath: string, caCertPath: string): Promise<boolean> {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const resolvedCaCertPath = path.isAbsolute(caCertPath) ? caCertPath : path.resolve(workspaceRoot, caCertPath);
    logger(`Running CA refresh script ${scriptPath}`);
    return new Promise((resolve) => {
        execFile(
            shell,
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-CaCertPath', resolvedCaCertPath],
            { cwd: workspaceRoot, timeout: CA_REFRESH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
                if (stdout.trim()) { logger(`CA refresh stdout:\n${stdout.trim()}`); }
                if (stderr.trim()) { logger(`CA refresh stderr:\n${stderr.trim()}`, 'WARN'); }
                if (err) {
                    logger(`CA refresh script failed: ${err.message}`, 'WARN');
                    vscode.window.showErrorMessage('Junior: CA refresh script failed. See the Junior output channel for details.');
                    resolve(false);
                    return;
                }
                clearConfiguredCaCertificateCache();
                logger('CA refresh script completed successfully. Retrying the failed request.');
                resolve(true);
            }
        );
    });
}

async function configureCaRefreshUserSettings(scriptPath: string, caCertPath: string): Promise<void> {
    await updateSetting('network.caCertPath', caCertPath, vscode.ConfigurationTarget.Global);
    await updateSetting('network.caCertRefreshScriptPath', scriptPath, vscode.ConfigurationTarget.Global);
}

async function openFile(fsPath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    await vscode.window.showTextDocument(doc, { preview: false });
}

function readCaRefreshScriptTemplate(extensionUri: vscode.Uri): string {
    const templatePath = vscode.Uri.joinPath(extensionUri, 'templates', 'junior-refresh-ca.ps1').fsPath;
    return fs.readFileSync(templatePath, 'utf8');
}
