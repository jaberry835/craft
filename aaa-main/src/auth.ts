import type { AccountInfo, PublicClientApplication } from '@azure/msal-browser';
import { setApiAuthProvider } from './api/aaaApi';
import type { AuthConfigResponse } from './types/api';

// MSAL is loaded only when sign-in is enabled, keeping it out of the default bundle.
type MsalModule = typeof import('@azure/msal-browser');

/**
 * Browser side of the optional Microsoft Entra sign-in. When the server reports
 * `mode: "none"` nothing here runs and AAA behaves exactly as before.
 */
export type AuthState =
  | { mode: 'none' }
  | { mode: 'entra'; account: AccountInfo | null };

let config: AuthConfigResponse = { mode: 'none' };
let client: PublicClientApplication | null = null;
let msal: MsalModule | null = null;
let initialization: Promise<AuthState> | null = null;

export class SignInRequiredError extends Error {
  constructor(message = 'Sign in with Microsoft Entra to continue.') {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

/** Loads the server's sign-in settings and completes any pending MSAL redirect (runs once). */
export function initializeAuth(): Promise<AuthState> {
  initialization ??= initialize().catch((error: unknown) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

async function initialize(): Promise<AuthState> {
  const response = await fetch('/api/auth/config');
  if (!response.ok) throw new Error(`Could not load sign-in settings (HTTP ${response.status}).`);
  config = await response.json() as AuthConfigResponse;
  if (config.mode !== 'entra') return { mode: 'none' };

  msal = await import('@azure/msal-browser');
  client = new msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      redirectUri: config.redirectUri ?? window.location.origin,
      postLogoutRedirectUri: config.redirectUri ?? window.location.origin
    },
    cache: { cacheLocation: 'sessionStorage' }
  });
  await client.initialize();
  const redirect = await client.handleRedirectPromise();
  const account = redirect?.account ?? client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
  if (account) client.setActiveAccount(account);
  setApiAuthProvider({
    enabled: authEnabled,
    headers: authHeaders,
    onAuthRequired: () => window.dispatchEvent(new CustomEvent('aaa:auth-required'))
  });
  return { mode: 'entra', account };
}

export function authEnabled(): boolean {
  return config.mode === 'entra';
}

export async function signIn(): Promise<void> {
  if (!client || config.mode !== 'entra') return;
  await client.loginRedirect({ scopes: config.scopes, prompt: 'select_account' });
}

export async function signOut(): Promise<void> {
  if (!client || config.mode !== 'entra') return;
  await fetch('/api/auth/session', { method: 'DELETE', headers: await authHeaders() }).catch(() => undefined);
  await client.logoutRedirect({ account: client.getActiveAccount() ?? undefined });
}

/** Authorization header for API calls, or nothing when sign-in is off. */
export async function authHeaders(forceRefresh = false): Promise<Record<string, string>> {
  if (!client || config.mode !== 'entra') return {};
  const account = client.getActiveAccount() ?? client.getAllAccounts()[0];
  if (!account) throw new SignInRequiredError();
  try {
    const result = await client.acquireTokenSilent({ account, scopes: config.scopes, forceRefresh });
    return { Authorization: `Bearer ${result.accessToken}` };
  } catch (error) {
    if (msal && error instanceof msal.InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({ account, scopes: config.scopes });
      throw new SignInRequiredError('Your sign-in expired. Redirecting to Microsoft Entra…');
    }
    throw error;
  }
}

/**
 * Exchanges the access token for the HttpOnly cookie that authorizes GET-only resources
 * (images, published previews) which cannot send an Authorization header.
 */
export async function refreshBrowserSession(): Promise<void> {
  if (config.mode !== 'entra') return;
  const response = await fetch('/api/auth/session', { method: 'POST', headers: await authHeaders() });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `Sign-in could not be completed (HTTP ${response.status}).`);
  }
}
