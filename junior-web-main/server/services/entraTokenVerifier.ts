import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthenticationError } from '../httpErrors.js';
import type { RequestIdentity } from '../types.js';

export interface EntraAuthOptions {
  tenantId: string;
  clientId: string;
  audience: string;
  scopes: string[];
  authority: string;
  redirectUri?: string;
  postLogoutRedirectUri?: string;
}

export type TokenVerifier = (token: string) => Promise<RequestIdentity>;

interface EntraJwtPayload extends JWTPayload {
  oid?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  upn?: string;
  roles?: string[];
}

export function createEntraTokenVerifier(options: EntraAuthOptions): TokenVerifier {
  const authority = options.authority.replace(/\/$/, '');
  const issuer = `${authority}/v2.0`;
  const jwksUri = new URL(`${authority}/${options.tenantId}/discovery/v2.0/keys`.replace(`${options.tenantId}/${options.tenantId}`, options.tenantId));
  const jwks = createRemoteJWKSet(jwksUri);
  const audiences = Array.from(new Set([
    options.audience,
    options.clientId,
    `api://${options.clientId}`
  ].map((value) => value.trim()).filter(Boolean)));

  return async (token: string): Promise<RequestIdentity> => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: audiences
      });

      return identityFromPayload(payload as EntraJwtPayload);
    } catch {
      throw new AuthenticationError('The Microsoft Entra bearer token is invalid or expired.');
    }
  };
}

function identityFromPayload(payload: EntraJwtPayload): RequestIdentity {
  const userId = readStringClaim(payload.oid) ?? readStringClaim(payload.sub);
  if (!userId) {
    throw new AuthenticationError('The bearer token did not include a stable user identifier.');
  }

  const displayName = readStringClaim(payload.name)
    ?? readStringClaim(payload.preferred_username)
    ?? readStringClaim(payload.upn)
    ?? userId;
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
    : [];

  return {
    userId,
    displayName,
    tenantId: readStringClaim(payload.tid) ?? undefined,
    roles,
    authSource: 'token',
    isAuthenticated: true
  };
}

function readStringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}