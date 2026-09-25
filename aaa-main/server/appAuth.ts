import { randomBytes } from 'node:crypto';
import type express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthenticationError, AuthorizationError } from './httpErrors.js';
import { log } from './logger.js';
import type { AuthConfigResponse, AuthIdentity } from '../src/types/api.js';

/**
 * Optional Microsoft Entra sign-in for the AAA web app, off by default.
 *
 * `AAA_AUTH_MODE=entra` turns it on. The browser signs in with MSAL and calls the API with
 * bearer tokens that are validated against the tenant's published signing keys. Because
 * `<img>`, the published-preview frame, and "open in new tab" cannot send headers, the
 * client exchanges its token for an HttpOnly, SameSite=Strict session cookie that is
 * accepted only for GET/HEAD requests; every state-changing request still needs the bearer
 * token, so the cookie cannot be used for cross-site request forgery.
 */
export type AppAuthMode = 'none' | 'entra';

export interface AppAuthConfig {
  mode: AppAuthMode;
  tenantId: string;
  clientId: string;
  /** Authority host without tenant, e.g. https://login.microsoftonline.com or https://login.microsoftonline.us. */
  authorityHost: string;
  audiences: string[];
  scopes: string[];
  issuers: string[];
  allowedRoles: string[];
  redirectUri?: string;
}

export type TokenVerifier = (token: string) => Promise<{ identity: AuthIdentity; expiresAt: number }>;

const sessionCookie = 'aaa_session';
const sessionRefreshMs = 55 * 60_000;

