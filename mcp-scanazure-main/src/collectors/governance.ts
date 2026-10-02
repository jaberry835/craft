import type { AzureSubscription } from "../azure/subscriptions.js";
import type { ResourceGraphClient } from "../azure/resourceGraph.js";

export interface CollectionAccess {
  complete: boolean;
  notes: string[];
}

export interface PolicyAssignment {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  scope: string;
  policyDefinitionId: string | null;
  enforcementMode: string | null;
  parameters: Record<string, unknown>;
  notScopes: string[];
  inherited: boolean;
  discoveredFrom: "assignment" | "compliance";
  exemptions: Array<Record<string, unknown>>;
}

export interface PolicyComplianceResource {
  id: string;
  resourceId: string;
  resourceType: string | null;
  resourceGroup: string | null;
  assignmentId: string;
  assignmentName: string | null;
  assignmentScope: string | null;
  policyDefinitionId: string | null;
  policyDefinitionName: string | null;
  policyDefinitionReferenceId: string | null;
  complianceState: string;
  timestamp: string | null;
}

export interface RoleAssignment {
  id: string;
  name: string;
  scope: string;
  principalId: string | null;
  principalType: string | null;
  roleDefinitionId: string | null;
  roleName: string | null;
  roleType: string | null;
  condition: string | null;
  privileged: boolean;
  privilegedReason: string | null;
}

