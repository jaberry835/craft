import { resolve } from "node:path";
import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  AUTH_MODE: z.enum(["none", "obo", "arm-token"]).default("none"),
  HOST: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  AZURE_CLOUD_PROFILE: z
    .string()
    .default(resolve(process.cwd(), "cloud-profiles", "azurecloud.json")),
  AZURE_TENANT_ID: z.string().min(1).optional(),
  MANAGED_IDENTITY_CLIENT_ID: z.string().min(1).optional(),
  ENTRA_SERVER_CLIENT_ID: z.string().min(1).optional(),
  ENTRA_ALLOWED_CLIENT_IDS: z.string().default(""),
  ENTRA_CLIENT_SECRET: z.string().min(1).optional(),
  ENTRA_RESOURCE_URI: z.url().optional(),
  ARM_ENDPOINT: z.url().optional(),
  ARM_AUDIENCE: z.url().optional(),
  AUTHORITY_HOST: z.url().optional(),
  PORTAL_URL: z.url().optional(),
  GRAPH_ENDPOINT: z.url().optional(),
  KEYVAULT_AUDIENCE: z.url().optional(),
  KEYVAULT_API_VERSION: z.string().min(1).default("7.4"),
  KEYVAULT_EXPIRY_WARN_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  SUBSCRIPTIONS_API_VERSION: z.string().default("2022-12-01"),
  RESOURCE_GRAPH_API_VERSION: z.string().default("2022-10-01"),
  RESOURCE_GRAPH_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  NIST_INITIATIVE_IDS: z.string().default("179d1daa-458f-4e47-8086-2a68d0d6c38f"),
  NIST_NAME_PATTERNS: z.string().default("NIST SP 800-53 Rev. 5,NIST SP 800-53 R5,NIST 800-53 Rev. 5"),
  PORTAL_RESOURCE_PATH_TEMPLATE: z.string().min(1).default("/#{tenant}/resource{resourceId}"),
  PORTAL_POLICY_COMPLIANCE_PATH_TEMPLATE: z.string().min(1).default("/#view/Microsoft_Azure_Policy/PolicyComplianceDetailedBlade/id/{assignmentId}"),
  PORTAL_POLICY_OVERVIEW_PATH: z.string().min(1).default("/#view/Microsoft_Azure_Policy/PolicyMenuBlade/~/Compliance"),
  PORTAL_DEFENDER_PATH: z.string().min(1).default("/#view/Microsoft_Azure_Security/SecurityMenuBlade/~/0"),
  PORTAL_DEFENDER_REGULATORY_PATH: z.string().min(1).default("/#view/Microsoft_Azure_Security/SecurityMenuBlade/~/22"),
  SCAN_CACHE_TTL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(60),
  SCAN_MAX_SCANS: z.coerce.number().int().min(1).max(1_000).default(20),
  SCAN_MAX_SCANS_PER_CALLER: z.coerce.number().int().min(1).max(100).default(5),
  SCAN_MAX_MEMORY_MB: z.coerce.number().int().min(16).max(4_096).default(128),
  SCAN_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  MCP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  MCP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100_000).default(120),
  CORS_ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
  ALLOW_UNAUTHENTICATED_REMOTE: booleanFromEnvironment,
  WEBSITE_SITE_NAME: z.string().min(1).optional()
});

export type AuthMode = z.infer<typeof environmentSchema>["AUTH_MODE"];

export interface AppConfig {
  authMode: AuthMode;
  host: string;
  port: number;
  cloudProfilePath: string;
  tenantId?: string;
  managedIdentityClientId?: string;
  entra?: {
    serverClientId: string;
    allowedClientIds: ReadonlySet<string>;
    clientSecret?: string;
    resourceUri: string;
  };
  cloudOverrides: {
    resourceManagerEndpoint?: string;
    resourceManagerAudience?: string;
    authorityHost?: string;
    portalUrl?: string;
    graphEndpoint?: string;
    keyVaultAudience?: string;
  };
  subscriptionsApiVersion: string;
  resourceGraphApiVersion: string;
  resourceGraphMaxRetries: number;
  keyVaultApiVersion: string;
  keyVaultExpiryWarningDays: number;
  nistInitiativeIds: ReadonlySet<string>;
  nistNamePatterns: string[];
  portalLinkTemplates: {
    resource: string;
    policyCompliance: string;
    policyOverview: string;
    defender: string;
    defenderRegulatory: string;
  };
  scan: {
    ttlMilliseconds: number;
    maximumScans: number;
    maximumScansPerCaller: number;
    maximumBytes: number;
    concurrency: number;
  };
  rateLimit: {
    windowMilliseconds: number;
    maximumRequests: number;
  };
  corsAllowedOrigins: ReadonlySet<string>;
  allowUnauthenticatedRemote: boolean;
}