export function loadAppAuthConfig(environment: NodeJS.ProcessEnv = process.env): AppAuthConfig {
  const raw = environment.AAA_AUTH_MODE?.trim().toLowerCase() || 'none';
  if (raw !== 'none' && raw !== 'entra') {
    throw new Error(`AAA_AUTH_MODE must be "none" or "entra"; received "${raw}".`);
  }
  const list = (name: string) => (environment[name] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const tenantId = environment.AAA_ENTRA_TENANT_ID?.trim() ?? '';
  const clientId = environment.AAA_ENTRA_CLIENT_ID?.trim() ?? '';
  const authorityHost = (environment.AAA_ENTRA_AUTHORITY_HOST?.trim() || 'https://login.microsoftonline.com').replace(/\/+$/, '');
  const audience = environment.AAA_ENTRA_API_AUDIENCE?.trim() || (clientId ? `api://${clientId}` : '');
  const config: AppAuthConfig = {
    mode: raw,
    tenantId,
    clientId,
    authorityHost,
    audiences: [...new Set([audience, clientId, clientId ? `api://${clientId}` : ''].filter(Boolean))],
    scopes: list('AAA_ENTRA_SCOPES').length ? list('AAA_ENTRA_SCOPES') : (audience ? [`${audience}/access_as_user`] : []),
    issuers: list('AAA_ENTRA_ISSUERS').length
      ? list('AAA_ENTRA_ISSUERS')
      : [`${authorityHost}/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`],
    allowedRoles: list('AAA_ENTRA_ALLOWED_ROLES'),
    ...(environment.AAA_ENTRA_REDIRECT_URI?.trim() ? { redirectUri: environment.AAA_ENTRA_REDIRECT_URI.trim() } : {})
  };
  if (config.mode === 'entra') {
    const missing = [!tenantId && 'AAA_ENTRA_TENANT_ID', !clientId && 'AAA_ENTRA_CLIENT_ID'].filter(Boolean);
    if (missing.length > 0) throw new Error(`AAA_AUTH_MODE=entra requires ${missing.join(' and ')}.`);
    try {
      if (new URL(authorityHost).protocol !== 'https:') throw new Error('protocol');
    } catch {
      throw new Error('AAA_ENTRA_AUTHORITY_HOST must be an HTTPS URL such as https://login.microsoftonline.us.');
    }
  }
  return config;
}

/** Settings the browser needs to start MSAL; contains no secrets. */
export function publicAuthConfig(config: AppAuthConfig): AuthConfigResponse {
  return config.mode === 'entra'
    ? {
      mode: 'entra',
      clientId: config.clientId,
      authority: `${config.authorityHost}/${config.tenantId}`,
      scopes: config.scopes,
      ...(config.redirectUri ? { redirectUri: config.redirectUri } : {})
    }
    : { mode: 'none' };
}

interface EntraClaims extends JWTPayload {
  oid?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  upn?: string;
  roles?: unknown;
}

export function createEntraTokenVerifier(config: AppAuthConfig): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${config.authorityHost}/${config.tenantId}/discovery/v2.0/keys`));
  return async (token) => {
    let payload: EntraClaims;
    try {
      ({ payload } = await jwtVerify<EntraClaims>(token, jwks, { issuer: config.issuers, audience: config.audiences }));
    } catch (error) {
      log.info('auth', 'Rejected a bearer token.', { reason: error instanceof Error ? error.message : 'invalid token' });
      throw new AuthenticationError('Your Microsoft Entra sign-in is invalid or expired. Sign in again.', 'auth_invalid');
    }
    return { identity: identityFromClaims(payload), expiresAt: (payload.exp ?? 0) * 1000 };
  };
}

export function identityFromClaims(claims: EntraClaims): AuthIdentity {
  const userId = [claims.oid, claims.sub].find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!userId) throw new AuthenticationError('The sign-in token has no user identifier.', 'auth_invalid');
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  return {
    userId,
    displayName: text(claims.name) ?? text(claims.preferred_username) ?? text(claims.upn) ?? userId,
    ...(text(claims.preferred_username) ?? text(claims.upn) ? { username: text(claims.preferred_username) ?? text(claims.upn) } : {}),
    ...(text(claims.tid) ? { tenantId: text(claims.tid) } : {}),
    roles: Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === 'string') : []
  };
}

/** In-memory browser sessions created from a validated bearer token. */
export class AuthSessionStore {
  private readonly sessions = new Map<string, { identity: AuthIdentity; expiresAt: number }>();

  create(identity: AuthIdentity, tokenExpiresAt: number): { id: string; expiresAt: number } {
    this.prune();
    const id = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(tokenExpiresAt || Date.now() + sessionRefreshMs, Date.now() + sessionRefreshMs);
    this.sessions.set(id, { identity, expiresAt });
    return { id, expiresAt };
  }

  get(id: string | undefined): AuthIdentity | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session.identity;
  }

  revoke(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    identity?: AuthIdentity;
  }
}

function readCookie(request: express.Request, name: string): string | undefined {
  for (const part of (request.header('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function bearerToken(request: express.Request): string | undefined {
  return /^Bearer\s+(.+)$/i.exec(request.header('authorization') ?? '')?.[1]?.trim() || undefined;
}

/**
 * Adds `/api/auth/*` routes and, when auth is on, requires a signed-in user for every
 * other `/api` route. Static client assets stay public so the sign-in page can load.
 */
export function installAppAuth(
  app: express.Express,
  config: AppAuthConfig,
  verifier: TokenVerifier | undefined,
  sessions = new AuthSessionStore()
): void {
  const enabled = config.mode === 'entra';
  if (enabled && !verifier) throw new Error('A token verifier is required when Microsoft Entra sign-in is enabled.');

  const authorize = (identity: AuthIdentity): AuthIdentity => {
    if (config.allowedRoles.length > 0) {
      const owned = new Set(identity.roles.map((role) => role.toLowerCase()));
      if (!config.allowedRoles.some((role) => owned.has(role.toLowerCase()))) {
        log.warn('auth', 'Signed-in user lacks an allowed app role.', { user: identity.username ?? identity.userId, roles: identity.roles.join(',') });
        throw new AuthorizationError(`Your account needs one of these AAA roles: ${config.allowedRoles.join(', ')}.`);
      }
    }
    return identity;
  };

  app.get('/api/auth/config', (_request, response) => {
    response.json(publicAuthConfig(config));
  });

  app.use('/api', async (request, _response, next) => {
    if (!enabled || request.path === '/auth/config') {
      next();
      return;
    }
    try {
      const token = bearerToken(request);
      if (token) {
        request.identity = authorize((await verifier!(token)).identity);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        const identity = sessions.get(readCookie(request, sessionCookie));
        if (!identity) throw new AuthenticationError();
        request.identity = identity;
      } else {
        throw new AuthenticationError();
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', (request, response) => {
    response.json({ mode: config.mode, ...(request.identity ? { identity: request.identity } : {}) });
  });

  app.post('/api/auth/session', async (request, response) => {
    if (!enabled) {
      response.json({ mode: 'none' });
      return;
    }
    const token = bearerToken(request);
    if (!token) throw new AuthenticationError();
    const verified = await verifier!(token);
    const identity = authorize(verified.identity);
    const previous = readCookie(request, sessionCookie);
    sessions.revoke(previous);
    const session = sessions.create(identity, verified.expiresAt);
    const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    response.setHeader('Set-Cookie', [
      `${sessionCookie}=${encodeURIComponent(session.id)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/api',
      `Max-Age=${maxAge}`,
      ...(request.secure ? ['Secure'] : [])
    ].join('; '));
    if (!previous) log.info('auth', 'User signed in.', { user: identity.username ?? identity.userId });
    response.json({ mode: 'entra', identity, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  app.delete('/api/auth/session', (request, response) => {
    sessions.revoke(readCookie(request, sessionCookie));
    response.setHeader('Set-Cookie', `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`);
    response.json({ signedOut: true });
  });
}
