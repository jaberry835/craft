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

/**
 * Read a setting only when the user explicitly configured it, ignoring package defaults.
 */
export function getConfiguredSetting<T>(path: string): T | undefined {
    for (const namespace of [PRIMARY_NAMESPACE, LEGACY_NAMESPACE]) {
        const inspected = vscode.workspace.getConfiguration(namespace).inspect<T>(path);
        const value = inspected?.workspaceFolderValue
            ?? inspected?.workspaceValue
            ?? inspected?.globalValue;
        if (value !== undefined) { return value; }
    }

    return undefined;
}

/** Update settings in the new `junior.*` namespace. */
export async function updateSetting(
    path: string,
    value: unknown,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
    await vscode.workspace.getConfiguration(PRIMARY_NAMESPACE).update(path, value, target);
}