function optionalProperties<T extends Record<string, string | undefined>>(value: T): {
  [K in keyof T]?: string;
} {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined)
  ) as { [K in keyof T]?: string };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const host = parsed.HOST ?? (parsed.AUTH_MODE === "none" ? "127.0.0.1" : "0.0.0.0");

  if (
    parsed.AUTH_MODE === "none" &&
    !isLoopbackHost(host) &&
    !parsed.ALLOW_UNAUTHENTICATED_REMOTE
  ) {
    throw new Error(
      "AUTH_MODE=none may only bind to a loopback host unless ALLOW_UNAUTHENTICATED_REMOTE=true"
    );
  }
  if (
    parsed.WEBSITE_SITE_NAME &&
    parsed.AUTH_MODE === "none" &&
    !parsed.ALLOW_UNAUTHENTICATED_REMOTE
  ) {
    throw new Error(
      "AUTH_MODE=none is blocked on App Service unless ALLOW_UNAUTHENTICATED_REMOTE=true"
    );
  }
  if (parsed.WEBSITE_SITE_NAME && parsed.AUTH_MODE === "arm-token") {
    throw new Error("AUTH_MODE=arm-token is a development mode and is blocked on App Service");
  }

  const origins = parsed.CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedClientIds = splitList(parsed.ENTRA_ALLOWED_CLIENT_IDS).map((value) =>
    value.toLowerCase()
  );

  if (parsed.AUTH_MODE !== "none") {
    if (!parsed.AZURE_TENANT_ID) {
      throw new Error("AZURE_TENANT_ID is required when authentication is enabled");
    }
    if (!parsed.ENTRA_SERVER_CLIENT_ID) {
      throw new Error("ENTRA_SERVER_CLIENT_ID is required when authentication is enabled");
    }
    if (allowedClientIds.length === 0) {
      throw new Error("ENTRA_ALLOWED_CLIENT_IDS must contain at least one client ID");
    }
    if (!parsed.ENTRA_RESOURCE_URI) {
      throw new Error("ENTRA_RESOURCE_URI is required when authentication is enabled");
    }
  }

  return {
    authMode: parsed.AUTH_MODE,
    host,
    port: parsed.PORT,
    cloudProfilePath: resolve(parsed.AZURE_CLOUD_PROFILE),
    ...(parsed.AZURE_TENANT_ID ? { tenantId: parsed.AZURE_TENANT_ID } : {}),
    ...(parsed.MANAGED_IDENTITY_CLIENT_ID
      ? { managedIdentityClientId: parsed.MANAGED_IDENTITY_CLIENT_ID }
      : {}),
    ...(parsed.AUTH_MODE !== "none" &&
    parsed.ENTRA_SERVER_CLIENT_ID &&
    parsed.ENTRA_RESOURCE_URI
      ? {
          entra: {
            serverClientId: parsed.ENTRA_SERVER_CLIENT_ID,
            allowedClientIds: new Set(allowedClientIds),
            ...(parsed.ENTRA_CLIENT_SECRET
              ? { clientSecret: parsed.ENTRA_CLIENT_SECRET }
              : {}),
            resourceUri: parsed.ENTRA_RESOURCE_URI
          }
        }
      : {}),
    cloudOverrides: optionalProperties({
      resourceManagerEndpoint: parsed.ARM_ENDPOINT,
      resourceManagerAudience: parsed.ARM_AUDIENCE,
      authorityHost: parsed.AUTHORITY_HOST,
      portalUrl: parsed.PORTAL_URL,
      graphEndpoint: parsed.GRAPH_ENDPOINT,
      keyVaultAudience: parsed.KEYVAULT_AUDIENCE
    }),
    subscriptionsApiVersion: parsed.SUBSCRIPTIONS_API_VERSION,
    resourceGraphApiVersion: parsed.RESOURCE_GRAPH_API_VERSION,
    resourceGraphMaxRetries: parsed.RESOURCE_GRAPH_MAX_RETRIES,
    keyVaultApiVersion: parsed.KEYVAULT_API_VERSION,
    keyVaultExpiryWarningDays: parsed.KEYVAULT_EXPIRY_WARN_DAYS,
    nistInitiativeIds: new Set(splitList(parsed.NIST_INITIATIVE_IDS).map((value) => value.toLowerCase())),
    nistNamePatterns: splitList(parsed.NIST_NAME_PATTERNS),
    portalLinkTemplates: {
      resource: parsed.PORTAL_RESOURCE_PATH_TEMPLATE,
      policyCompliance: parsed.PORTAL_POLICY_COMPLIANCE_PATH_TEMPLATE,
      policyOverview: parsed.PORTAL_POLICY_OVERVIEW_PATH,
      defender: parsed.PORTAL_DEFENDER_PATH,
      defenderRegulatory: parsed.PORTAL_DEFENDER_REGULATORY_PATH
    },
    scan: {
      ttlMilliseconds: parsed.SCAN_CACHE_TTL_MINUTES * 60_000,
      maximumScans: parsed.SCAN_MAX_SCANS,
      maximumScansPerCaller: parsed.SCAN_MAX_SCANS_PER_CALLER,
      maximumBytes: parsed.SCAN_MAX_MEMORY_MB * 1_024 * 1_024,
      concurrency: parsed.SCAN_CONCURRENCY
    },
    rateLimit: {
      windowMilliseconds: parsed.MCP_RATE_LIMIT_WINDOW_SECONDS * 1_000,
      maximumRequests: parsed.MCP_RATE_LIMIT_MAX_REQUESTS
    },
    corsAllowedOrigins: new Set(origins),
    allowUnauthenticatedRemote: parsed.ALLOW_UNAUTHENTICATED_REMOTE
  };
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
