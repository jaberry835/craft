import type { TokenCredential } from "@azure/core-auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ArmReadClient } from "../azure/arm.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import {
  buildNistEvidence,
  collectNistControls,
  collectNistStatus,
  type NistControl,
  type NistSourceAccess
} from "../collectors/nist.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalDefenderUrl, portalPolicyUrl, portalResourceUrl } from "../links.js";
import { pageSlice } from "../pagination.js";
import { collectIdentityPosture } from "../collectors/identity.js";
import { collectKeyVaultItemMetadata } from "../collectors/keyVaultMetadata.js";

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

export interface NistToolDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  resourceGraph: ResourceGraphClient;
  arm: ArmReadClient;
  credential: TokenCredential;
}

export function registerNistTools(server: McpServer, dependencies: NistToolDependencies): void {
  server.registerTool("get_nist_status", {
    title: "Get NIST SP 800-53 Rev. 5 status",
    description: "Detects the configured NIST SP 800-53 Rev. 5 standard through Defender regulatory compliance and direct or inherited policy initiative assignments.",
    inputSchema: { subscriptionId: subscriptionIdSchema },
    outputSchema: {
      tool: z.literal("get_nist_status"), ...commonOutput,
      summary: z.object({
        standard: z.string(),
        enabled: z.boolean().nullable(),
        availability: z.enum(["available", "partial", "unavailable"]),
        source: z.enum(["defender", "policy", "both", "none", "unknown"]),
        assignmentScopes: z.array(z.string()),
        lastEvaluated: z.string().nullable(),
        controlSummary: z.record(z.string(), z.number().int().nonnegative())
      }),
      data: z.object({
        defender: recordSchema,
        policy: recordSchema,
        detectionConfiguration: z.object({
          initiativeIds: z.array(z.string()),
          namePatterns: z.array(z.string())
        })
      })
    },
    annotations
  }, async ({ subscriptionId }) => {
    try {
      const status = await collectNistStatus(dependencies.resourceGraph, subscriptionId, matchOptions(dependencies));
      const structuredContent = createEnvelope({
        tool: "get_nist_status",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "subscription", subscriptionId },
        summary: {
          standard: status.standard,
          enabled: status.enabled,
          availability: status.availability,
          source: status.source,
          assignmentScopes: status.assignmentScopes,
          lastEvaluated: status.lastEvaluated,
          controlSummary: status.controlSummary
        },
        data: {
          defender: status.defender,
          policy: status.policy,
          detectionConfiguration: {
            initiativeIds: [...dependencies.config.nistInitiativeIds].sort(),
            namePatterns: [...dependencies.config.nistNamePatterns]
          }
        },
        portalLinks: nistPortalLinks(dependencies, subscriptionId),
        accessStatus: accessStatus(status.access),
        accessNotes: status.access.notes
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailable(dependencies, "get_nist_status", subscriptionId, {
        standard: "NIST SP 800-53 Rev. 5", enabled: null, availability: "unavailable",
        source: "unknown", assignmentScopes: [], lastEvaluated: null, controlSummary: {}
      }, { defender: {}, policy: {}, detectionConfiguration: { initiativeIds: [], namePatterns: [] } }, error);
    }
  });

  server.registerTool("get_nist_controls", {
    title: "Get NIST controls and assessments",
    description: "Returns stable paged NIST control, Defender assessment, or affected-resource detail with family, control, state, and resource filters.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      detailLevel: z.enum(["control", "assessment", "resource"]).default("control"),
      families: z.array(z.string().min(2).max(4)).max(20).optional(),
      controls: z.array(z.string().min(3).max(32)).max(200).optional(),
      statuses: z.array(z.string().min(1).max(64)).max(20).optional(),
      resourceId: z.string().min(1).max(2_048).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("get_nist_controls"), ...commonOutput,
      summary: z.object({
        standard: z.string(),
        enabled: z.boolean().nullable(),
        availability: z.enum(["available", "partial", "unavailable"]),
        totalControls: z.number().int().nonnegative(),
        matchedDetails: z.number().int().nonnegative(),
        detailLevel: z.enum(["control", "assessment", "resource"]),
        byStatus: z.record(z.string(), z.number().int().nonnegative())
      }),
      data: z.array(recordSchema)
    },
    annotations
  }, async ({ subscriptionId, detailLevel, families, controls, statuses, resourceId, pageSize, pageToken }) => {
    try {
      const result = await collectNistControls(dependencies.resourceGraph, subscriptionId, matchOptions(dependencies));
      const normalizedFamilies = families?.map((value) => value.toUpperCase()) ?? [];
      const normalizedControls = controls?.map(normalizeToken) ?? [];
      const normalizedStatuses = statuses?.map(normalizeState) ?? [];
      const selected = result.controls.filter((control) =>
        (!normalizedFamilies.length || normalizedFamilies.includes(control.family)) &&
        (!normalizedControls.length || normalizedControls.includes(normalizeToken(control.id))) &&
        (!normalizedStatuses.length || normalizedStatuses.includes(normalizeState(control.state))) &&
        (!resourceId || control.failedResources.some((id) => id.toLowerCase() === resourceId.toLowerCase()))
      );
      const details = detailRows(selected, detailLevel).filter((row) =>
        (!normalizedStatuses.length || normalizedStatuses.includes(normalizeState(String(row.state ?? "unknown")))) &&
        (!resourceId || String(row.resourceId ?? "").toLowerCase() === resourceId.toLowerCase())
      );
      const filters = {
        subscriptionId, detailLevel,
        families: normalizedFamilies, controls: normalizedControls,
        statuses: normalizedStatuses, resourceId: resourceId?.toLowerCase() ?? null
      };
      const page = pageSlice(details, pageSize, pageToken, filters);
      const structuredContent = createEnvelope({
        tool: "get_nist_controls",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "subscription", subscriptionId },
        summary: {
          standard: result.status.standard,
          enabled: result.status.enabled,
          availability: result.status.availability,
          totalControls: result.controls.length,
          matchedDetails: details.length,
          detailLevel,
          byStatus: countBy(details.map((row) => String(row.state ?? "unknown")))
        },
        data: page.values,
        page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
        portalLinks: nistPortalLinks(dependencies, subscriptionId),
        accessStatus: accessStatus(result.status.access),
        accessNotes: result.status.access.notes
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailable(dependencies, "get_nist_controls", subscriptionId, {
        standard: "NIST SP 800-53 Rev. 5", enabled: null, availability: "unavailable",
        totalControls: 0, matchedDetails: 0, detailLevel, byStatus: {}
      }, [], error);
    }
  });

  server.registerTool("build_nist_evidence", {
    title: "Build NIST SP 800-53 Rev. 5 evidence",
    description: "Builds a live, read-only evidence package grouped by NIST family and control from Defender, policy, generic, network, and service findings.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      families: z.array(z.string().min(2).max(4)).max(20).optional(),
      controls: z.array(z.string().min(3).max(32)).max(200).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("build_nist_evidence"), ...commonOutput,
      summary: z.object({
        standard: z.string(),
        defenderStandardEnabled: z.boolean().nullable(),
        availability: z.enum(["available", "partial", "unavailable"]),
        controlCount: z.number().int().nonnegative(),
        familyCount: z.number().int().nonnegative(),
        evidenceGapCount: z.number().int().nonnegative()
      }),
      data: z.object({
        families: z.array(z.object({
          family: z.string(),
          name: z.string(),
          controls: z.array(recordSchema)
        })),
        evidenceGaps: z.array(z.string())
      })
    },
    annotations
  }, async ({ subscriptionId, families, controls, pageSize, pageToken }) => {
    try {
      const result = await buildNistEvidence(
        dependencies.resourceGraph,
        dependencies.arm,
        subscriptionId,
        matchOptions(dependencies),
        {
          identityPosture: () =>
            collectIdentityPosture(dependencies.credential, dependencies.cloud),
          keyVaultMetadata: () =>
            collectKeyVaultItemMetadata(
              dependencies.resourceGraph,
              dependencies.credential,
              dependencies.cloud,
              subscriptionId,
              { apiVersion: dependencies.config.keyVaultApiVersion }
            ),
          keyVaultExpiryWarningDays: dependencies.config.keyVaultExpiryWarningDays
        }
      );
      const normalizedFamilies = families?.map((value) => value.toUpperCase()) ?? [];
      const normalizedControls = controls?.map(normalizeToken) ?? [];
      const selected = result.controls.filter((control) =>
        (!normalizedFamilies.length || normalizedFamilies.includes(String(control.family))) &&
        (!normalizedControls.length || normalizedControls.includes(normalizeToken(String(control.id))))
      );
      const filters = { subscriptionId, families: normalizedFamilies, controls: normalizedControls };
      const page = pageSlice(selected, pageSize, pageToken, filters);
      const grouped = groupFamilies(page.values);
      const packageAccess = evidenceAccessStatus(result.access);
      const packageAvailability = packageAccess === "full"
        ? result.status.availability
        : packageAccess === "unavailable" ? "unavailable" : "partial";
      const structuredContent = createEnvelope({
        tool: "build_nist_evidence",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "subscription", subscriptionId },
        summary: {
          standard: result.status.standard,
          defenderStandardEnabled: result.status.defender.enabled,
          availability: packageAvailability,
          controlCount: selected.length,
          familyCount: new Set(selected.map((control) => control.family)).size,
          evidenceGapCount: result.access.notes.length
            + selected.reduce((count, control) => count + (Array.isArray(control.gaps) ? control.gaps.length : 0), 0)
        },
        data: { families: grouped, evidenceGaps: result.access.notes },
        page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
        portalLinks: nistPortalLinks(dependencies, subscriptionId),
        accessStatus: packageAccess,
        accessNotes: result.access.notes
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailable(dependencies, "build_nist_evidence", subscriptionId, {
        standard: "NIST SP 800-53 Rev. 5", defenderStandardEnabled: null,
        availability: "unavailable", controlCount: 0, familyCount: 0, evidenceGapCount: 1
      }, { families: [], evidenceGaps: [error instanceof Error ? error.message : String(error)] }, error);
    }
  });
}

function matchOptions(dependencies: NistToolDependencies) {
  return {
    initiativeIds: dependencies.config.nistInitiativeIds,
    namePatterns: dependencies.config.nistNamePatterns
  };
}

function detailRows(controls: NistControl[], level: "control" | "assessment" | "resource"): Array<Record<string, unknown>> {
  if (level === "control") return controls.map((control) => ({
    id: control.id, family: control.family, familyName: control.familyName,
    title: control.title, state: control.state,
    passedAssessments: control.passedAssessments,
    failedAssessments: control.failedAssessments,
    skippedAssessments: control.skippedAssessments,
    assessmentCount: control.assessments.length,
    failedResourceCount: control.failedResources.length
  }));
  const assessmentRows = controls.flatMap((control) => control.assessments.map((assessment) => ({
    family: control.family, familyName: control.familyName,
    controlTitle: control.title, ...assessment
  })));
  if (level === "assessment") return assessmentRows;
  return assessmentRows
    .filter((assessment) => assessment.resourceId)
    .map((assessment) => ({
      family: assessment.family, familyName: assessment.familyName,
      controlId: assessment.controlId, controlTitle: assessment.controlTitle,
      assessmentId: assessment.id, assessmentTitle: assessment.title,
      assessmentKey: assessment.assessmentKey, state: assessment.state,
      severity: assessment.severity, resourceId: assessment.resourceId,
      source: assessment.source
    }));
}

function groupFamilies(controls: Array<Record<string, unknown>>) {
  const values = new Map<string, { family: string; name: string; controls: Array<Record<string, unknown>> }>();
  for (const control of controls) {
    const family = String(control.family ?? "Unknown");
    const value = values.get(family) ?? {
      family, name: String(control.familyName ?? family), controls: []
    };
    value.controls.push(control);
    values.set(family, value);
  }
  return [...values.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function nistPortalLinks(dependencies: NistToolDependencies, subscriptionId: string) {
  return {
    subscription: portalResourceUrl(
      dependencies.cloud, `/subscriptions/${subscriptionId}`,
      dependencies.config.tenantId, dependencies.config.portalLinkTemplates
    ),
    defenderRegulatoryCompliance: portalDefenderUrl(
      dependencies.cloud, dependencies.config.portalLinkTemplates, true
    ),
    policyCompliance: portalPolicyUrl(
      dependencies.cloud, dependencies.config.portalLinkTemplates
    )
  };
}

function accessStatus(access: NistSourceAccess): "full" | "partial" | "unavailable" {
  if (access.defender === "unavailable" && access.policy === "unavailable") return "unavailable";
  return access.notes.length ? "partial" : "full";
}
function evidenceAccessStatus(access: NistSourceAccess): "full" | "partial" | "unavailable" {
  if (access.defender === "unavailable" && access.policy === "unavailable"
    && access.genericFindings === "unavailable" && access.networkFindings === "unavailable"
    && access.serviceFindings === "unavailable") return "unavailable";
  return access.notes.length ? "partial" : "full";
}
function unavailable(
  dependencies: NistToolDependencies, tool: string, subscriptionId: string,
  summary: Record<string, unknown>, data: unknown, error: unknown
) {
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = createEnvelope({
    tool, tenantId: dependencies.config.tenantId ?? null,
    authMode: dependencies.config.authMode,
    scope: { level: "subscription", subscriptionId },
    summary, data,
    portalLinks: nistPortalLinks(dependencies, subscriptionId),
    accessStatus: "unavailable", accessNotes: [message],
    errors: [{ source: "NIST collectors", code: "NistDataUnavailable", message }]
  });
  return jsonResult(structuredContent);
}
function jsonResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}
function normalizeToken(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}
function normalizeState(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
