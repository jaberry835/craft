import type { TokenCredential } from "@azure/core-auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { collectIdentityPosture, type IdentityCheckId } from "../collectors/identity.js";
import {
  collectKeyVaultItemMetadata,
  type KeyVaultItemType
} from "../collectors/keyVaultMetadata.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalResourceUrl } from "../links.js";
import { pageSlice } from "../pagination.js";

const subscriptionIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
);
const pageSizeSchema = z.number().int().min(1).max(500).default(100);
const pageTokenSchema = z.string().min(1).max(32_768).optional();
const recordSchema = z.record(z.string(), z.unknown());
const commonOutput = {
  generatedAt: z.iso.datetime(),
  tenantId: z.string().nullable(),
  scope: z.object({
    level: z.enum(["tenant", "subscription", "resourceGroup", "resource"]),
    subscriptionId: z.string().optional(),
    resourceId: z.string().optional()
  }),
  caller: callerSchema,
  access: accessSchema,
  page: z.object({
    nextPageToken: z.string().nullable(),
    returned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable()
  }).nullable(),
  portalLinks: z.record(z.string(), z.string()),
  errors: z.array(errorSchema)
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;
const identityCheckIds: IdentityCheckId[] = [
  "conditionalAccess", "securityDefaults", "mfaRegistration", "directoryRoles",
  "pimEligibility", "guests", "authenticationMethods"
];
const itemTypes: KeyVaultItemType[] = ["secret", "key", "certificate"];

export interface Phase8aToolDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  credential: TokenCredential;
  resourceGraph: ResourceGraphClient;
}

