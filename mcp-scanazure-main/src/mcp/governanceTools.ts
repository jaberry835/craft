import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import type { AzureSubscription } from "../azure/subscriptions.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import {
  collectPolicyAssignments,
  collectPolicyCompliance,
  collectRoleAssignments,
  collectSecurityPosture,
  collectTenantContext
} from "../collectors/governance.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalDefenderUrl, portalPolicyUrl, portalResourceUrl } from "../links.js";
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

export interface GovernanceToolDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  resourceGraph: ResourceGraphClient;
  listSubscriptions: () => Promise<AzureSubscription[]>;
}

export function registerGovernanceTools(
  server: McpServer,
  dependencies: GovernanceToolDependencies
): void {
  server.registerTool("list_policy_assignments", {
    title: "List Azure policy assignments",
    description: "Lists direct and inherited policy assignments visible through Resource Graph, including visible exemptions.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      inherited: z.boolean().optional(),
      scopeContains: z.string().min(1).max(1_024).optional(),
      policyDefinitionContains: z.string().min(1).max(1_024).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("list_policy_assignments"), ...commonOutput,
      summary: z.object({
        total: z.number().int().nonnegative(),
        direct: z.number().int().nonnegative(),
        inherited: z.number().int().nonnegative(),
        inferredFromCompliance: z.number().int().nonnegative(),
        exemptionCount: z.number().int().nonnegative()
      }),
      data: z.array(recordSchema)
    },
    annotations
  }, async ({ subscriptionId, inherited, scopeContains, policyDefinitionContains, pageSize, pageToken }) => {
    try {
      const result = await collectPolicyAssignments(dependencies.resourceGraph, subscriptionId);
      const filters = {
        subscriptionId, inherited: inherited ?? null,
        scopeContains: scopeContains?.toLowerCase() ?? null,
        policyDefinitionContains: policyDefinitionContains?.toLowerCase() ?? null
      };
      const filtered = result.assignments.filter((item) =>
        (inherited === undefined || item.inherited === inherited) &&
        (!scopeContains || item.scope.toLowerCase().includes(scopeContains.toLowerCase())) &&
        (!policyDefinitionContains || item.policyDefinitionId?.toLowerCase().includes(policyDefinitionContains.toLowerCase()))
      );
      const page = pageSlice(filtered, pageSize, pageToken, filters);
      return resultEnvelope(dependencies, "list_policy_assignments", subscriptionId, {
        total: filtered.length,
        direct: filtered.filter((item) => !item.inherited).length,
        inherited: filtered.filter((item) => item.inherited).length,
        inferredFromCompliance: filtered.filter((item) => item.discoveredFrom === "compliance").length,
        exemptionCount: filtered.reduce((count, item) => count + item.exemptions.length, 0)
      }, page.values, page, result.access);
    } catch (error) {
      return unavailableEnvelope(dependencies, "list_policy_assignments", subscriptionId,
        { total: 0, direct: 0, inherited: 0, inferredFromCompliance: 0, exemptionCount: 0 }, [], error);
    }
  });

  server.registerTool("get_policy_compliance", {
    title: "Get Azure policy compliance",
    description: "Returns policy compliance summaries and a stable paged list of resource compliance states, defaulting to noncompliant resources.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      assignmentId: z.string().min(1).max(2_048).optional(),
      complianceState: z.string().min(1).max(64).default("noncompliant"),
      resourceType: z.string().min(1).max(256).optional(),
      resourceGroup: z.string().min(1).max(256).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("get_policy_compliance"), ...commonOutput,
      summary: z.object({
        totalStates: z.number().int().nonnegative(),
        matchedResources: z.number().int().nonnegative(),
        byState: z.record(z.string(), z.number().int().nonnegative()),
        byAssignment: z.array(recordSchema)
      }),
      data: z.array(recordSchema)
    },
    annotations
  }, async ({ subscriptionId, assignmentId, complianceState, resourceType, resourceGroup, pageSize, pageToken }) => {
    try {
      const result = await collectPolicyCompliance(dependencies.resourceGraph, subscriptionId);
      const normalizedState = complianceState.replace(/\s+/g, "").toLowerCase();
      const filters = {
        subscriptionId, assignmentId: assignmentId?.toLowerCase() ?? null,
        complianceState: normalizedState,
        resourceType: resourceType?.toLowerCase() ?? null,
        resourceGroup: resourceGroup?.toLowerCase() ?? null
      };
      const resources = result.resources.filter((item) =>
        (!assignmentId || item.assignmentId.toLowerCase() === assignmentId.toLowerCase()) &&
        item.complianceState === normalizedState &&
        (!resourceType || item.resourceType?.toLowerCase() === resourceType.toLowerCase()) &&
        (!resourceGroup || item.resourceGroup?.toLowerCase() === resourceGroup.toLowerCase())
      );
      const page = pageSlice(resources, pageSize, pageToken, filters);
      return resultEnvelope(dependencies, "get_policy_compliance", subscriptionId, {
        totalStates: result.resources.length,
        matchedResources: resources.length,
        byState: result.byState,
        byAssignment: result.byAssignment
      }, page.values, page, result.access, {
        policy: portalPolicyUrl(dependencies.cloud, dependencies.config.portalLinkTemplates, assignmentId)
      });
    } catch (error) {
      return unavailableEnvelope(dependencies, "get_policy_compliance", subscriptionId,
        { totalStates: 0, matchedResources: 0, byState: {}, byAssignment: [] }, [], error);
    }
  });

  server.registerTool("get_security_posture", {
    title: "Get Microsoft Defender for Cloud posture",
    description: "Returns Defender plan pricing tiers, secure scores, and a stable paged list of unhealthy security assessments from Resource Graph.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      severity: z.string().min(1).max(64).optional(),
      resourceId: z.string().min(1).max(2_048).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("get_security_posture"), ...commonOutput,
      summary: z.object({
        defenderPlanCount: z.number().int().nonnegative(),
        enabledPlanCount: z.number().int().nonnegative(),
        secureScoreCount: z.number().int().nonnegative(),
        unhealthyAssessmentCount: z.number().int().nonnegative()
      }),
      data: z.object({
        defenderPlans: z.array(recordSchema),
        secureScores: z.array(recordSchema),
        unhealthyAssessments: z.array(recordSchema)
      })
    },
    annotations
  }, async ({ subscriptionId, severity, resourceId, pageSize, pageToken }) => {
    try {
      const result = await collectSecurityPosture(dependencies.resourceGraph, subscriptionId);
      const filters = {
        subscriptionId,
        severity: severity?.toLowerCase() ?? null,
        resourceId: resourceId?.toLowerCase() ?? null
      };
      const assessments = result.unhealthyAssessments.filter((item) =>
        (!severity || String(item.severity ?? "").toLowerCase() === severity.toLowerCase()) &&
        (!resourceId || String(item.resourceId ?? "").toLowerCase() === resourceId.toLowerCase())
      );
      const page = pageSlice(assessments, pageSize, pageToken, filters);
      const structuredContent = createEnvelope({
        tool: "get_security_posture",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "subscription", subscriptionId },
        summary: {
          defenderPlanCount: result.defenderPlans.length,
          enabledPlanCount: result.defenderPlans.filter((item) => item.enabled === true).length,
          secureScoreCount: result.secureScores.length,
          unhealthyAssessmentCount: assessments.length
        },
        data: {
          defenderPlans: result.defenderPlans,
          secureScores: result.secureScores,
          unhealthyAssessments: page.values
        },
        page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
        portalLinks: {
          subscription: subscriptionPortal(dependencies, subscriptionId),
          defender: portalDefenderUrl(dependencies.cloud, dependencies.config.portalLinkTemplates)
        },
        accessStatus: result.access.complete ? "full" : "partial",
        accessNotes: result.access.notes
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailableEnvelope(dependencies, "get_security_posture", subscriptionId,
        { defenderPlanCount: 0, enabledPlanCount: 0, secureScoreCount: 0, unhealthyAssessmentCount: 0 },
        { defenderPlans: [], secureScores: [], unhealthyAssessments: [] }, error);
    }
  });

  server.registerTool("list_role_assignments", {
    title: "List Azure RBAC role assignments",
    description: "Lists Azure RBAC assignments visible through Resource Graph and flags privileged built-in or wildcard roles.",
    inputSchema: {
      subscriptionId: subscriptionIdSchema,
      scopeContains: z.string().min(1).max(1_024).optional(),
      principalType: z.string().min(1).max(128).optional(),
      roleNameContains: z.string().min(1).max(256).optional(),
      privilegedOnly: z.boolean().default(false),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("list_role_assignments"), ...commonOutput,
      summary: z.object({
        total: z.number().int().nonnegative(),
        privileged: z.number().int().nonnegative(),
        byPrincipalType: z.record(z.string(), z.number().int().nonnegative())
      }),
      data: z.array(recordSchema)
    },
    annotations
  }, async ({ subscriptionId, scopeContains, principalType, roleNameContains, privilegedOnly, pageSize, pageToken }) => {
    try {
      const result = await collectRoleAssignments(dependencies.resourceGraph, subscriptionId);
      const filters = {
        subscriptionId, scopeContains: scopeContains?.toLowerCase() ?? null,
        principalType: principalType?.toLowerCase() ?? null,
        roleNameContains: roleNameContains?.toLowerCase() ?? null, privilegedOnly
      };
      const assignments = result.assignments.filter((item) =>
        (!scopeContains || item.scope.toLowerCase().includes(scopeContains.toLowerCase())) &&
        (!principalType || item.principalType?.toLowerCase() === principalType.toLowerCase()) &&
        (!roleNameContains || item.roleName?.toLowerCase().includes(roleNameContains.toLowerCase())) &&
        (!privilegedOnly || item.privileged)
      );
      const page = pageSlice(assignments, pageSize, pageToken, filters);
      return resultEnvelope(dependencies, "list_role_assignments", subscriptionId, {
        total: assignments.length,
        privileged: assignments.filter((item) => item.privileged).length,
        byPrincipalType: countStrings(assignments.map((item) => item.principalType ?? "Unknown"))
      }, page.values, page, result.access);
    } catch (error) {
      return unavailableEnvelope(dependencies, "list_role_assignments", subscriptionId,
        { total: 0, privileged: 0, byPrincipalType: {} }, [], error);
    }
  });

  server.registerTool("get_tenant_context", {
    title: "Get Azure tenant and management group context",
    description: "Best-effort tenant context: visible subscriptions, management groups, and management-group policy and RBAC assignments. Missing permissions are explicit.",
    inputSchema: {
      itemKind: z.enum(["managementGroup", "subscription", "policyAssignment", "roleAssignment"]).optional(),
      pageSize: pageSizeSchema,
      pageToken: pageTokenSchema
    },
    outputSchema: {
      tool: z.literal("get_tenant_context"), ...commonOutput,
      summary: z.object({
        managementGroupCount: z.number().int().nonnegative(),
        subscriptionCount: z.number().int().nonnegative(),
        policyAssignmentCount: z.number().int().nonnegative(),
        roleAssignmentCount: z.number().int().nonnegative()
      }),
      data: z.array(z.object({ kind: z.string(), value: recordSchema }))
    },
    annotations
  }, async ({ itemKind, pageSize, pageToken }) => {
    try {
      const subscriptions = await dependencies.listSubscriptions();
      const result = await collectTenantContext(dependencies.resourceGraph, subscriptions);
      const items: Array<{ kind: string; value: Record<string, unknown> }> = [
        ...result.managementGroups.map((value) => ({ kind: "managementGroup", value })),
        ...subscriptions.map((value): { kind: string; value: Record<string, unknown> } => ({
          kind: "subscription",
          value: {
            subscriptionId: value.subscriptionId,
            displayName: value.displayName,
            state: value.state,
            tenantId: value.tenantId
          }
        })),
        ...result.policyAssignments.map((value) => ({ kind: "policyAssignment", value })),
        ...result.roleAssignments.map((value) => ({ kind: "roleAssignment", value }))
      ].filter((item) => !itemKind || item.kind === itemKind)
        .sort((a, b) => `${a.kind}:${String(a.value.id ?? a.value.subscriptionId ?? "")}`
          .localeCompare(`${b.kind}:${String(b.value.id ?? b.value.subscriptionId ?? "")}`));
      const page = pageSlice(items, pageSize, pageToken, { itemKind: itemKind ?? null });
      const structuredContent = createEnvelope({
        tool: "get_tenant_context",
        tenantId: dependencies.config.tenantId ?? null,
        authMode: dependencies.config.authMode,
        scope: { level: "tenant" },
        summary: {
          managementGroupCount: result.managementGroups.length,
          subscriptionCount: subscriptions.length,
          policyAssignmentCount: result.policyAssignments.length,
          roleAssignmentCount: result.roleAssignments.length
        },
        data: page.values,
        page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
        portalLinks: { managementGroups: `${dependencies.cloud.portalUrl}/#view/Microsoft_Azure_ManagementGroups/ManagementGroupBrowseBlade` },
        accessStatus: result.access.complete ? "full" : result.access.notes.length ? "partial" : "unavailable",
        accessNotes: result.access.notes
      });
      return jsonResult(structuredContent);
    } catch (error) {
      return unavailableEnvelope(dependencies, "get_tenant_context", undefined,
        { managementGroupCount: 0, subscriptionCount: 0, policyAssignmentCount: 0, roleAssignmentCount: 0 }, [], error, "tenant");
    }
  });
}

