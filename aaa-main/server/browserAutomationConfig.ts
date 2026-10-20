export type BrowserAutomationMode = 'disabled' | 'local' | 'bridge';

export interface BrowserAutomationConfig {
  mode: BrowserAutomationMode;
  enabled: boolean;
}

export function loadBrowserAutomationConfig(
  environment: NodeJS.ProcessEnv = process.env
): BrowserAutomationConfig {
  const mode = environment.AAA_BROWSER_MODE?.trim().toLowerCase() || 'disabled';
  if (mode !== 'disabled' && mode !== 'local' && mode !== 'bridge') {
    throw new Error(`AAA_BROWSER_MODE must be "disabled", "local", or "bridge"; received "${mode}".`);
  }
  return { mode, enabled: mode !== 'disabled' };
}