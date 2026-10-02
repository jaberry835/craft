import { z } from "zod";
import { analyzeGenericConfiguration, type SecurityFinding } from "../analyzers/generic.js";
import { analyzeServiceConfiguration } from "../analyzers/service.js";
import { API_VERSIONS } from "../azure/apiVersions.js";
import type { ArmReadClient } from "../azure/arm.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";

const serviceResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  location: z.string().nullable().optional(),
  resourceGroup: z.string().nullable().optional(),
  subscriptionId: z.string(),
  tags: z.record(z.string(), z.unknown()).nullable().optional(),
  identity: z.record(z.string(), z.unknown()).nullable().optional(),
  properties: z.record(z.string(), z.unknown()).nullable().optional()
});

export const SERVICE_CATEGORIES = [
  "compute",
  "containers",
  "app-platform",
  "keyvault",
  "storage",
  "database",
  "messaging",
  "ai",
  "monitoring",
  "backup"
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ServiceFinding extends SecurityFinding {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  category: ServiceCategory;
  source: "resourceGraph" | "arm";
}

export interface ServiceFindingResource {
  id: string;
  name: string;
  type: string;
  category: ServiceCategory;
  location?: string | null;
  resourceGroup?: string | null;
  findingCount: number;
  failed: number;
  unknown: number;
}

export interface ServiceFindingsResult {
  resources: ServiceFindingResource[];
  findings: ServiceFinding[];
  errors: Array<{ source: string; code: string; message: string }>;
  complete: boolean;
  incompleteReasons: string[];
}

const CATEGORY_NAMESPACES: Record<ServiceCategory, string[]> = {
  compute: ["microsoft.compute"],
  containers: [
    "microsoft.containerservice",
    "microsoft.containerregistry",
    "microsoft.app",
    "microsoft.containerinstance"
  ],
  "app-platform": ["microsoft.web", "microsoft.apimanagement", "microsoft.logic"],
  keyvault: ["microsoft.keyvault", "microsoft.appconfiguration"],
  storage: ["microsoft.storage"],
  database: [
    "microsoft.sql",
    "microsoft.dbforpostgresql",
    "microsoft.dbformysql",
    "microsoft.documentdb",
    "microsoft.cache"
  ],
  messaging: ["microsoft.servicebus", "microsoft.eventhub", "microsoft.eventgrid"],
  ai: [
    "microsoft.cognitiveservices",
    "microsoft.search",
    "microsoft.synapse",
    "microsoft.databricks",
    "microsoft.kusto"
  ],
  monitoring: ["microsoft.insights", "microsoft.operationalinsights"],
  backup: ["microsoft.recoveryservices", "microsoft.dataprotection"]
};

export async function collectServiceFindings(
  graph: ResourceGraphClient,
  arm: ArmReadClient,
  subscriptionId: string,
  categories: ServiceCategory[]
): Promise<ServiceFindingsResult> {
  const namespaces = [...new Set(categories.flatMap((category) => CATEGORY_NAMESPACES[category]))];
  const result = await graph.queryAll({
    subscriptions: [subscriptionId],
    query: `
Resources
| extend providerNamespace=tolower(split(type, '/')[0])
| where providerNamespace in (${namespaces.map((value) => `'${value}'`).join(", ")})
| project id, name, type=tolower(type), location, resourceGroup, subscriptionId,
    tags, identity, properties
| order by id asc`,
    pageSize: 1_000
  });
  const rows = result.data.map((row) => serviceResourceSchema.parse(row));
  const findings: ServiceFinding[] = [];
  const resources: ServiceFindingResource[] = [];
  const errors: ServiceFindingsResult["errors"] = [];

  for (const resource of rows) {
    const category = categoryForType(resource.type);
    if (!category || !categories.includes(category)) {
      continue;
    }
    const resourceFindings = [
      ...analyzeGenericConfiguration(resource),
      ...analyzeServiceConfiguration(resource)
    ].map<ServiceFinding>((finding) => ({
      ...finding,
      resourceId: resource.id,
      resourceName: resource.name,
      resourceType: resource.type,
      category,
      source: "resourceGraph"
    }));

    const enrichment = await enrichResource(arm, resource, category);
    resourceFindings.push(...enrichment.findings);
    errors.push(...enrichment.errors);
    findings.push(...resourceFindings);
    resources.push({
      id: resource.id,
      name: resource.name,
      type: resource.type,
      category,
      location: resource.location,
      resourceGroup: resource.resourceGroup,
      findingCount: resourceFindings.length,
      failed: resourceFindings.filter((finding) => finding.status === "fail").length,
      unknown: resourceFindings.filter((finding) => finding.status === "unknown").length
    });
  }

  return {
    resources,
    findings,
    errors,
    complete: result.complete,
    incompleteReasons: result.incompleteReason ? [result.incompleteReason] : []
  };
}

async function enrichResource(
  arm: ArmReadClient,
  resource: z.infer<typeof serviceResourceSchema>,
  category: ServiceCategory
): Promise<{
  findings: ServiceFinding[];
  errors: ServiceFindingsResult["errors"];
}> {
  if (resource.type !== "microsoft.web/sites") {
    return { findings: [], errors: [] };
  }

  try {
    const config = await arm.get<Record<string, unknown>>(
      `${resource.id}/config/web`,
      API_VERSIONS.appServiceConfig
    );
    const properties = objectValue(config.properties) ?? {};
    const checks: SecurityFinding[] = [
      {
        checkId: "appservice.minimum-tls",
        title: "App Service minimum TLS version is 1.2 or newer",
        severity: "high",
        status: tlsStatus(properties.minTlsVersion),
        evidence: { minTlsVersion: properties.minTlsVersion ?? null },
        nistControls: ["SC-8", "SC-13"]
      },
      {
        checkId: "appservice.ftps-disabled",
        title: "App Service FTP/FTPS publishing is disabled",
        severity: "medium",
        status:
          typeof properties.ftpsState === "string"
            ? properties.ftpsState.toLowerCase() === "disabled"
              ? "pass"
              : "fail"
            : "unknown",
        evidence: { ftpsState: properties.ftpsState ?? null },
        nistControls: ["CM-7", "SC-8"]
      },
      {
        checkId: "appservice.remote-debugging-disabled",
        title: "App Service remote debugging is disabled",
        severity: "high",
        status:
          typeof properties.remoteDebuggingEnabled === "boolean"
            ? properties.remoteDebuggingEnabled
              ? "fail"
              : "pass"
            : "unknown",
        evidence: {
          remoteDebuggingEnabled: properties.remoteDebuggingEnabled ?? null
        },
        nistControls: ["CM-7"]
      }
    ];
    return {
      findings: checks.map((finding) => ({
        ...finding,
        resourceId: resource.id,
        resourceName: resource.name,
        resourceType: resource.type,
        category,
        source: "arm"
      })),
      errors: []
    };
  } catch (error) {
    return {
      findings: [],
      errors: [
        {
          source: `${resource.id}/config/web`,
          code: "AppServiceEnrichmentFailed",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

function categoryForType(type: string): ServiceCategory | null {
  const namespace = type.split("/")[0]?.toLowerCase();
  if (!namespace) {
    return null;
  }
  return (
    SERVICE_CATEGORIES.find((category) =>
      CATEGORY_NAMESPACES[category].includes(namespace)
    ) ?? null
  );
}

function tlsStatus(value: unknown): SecurityFinding["status"] {
  if (typeof value !== "string") {
    return "unknown";
  }
  const version = value.match(/\d+(?:\.\d+)?/)?.[0];
  return version && Number(version) >= 1.2 ? "pass" : "fail";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
