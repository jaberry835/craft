import { describe, expect, it } from "vitest";
import { analyzeServiceConfiguration } from "../src/analyzers/service.js";

describe("service-specific analyzers", () => {
  it("detects insecure storage settings", () => {
    const findings = analyzeServiceConfiguration({
      id: "/storage/one",
      name: "one",
      type: "microsoft.storage/storageaccounts",
      properties: {
        allowBlobPublicAccess: true,
        allowSharedKeyAccess: true,
        supportsHttpsTrafficOnly: false,
        minimumTlsVersion: "TLS1_0"
      }
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "storage.blob-public-access-disabled",
          status: "fail"
        }),
        expect.objectContaining({
          checkId: "storage.minimum-tls",
          status: "fail"
        })
      ])
    );
  });

  it("detects AKS identity and network controls", () => {
    const findings = analyzeServiceConfiguration({
      id: "/aks/one",
      name: "one",
      type: "microsoft.containerservice/managedclusters",
      properties: {
        disableLocalAccounts: true,
        apiServerAccessProfile: { enablePrivateCluster: true },
        networkProfile: { networkPolicy: "azure" },
        aadProfile: { managed: true }
      }
    });

    expect(findings.every((finding) => finding.status === "pass")).toBe(true);
  });

  it("uses unknown for absent backup soft-delete data", () => {
    const findings = analyzeServiceConfiguration({
      id: "/backup/one",
      name: "one",
      type: "microsoft.recoveryservices/vaults",
      properties: {}
    });

    expect(findings.find((finding) => finding.checkId === "backup.soft-delete"))
      .toMatchObject({ status: "unknown" });
  });
});