function resultEnvelope(
  dependencies: GovernanceToolDependencies,
  tool: string,
  subscriptionId: string,
  summary: Record<string, unknown>,
  data: unknown,
  page: { nextPageToken: string | null; values: unknown[]; total: number },
  access: { complete: boolean; notes: string[] },
  extraLinks: Record<string, string> = {}
) {
  const structuredContent = createEnvelope({
    tool, tenantId: dependencies.config.tenantId ?? null,
    authMode: dependencies.config.authMode,
    scope: { level: "subscription", subscriptionId },
    summary, data,
    page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
    portalLinks: { subscription: subscriptionPortal(dependencies, subscriptionId), ...extraLinks },
    accessStatus: access.complete ? "full" : "partial",
    accessNotes: access.notes
  });
  return jsonResult(structuredContent);
}

function unavailableEnvelope(
  dependencies: GovernanceToolDependencies,
  tool: string,
  subscriptionId: string | undefined,
  summary: Record<string, unknown>,
  data: unknown,
  error: unknown,
  level: "tenant" | "subscription" = "subscription"
) {
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = createEnvelope({
    tool, tenantId: dependencies.config.tenantId ?? null,
    authMode: dependencies.config.authMode,
    scope: subscriptionId ? { level, subscriptionId } : { level: "tenant" },
    summary, data, page: { nextPageToken: null, returned: 0, total: 0 },
    portalLinks: subscriptionId ? { subscription: subscriptionPortal(dependencies, subscriptionId) } : {},
    accessStatus: isDenied(message) ? "denied" : "unavailable",
    accessNotes: [message],
    errors: [{ source: "Azure Resource Graph", code: isDenied(message) ? "AuthorizationFailed" : "QueryUnavailable", message }]
  });
  return jsonResult(structuredContent);
}

function jsonResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}
function subscriptionPortal(dependencies: GovernanceToolDependencies, subscriptionId: string): string {
  return portalResourceUrl(
    dependencies.cloud,
    `/subscriptions/${subscriptionId}`,
    dependencies.config.tenantId,
    dependencies.config.portalLinkTemplates
  );
}
function countStrings(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
function isDenied(message: string): boolean {
  return /403|authorization|forbidden|denied/i.test(message);
}
