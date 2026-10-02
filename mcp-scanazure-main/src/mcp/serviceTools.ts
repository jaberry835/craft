import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ArmReadClient } from "../azure/arm.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";
import {
  collectServiceFindings,
  SERVICE_CATEGORIES,
  type ServiceCategory
} from "../collectors/serviceFindings.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { portalResourceUrl } from "../links.js";
import { pageSlice } from "../pagination.js";

const categorySchema = z.enum(SERVICE_CATEGORIES);
const findingStatusSchema = z.enum(["pass", "fail", "notApplicable", "unknown"]);

export function registerServiceTools(
  server: McpServer,
  dependencies: {
    config: AppConfig;
    cloud: CloudProfile;
    resourceGraph: ResourceGraphClient;
    arm: ArmReadClient;
  }
): void {
  server.registerTool(
    "get_service_findings",
    {
      title: "Get Azure service security findings",
      description:
        "Analyzes major Azure service categories with generic and type-specific checks. Uses safe ARM enrichment for non-secret configuration where supported.",
      inputSchema: {
        subscriptionId: z
          .string()
          .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        categories: z.array(categorySchema).min(1).default([...SERVICE_CATEGORIES]),
        findingStatus: findingStatusSchema.optional(),
        severity: z.enum(["low", "medium", "high"]).optional(),
        pageSize: z.number().int().min(1).max(200).default(50),
        pageToken: z.string().min(1).max(32_768).optional()
      },
      outputSchema: {
        tool: z.literal("get_service_findings"),
        generatedAt: z.iso.datetime(),
        tenantId: z.string().nullable(),
        scope: z.object({
          level: z.literal("subscription"),
          subscriptionId: z.string()
        }),
        caller: callerSchema,
        access: accessSchema,
        summary: z.object({
          totalResources: z.number().int().nonnegative(),
          totalFindings: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          passed: z.number().int().nonnegative(),
          unknown: z.number().int().nonnegative(),
          byCategory: z.record(z.string(), z.number().int().nonnegative()),
          bySeverity: z.record(z.string(), z.number().int().nonnegative()),
          complete: z.boolean(),
          incompleteReasons: z.array(z.string())
        }),
        data: z.object({
          resources: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              type: z.string(),
              category: categorySchema,
              location: z.string().nullable().optional(),
              resourceGroup: z.string().nullable().optional(),
              findingCount: z.number().int().nonnegative(),
              failed: z.number().int().nonnegative(),
              unknown: z.number().int().nonnegative()
            })
          ),
          findings: z.array(
            z.object({
              checkId: z.string(),
              title: z.string(),
              severity: z.enum(["low", "medium", "high"]),
              status: findingStatusSchema,
              evidence: z.record(z.string(), z.unknown()),
              nistControls: z.array(z.string()),
              resourceId: z.string(),
              resourceName: z.string(),
              resourceType: z.string(),
              category: categorySchema,
              source: z.enum(["resourceGraph", "arm"])
            })
          )
        }),
        page: z.object({
          nextPageToken: z.string().nullable(),
          returned: z.number().int().nonnegative(),
          total: z.number().int().nonnegative().nullable()
        }),
        portalLinks: z.record(z.string(), z.string()),
        errors: z.array(errorSchema)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({
      subscriptionId,
      categories,
      findingStatus,
      severity,
      pageSize,
      pageToken
    }) => {
      try {
        const selectedCategories = [...new Set(categories)] as ServiceCategory[];
        const result = await collectServiceFindings(
          dependencies.resourceGraph,
          dependencies.arm,
          subscriptionId,
          selectedCategories
        );
        const page = pageSlice(
          result.resources,
          pageSize,
          pageToken,
          { subscriptionId, categories: [...selectedCategories].sort() }
        );
        const visibleResourceIds = new Set(page.values.map((resource) => resource.id));
        const findings = result.findings.filter(
          (finding) =>
            visibleResourceIds.has(finding.resourceId) &&
            (!findingStatus || finding.status === findingStatus) &&
            (!severity || finding.severity === severity)
        );
        const allFilteredFindings = result.findings.filter(
          (finding) =>
            (!findingStatus || finding.status === findingStatus) &&
            (!severity || finding.severity === severity)
        );
        const notes = [
          ...result.incompleteReasons,
          ...(result.errors.length
            ? [`${result.errors.length} optional ARM enrichment request(s) failed`]
            : [])
        ];
        const structuredContent = createEnvelope({
          tool: "get_service_findings",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: { level: "subscription", subscriptionId },
          summary: {
            totalResources: result.resources.length,
            totalFindings: allFilteredFindings.length,
            failed: allFilteredFindings.filter((finding) => finding.status === "fail")
              .length,
            passed: allFilteredFindings.filter((finding) => finding.status === "pass")
              .length,
            unknown: allFilteredFindings.filter(
              (finding) => finding.status === "unknown"
            ).length,
            byCategory: countBy(allFilteredFindings, (finding) => finding.category),
            bySeverity: countBy(allFilteredFindings, (finding) => finding.severity),
            complete: result.complete && result.errors.length === 0,
            incompleteReasons: notes
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
          errors: result.errors,
          accessStatus: notes.length ? "partial" : "full",
          accessNotes: notes
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }
          ],
          structuredContent
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  tool: "get_service_findings",
                  code: "ServiceFindingsFailed",
                  message: error instanceof Error ? error.message : String(error)
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const current = key(value);
    counts[current] = (counts[current] ?? 0) + 1;
    return counts;
  }, {});
}
