import { describe, expect, it } from "vitest";
import { analyzeGenericConfiguration } from "../src/analyzers/generic.js";
import { redactSensitiveValues } from "../src/security/redact.js";

describe("generic resource analyzer", () => {
  it("reports explicit insecure configuration as failures", () => {
    const findings = analyzeGenericConfiguration({
      type: "microsoft.storage/storageaccounts",
      tags: { owner: "platform" },
      properties: {
        publicNetworkAccess: "Enabled",
        minimumTlsVersion: "TLS1_0",
        httpsOnly: false,
        allowSharedKeyAccess: true,
        privateEndpointConnections: []
      }
    });

    expect(findings.find((finding) => finding.checkId === "generic.public-network-access"))
      .toMatchObject({ status: "fail", severity: "high" });
    expect(findings.find((finding) => finding.checkId === "generic.minimum-tls-version"))
      .toMatchObject({ status: "fail" });
    expect(findings.find((finding) => finding.checkId === "generic.local-auth-disabled"))
      .toMatchObject({ status: "fail" });
    expect(findings.find((finding) => finding.checkId === "generic.governance-tags"))
      .toMatchObject({
        status: "fail",
        evidence: { missingTags: ["environment", "dataClassification"] }
      });
  });

  it("uses unknown rather than guessing when a property is absent", () => {
    const findings = analyzeGenericConfiguration({
      type: "microsoft.example/widgets",
      properties: {}
    });

    expect(findings.find((finding) => finding.checkId === "generic.minimum-tls-version"))
      .toMatchObject({ status: "unknown" });
    expect(findings.find((finding) => finding.checkId === "generic.managed-identity"))
      .toMatchObject({ status: "unknown" });
  });

  it("redacts sensitive-looking configuration recursively", () => {
    expect(
      redactSensitiveValues({
        connectionString: "sensitive",
        nested: { clientSecret: "sensitive", harmless: "visible" }
      })
    ).toEqual({
      connectionString: "[REDACTED]",
      nested: { clientSecret: "[REDACTED]", harmless: "visible" }
    });
  });
});
