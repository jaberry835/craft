import * as vscode from 'vscode';

const NAMESPACE = 'juniorgh';

/**
 * Read a setting from the `juniorgh.*` namespace.
 */
export function getSetting<T>(path: string, defaultValue?: T): T | undefined {
    const value = vscode.workspace.getConfiguration(NAMESPACE).get<T>(path);
    if (value !== undefined) { return value; }

    return defaultValue;
}

/** Update settings in the `juniorgh.*` namespace. */
export async function updateSetting(
    path: string,
    value: unknown,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
    await vscode.workspace.getConfiguration(NAMESPACE).update(path, value, target);
}
