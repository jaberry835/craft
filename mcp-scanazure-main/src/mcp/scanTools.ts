import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalResourceUrl } from "../links.js";
import { pageSlice } from "../pagination.js";
import type { CallerIdentity } from "../scan/identity.js";
import type { ScanManager } from "../scan/orchestrator.js";
import type { ScanSection } from "../scan/store.js";

const subscriptionIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
);
const scanIdSchema = z.uuid();
const recordSchema = z.record(z.string(), z.unknown());
const scanStateSchema = z.enum([
  "queued", "running", "completed", "partial", "failed", "cancelled", "unavailable"
]);
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
const sectionStatusSchema = z.object({
  name: z.string(),
  state: z.enum(["pending", "running", "completed", "partial", "failed", "cancelled"]),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  notes: z.array(z.string()),
  errors: z.array(z.object({ code: z.string(), message: z.string() }))
});

export interface ScanToolDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  manager: ScanManager;
  caller: CallerIdentity;
}

export function registerScanTools(server: McpServer, dependencies: ScanToolDependencies): void {
  server.registerTool("start_scan", {
    title: "Start an asynchronous Azure subscription scan",
    description: "Queues a bounded-concurrency, read-only full subscription scan. Poll get_scan_status; the initial request does not wait for collection.",
    inputSchema: { subscriptionId: subscriptionIdSchema },
    outputSchema: {
      tool: z.literal("start_scan"), ...commonOutput,
      summary: z.object({
        scanId: z.string().nullable(),
        state: scanStateSchema,
        sectionCount: z.number().int().nonnegative(),
        expiresAt: z.string().nullable()
      }),
      data: z.object({
        scanId: z.string().nullable(),
        statusTool: z.literal("get_scan_status"),
        resultTool: z.literal("get_scan_result")
      })
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }, async ({ subscriptionId }) => {
    try {
      const record = dependencies.manager.start(dependencies.caller, subscriptionId);
      return scanEnvelope(dependencies, "start_scan", subscriptionId, {
        scanId: record.scanId,
        state: record.state,
        sectionCount: Object.keys(record.sections).length,
        expiresAt: record.expiresAt
      }, {
        scanId: record.scanId,
        statusTool: "get_scan_status" as const,
        resultTool: "get_scan_result" as const
      });
    } catch (error) {
      return scanEnvelope(dependencies, "start_scan", subscriptionId, {
        scanId: null, state: "unavailable" as const, sectionCount: 0, expiresAt: null
      }, {
        scanId: null,
        statusTool: "get_scan_status" as const,
        resultTool: "get_scan_result" as const
      }, "unavailable", [message(error)], [{
        source: "scan store", code: "ScanStartRejected", message: message(error)
      }]);
    }
  });

  server.registerTool("get_scan_status", {
    title: "Get asynchronous scan status",
    description: "Returns authoritative overall and section-level progress for a caller-owned scan.",
    inputSchema: { scanId: scanIdSchema },
    outputSchema: {
      tool: z.literal("get_scan_status"), ...commonOutput,
      summary: z.object({
        scanId: z.string(),
        state: scanStateSchema,
        completedSections: z.number().int().nonnegative(),
        totalSections: z.number().int().nonnegative(),
        percentComplete: z.number().min(0).max(100),
        createdAt: z.string().nullable(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        expiresAt: z.string().nullable()
      }),
      data: z.array(sectionStatusSchema)
    },
    annotations: readOnlyAnnotations
  }, async ({ scanId }) => {
    const record = dependencies.manager.get(dependencies.caller, scanId);
    if (!record) {
      return scanEnvelope(dependencies, "get_scan_status", undefined, {
        scanId, state: "unavailable" as const, completedSections: 0,
        totalSections: 0, percentComplete: 0, createdAt: null,
        startedAt: null, completedAt: null, expiresAt: null
      }, [], "unavailable", ["Scan was not found, expired, evicted, or belongs to another caller"], [{
        source: "scan store", code: "ScanNotFound", message: "Scan is unavailable"
      }]);
    }
    const sections = Object.values(record.sections);
    const completed = sections.filter((section) =>
      ["completed", "partial", "failed", "cancelled"].includes(section.state)
    ).length;
    return scanEnvelope(dependencies, "get_scan_status", record.subscriptionId, {
      scanId,
      state: record.state,
      completedSections: completed,
      totalSections: sections.length,
      percentComplete: sections.length ? Math.round(completed / sections.length * 10_000) / 100 : 100,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      expiresAt: record.expiresAt
    }, sections.map(sectionMetadata),
    record.state === "failed" || record.state === "partial" ? "partial" : "full",
    record.errors.map((error) => error.message));
  });

  server.registerTool("get_scan_result", {
    title: "Get a paged asynchronous scan section",
    description: "Returns one caller-owned scan section with stable paging and common resource, finding, and NIST filters.",
    inputSchema: {
      scanId: scanIdSchema,
      section: z.string().min(1).max(128),
      collection: z.string().min(1).max(128).optional(),
      resourceType: z.string().min(1).max(256).optional(),
      resourceGroup: z.string().min(1).max(256).optional(),
      status: z.string().min(1).max(64).optional(),
      severity: z.string().min(1).max(64).optional(),
      family: z.string().min(1).max(16).optional(),
      control: z.string().min(1).max(32).optional(),
      pageSize: z.number().int().min(1).max(500).default(100),
      pageToken: z.string().min(1).max(32_768).optional()
    },
    outputSchema: {
      tool: z.literal("get_scan_result"), ...commonOutput,
      summary: z.object({
        scanId: z.string(),
        scanState: scanStateSchema,
        section: z.string(),
        sectionState: z.string(),
        collection: z.string(),
        storedItemCount: z.number().int().nonnegative(),
        matchedItemCount: z.number().int().nonnegative()
      }),
      data: z.object({
        sectionMetadata: recordSchema,
        items: z.array(z.unknown())
      })
    },
    annotations: readOnlyAnnotations
  }, async ({
    scanId, section, collection, resourceType, resourceGroup, status,
    severity, family, control, pageSize, pageToken
  }) => {
    const record = dependencies.manager.get(dependencies.caller, scanId);
    const selected = record?.sections[section];
    if (!record || !selected) {
      return scanEnvelope(dependencies, "get_scan_result", record?.subscriptionId, {
        scanId, scanState: record?.state ?? "unavailable", section,
        sectionState: "unavailable", collection: collection ?? "default",
        storedItemCount: 0, matchedItemCount: 0
      }, { sectionMetadata: {}, items: [] }, "unavailable",
      ["Scan or section was not found, expired, evicted, or belongs to another caller"], [{
        source: "scan store", code: "ScanSectionNotFound", message: "Scan section is unavailable"
      }]);
    }
    const resolvedCollection = collection ?? defaultCollection(section);
    const items = extractItems(section, resolvedCollection, selected.data);
    const filters = {
      scanId, section, collection: resolvedCollection,
      resourceType: resourceType?.toLowerCase() ?? null,
      resourceGroup: resourceGroup?.toLowerCase() ?? null,
      status: status?.toLowerCase() ?? null,
      severity: severity?.toLowerCase() ?? null,
      family: family?.toUpperCase() ?? null,
      control: control?.toUpperCase() ?? null
    };
    const filtered = items.filter((item) => matchesFilters(item, filters));
    const page = pageSlice(filtered, pageSize, pageToken, filters);
    const sectionAccess = selected.state === "failed" ? "unavailable"
      : selected.state === "partial" || selected.state === "running" || selected.state === "pending"
        ? "partial" : "full";
    const structuredContent = createEnvelope({
      tool: "get_scan_result",
      tenantId: dependencies.caller.tenantId,
      authMode: dependencies.config.authMode,
      scope: { level: "subscription", subscriptionId: record.subscriptionId },
      summary: {
        scanId, scanState: record.state, section,
        sectionState: selected.state, collection: resolvedCollection,
        storedItemCount: selected.itemCount, matchedItemCount: filtered.length
      },
      data: { sectionMetadata: sectionMetadata(selected), items: page.values },
      page: { nextPageToken: page.nextPageToken, returned: page.values.length, total: page.total },
      portalLinks: subscriptionLink(dependencies, record.subscriptionId),
      accessStatus: sectionAccess,
      accessNotes: [
        ...selected.notes,
        ...(selected.state === "pending" || selected.state === "running"
          ? ["Section collection has not completed; poll get_scan_status"] : [])
      ],
      errors: selected.errors.map((error) => ({
        source: section, code: error.code, message: error.message
      }))
    });
    return jsonResult(structuredContent);
  });
}

function extractItems(section: string, collection: string, data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const value = object(data);
  const paths: Record<string, Record<string, string>> = {
    inventory: { default: "resources", resources: "resources" },
    network: { default: "resources", resources: "resources", findings: "findings", endpoints: "endpoints" },
    endpoints: { default: "endpoints", endpoints: "endpoints" },
    serviceFindings: { default: "findings", findings: "findings", resources: "resources" },
    policyCompliance: { default: "resources", resources: "resources", assignments: "byAssignment" },
    securityPosture: { default: "unhealthyAssessments", assessments: "unhealthyAssessments", defenderPlans: "defenderPlans", secureScores: "secureScores" },
    tenantContext: { default: "subscriptions", subscriptions: "subscriptions", managementGroups: "managementGroups", policyAssignments: "policyAssignments", roleAssignments: "roleAssignments" },
    nistControls: { default: "controls", controls: "controls" },
    nistEvidence: { default: "controls", controls: "controls" },
    nistStatus: { default: "$self" }
  };
  const key = paths[section]?.[collection] ?? paths[section]?.default;
  if (key === "$self") return [value];
  const items = key ? value[key] : undefined;
  return Array.isArray(items) ? items : [];
}

function matchesFilters(item: unknown, filters: Record<string, unknown>): boolean {
  const value = object(item);
  const resourceType = string(value.resourceType) ?? string(value.type);
  const resourceGroup = string(value.resourceGroup);
  const status = string(value.status) ?? string(value.state) ?? string(value.complianceState);
  const severity = string(value.severity);
  const family = string(value.family);
  const control = string(value.controlId) ?? string(value.id);
  return (!filters.resourceType || resourceType?.toLowerCase() === filters.resourceType)
    && (!filters.resourceGroup || resourceGroup?.toLowerCase() === filters.resourceGroup)
    && (!filters.status || status?.toLowerCase() === filters.status)
    && (!filters.severity || severity?.toLowerCase() === filters.severity)
    && (!filters.family || family?.toUpperCase() === filters.family)
    && (!filters.control || control?.toUpperCase() === filters.control);
}

function sectionMetadata(section: ScanSection): Record<string, unknown> {
  return {
    name: section.name,
    state: section.state,
    startedAt: section.startedAt,
    completedAt: section.completedAt,
    itemCount: section.itemCount,
    notes: section.notes,
    errors: section.errors,
    bytes: section.bytes
  };
}

function defaultCollection(section: string): string {
  return ({
    inventory: "resources",
    network: "resources",
    endpoints: "endpoints",
    serviceFindings: "findings",
    policyCompliance: "resources",
    securityPosture: "assessments",
    tenantContext: "subscriptions",
    nistControls: "controls",
    nistEvidence: "controls"
  } as Record<string, string>)[section] ?? "default";
}

function scanEnvelope(
  dependencies: ScanToolDependencies,
  tool: string,
  subscriptionId: string | undefined,
  summary: Record<string, unknown>,
  data: unknown,
  accessStatus: "full" | "partial" | "unavailable" = "full",
  accessNotes: string[] = [],
  errors: Array<{ source: string; code: string; message: string }> = []
) {
  const structuredContent = createEnvelope({
    tool,
    tenantId: dependencies.caller.tenantId,
    authMode: dependencies.config.authMode,
    scope: subscriptionId
      ? { level: "subscription", subscriptionId }
      : { level: "tenant" },
    summary, data,
    portalLinks: subscriptionId ? subscriptionLink(dependencies, subscriptionId) : {},
    accessStatus, accessNotes, errors
  });
  return jsonResult(structuredContent);
}

function subscriptionLink(dependencies: ScanToolDependencies, subscriptionId: string) {
  return {
    subscription: portalResourceUrl(
      dependencies.cloud,
      `/subscriptions/${subscriptionId}`,
      dependencies.caller.tenantId ?? undefined,
      dependencies.config.portalLinkTemplates
    )
  };
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function jsonResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;
