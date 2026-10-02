import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getResourceConfiguration,
  inventoryResources,
  listResourceGroups
} from "../collectors/inventory.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalResourceUrl } from "../links.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";

const subscriptionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const pageSizeSchema = z.number().int().min(1).max(500).default(200);
const pageTokenSchema = z.string().min(1).max(32_768).optional();

const scopeSchema = z.object({
  level: z.enum(["tenant", "subscription", "resourceGroup", "resource"]),
  subscriptionId: z.string().optional(),
  resourceId: z.string().optional()
});

const pageSchema = z
  .object({
    nextPageToken: z.string().nullable(),
    returned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable()
  })
  .nullable();

const resourceGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string().nullable().optional(),
  subscriptionId: z.string(),
  tags: z.record(z.string(), z.unknown()).nullable().optional(),
  provisioningState: z.string().nullable().optional()
});

const inventoryResourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    category: z.string(),
    location: z.string().nullable().optional(),
    resourceGroup: z.string().nullable().optional(),
    subscriptionId: z.string(),
    tags: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();

const findingSchema = z.object({
  checkId: z.string(),
  title: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  status: z.enum(["pass", "fail", "notApplicable", "unknown"]),
  evidence: z.record(z.string(), z.unknown()),
  nistControls: z.array(z.string())
});

const commonOutput = {
  generatedAt: z.iso.datetime(),
  tenantId: z.string().nullable(),
  scope: scopeSchema,
  caller: callerSchema,
  access: accessSchema,
  page: pageSchema,
  portalLinks: z.record(z.string(), z.string()),
  errors: z.array(errorSchema)
};

export interface InventoryToolDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  resourceGraph: ResourceGraphClient;
}

