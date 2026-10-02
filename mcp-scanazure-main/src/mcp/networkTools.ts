import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import {
  collectNetworkEndpoints,
  collectNetworkInventory
} from "../collectors/network.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalResourceUrl } from "../links.js";
import { pageSlice } from "../pagination.js";

const subscriptionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const pageSizeSchema = z.number().int().min(1).max(500).default(100);
const pageTokenSchema = z.string().min(1).max(32_768).optional();

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
  page: z
    .object({
      nextPageToken: z.string().nullable(),
      returned: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().nullable()
    })
    .nullable(),
  portalLinks: z.record(z.string(), z.string()),
  errors: z.array(errorSchema)
};

const networkResourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    location: z.string().nullable().optional(),
    resourceGroup: z.string().nullable().optional(),
    subscriptionId: z.string(),
    properties: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();

const networkFindingSchema = z.object({
  checkId: z.string(),
  title: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  resourceId: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  nistControls: z.array(z.string())
});

const endpointSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  resourceName: z.string(),
  resourceType: z.string(),
  endpointType: z.enum(["ip", "fqdn"]),
  value: z.string(),
  exposure: z.enum(["public", "private", "restricted", "unknown"]),
  source: z.string(),
  associatedResourceId: z.string().nullable()
});

export interface NetworkToolDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  resourceGraph: ResourceGraphClient;
}

