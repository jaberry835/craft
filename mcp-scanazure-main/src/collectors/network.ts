import { z } from "zod";
import { analyzeNsgRules, type NetworkFinding, type NsgRule } from "../analyzers/network.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";

const networkResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  location: z.string().nullable().optional(),
  resourceGroup: z.string().nullable().optional(),
  subscriptionId: z.string(),
  properties: z.record(z.string(), z.unknown()).nullable().optional(),
  sku: z.unknown().optional(),
  zones: z.array(z.string()).nullable().optional()
});

export type NetworkResource = z.infer<typeof networkResourceSchema>;

export interface NetworkEndpoint {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  endpointType: "ip" | "fqdn";
  value: string;
  exposure: "public" | "private" | "restricted" | "unknown";
  source: string;
  associatedResourceId: string | null;
}

export interface NetworkInventory {
  resources: NetworkResource[];
  findings: NetworkFinding[];
  endpoints: NetworkEndpoint[];
  summary: {
    totalResources: number;
    byType: Record<string, number>;
    vnetCount: number;
    subnetCount: number;
    peeringCount: number;
    nsgCount: number;
    publicIpCount: number;
    privateEndpointCount: number;
    publicEndpointCount: number;
    privateEndpointAddressCount: number;
    highSeverityFindingCount: number;
    complete: boolean;
    incompleteReasons: string[];
  };
}

const NETWORK_TYPES = [
  "microsoft.network/virtualnetworks",
  "microsoft.network/networksecuritygroups",
  "microsoft.network/publicipaddresses",
  "microsoft.network/privateendpoints",
  "microsoft.network/privatednszones",
  "microsoft.network/privatednszones/virtualnetworklinks",
  "microsoft.network/routetables",
  "microsoft.network/natgateways",
  "microsoft.network/networkinterfaces",
  "microsoft.network/loadbalancers",
  "microsoft.network/applicationgateways",
  "microsoft.network/azurefirewalls",
  "microsoft.network/firewallpolicies",
  "microsoft.network/ddosprotectionplans",
  "microsoft.network/virtualnetworkgateways",
  "microsoft.network/localnetworkgateways",
  "microsoft.network/connections",
  "microsoft.network/expressroutecircuits",
  "microsoft.network/bastionhosts",
  "microsoft.network/virtualhubs",
  "microsoft.network/virtualwans",
  "microsoft.cdn/profiles",
  "microsoft.cdn/profiles/endpoints",
  "microsoft.cdn/profiles/afdendpoints"
] as const;

const NETWORK_QUERY = `
Resources
| where tolower(type) in (${NETWORK_TYPES.map((type) => `'${type}'`).join(", ")})
| project id, name, type=tolower(type), location, resourceGroup, subscriptionId,
    properties, sku, zones
| order by id asc`;

const ENDPOINT_QUERY = `
Resources
| where type =~ 'microsoft.network/publicipaddresses'
    or type =~ 'microsoft.network/privateendpoints'
    or isnotempty(properties.publicNetworkAccess)
    or isnotempty(properties.defaultHostName)
    or isnotempty(properties.hostNameSslStates)
    or isnotempty(properties.fullyQualifiedDomainName)
    or isnotempty(properties.hostName)
    or isnotempty(properties.endpoint)
    or isnotempty(properties.primaryEndpoints)
    or isnotempty(properties.vaultUri)
    or isnotempty(properties.loginServer)
| project id, name, type=tolower(type), location, resourceGroup, subscriptionId,
    properties, sku, zones
| order by id asc`;

export async function collectNetworkInventory(
  client: ResourceGraphClient,
  subscriptionId: string
): Promise<NetworkInventory> {
  const result = await client.queryAll<NetworkResource>({
    subscriptions: [subscriptionId],
    query: NETWORK_QUERY,
    pageSize: 1_000
  });
  const resources = result.data.map((resource) => networkResourceSchema.parse(resource));
  const findings = resources.flatMap(analyzeNetworkResource);
  const endpoints = deduplicateEndpoints(resources.flatMap(extractNetworkEndpoints));
  const byType = countBy(resources, (resource) => resource.type);

  return {
    resources,
    findings,
    endpoints,
    summary: {
      totalResources: resources.length,
      byType,
      vnetCount: byType["microsoft.network/virtualnetworks"] ?? 0,
      subnetCount: resources.reduce(
        (count, resource) =>
          count + arrayValue(resource.properties?.subnets).length,
        0
      ),
      peeringCount: resources.reduce(
        (count, resource) =>
          count + arrayValue(resource.properties?.virtualNetworkPeerings).length,
        0
      ),
      nsgCount: byType["microsoft.network/networksecuritygroups"] ?? 0,
      publicIpCount: byType["microsoft.network/publicipaddresses"] ?? 0,
      privateEndpointCount: byType["microsoft.network/privateendpoints"] ?? 0,
      publicEndpointCount: endpoints.filter((endpoint) => endpoint.exposure === "public")
        .length,
      privateEndpointAddressCount: endpoints.filter(
        (endpoint) => endpoint.exposure === "private"
      ).length,
      highSeverityFindingCount: findings.filter(
        (finding) => finding.severity === "high"
      ).length,
      complete: result.complete,
      incompleteReasons: result.incompleteReason ? [result.incompleteReason] : []
    }
  };
}