export function registerPhase8aTools(
  server: McpServer,
  dependencies: Phase8aToolDependencies
): void {
  server.registerTool("get_keyvault_item_metadata", {
    title: "Get Key Vault item metadata",
    description: "Best-effort secret, key, and certificate metadata. Never retrieves item values or private/public key material.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      vaultId: z.string().min(1).max(2_048).optional(),
      itemTypes: z.array(z.enum(itemTypes)).max(3).optional(),
      expiresWithinDays: z.number().int().min(0).max(3_650).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("get_keyvault_item_metadata"), ...commonOutput,
      summary: z.object({
        vaultCount: z.number().int().nonnegative(),
        itemCount: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        expiring: z.number().int().nonnegative(),
        withoutExpiry: z.number().int().nonnegative(),
        checks: z.array(recordSchema)
      }),
      data: z.array(recordSchema)
    },
    annotations
  }, async ({ subscriptionId, vaultId, itemTypes: requestedTypes, expiresWithinDays, pageSize, pageToken }) => {
    try {
      const result = await collectKeyVaultItemMetadata(
        dependencies.resourceGraph,
        dependencies.credential,
        dependencies.cloud,
        subscriptionId,
        { apiVersion: dependencies.config.keyVaultApiVersion }
      );
      const selectedTypes = requestedTypes ?? itemTypes;
      const items = result.items.filter((item) =>
        (!vaultId || item.vaultId.toLowerCase() === vaultId.toLowerCase()) &&
        selectedTypes.includes(item.itemType) &&
        (expiresWithinDays === undefined
          || (item.daysUntilExpiry !== null && item.daysUntilExpiry <= expiresWithinDays))
      );
      const checks = result.checks.filter((item) =>
        (!vaultId || item.vaultId.toLowerCase() === vaultId.toLowerCase()) &&
        selectedTypes.includes(item.itemType)
      );
      const filters = {
        subscriptionId,
        vaultId: vaultId?.toLowerCase() ?? null,
        itemTypes: [...selectedTypes].sort(),
        expiresWithinDays: expiresWithinDays ?? null
      };
      const page = pageSlice(items, pageSize, pageToken, filters);
      const statuses = checks.map((item) => item.status);
      const structuredContent = createEnvelope({
        tool: "get_keyvault_item_metadata",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "subscription", subscriptionId },
        summary: {
          vaultCount: new Set(checks.map((item) => item.vaultId)).size,
          itemCount: items.length,
          expired: items.filter((item) => item.daysUntilExpiry !== null && item.daysUntilExpiry < 0).length,
          expiring: items.filter((item) => item.daysUntilExpiry !== null && item.daysUntilExpiry >= 0
            && item.daysUntilExpiry <= (
              expiresWithinDays ?? dependencies.config.keyVaultExpiryWarningDays
            )).length,
          withoutExpiry: items.filter((item) => item.expiresAt === null).length,
          checks
        },
        data: page.values,
        page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
        portalLinks: vaultId
          ? { vault: portalResourceUrl(dependencies.cloud, vaultId, dependencies.config.tenantId,
            dependencies.config.portalLinkTemplates) }
          : {},
        accessStatus: envelopeStatus(statuses),
        accessNotes: checks.flatMap((item) =>
          item.notes.map((note) => `${item.vaultName}/${item.itemType}: ${note}`)
        )
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailable(
        dependencies,
        "get_keyvault_item_metadata",
        { level: "subscription" as const, subscriptionId },
        { vaultCount: 0, itemCount: 0, expired: 0, expiring: 0, withoutExpiry: 0, checks: [] },
        [],
        error
      );
    }
  });

  server.registerTool("get_identity_posture", {
    title: "Get Microsoft Entra identity posture",
    description: "Runs independent best-effort Microsoft Graph checks for Conditional Access, security defaults, MFA registration, privileged roles, PIM, guests, and authentication methods.",
    inputSchema: {
      checks: z.array(z.enum(identityCheckIds)).max(identityCheckIds.length).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("get_identity_posture"), ...commonOutput,
      summary: z.object({
        checkCount: z.number().int().nonnegative(),
        available: z.number().int().nonnegative(),
        denied: z.number().int().nonnegative(),
        unavailable: z.number().int().nonnegative(),
        checks: z.array(recordSchema)
      }),
      data: z.array(z.object({ checkId: z.string(), value: recordSchema }))
    },
    annotations
  }, async ({ checks: requestedChecks, pageSize, pageToken }) => {
    try {
      const result = await collectIdentityPosture(dependencies.credential, dependencies.cloud);
      const selected = result.checks.filter((item) =>
        !requestedChecks || requestedChecks.includes(item.id)
      );
      const rows = selected.flatMap((item) =>
        item.data.map((value) => ({ checkId: item.id, value }))
      );
      const page = pageSlice(rows, pageSize, pageToken, {
        checks: requestedChecks ? [...requestedChecks].sort() : null
      });
      const statuses = selected.map((item) => item.status);
      const structuredContent = createEnvelope({
        tool: "get_identity_posture",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "tenant" },
        summary: {
          checkCount: selected.length,
          available: statuses.filter((value) => value === "available").length,
          denied: statuses.filter((value) => value === "denied").length,
          unavailable: statuses.filter((value) => value === "unavailable").length,
          checks: selected.map(({ data: _data, ...item }) => item)
        },
        data: page.values,
        page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
        accessStatus: envelopeStatus(statuses),
        accessNotes: selected.flatMap((item) =>
          item.notes.map((note) => `${item.id}: ${note}`)
        )
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailable(
        dependencies,
        "get_identity_posture",
        { level: "tenant" as const },
        { checkCount: 0, available: 0, denied: 0, unavailable: identityCheckIds.length, checks: [] },
        [],
        error
      );
    }
  });
}

function envelopeStatus(
  statuses: Array<"available" | "partial" | "denied" | "unavailable">
): "full" | "partial" | "denied" | "unavailable" {
  if (!statuses.length) return "full";
  if (statuses.every((value) => value === "unavailable")) return "unavailable";
  if (statuses.every((value) => value === "denied")) return "denied";
  if (statuses.every((value) => value === "available")) return "full";
  return "partial";
}

function unavailable(
  dependencies: Phase8aToolDependencies,
  tool: string,
  scope: { level: "tenant" } | { level: "subscription"; subscriptionId: string },
  summary: Record<string, unknown>,
  data: unknown[],
  error: unknown
) {
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = createEnvelope({
    tool,
    tenantId: dependencies.config.tenantId ?? null,
    authMode: dependencies.config.authMode,
    scope,
    summary,
    data,
    accessStatus: "unavailable",
    accessNotes: [message],
    errors: [{ source: tool, code: "CollectorUnavailable", message }]
  });
  return jsonResult(structuredContent);
}

function jsonResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}
