import { describe, expect, it, vi } from "vitest";
import type { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import {
  collectPolicyAssignments,
  collectPolicyCompliance,
  collectRoleAssignments,
  collectSecurityPosture,
  collectTenantContext
} from "../src/collectors/governance.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";

describe("governance collectors", () => {
  it("combines direct and compliance-inferred inherited policy assignments", async () => {
    const client = fakeClient((query) => {
      if (query.includes("policyexemptions")) return [];
      if (query.includes("summarize assignmentName")) return [{
        assignmentId: "/providers/Microsoft.Management/managementGroups/root/providers/Microsoft.Authorization/policyAssignments/inherited",
        assignmentName: "inherited",
        assignmentScope: "/providers/Microsoft.Management/managementGroups/root",
        policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/policy-two"
      }];
      return [{
        id: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyAssignments/direct`,
        name: "direct",
        properties: {
          displayName: "Direct policy",
          scope: `/subscriptions/${subscriptionId}`,
          policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/policy-one",
          enforcementMode: "Default"
        }
      }];
    });

    const result = await collectPolicyAssignments(client, subscriptionId);

    expect(result.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "direct", inherited: false, discoveredFrom: "assignment" }),
      expect.objectContaining({ name: "inherited", inherited: true, discoveredFrom: "compliance" })
    ]));
  });

  it("summarizes compliance and preserves noncompliant resource detail", async () => {
    const client = fakeClient(() => [
      {
        id: "state-one",
        resourceId: "/resource/one",
        resourceType: "microsoft.storage/storageaccounts",
        resourceGroup: "rg-one",
        assignmentId: "/assignment/one",
        assignmentName: "one",
        assignmentScope: `/subscriptions/${subscriptionId}`,
        policyDefinitionId: "/definition/one",
        policyDefinitionName: "definition-one",
        complianceState: "NonCompliant",
        timestamp: "2026-09-29T00:00:00Z"
      },
      {
        id: "state-two",
        resourceId: "/resource/two",
        assignmentId: "/assignment/one",
        complianceState: "Compliant"
      }
    ]);

    const result = await collectPolicyCompliance(client, subscriptionId);

    expect(result.byState).toEqual({ noncompliant: 1, compliant: 1 });
    expect(result.byAssignment[0]).toMatchObject({ total: 2, nonCompliant: 1 });
    expect(result.resources[0]).toMatchObject({
      resourceId: "/resource/one",
      complianceState: "noncompliant"
    });
  });

  it("flags privileged RBAC roles and parses Defender posture", async () => {
    const roleClient = fakeClient(() => [{
      id: "/roleAssignment/one",
      name: "one",
      scope: `/subscriptions/${subscriptionId}`,
      principalId: "principal-one",
      principalType: "ServicePrincipal",
      roleDefinitionId: "/roleDefinition/owner",
      roleName: "Owner",
      roleType: "BuiltInRole",
      permissions: [{ actions: ["*"] }]
    }]);
    const roles = await collectRoleAssignments(roleClient, subscriptionId);
    expect(roles.assignments[0]).toMatchObject({
      roleName: "Owner",
      privileged: true
    });

    const securityClient = fakeClient(() => [
      {
        id: "/pricing/servers",
        name: "servers",
        type: "microsoft.security/pricings",
        properties: { pricingTier: "Standard", subPlan: "P2" }
      },
      {
        id: "/score/default",
        name: "default",
        type: "microsoft.security/securescores",
        properties: { score: { current: 40, max: 50, percentage: 0.8 } }
      },
      {
        id: "/assessment/one",
        name: "one",
        type: "microsoft.security/assessments",
        properties: {
          displayName: "Fix this",
          status: { code: "Unhealthy" },
          metadata: { severity: "High" },
          resourceDetails: { id: "/resource/one" }
        }
      }
    ]);
    const security = await collectSecurityPosture(securityClient, subscriptionId);
    expect(security.defenderPlans[0]).toMatchObject({ enabled: true, subPlan: "P2" });
    expect(security.secureScores[0]).toMatchObject({ current: 40, maximum: 50 });
    expect(security.unhealthyAssessments).toHaveLength(1);
  });

  it("recognizes privileged built-in role IDs when inherited definitions are unavailable", async () => {
    const client = fakeClient(() => [{
      id: "/roleAssignment/inherited-owner",
      name: "inherited-owner",
      scope: "/providers/Microsoft.Management/managementGroups/root",
      principalId: "principal-one",
      principalType: "ServicePrincipal",
      roleDefinitionId: "/providers/microsoft.authorization/roledefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
      roleName: "",
      roleType: "",
      permissions: null
    }]);

    const roles = await collectRoleAssignments(client, subscriptionId);

    expect(roles.assignments[0]).toMatchObject({
      roleName: "Owner",
      privileged: true,
      privilegedReason: "Built-in privileged role: Owner"
    });
  });

  it("returns partial tenant context when an ARG table is unavailable", async () => {
    const queryAll = vi.fn(async ({ query }: { query: string }) => {
      if (query.startsWith("ResourceContainers")) {
        return complete([{ id: "/mg/root", name: "root", displayName: "Root" }]);
      }
      throw new Error("AuthorizationFailed");
    });
    const result = await collectTenantContext(
      { queryAll } as unknown as ResourceGraphClient,
      [{ subscriptionId, displayName: "Workload", state: "Enabled", tenantId: "tenant" }]
    );
    expect(result.managementGroups).toHaveLength(1);
    expect(result.access.complete).toBe(false);
    expect(result.access.notes).toHaveLength(2);
  });
});

function fakeClient(rows: (query: string) => Array<Record<string, unknown>>): ResourceGraphClient {
  return {
    queryAll: vi.fn(async ({ query }: { query: string }) => complete(rows(query)))
  } as unknown as ResourceGraphClient;
}

function complete(data: Array<Record<string, unknown>>) {
  return { data, complete: true, incompleteReason: null };
}