export async function collectNetworkEndpoints(
  client: ResourceGraphClient,
  subscriptionId: string
): Promise<{
  endpoints: NetworkEndpoint[];
  complete: boolean;
  incompleteReasons: string[];
}> {
  const result = await client.queryAll<NetworkResource>({
    subscriptions: [subscriptionId],
    query: ENDPOINT_QUERY,
    pageSize: 1_000
  });
  const resources = result.data.map((resource) => networkResourceSchema.parse(resource));
  return {
    endpoints: deduplicateEndpoints(resources.flatMap(extractNetworkEndpoints)),
    complete: result.complete,
    incompleteReasons: result.incompleteReason ? [result.incompleteReason] : []
  };
}

function analyzeNetworkResource(resource: NetworkResource): NetworkFinding[] {
  if (resource.type !== "microsoft.network/networksecuritygroups") {
    return [];
  }
  const rules = [
    ...arrayValue(resource.properties?.securityRules),
    ...arrayValue(resource.properties?.defaultSecurityRules)
  ]
    .map(normalizeNsgRule)
    .filter((rule): rule is NsgRule => rule !== null);
  return analyzeNsgRules(resource.id, rules);
}

function normalizeNsgRule(value: unknown): NsgRule | null {
  const object = objectValue(value);
  if (!object) {
    return null;
  }
  const properties = objectValue(object.properties) ?? object;
  const name = stringValue(object.name) ?? stringValue(properties.name);
  if (!name) {
    return null;
  }
  return {
    name,
    ...optionalString("direction", properties.direction),
    ...optionalString("access", properties.access),
    ...optionalNumber("priority", properties.priority),
    ...optionalString("protocol", properties.protocol),
    ...optionalString("sourceAddressPrefix", properties.sourceAddressPrefix),
    ...optionalStringArray("sourceAddressPrefixes", properties.sourceAddressPrefixes),
    ...optionalString("destinationAddressPrefix", properties.destinationAddressPrefix),
    ...optionalStringArray(
      "destinationAddressPrefixes",
      properties.destinationAddressPrefixes
    ),
    ...optionalString("destinationPortRange", properties.destinationPortRange),
    ...optionalStringArray("destinationPortRanges", properties.destinationPortRanges)
  };
}

function extractNetworkEndpoints(resource: NetworkResource): NetworkEndpoint[] {
  const properties = resource.properties ?? {};
  const endpoints: NetworkEndpoint[] = [];
  const publicNetworkAccess = stringValue(properties.publicNetworkAccess);
  const restricted = publicNetworkAccess
    ? /^disabled$/i.test(publicNetworkAccess)
      ? "private"
      : hasNetworkRestrictions(properties)
        ? "restricted"
        : "public"
    : "unknown";

  if (resource.type === "microsoft.network/publicipaddresses") {
    addEndpoint(
      endpoints,
      resource,
      "ip",
      stringValue(properties.ipAddress),
      "public",
      "properties.ipAddress",
      idValue(properties.ipConfiguration)
    );
    addEndpoint(
      endpoints,
      resource,
      "fqdn",
      stringValue(objectValue(properties.dnsSettings)?.fqdn),
      "public",
      "properties.dnsSettings.fqdn",
      idValue(properties.ipConfiguration)
    );
  }

  if (resource.type === "microsoft.network/privateendpoints") {
    for (const config of arrayValue(properties.customDnsConfigs)) {
      const customDns = objectValue(config);
      for (const ipAddress of stringArray(customDns?.ipAddresses)) {
        addEndpoint(
          endpoints,
          resource,
          "ip",
          ipAddress,
          "private",
          "properties.customDnsConfigs.ipAddresses",
          privateLinkTarget(properties)
        );
      }
      for (const fqdn of stringArray(customDns?.fqdn)) {
        addEndpoint(
          endpoints,
          resource,
          "fqdn",
          fqdn,
          "private",
          "properties.customDnsConfigs.fqdn",
          privateLinkTarget(properties)
        );
      }
    }
    for (const ipAddress of findValuesByKey(properties, "privateIPAddress")) {
      addEndpoint(
        endpoints,
        resource,
        "ip",
        ipAddress,
        "private",
        "properties.privateIPAddress",
        privateLinkTarget(properties)
      );
    }
  }

  const fqdnFields = [
    "defaultHostName",
    "fullyQualifiedDomainName",
    "hostName",
    "endpoint",
    "documentEndpoint",
    "vaultUri",
    "loginServer"
  ];
  for (const field of fqdnFields) {
    const value = stringValue(properties[field]);
    if (value && looksLikeHostname(value)) {
      addEndpoint(endpoints, resource, "fqdn", normalizeEndpointValue(value), restricted, `properties.${field}`, null);
    }
    const primaryEndpoints = objectValue(properties.primaryEndpoints);
    if (primaryEndpoints) {
      for (const [service, value] of Object.entries(primaryEndpoints)) {
        const endpoint = stringValue(value);
        if (endpoint && looksLikeHostname(endpoint)) {
          addEndpoint(
            endpoints,
            resource,
            "fqdn",
            normalizeEndpointValue(endpoint),
            restricted,
            `properties.primaryEndpoints.${service}`,
            null
          );
        }
      }
    }
  }
  for (const hostNameState of arrayValue(properties.hostNameSslStates)) {
    addEndpoint(
      endpoints,
      resource,
      "fqdn",
      stringValue(objectValue(hostNameState)?.name),
      restricted,
      "properties.hostNameSslStates.name",
      null
    );
  }

  return endpoints;
}

