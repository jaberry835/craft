import { z } from "zod";
import { analyzeGenericConfiguration, type SecurityFinding } from "../analyzers/generic.js";
import { kqlString } from "../azure/kql.js";
import { ResourceGraphClient } from "../azure/resourceGraph.js";
import { redactSensitiveValues } from "../security/redact.js";

const resourceGroupRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string().nullable().optional(),
  subscriptionId: z.string(),
  tags: z.record(z.string(), z.unknown()).nullable().optional(),
  provisioningState: z.string().nullable().optional()
});

const azureBooleanSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1);

const inventoryRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  location: z.string().nullable().optional(),
  resourceGroup: z.string().nullable().optional(),
  subscriptionId: z.string(),
  tags: z.record(z.string(), z.unknown()).nullable().optional(),
  kind: z.string().nullable().optional(),
  sku: z.unknown().optional(),
  identityType: z.string().nullable().optional(),
  publicNetworkAccess: z.string().nullable().optional(),
  minimumTlsVersion: z.string().nullable().optional(),
  httpsOnly: azureBooleanSchema.nullable().optional(),
  disableLocalAuth: azureBooleanSchema.nullable().optional(),
  allowSharedKeyAccess: azureBooleanSchema.nullable().optional(),
  enableRbacAuthorization: azureBooleanSchema.nullable().optional(),
  privateEndpointConnectionCount: z.number().nullable().optional()
});

const resourceConfigurationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    location: z.string().nullable().optional(),
    resourceGroup: z.string().nullable().optional(),
    subscriptionId: z.string(),
    tags: z.record(z.string(), z.unknown()).nullable().optional(),
    kind: z.string().nullable().optional(),
    sku: z.unknown().optional(),
    identity: z.record(z.string(), z.unknown()).nullable().optional(),
    managedBy: z.string().nullable().optional(),
    zones: z.array(z.string()).nullable().optional(),
    properties: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();

const countRowSchema = z.object({
  key: z.string(),
  count: z.number()
});

export interface InventoryFilters {
  resourceGroup?: string;
  resourceType?: string;
  location?: string;
  nameContains?: string;
}

export interface InventoryResource extends z.infer<typeof inventoryRowSchema> {
  category: string;
}

export interface ResourceConfiguration {
  resource: Record<string, unknown>;
  findings: SecurityFinding[];
}

export async function listResourceGroups(
  client: ResourceGraphClient,
  subscriptionId: string,
  pageSize: number,
  pageToken?: string
) {
  const page = await client.query({
    subscriptions: [subscriptionId],
    query: `
ResourceContainers
| where type =~ 'microsoft.resources/subscriptions/resourcegroups'
| project id, name, location, subscriptionId, tags,
    provisioningState=tostring(properties.provisioningState)
| order by id asc`,
    pageSize,
    ...(pageToken ? { skipToken: pageToken } : {})
  });

  return {
    ...page,
    data: page.data.map((row) => resourceGroupRowSchema.parse(row))
  };
}

export async function inventoryResources(
  client: ResourceGraphClient,
  subscriptionId: string,
  filters: InventoryFilters,
  pageSize: number,
  pageToken?: string
) {
  const where = buildFilters(filters);
  const page = await client.query({
    subscriptions: [subscriptionId],
    query: `
Resources
${where}
| project id, name, type=tolower(type), location, resourceGroup, subscriptionId,
    tags, kind, sku,
    identityType=tostring(identity.type),
    publicNetworkAccess=tostring(properties.publicNetworkAccess),
    minimumTlsVersion=tostring(coalesce(properties.minimumTlsVersion, properties.minTlsVersion)),
    httpsOnly=tobool(properties.httpsOnly),
    disableLocalAuth=tobool(properties.disableLocalAuth),
    allowSharedKeyAccess=tobool(properties.allowSharedKeyAccess),
    enableRbacAuthorization=tobool(properties.enableRbacAuthorization),
    privateEndpointConnectionCount=array_length(properties.privateEndpointConnections)
| order by id asc`,
    pageSize,
    ...(pageToken ? { skipToken: pageToken } : {})
  });

  const [byType, byLocation, byResourceGroup] = await Promise.all([
    summarize(client, subscriptionId, where, "tolower(type)"),
    summarize(client, subscriptionId, where, "tostring(location)"),
    summarize(client, subscriptionId, where, "tostring(resourceGroup)")
  ]);

  return {
    ...page,
    data: page.data.map((row) => {
      const parsed = inventoryRowSchema.parse(row);
      return { ...parsed, category: resourceCategory(parsed.type) };
    }),
    summary: {
      total: page.totalRecords,
      byType: byType.counts,
      byLocation: byLocation.counts,
      byResourceGroup: byResourceGroup.counts,
      complete: byType.complete && byLocation.complete && byResourceGroup.complete,
      incompleteReasons: [
        byType.incompleteReason,
        byLocation.incompleteReason,
        byResourceGroup.incompleteReason
      ].filter((reason): reason is string => reason !== null)
    }
  };
}