export function registerInventoryTools(
  server: McpServer,
  dependencies: InventoryToolDependencies
): void {
  server.registerTool(
    "list_resource_groups",
    {
      title: "List Azure resource groups",
      description:
        "Lists resource groups in one subscription with stable Resource Graph pagination.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        pageSize: pageSizeSchema,
        pageToken: pageTokenSchema
      },
      outputSchema: {
        tool: z.literal("list_resource_groups"),
        ...commonOutput,
        summary: z.object({ total: z.number().int().nonnegative() }),
        data: z.array(resourceGroupSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({ subscriptionId, pageSize, pageToken }) => {
      try {
        const result = await listResourceGroups(
          dependencies.resourceGraph,
          subscriptionId,
          pageSize,
          pageToken
        );
        const structuredContent = createEnvelope({
          tool: "list_resource_groups",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: { level: "subscription", subscriptionId },
          summary: { total: result.totalRecords },
          data: result.data,
          page: {
            nextPageToken: result.nextPageToken,
            returned: result.count,
            total: result.totalRecords
          },
          portalLinks: {
            subscription: portalResourceUrl(
              dependencies.cloud,
              `/subscriptions/${subscriptionId}`,
              dependencies.config.tenantId,
              dependencies.config.portalLinkTemplates
            )
          },
          accessStatus: result.incompleteReason ? "partial" : "full",
          accessNotes: result.incompleteReason ? [result.incompleteReason] : []
        });
        return jsonToolResult(structuredContent);
      } catch (error) {
        return toolError("list_resource_groups", "ResourceGroupListFailed", error);
      }
    }
  );

  server.registerTool(
    "inventory_resources",
    {
      title: "Inventory Azure resources",
      description:
        "Returns a paged resource inventory and complete counts by type, location, and resource group.",
      inputSchema: {
        subscriptionId: subscriptionIdSchema,
        resourceGroup: z.string().min(1).max(256).optional(),
        resourceType: z.string().min(1).max(256).optional(),
        location: z.string().min(1).max(128).optional(),
        nameContains: z.string().min(1).max(256).optional(),
        pageSize: pageSizeSchema,
        pageToken: pageTokenSchema
      },
      outputSchema: {
        tool: z.literal("inventory_resources"),
        ...commonOutput,
        summary: z.object({
          total: z.number().int().nonnegative(),
          byType: z.record(z.string(), z.number().int().nonnegative()),
          byLocation: z.record(z.string(), z.number().int().nonnegative()),
          byResourceGroup: z.record(z.string(), z.number().int().nonnegative()),
          complete: z.boolean(),
          incompleteReasons: z.array(z.string())
        }),
        data: z.array(inventoryResourceSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({
      subscriptionId,
      resourceGroup,
      resourceType,
      location,
      nameContains,
      pageSize,
      pageToken
    }) => {
      try {
        const result = await inventoryResources(
          dependencies.resourceGraph,
          subscriptionId,
          {
            ...(resourceGroup ? { resourceGroup } : {}),
            ...(resourceType ? { resourceType } : {}),
            ...(location ? { location } : {}),
            ...(nameContains ? { nameContains } : {})
          },
          pageSize,
          pageToken
        );
        const notes = [
          ...(result.incompleteReason ? [result.incompleteReason] : []),
          ...result.summary.incompleteReasons
        ];
        const structuredContent = createEnvelope({
          tool: "inventory_resources",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: { level: "subscription", subscriptionId },
          summary: result.summary,
          data: result.data,
          page: {
            nextPageToken: result.nextPageToken,
            returned: result.count,
            total: result.totalRecords
          },
          portalLinks: {
            subscription: portalResourceUrl(
              dependencies.cloud,
              `/subscriptions/${subscriptionId}`,
              dependencies.config.tenantId,
              dependencies.config.portalLinkTemplates
            )
          },
          accessStatus: notes.length ? "partial" : "full",
          accessNotes: notes
        });
        return jsonToolResult(structuredContent);
      } catch (error) {
        return toolError("inventory_resources", "ResourceInventoryFailed", error);
      }
    }
  );

  server.registerTool(
    "get_resource_configuration",
    {
      title: "Get Azure resource configuration",
      description:
        "Returns one resource's Resource Graph configuration, with sensitive-looking fields redacted, plus generic security findings.",
      inputSchema: {
        resourceId: z
          .string()
          .min(1)
          .max(2_048)
          .regex(/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/.+/i)
      },
      outputSchema: {
        tool: z.literal("get_resource_configuration"),
        ...commonOutput,
        summary: z.object({
          findingCount: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          passed: z.number().int().nonnegative(),
          unknown: z.number().int().nonnegative()
        }),
        data: z.object({
          resource: z.record(z.string(), z.unknown()),
          findings: z.array(findingSchema)
        })
      },
      annotations: readOnlyAnnotations
    },
    async ({ resourceId }) => {
      try {
        const result = await getResourceConfiguration(
          dependencies.resourceGraph,
          resourceId
        );
        if (!result) {
          return toolError(
            "get_resource_configuration",
            "ResourceNotFound",
            new Error("The resource was not found or is not visible to the caller")
          );
        }
        const statuses = result.findings.map((finding) => finding.status);
        const structuredContent = createEnvelope({
          tool: "get_resource_configuration",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: {
            level: "resource",
            subscriptionId: subscriptionIdFromResourceId(resourceId),
            resourceId
          },
          summary: {
            findingCount: result.findings.length,
            failed: statuses.filter((status) => status === "fail").length,
            passed: statuses.filter((status) => status === "pass").length,
            unknown: statuses.filter((status) => status === "unknown").length
          },
          data: result,
          portalLinks: {
            resource: portalResourceUrl(
              dependencies.cloud,
              resourceId,
              dependencies.config.tenantId,
              dependencies.config.portalLinkTemplates
            )
          }
        });
        return jsonToolResult(structuredContent);
      } catch (error) {
        return toolError(
          "get_resource_configuration",
          "ResourceConfigurationFailed",
          error
        );
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
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ tool, code, message }, null, 2)
      }
    ]
  };
}

function subscriptionIdFromResourceId(resourceId: string): string {
  return resourceId.split("/")[2] ?? "";
}
