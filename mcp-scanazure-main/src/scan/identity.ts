import type { AuthMode } from "../config.js";

export interface CallerIdentity {
  /** Opaque store partition key. Never returned by MCP tools. */
  key: string;
  tenantId: string | null;
  objectId: string | null;
  authMode: AuthMode;
}

export function localCallerIdentity(tenantId?: string): CallerIdentity {
  return {
    key: `local:${tenantId ?? "default"}`,
    tenantId: tenantId ?? null,
    objectId: null,
    authMode: "none"
  };
}

export function entraCallerIdentity(
  authMode: Exclude<AuthMode, "none">,
  tenantId: string,
  objectId: string
): CallerIdentity {
  if (!tenantId.trim() || !objectId.trim()) {
    throw new Error("Both tenant ID and object ID are required for an authenticated caller");
  }
  return {
    key: `entra:${tenantId.toLowerCase()}:${objectId.toLowerCase()}`,
    tenantId,
    objectId,
    authMode
  };
}
