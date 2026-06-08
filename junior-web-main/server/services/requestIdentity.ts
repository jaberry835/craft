import type express from 'express';
import { AuthenticationError, AuthorizationError } from '../httpErrors.js';
import type { RequestIdentity } from '../types.js';
import { createEntraTokenVerifier, type EntraAuthOptions, type TokenVerifier } from './entraTokenVerifier.js';

declare module 'express-serve-static-core' {
  interface Request {
    requestIdentity?: RequestIdentity;
  }
}

export type IdentityMode = 'local-fallback' | 'trusted-header' | 'entra-msal';

export interface RequestIdentityOptions {
  mode: IdentityMode;
  fallbackIdentity: RequestIdentity;
  adminRoles: string[];
  userRoles: string[];
  entra: EntraAuthOptions | null;
  tokenVerifier: TokenVerifier | null;
}

export interface RequestIdentityOptionsInput {
  mode?: IdentityMode;
  fallbackIdentity?: Partial<RequestIdentity>;
  adminRoles?: string[];
  userRoles?: string[];
  entra?: Partial<EntraAuthOptions>;
  tokenVerifier?: TokenVerifier;
}

const defaultAdminRoles = ['admin', 'Junior.Admin'];
const defaultUserRoles = ['Junior.User', 'Junior.Admin', 'admin'];

export function resolveRequestIdentityOptions(
  overrides: RequestIdentityOptionsInput | undefined,
  env: NodeJS.ProcessEnv = process.env
): RequestIdentityOptions {
  const defaults = loadRequestIdentityOptions(env);
  const mode = overrides?.mode ?? defaults.mode;
  const entra = resolveEntraOptions(mode, defaults.entra, overrides?.entra);

  return {
    mode,
    fallbackIdentity: {
      ...defaults.fallbackIdentity,
      ...overrides?.fallbackIdentity,
      roles: overrides?.fallbackIdentity?.roles ?? defaults.fallbackIdentity.roles
    },
    adminRoles: overrides?.adminRoles ?? defaults.adminRoles,
    userRoles: overrides?.userRoles ?? defaults.userRoles,
    entra,
    tokenVerifier: overrides?.tokenVerifier ?? (mode === 'entra-msal' && entra ? createEntraTokenVerifier(entra) : null)
  };
}

