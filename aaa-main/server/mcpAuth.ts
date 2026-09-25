import { BadRequestError } from './httpErrors.js';
import { maskedSecretValue, type McpAuthSettings, type McpAuthType } from '../src/types/api.js';

const authTypes: readonly McpAuthType[] = ['none', 'bearer', 'header', 'oauth', 'entra'];
const secretFields = ['token', 'value', 'clientSecret'] as const;
const stringFields = [
  'token', 'headerName', 'value', 'tokenUrl', 'clientId', 'clientSecret', 'scope', 'audience',
  'managedIdentityClientId', 'tenantId', 'authorityHost'
] as const;
const environmentReference = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Validates and normalizes auth from the editor; `none` (or nothing) removes auth. */
export function validateMcpAuth(input: unknown): McpAuthSettings | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestError('MCP authentication must be an object.', 'invalid_mcp_auth');
  }
  const raw = input as Record<string, unknown>;
  const type = raw.type as McpAuthType;
  if (!authTypes.includes(type)) {
    throw new BadRequestError(`MCP authentication type must be one of: ${authTypes.join(', ')}.`, 'invalid_mcp_auth');
  }
  if (type === 'none') return undefined;

  const auth: McpAuthSettings = { type };
  for (const field of stringFields) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim()) auth[field] = value.trim().slice(0, 4000);
  }
  const require = (...fields: Array<(typeof stringFields)[number]>) => {
    const missing = fields.filter((field) => !auth[field]);
    if (missing.length > 0) {
      throw new BadRequestError(`${label(type)} authentication requires: ${missing.join(', ')}.`, 'invalid_mcp_auth');
    }
  };
  const httpsUrl = (field: 'tokenUrl' | 'authorityHost', allowHttp = false) => {
    const value = auth[field];
    if (!value || environmentReference.test(value)) return;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new Error('protocol');
    } catch {
      throw new BadRequestError(`${field} must be a valid ${allowHttp ? 'HTTP(S)' : 'HTTPS'} URL.`, 'invalid_mcp_auth');
    }
  };

  if (type === 'bearer') require('token');
  if (type === 'header') {
    require('headerName', 'value');
    if (!headerNamePattern.test(auth.headerName!)) {
      throw new BadRequestError('The header name contains characters that are not allowed.', 'invalid_mcp_auth');
    }
  }
  if (type === 'oauth') {
    require('tokenUrl', 'clientId', 'clientSecret');
    httpsUrl('tokenUrl', true);
  }
  if (type === 'entra') {
    require('scope');
    httpsUrl('authorityHost');
  }
  return pick(auth, type);
}

/** Replaces literal secrets with a placeholder so they are never sent back to the browser. */
export function maskMcpAuth(auth: McpAuthSettings | undefined): McpAuthSettings | undefined {
  if (!auth) return undefined;
  const masked: McpAuthSettings = { ...auth };
  for (const field of secretFields) {
    const value = masked[field];
    if (value && !environmentReference.test(value)) masked[field] = maskedSecretValue;
  }
  return masked;
}

/** Keeps stored secrets when the editor returns the placeholder unchanged. */
export function mergeMcpAuth(
  existing: McpAuthSettings | undefined,
  incoming: McpAuthSettings | undefined
): McpAuthSettings | undefined {
  if (!incoming) return undefined;
  const merged: McpAuthSettings = { ...incoming };
  for (const field of secretFields) {
    if (merged[field] === maskedSecretValue) {
      if (existing?.type === incoming.type && existing[field]) merged[field] = existing[field];
      else throw new BadRequestError(`Enter a value for ${field}.`, 'invalid_mcp_auth');
    }
  }
  return merged;
}

/** Resolves `${env:NAME}` references; returns the names that are missing or empty. */
export function resolveMcpAuth(
  auth: McpAuthSettings | undefined,
  environment: NodeJS.ProcessEnv
): { auth?: McpAuthSettings; missing: string[] } {
  if (!auth || auth.type === 'none') return { missing: [] };
  const missing: string[] = [];
  const resolved: McpAuthSettings = { type: auth.type };
  for (const field of stringFields) {
    const value = auth[field];
    if (!value) continue;
    resolved[field] = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const found = environment[name]?.trim();
      if (!found) missing.push(name);
      return found ?? '';
    });
  }
  return { auth: resolved, missing: [...new Set(missing)] };
}

export function describeMcpAuth(auth: McpAuthSettings | undefined): string {
  return auth ? `${label(auth.type)} authentication` : 'No authentication';
}

function label(type: McpAuthType): string {
  return {
    none: 'No',
    bearer: 'Bearer token',
    header: 'API key header',
    oauth: 'OAuth client credentials',
    entra: 'Microsoft Entra'
  }[type];
}

function pick(auth: McpAuthSettings, type: McpAuthType): McpAuthSettings {
  const fields: Record<Exclude<McpAuthType, 'none'>, Array<(typeof stringFields)[number]>> = {
    bearer: ['token'],
    header: ['headerName', 'value'],
    oauth: ['tokenUrl', 'clientId', 'clientSecret', 'scope', 'audience'],
    entra: ['scope', 'managedIdentityClientId', 'tenantId', 'authorityHost']
  };
  const result: McpAuthSettings = { type };
  for (const field of fields[type as Exclude<McpAuthType, 'none'>]) {
    if (auth[field]) result[field] = auth[field];
  }
  return result;
}