export function registerNetworkTools(
  server: McpServer,
  dependencies: NetworkToolDependencies
): void {
  server.registerTool(
    "inventory_network",
    {
      title: "Inventory Azure network topology",
      description:
        "Returns paged Azure network resources, topology counts, public/private endpoint counts, and NSG exposure findings.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        resourceType: z.string().min(1).max(256).optional(),
        resourceGroup: z.string().min(1).max(256).optional(),
        findingSeverity: z.enum(["low", "medium", "high"]).optional(),
        pageSize: pageSizeSchema,
        pageToken: pageTokenSchema
      },
      outputSchema: {
        tool: z.literal("inventory_network"),
        ...commonOutput,
        summary: z.object({
          totalResources: z.number().int().nonnegative(),
          filteredResources: z.number().int().nonnegative(),
          byType: z.record(z.string(), z.number().int().nonnegative()),
          vnetCount: z.number().int().nonnegative(),
          subnetCount: z.number().int().nonnegative(),
          peeringCount: z.number().int().nonnegative(),
          nsgCount: z.number().int().nonnegative(),
          publicIpCount: z.number().int().nonnegative(),
          privateEndpointCount: z.number().int().nonnegative(),
          publicEndpointCount: z.number().int().nonnegative(),
          privateEndpointAddressCount: z.number().int().nonnegative(),
          highSeverityFindingCount: z.number().int().nonnegative(),
          complete: z.boolean(),
          incompleteReasons: z.array(z.string())
        }),
        data: z.object({
          resources: z.array(networkResourceSchema),
          findings: z.array(networkFindingSchema)
        })
      },
      annotations: readOnlyAnnotations
    },
    async ({
      subscriptionId,
      resourceType,
      resourceGroup,
      findingSeverity,
      pageSize,
      pageToken
    }) => {
      try {
        const inventory = await collectNetworkInventory(
          dependencies.resourceGraph,
          subscriptionId
        );
        const filters = {
          subscriptionId,
          resourceType: resourceType?.toLowerCase() ?? null,
          resourceGroup: resourceGroup?.toLowerCase() ?? null
        };
        const filteredResources = inventory.resources.filter(
          (resource) =>
            (!resourceType || resource.type.toLowerCase() === resourceType.toLowerCase()) &&
            (!resourceGroup ||
              resource.resourceGroup?.toLowerCase() === resourceGroup.toLowerCase())
        );
        const page = pageSlice(filteredResources, pageSize, pageToken, filters);
        const visibleResourceIds = new Set(page.values.map((resource) => resource.id));
        const findings = inventory.findings.filter(
          (finding) =>
            visibleResourceIds.has(finding.resourceId) &&
            (!findingSeverity || finding.severity === findingSeverity)
        );
        const structuredContent = createEnvelope({
          tool: "inventory_network",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: { level: "subscription", subscriptionId },
          summary: {
            ...inventory.summary,
            filteredResources: filteredResources.length
          },
          data: { resources: page.values, findings },
          page: {
            nextPageToken: page.nextPageToken,
            returned: page.values.length,
            total: page.total
          },
          portalLinks: {
            subscription: portalResourceUrl(
              dependencies.cloud,
              `/subscriptions/${subscriptionId}`,
              dependencies.config.tenantId,
              dependencies.config.portalLinkTemplates
            )
          },
          accessStatus: inventory.summary.complete ? "full" : "partial",
          accessNotes: inventory.summary.incompleteReasons
        });
        return jsonToolResult(structuredContent);
      } catch (error) {
        return toolError("inventory_network", "NetworkInventoryFailed", error);
      }
    }
  );

  server.registerTool(
    "list_network_endpoints",
    {
      title: "List Azure network endpoints",
      description:
        "Returns a flat, paged list of public, restricted, private, and unknown IP/FQDN endpoints associated with Azure resources.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        exposure: z.enum(["public", "private", "restricted", "unknown"]).optional(),
        endpointType: z.enum(["ip", "fqdn"]).optional(),
        resourceType: z.string().min(1).max(256).optional(),
        pageSize: pageSizeSchema,
        pageToken: pageTokenSchema
      },
      outputSchema: {
        tool: z.literal("list_network_endpoints"),
        ...commonOutput,
        summary: z.object({
          total: z.number().int().nonnegative(),
          byExposure: z.record(z.string(), z.number().int().nonnegative()),
          byEndpointType: z.record(z.string(), z.number().int().nonnegative()),
          complete: z.boolean(),
          incompleteReasons: z.array(z.string())
        }),
        data: z.array(endpointSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({
      subscriptionId,
      exposure,
      endpointType,
      resourceType,
      pageSize,
      pageToken
    }) => {
      try {
        const result = await collectNetworkEndpoints(
          dependencies.resourceGraph,
          subscriptionId
        );
        const filters = {
          subscriptionId,
          exposure: exposure ?? null,
          endpointType: endpointType ?? null,
          resourceType: resourceType?.toLowerCase() ?? null
        };
        const endpoints = result.endpoints.filter(
          (endpoint) =>
            (!exposure || endpoint.exposure === exposure) &&
            (!endpointType || endpoint.endpointType === endpointType) &&
            (!resourceType ||
              endpoint.resourceType.toLowerCase() === resourceType.toLowerCase())
        );
        const page = pageSlice(endpoints, pageSize, pageToken, filters);
        const structuredContent = createEnvelope({
          tool: "list_network_endpoints",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: { level: "subscription", subscriptionId },
          summary: {
            total: endpoints.length,
            byExposure: countBy(endpoints, (endpoint) => endpoint.exposure),
            byEndpointType: countBy(endpoints, (endpoint) => endpoint.endpointType),
            complete: result.complete,
            incompleteReasons: result.incompleteReasons
          },
          data: page.values,
          page: {
            nextPageToken: page.nextPageToken,
            returned: page.values.length,
            total: page.total
          },
          portalLinks: {
            subscription: portalResourceUrl(
              dependencies.cloud,
              `/subscriptions/${subscriptionId}`,
              dependencies.config.tenantId,
              dependencies.config.portalLinkTemplates
            )
          },
          accessStatus: result.complete ? "full" : "partial",
          accessNotes: result.incompleteReasons
        });
        return jsonToolResult(structuredContent);
      } catch (error) {
        return toolError("list_network_endpoints", "NetworkEndpointListFailed", error);
      }
    }
  );
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

function jsonToolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

function toolError(tool: string, code: string, error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            tool,
            code,
            message: error instanceof Error ? error.message : String(error)
          },
          null,
          2
        )
      }
    ]
  };
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const current = key(value);
    counts[current] = (counts[current] ?? 0) + 1;
    return counts;
  }, {});
}