function addEndpoint(
  endpoints: NetworkEndpoint[],
  resource: NetworkResource,
  endpointType: "ip" | "fqdn",
  value: string | undefined,
  exposure: NetworkEndpoint["exposure"],
  source: string,
  associatedResourceId: string | null
): void {
  if (!value) {
    return;
  }
  endpoints.push({
    id: `${resource.id}|${endpointType}|${value}`.toLowerCase(),
    resourceId: resource.id,
    resourceName: resource.name,
    resourceType: resource.type,
    endpointType,
    value,
    exposure,
    source,
    associatedResourceId
  });
}

function privateLinkTarget(properties: Record<string, unknown>): string | null {
  for (const connection of [
    ...arrayValue(properties.privateLinkServiceConnections),
    ...arrayValue(properties.manualPrivateLinkServiceConnections)
  ]) {
    const target = idValue(objectValue(connection)?.properties);
    if (target) {
      return target;
    }
    const connectionProperties = objectValue(objectValue(connection)?.properties);
    const serviceId = stringValue(connectionProperties?.privateLinkServiceId);
    if (serviceId) {
      return serviceId;
    }
  }
  return null;
}

function hasNetworkRestrictions(properties: Record<string, unknown>): boolean {
  const networkAcls = objectValue(properties.networkAcls);
  return (
    /^deny$/i.test(stringValue(networkAcls?.defaultAction) ?? "") ||
    arrayValue(properties.ipSecurityRestrictions).length > 0 ||
    arrayValue(networkAcls?.ipRules).length > 0
  );
}

function findValuesByKey(value: unknown, targetKey: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => findValuesByKey(item, targetKey));
  }
  const object = objectValue(value);
  if (!object) {
    return [];
  }
  return Object.entries(object).flatMap(([key, item]) =>
    key.toLowerCase() === targetKey.toLowerCase()
      ? stringArray(item)
      : findValuesByKey(item, targetKey)
  );
}

function deduplicateEndpoints(endpoints: NetworkEndpoint[]): NetworkEndpoint[] {
  return [...new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])).values()].sort(
    (left, right) => left.id.localeCompare(right.id)
  );
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const current = key(value);
    counts[current] = (counts[current] ?? 0) + 1;
    return counts;
  }, {});
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function idValue(value: unknown): string | null {
  const object = objectValue(value);
  return stringValue(object?.id) ?? null;
}

function looksLikeHostname(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.hostname);
  } catch {
    return value.includes(".") && !value.includes(" ");
  }
}

function normalizeEndpointValue(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function optionalString<K extends string>(
  key: K,
  value: unknown
): Partial<Record<K, string>> {
  const parsed = stringValue(value);
  return parsed ? ({ [key]: parsed } as Record<K, string>) : {};
}

function optionalStringArray<K extends string>(
  key: K,
  value: unknown
): Partial<Record<K, string[]>> {
  const parsed = stringArray(value);
  return parsed.length ? ({ [key]: parsed } as Record<K, string[]>) : {};
}

function optionalNumber<K extends string>(
  key: K,
  value: unknown
): Partial<Record<K, number>> {
  return typeof value === "number" ? ({ [key]: value } as Record<K, number>) : {};
}