export async function getResourceConfiguration(
  client: ResourceGraphClient,
  resourceId: string
): Promise<ResourceConfiguration | null> {
  const subscriptionId = subscriptionIdFromResourceId(resourceId);
  const page = await client.query({
    subscriptions: [subscriptionId],
    query: `
Resources
| where id =~ ${kqlString(resourceId)}
| project id, name, type=tolower(type), location, resourceGroup, subscriptionId,
    tags, kind, sku, identity, managedBy, zones, properties
| order by id asc`,
    pageSize: 2
  });
  const row = page.data[0];
  if (!row) {
    return null;
  }

  const parsed = resourceConfigurationSchema.parse(row);
  const sanitized = redactSensitiveValues(parsed) as Record<string, unknown>;
  return {
    resource: sanitized,
    findings: analyzeGenericConfiguration({
      type: parsed.type,
      tags: parsed.tags,
      identity: parsed.identity,
      properties: parsed.properties
    })
  };
}

async function summarize(
  client: ResourceGraphClient,
  subscriptionId: string,
  where: string,
  expression: string
): Promise<{
  counts: Record<string, number>;
  complete: boolean;
  incompleteReason: string | null;
}> {
  const result = await client.queryAll({
    subscriptions: [subscriptionId],
    query: `
Resources
${where}
| summarize count=count() by key=${expression}
| order by key asc`,
    pageSize: 1_000
  });

  const counts = Object.fromEntries(
    result.data.map((row) => {
      const parsed = countRowSchema.parse(row);
      return [parsed.key || "(none)", parsed.count];
    })
  );
  return { counts, complete: result.complete, incompleteReason: result.incompleteReason };
}

function buildFilters(filters: InventoryFilters): string {
  const clauses: string[] = [];
  if (filters.resourceGroup) {
    clauses.push(`resourceGroup =~ ${kqlString(filters.resourceGroup)}`);
  }
  if (filters.resourceType) {
    clauses.push(`type =~ ${kqlString(filters.resourceType)}`);
  }
  if (filters.location) {
    clauses.push(`location =~ ${kqlString(filters.location)}`);
  }
  if (filters.nameContains) {
    clauses.push(`name contains ${kqlString(filters.nameContains)}`);
  }
  return clauses.length ? `| where ${clauses.join(" and ")}` : "";
}

function subscriptionIdFromResourceId(resourceId: string): string {
  const match = resourceId.match(/^\/subscriptions\/([^/]+)\//i);
  if (!match?.[1]) {
    throw new Error("resourceId must begin with /subscriptions/{subscriptionId}/");
  }
  return match[1];
}

function resourceCategory(type: string): string {
  const namespace = type.split("/", 1)[0]?.toLowerCase();
  const categories: Record<string, string> = {
    "microsoft.compute": "compute",
    "microsoft.network": "network",
    "microsoft.storage": "storage",
    "microsoft.keyvault": "keyvault",
    "microsoft.web": "app-platform",
    "microsoft.containerservice": "containers",
    "microsoft.containerregistry": "containers",
    "microsoft.app": "containers",
    "microsoft.sql": "database",
    "microsoft.dbforpostgresql": "database",
    "microsoft.dbformysql": "database",
    "microsoft.documentdb": "database",
    "microsoft.cache": "database",
    "microsoft.servicebus": "messaging",
    "microsoft.eventhub": "messaging",
    "microsoft.insights": "monitoring",
    "microsoft.operationalinsights": "monitoring",
    "microsoft.recoveryservices": "backup",
    "microsoft.dataprotection": "backup",
    "microsoft.cognitiveservices": "ai",
    "microsoft.search": "ai"
  };
  return namespace ? (categories[namespace] ?? "other") : "other";
}