export function attachRequestIdentity(options: RequestIdentityOptions): express.RequestHandler {
  return async (request, _response, next) => {
    try {
      request.requestIdentity = await resolveRequestIdentity(request, options);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRequestIdentity(request: express.Request): RequestIdentity {
  const identity = request.requestIdentity;
  if (!identity) {
    throw new AuthenticationError('No request identity was supplied.');
  }

  return identity;
}

export function requireAdminIdentity(request: express.Request, adminRoles: readonly string[]): RequestIdentity {
  const identity = requireRequestIdentity(request);
  if (!hasAnyRole(identity, adminRoles)) {
    throw new AuthorizationError('Admin access is required for this route.');
  }

  return identity;
}

export function requireUserIdentity(request: express.Request, userRoles: readonly string[]): RequestIdentity {
  const identity = requireRequestIdentity(request);
  if (!hasAnyRole(identity, userRoles)) {
    throw new AuthorizationError('A Junior user role is required for this route.');
  }

  return identity;
}

export function hasAnyRole(identity: RequestIdentity, roles: readonly string[]): boolean {
  const ownedRoles = new Set(identity.roles.map((role) => role.toLowerCase()));
  return roles.some((role) => ownedRoles.has(role.toLowerCase()));
}

function loadRequestIdentityOptions(env: NodeJS.ProcessEnv): RequestIdentityOptions {
  const mode = normalizeIdentityMode(env.JUNIOR_IDENTITY_MODE);
  return {
    mode,
    fallbackIdentity: {
      userId: env.JUNIOR_IDENTITY_FALLBACK_USER_ID?.trim() || 'admin',
      displayName: env.JUNIOR_IDENTITY_FALLBACK_DISPLAY_NAME?.trim() || 'Admin',
      tenantId: env.JUNIOR_IDENTITY_FALLBACK_TENANT_ID?.trim() || undefined,
      roles: parseList(env.JUNIOR_IDENTITY_FALLBACK_ROLES) ?? ['Junior.Admin', 'Junior.User'],
      authSource: 'local-fallback',
      isAuthenticated: false
    },
    adminRoles: parseList(env.JUNIOR_ADMIN_ROLES) ?? defaultAdminRoles,
    userRoles: parseList(env.JUNIOR_USER_ROLES) ?? defaultUserRoles,
    entra: loadEntraOptions(mode, env),
    tokenVerifier: null
  };
}

async function resolveRequestIdentity(request: express.Request, options: RequestIdentityOptions): Promise<RequestIdentity | undefined> {
  if (options.mode === 'local-fallback') {
    return options.fallbackIdentity;
  }

  if (options.mode === 'entra-msal') {
    const token = readBearerToken(request);
    if (!token) {
      return undefined;
    }

    if (!options.tokenVerifier) {
      throw new AuthenticationError('Microsoft Entra token validation is not configured.');
    }

    return options.tokenVerifier(token);
  }

  const userId = readSingleHeader(request, 'x-junior-user-id');
  if (!userId) {
    return undefined;
  }

  const displayName = readSingleHeader(request, 'x-junior-display-name') ?? userId;
  const roles = parseList(readSingleHeader(request, 'x-junior-roles')) ?? ['Junior.User'];
  return {
    userId,
    displayName,
    tenantId: readSingleHeader(request, 'x-junior-tenant-id') ?? undefined,
    roles,
    authSource: 'trusted-header',
    isAuthenticated: true
  };
}

function readSingleHeader(request: express.Request, headerName: string): string | undefined {
  const value = request.header(headerName);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIdentityMode(mode: string | undefined): IdentityMode {
  if (!mode) {
    return 'local-fallback';
  }

  if (mode === 'local-fallback' || mode === 'trusted-header' || mode === 'entra-msal') {
    return mode;
  }

  throw new Error(`Unsupported JUNIOR_IDENTITY_MODE: ${mode}`);
}

function resolveEntraOptions(
  mode: IdentityMode,
  defaults: EntraAuthOptions | null,
  overrides: Partial<EntraAuthOptions> | undefined
): EntraAuthOptions | null {
  const merged = defaults || overrides
    ? {
        ...(defaults ?? {}),
        ...(overrides ?? {}),
        scopes: overrides?.scopes ?? defaults?.scopes ?? []
      }
    : null;

  if (mode !== 'entra-msal') {
    return merged
      ? {
          tenantId: merged.tenantId?.trim() ?? '',
          clientId: merged.clientId?.trim() ?? '',
          audience: merged.audience?.trim() ?? '',
          scopes: merged.scopes.map((scope) => scope.trim()).filter(Boolean),
          authority: merged.authority?.trim().replace(/\/$/, '') ?? '',
          redirectUri: merged.redirectUri?.trim() || undefined,
          postLogoutRedirectUri: merged.postLogoutRedirectUri?.trim() || undefined
        }
      : null;
  }

  if (!merged?.tenantId?.trim()) {
    throw new Error('JUNIOR_ENTRA_TENANT_ID is required when JUNIOR_IDENTITY_MODE=entra-msal.');
  }

  if (!merged.clientId?.trim()) {
    throw new Error('JUNIOR_ENTRA_CLIENT_ID is required when JUNIOR_IDENTITY_MODE=entra-msal.');
  }

  if (!merged.audience?.trim()) {
    throw new Error('JUNIOR_ENTRA_API_AUDIENCE is required when JUNIOR_IDENTITY_MODE=entra-msal.');
  }

  if (!merged.scopes.length) {
    throw new Error('JUNIOR_ENTRA_SCOPES is required when JUNIOR_IDENTITY_MODE=entra-msal.');
  }

  if (!merged.authority?.trim()) {
    throw new Error('JUNIOR_ENTRA_AUTHORITY is required when JUNIOR_IDENTITY_MODE=entra-msal.');
  }

  return {
    tenantId: merged.tenantId.trim(),
    clientId: merged.clientId.trim(),
    audience: merged.audience.trim(),
    scopes: merged.scopes.map((scope) => scope.trim()).filter(Boolean),
    authority: merged.authority.trim().replace(/\/$/, ''),
    redirectUri: merged.redirectUri?.trim() || undefined,
    postLogoutRedirectUri: merged.postLogoutRedirectUri?.trim() || undefined
  };
}

function loadEntraOptions(mode: IdentityMode, env: NodeJS.ProcessEnv): EntraAuthOptions | null {
  const tenantId = env.JUNIOR_ENTRA_TENANT_ID?.trim();
  const clientId = env.JUNIOR_ENTRA_CLIENT_ID?.trim();
  const authority = env.JUNIOR_ENTRA_AUTHORITY?.trim() || (tenantId ? `https://login.microsoftonline.com/${tenantId}` : '');
  const audience = env.JUNIOR_ENTRA_API_AUDIENCE?.trim();
  const scopes = parseList(env.JUNIOR_ENTRA_SCOPES) ?? [];
  const redirectUri = env.JUNIOR_ENTRA_REDIRECT_URI?.trim() || undefined;
  const postLogoutRedirectUri = env.JUNIOR_ENTRA_POST_LOGOUT_REDIRECT_URI?.trim() || undefined;

  if (mode !== 'entra-msal' && !tenantId && !clientId && !audience && scopes.length === 0) {
    return null;
  }

  return {
    tenantId: tenantId ?? '',
    clientId: clientId ?? '',
    audience: audience ?? '',
    scopes,
    authority,
    redirectUri,
    postLogoutRedirectUri
  };
}

function readBearerToken(request: express.Request): string | undefined {
  const authorization = request.header('authorization');
  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

function parseList(raw: string | undefined): string[] | undefined {
  const values = raw
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values?.length ? values : undefined;
}