const PRIVILEGED_ROLE_NAMES = new Set([
  "owner",
  "contributor",
  "user access administrator",
  "role based access control administrator",
  "role based access control administrator (preview)"
]);
const PRIVILEGED_BUILT_IN_ROLES = new Map([
  ["8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "Owner"],
  ["b24988ac-6180-42a0-ab88-20f7382dd24c", "Contributor"],
  ["18d7d88d-d35e-4fb5-a5c3-7773c20a72d9", "User Access Administrator"],
  ["f58310d9-a9f6-439a-9e8d-f62e7b41a168", "Role Based Access Control Administrator"]
]);

export async function collectPolicyAssignments(
  client: ResourceGraphClient,
  subscriptionId: string
): Promise<{ assignments: PolicyAssignment[]; access: CollectionAccess }> {
  const [assignmentResult, stateResult, exemptionResult] = await Promise.all([
    client.queryAll({
      subscriptions: [subscriptionId],
      query: `
PolicyResources
| where type =~ 'microsoft.authorization/policyassignments'
| project id, name, properties
| order by id asc`,
      pageSize: 1_000
    }),
    client.queryAll({
      subscriptions: [subscriptionId],
      query: `
PolicyResources
| where type =~ 'microsoft.policyinsights/policystates'
| project assignmentId=tostring(properties.policyAssignmentId),
    assignmentName=tostring(properties.policyAssignmentName),
    assignmentScope=tostring(properties.policyAssignmentScope),
    policyDefinitionId=tostring(properties.policyDefinitionId)
| where isnotempty(assignmentId)
| summarize assignmentName=any(assignmentName), assignmentScope=any(assignmentScope),
    policyDefinitionId=any(policyDefinitionId) by assignmentId
| order by assignmentId asc`,
      pageSize: 1_000
    }),
    client.queryAll({
      subscriptions: [subscriptionId],
      query: `
PolicyResources
| where type =~ 'microsoft.authorization/policyexemptions'
| project id, name, properties
| order by id asc`,
      pageSize: 1_000
    })
  ]);

  const exemptions = exemptionResult.data.map(normalizeObject);
  const byAssignment = new Map<string, PolicyAssignment>();
  for (const row of assignmentResult.data) {
    const properties = object(row.properties);
    const id = text(row.id);
    if (!id) continue;
    const scope = text(properties.scope) ?? parentScope(id);
    byAssignment.set(id.toLowerCase(), {
      id,
      name: text(row.name) ?? id.split("/").pop() ?? id,
      displayName: text(properties.displayName),
      description: text(properties.description),
      scope,
      policyDefinitionId: text(properties.policyDefinitionId),
      enforcementMode: text(properties.enforcementMode),
      parameters: object(properties.parameters),
      notScopes: stringArray(properties.notScopes),
      inherited: isInherited(scope, subscriptionId),
      discoveredFrom: "assignment",
      exemptions: []
    });
  }

  for (const row of stateResult.data) {
    const id = text(row.assignmentId);
    if (!id || byAssignment.has(id.toLowerCase())) continue;
    const scope = text(row.assignmentScope) ?? parentScope(id);
    byAssignment.set(id.toLowerCase(), {
      id,
      name: text(row.assignmentName) ?? id.split("/").pop() ?? id,
      displayName: null,
      description: null,
      scope,
      policyDefinitionId: text(row.policyDefinitionId),
      enforcementMode: null,
      parameters: {},
      notScopes: [],
      inherited: isInherited(scope, subscriptionId),
      discoveredFrom: "compliance",
      exemptions: []
    });
  }

  for (const assignment of byAssignment.values()) {
    assignment.exemptions = exemptions.filter((exemption) => {
      const properties = object(exemption.properties);
      return stringArray(properties.policyAssignmentReferenceIds).some(
        (value) => value.toLowerCase() === assignment.id.toLowerCase()
      ) || text(properties.policyAssignmentId)?.toLowerCase() === assignment.id.toLowerCase();
    });
  }

  const results = [assignmentResult, stateResult, exemptionResult];
  return {
    assignments: [...byAssignment.values()].sort((a, b) => a.id.localeCompare(b.id)),
    access: accessFromResults(results)
  };
}

export async function collectPolicyCompliance(
  client: ResourceGraphClient,
  subscriptionId: string
): Promise<{
  resources: PolicyComplianceResource[];
  byAssignment: Array<Record<string, unknown>>;
  byState: Record<string, number>;
  access: CollectionAccess;
}> {
  const result = await client.queryAll({
    subscriptions: [subscriptionId],
    query: `
PolicyResources
| where type =~ 'microsoft.policyinsights/policystates'
| project id, resourceId=tostring(properties.resourceId),
    resourceType=tostring(properties.resourceType),
    resourceGroup=tostring(properties.resourceGroup),
    assignmentId=tostring(properties.policyAssignmentId),
    assignmentName=tostring(properties.policyAssignmentName),
    assignmentScope=tostring(properties.policyAssignmentScope),
    policyDefinitionId=tostring(properties.policyDefinitionId),
    policyDefinitionName=tostring(properties.policyDefinitionName),
    policyDefinitionReferenceId=tostring(properties.policyDefinitionReferenceId),
    complianceState=tostring(properties.complianceState),
    timestamp=tostring(properties.timestamp)
| order by assignmentId asc, resourceId asc, id asc`,
    pageSize: 1_000
  });
  const resources = result.data.flatMap((row): PolicyComplianceResource[] => {
    const assignmentId = text(row.assignmentId);
    if (!assignmentId) return [];
    return [{
      id: text(row.id) ?? `${assignmentId}:${text(row.resourceId) ?? ""}`,
      resourceId: text(row.resourceId) ?? "",
      resourceType: text(row.resourceType),
      resourceGroup: text(row.resourceGroup),
      assignmentId,
      assignmentName: text(row.assignmentName),
      assignmentScope: text(row.assignmentScope),
      policyDefinitionId: text(row.policyDefinitionId),
      policyDefinitionName: text(row.policyDefinitionName),
      policyDefinitionReferenceId: text(row.policyDefinitionReferenceId),
      complianceState: normalizeComplianceState(text(row.complianceState)),
      timestamp: text(row.timestamp)
    }];
  });
  const byState = countBy(resources, (item) => item.complianceState);
  const assignmentMap = new Map<string, PolicyComplianceResource[]>();
  for (const item of resources) {
    const values = assignmentMap.get(item.assignmentId) ?? [];
    values.push(item);
    assignmentMap.set(item.assignmentId, values);
  }
  const byAssignment = [...assignmentMap.entries()].map(([assignmentId, values]) => ({
    assignmentId,
    assignmentName: values[0]?.assignmentName ?? null,
    assignmentScope: values[0]?.assignmentScope ?? null,
    total: values.length,
    byState: countBy(values, (item) => item.complianceState),
    nonCompliant: values.filter((item) => item.complianceState === "noncompliant").length
  })).sort((a, b) => String(a.assignmentId).localeCompare(String(b.assignmentId)));
  return {
    resources,
    byAssignment,
    byState,
    access: accessFromResults([result])
  };
}

export async function collectSecurityPosture(
  client: ResourceGraphClient,
  subscriptionId: string
): Promise<{
  defenderPlans: Array<Record<string, unknown>>;
  secureScores: Array<Record<string, unknown>>;
  unhealthyAssessments: Array<Record<string, unknown>>;
  access: CollectionAccess;
}> {
  const result = await client.queryAll({
    subscriptions: [subscriptionId],
    query: `
SecurityResources
| where type in~ (
    'microsoft.security/pricings',
    'microsoft.security/securescores',
    'microsoft.security/assessments')
| project id, name, type=tolower(type), subscriptionId, properties
| order by type asc, id asc`,
    pageSize: 1_000
  });
  const rows = result.data.map(normalizeObject);
  const defenderPlans = rows
    .filter((row) => text(row.type)?.endsWith("/pricings"))
    .map((row) => {
      const properties = object(row.properties);
      return {
        id: text(row.id) ?? "",
        name: text(row.name) ?? "",
        pricingTier: text(properties.pricingTier),
        subPlan: text(properties.subPlan),
        enabled: text(properties.pricingTier)?.toLowerCase() === "standard",
        extensions: Array.isArray(properties.extensions) ? properties.extensions : []
      };
    });
  const secureScores = rows
    .filter((row) => text(row.type)?.endsWith("/securescores"))
    .map((row) => {
      const properties = object(row.properties);
      const score = object(properties.score);
      return {
        id: text(row.id) ?? "",
        name: text(row.name) ?? "",
        displayName: text(properties.displayName),
        current: number(score.current),
        maximum: number(score.max),
        percentage: number(score.percentage),
        weight: number(properties.weight)
      };
    });
  const unhealthyAssessments = rows
    .filter((row) => text(row.type)?.endsWith("/assessments"))
    .flatMap((row) => {
      const properties = object(row.properties);
      const status = object(properties.status);
      if ((text(status.code) ?? "").toLowerCase() !== "unhealthy") return [];
      const resourceDetails = object(properties.resourceDetails);
      return [{
        id: text(row.id) ?? "",
        name: text(row.name) ?? "",
        displayName: text(properties.displayName),
        severity: text(object(properties.metadata).severity),
        status: text(status.code) ?? "Unhealthy",
        statusCause: text(status.cause),
        statusDescription: text(status.description),
        resourceId: text(resourceDetails.id) ?? text(properties.resourceId),
        remediationDescription: text(properties.remediationDescription)
      }];
    });
  return {
    defenderPlans,
    secureScores,
    unhealthyAssessments,
    access: accessFromResults([result])
  };
}

export async function collectRoleAssignments(
  client: ResourceGraphClient,
  subscriptionId: string
): Promise<{ assignments: RoleAssignment[]; access: CollectionAccess }> {
  const result = await client.queryAll({
    subscriptions: [subscriptionId],
    query: `
AuthorizationResources
| where type =~ 'microsoft.authorization/roleassignments'
| extend roleDefinitionId=tolower(tostring(properties.roleDefinitionId))
| join kind=leftouter (
    AuthorizationResources
    | where type =~ 'microsoft.authorization/roledefinitions'
    | project roleDefinitionId=tolower(id), roleName=tostring(properties.roleName),
        roleType=tostring(properties.type), permissions=properties.permissions
  ) on roleDefinitionId
| project id, name, scope=tostring(properties.scope),
    principalId=tostring(properties.principalId),
    principalType=tostring(properties.principalType), roleDefinitionId,
    roleName, roleType, condition=tostring(properties.condition), permissions
| order by id asc`,
    pageSize: 1_000
  });
  const assignments = result.data.flatMap((row): RoleAssignment[] => {
    const id = text(row.id);
    if (!id) return [];
    const roleDefinitionId = text(row.roleDefinitionId);
    const builtInRoleName = builtInRoleNameFromId(roleDefinitionId);
    const roleName = text(row.roleName) ?? builtInRoleName;
    const wildcard = JSON.stringify(row.permissions ?? "").includes('"*"');
    const privileged = builtInRoleName !== null ||
      PRIVILEGED_ROLE_NAMES.has((roleName ?? "").toLowerCase()) || wildcard;
    return [{
      id,
      name: text(row.name) ?? id.split("/").pop() ?? id,
      scope: text(row.scope) ?? parentScope(id),
      principalId: text(row.principalId),
      principalType: text(row.principalType),
      roleDefinitionId,
      roleName,
      roleType: text(row.roleType),
      condition: text(row.condition),
      privileged,
      privilegedReason: builtInRoleName !== null ||
        PRIVILEGED_ROLE_NAMES.has((roleName ?? "").toLowerCase())
        ? `Built-in privileged role: ${roleName}`
        : wildcard ? "Role definition includes wildcard actions" : null
    }];
  });
  return { assignments, access: accessFromResults([result]) };
}

function builtInRoleNameFromId(roleDefinitionId: string | null): string | null {
  const roleId = roleDefinitionId?.split("/").pop()?.toLowerCase();
  return roleId ? (PRIVILEGED_BUILT_IN_ROLES.get(roleId) ?? null) : null;
}

export async function collectTenantContext(
  client: ResourceGraphClient,
  subscriptions: AzureSubscription[]
): Promise<{
  managementGroups: Array<Record<string, unknown>>;
  subscriptions: AzureSubscription[];
  policyAssignments: Array<Record<string, unknown>>;
  roleAssignments: Array<Record<string, unknown>>;
  access: CollectionAccess;
}> {
  if (subscriptions.length === 0) {
    return {
      managementGroups: [],
      subscriptions,
      policyAssignments: [],
      roleAssignments: [],
      access: { complete: false, notes: ["No visible subscriptions are available to anchor tenant Resource Graph queries"] }
    };
  }
  const ids = subscriptions.map((item) => item.subscriptionId).filter(isSubscriptionId);
  if (ids.length === 0) {
    return {
      managementGroups: [],
      subscriptions,
      policyAssignments: [],
      roleAssignments: [],
      access: { complete: false, notes: ["Visible subscriptions did not contain Resource Graph-compatible IDs"] }
    };
  }
  const queries = [
    `ResourceContainers
| where type =~ 'microsoft.management/managementgroups'
| project id, name, displayName=tostring(properties.displayName),
    parentId=tostring(properties.details.parent.id), tenantId
| order by id asc`,
    `PolicyResources
| where type =~ 'microsoft.authorization/policyassignments'
| where id startswith '/providers/Microsoft.Management/managementGroups/'
| project id, name, properties
| order by id asc`,
    `AuthorizationResources
| where type =~ 'microsoft.authorization/roleassignments'
| where id startswith '/providers/Microsoft.Management/managementGroups/'
| project id, name, properties
| order by id asc`
  ];
  const values: Array<Array<Record<string, unknown>>> = [[], [], []];
  const notes: string[] = [];
  await Promise.all(queries.map(async (query, index) => {
    try {
      const result = await client.queryAll({ subscriptions: ids, query, pageSize: 1_000 });
      values[index] = result.data.map(normalizeObject);
      if (!result.complete) notes.push(result.incompleteReason ?? `Tenant query ${index + 1} was incomplete`);
    } catch (error) {
      notes.push(`Tenant query ${index + 1} unavailable: ${message(error)}`);
    }
  }));
  return {
    managementGroups: values[0] ?? [],
    subscriptions,
    policyAssignments: values[1] ?? [],
    roleAssignments: values[2] ?? [],
    access: { complete: notes.length === 0, notes }
  };
}

function accessFromResults(results: Array<{ complete: boolean; incompleteReason: string | null }>): CollectionAccess {
  return {
    complete: results.every((result) => result.complete),
    notes: results.flatMap((result) => result.incompleteReason ? [result.incompleteReason] : [])
  };
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return object(value);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function parentScope(id: string): string {
  const marker = id.toLowerCase().lastIndexOf("/providers/microsoft.authorization/");
  return marker > 0 ? id.slice(0, marker) : "/";
}
function isInherited(scope: string, subscriptionId: string): boolean {
  return !scope.toLowerCase().startsWith(`/subscriptions/${subscriptionId.toLowerCase()}`);
}
function normalizeComplianceState(value: string | null): string {
  return (value ?? "unknown").replace(/\s+/g, "").toLowerCase();
}
function countBy<T>(values: T[], selector: (value: T) => string): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
function isSubscriptionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
