import * as vscode from 'vscode';

const PRIMARY_NAMESPACE = 'junior';
const LEGACY_NAMESPACE = 'securechat';

/**
 * Read a setting from the new `junior.*` namespace first, then fall back
 * to `securechat.*` for backward compatibility.
 */
export function getSetting<T>(path: string, defaultValue?: T): T | undefined {
    const primary = vscode.workspace.getConfiguration(PRIMARY_NAMESPACE).get<T>(path);
    if (primary !== undefined) { return primary; }

    const legacy = vscode.workspace.getConfiguration(LEGACY_NAMESPACE).get<T>(path);
    if (legacy !== undefined) { return legacy; }

    return defaultValue;
}

/** Update settings in the new `junior.*` namespace. */
export async function updateSetting(
    path: string,
    value: unknown,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
    await vscode.workspace.getConfiguration(PRIMARY_NAMESPACE).update(path, value, target);
}
