import { describe, expect, it, vi } from "vitest";
import type { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import {
  buildNistEvidence,
  collectNistControls,
  collectNistStatus
} from "../src/collectors/nist.js";
import type { ArmReadClient } from "../src/azure/arm.js";
import {
  matchesConfiguredNist,
  normalizeControlId
} from "../src/nist/mapping.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";
const initiativeId = "179d1daa-458f-4e47-8086-2a68d0d6c38f";
const options = {
  initiativeIds: new Set([initiativeId]),
  namePatterns: ["NIST SP 800-53 Rev. 5"]
};

describe("NIST mapping and collectors", () => {
  it("matches configurable IDs and air-gap-friendly standard names", () => {
    expect(matchesConfiguredNist(
      [`/providers/Microsoft.Authorization/policySetDefinitions/${initiativeId}`],
      options.initiativeIds,
      []
    )).toBe(true);
    expect(matchesConfiguredNist(
      ["NIST_SP_800-53_Rev_5"],
      new Set(),
      options.namePatterns
    )).toBe(true);
    expect(normalizeControlId("SC_7 (3)")).toBe("SC-7(3)");
  });

  it("detects Defender and policy sources and parses resource-level assessments", async () => {
    const standardId = `/subscriptions/${subscriptionId}/providers/Microsoft.Security/regulatoryComplianceStandards/NIST_SP_800-53_Rev_5`;
    const controlId = `${standardId}/regulatoryComplianceControls/SC-7`;
    const graph = fakeGraph((query) => {
      if (query.includes("SecurityResources")) return [
        {
          id: standardId,
          name: "NIST_SP_800-53_Rev_5",
          type: "microsoft.security/regulatorycompliancestandards",
          properties: {
            displayName: "NIST SP 800-53 Rev. 5",
            state: "Failed",
            passedControls: 1,
            failedControls: 1,
            timestamp: "2026-09-29T20:00:00Z"
          }
        },
        {
          id: controlId,
          name: "SC-7",
          type: "microsoft.security/regulatorycompliancestandards/regulatorycompliancecontrols",
          properties: {
            description: "Boundary Protection",
            state: "Failed",
            passedAssessments: 0,
            failedAssessments: 1
          }
        },
        {
          id: `${controlId}/regulatoryComplianceAssessments/assessment-key`,
          name: "assessment-key",
          type: "microsoft.security/regulatorycompliancestandards/regulatorycompliancecontrols/regulatorycomplianceassessments",
          properties: { assessmentId: "assessment-key", state: "Failed" }
        },
        {
          id: "/securityAssessment/resource-one",
          name: "assessment-key",
          type: "microsoft.security/assessments",
          properties: {
            status: { code: "Unhealthy" },
            resourceDetails: { id: "/resource/one" }
          }
        }
      ];
      if (query.includes("policyassignments")) return [{
        id: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyAssignments/nist`,
        name: "nist",
        properties: {
          displayName: "NIST SP 800-53 Rev. 5",
          policyDefinitionId: `/providers/Microsoft.Authorization/policySetDefinitions/${initiativeId}`,
          scope: `/subscriptions/${subscriptionId}`
        }
      }];
      return [];
    });

    const status = await collectNistStatus(graph, subscriptionId, options);
    expect(status).toMatchObject({
      enabled: true,
      availability: "available",
      source: "both",
      controlSummary: { failed: 1 }
    });

    const detail = await collectNistControls(graph, subscriptionId, options);
    expect(detail.controls[0]).toMatchObject({
      id: "SC-7",
      family: "SC",
      failedAssessments: 1,
      failedResources: ["/resource/one"]
    });
    expect(detail.controls[0]?.assessments[0]).toMatchObject({
      assessmentKey: "assessment-key",
      resourceId: "/resource/one"
    });
  });

  it("distinguishes disabled from unavailable", async () => {
    const disabled = await collectNistStatus(fakeGraph(() => []), subscriptionId, options);
    expect(disabled).toMatchObject({
      enabled: false,
      availability: "available",
      source: "none"
    });

    const unavailableGraph = {
      queryAll: vi.fn().mockRejectedValue(new Error("table unavailable"))
    } as unknown as ResourceGraphClient;
    const unavailable = await collectNistStatus(unavailableGraph, subscriptionId, options);
    expect(unavailable).toMatchObject({
      enabled: null,
      availability: "unavailable",
      source: "unknown"
    });
    expect(unavailable.access.notes.length).toBeGreaterThan(0);
  });

  it("combines Defender and analyzer evidence by control", async () => {
    const standardId = `/subscriptions/${subscriptionId}/providers/Microsoft.Security/regulatoryComplianceStandards/NIST_SP_800-53_Rev_5`;
    const graph = fakeGraph((query) => {
      if (query.includes("SecurityResources")) return [
        {
          id: standardId,
          name: "NIST_SP_800-53_Rev_5",
          type: "microsoft.security/regulatorycompliancestandards",
          properties: { displayName: "NIST SP 800-53 Rev. 5", state: "Failed" }
        },
        {
          id: `${standardId}/regulatoryComplianceControls/SC-7`,
          name: "SC-7",
          type: "microsoft.security/regulatorycompliancestandards/regulatorycompliancecontrols",
          properties: { state: "Failed", failedAssessments: 1 }
        }
      ];
      if (query.includes("PolicyResources")) return [];
      if (query.includes("microsoft.network/networksecuritygroups")) return [{
        id: "/network/nsg-one",
        name: "nsg-one",
        type: "microsoft.network/networksecuritygroups",
        subscriptionId,
        properties: {
          securityRules: [{
            name: "internet",
            properties: {
              direction: "Inbound",
              access: "Allow",
              sourceAddressPrefix: "Internet",
              destinationPortRange: "*"
            }
          }]
        }
      }];
      return [{
        id: "/storage/one",
        name: "one",
        type: "microsoft.storage/storageaccounts",
        subscriptionId,
        properties: {
          publicNetworkAccess: "Enabled",
          supportsHttpsTrafficOnly: false
        }
      }];
    });

    const result = await buildNistEvidence(
      graph,
      {} as ArmReadClient,
      subscriptionId,
      options
    );
    const sc7 = result.controls.find((control) => control.id === "SC-7");
    expect(sc7).toMatchObject({ defenderStatus: "failed" });
    expect(sc7?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: "network.nsg.internet-allow-all" })
    ]));
    expect(result.access.genericFindings).toBe("available");
    expect(result.access.networkFindings).toBe("available");
  });

  it("adds explicit identity gaps and Key Vault metadata evidence", async () => {
    const graph = fakeGraph(() => []);
    const result = await buildNistEvidence(
      graph,
      {} as ArmReadClient,
      subscriptionId,
      options,
      {
        identityPosture: async () => ({
          checks: [{
            id: "mfaRegistration",
            status: "denied",
            requiredPermissions: ["AuditLog.Read.All"],
            nistControls: ["IA-2(1)", "IA-2(2)"],
            summary: { count: 0 },
            data: [],
            notes: ["HTTP 403"]
          }]
        }),
        keyVaultMetadata: async () => ({
          checks: [{
            vaultId: "/vault/one",
            vaultName: "one",
            vaultUri: "https://one.vault.example.invalid",
            itemType: "key",
            status: "available",
            count: 1,
            notes: []
          }],
          items: [{
            vaultId: "/vault/one",
            vaultName: "one",
            vaultUri: "https://one.vault.example.invalid",
            itemType: "key",
            id: "https://one.vault.example.invalid/keys/key-one",
            name: "key-one",
            enabled: true,
            createdAt: null,
            updatedAt: null,
            notBefore: null,
            expiresAt: "2030-01-01T00:00:00.000Z",
            daysUntilExpiry: 365,
            tags: {},
            contentType: null,
            keyType: "RSA",
            keyOperations: ["sign"],
            rotationPolicy: { lifetimeActions: [{ action: { type: "Rotate" } }] },
            rotationPolicyStatus: "available",
            rotationPolicyNotes: [],
            certificatePolicy: null,
            certificatePolicyStatus: null,
            certificatePolicyNotes: []
          }]
        })
      }
    );

    const ia21 = result.controls.find((control) => control.id === "IA-2(1)");
    expect(ia21?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: "identity.mfaRegistration",
        evidenceGap: "identity data not accessible",
        requiredPermissions: ["AuditLog.Read.All"]
      })
    ]));
    const sc12 = result.controls.find((control) => control.id === "SC-12");
    expect(sc12?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: "keyvault.key-rotation-policy", status: "pass" })
    ]));
    expect(result.access).toMatchObject({
      identityPosture: "unavailable",
      keyVaultMetadata: "available"
    });
  });
});

function fakeGraph(rows: (query: string) => Array<Record<string, unknown>>): ResourceGraphClient {
  return {
    queryAll: vi.fn(async ({ query }: { query: string }) => ({
      data: rows(query),
      complete: true,
      incompleteReason: null
    }))
  } as unknown as ResourceGraphClient;
}
