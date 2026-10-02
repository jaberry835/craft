import { describe, expect, it } from "vitest";
import { analyzeNsgRules } from "../src/analyzers/network.js";

describe("NSG exposure analyzer", () => {
  it("flags internet access to all ports", () => {
    const findings = analyzeNsgRules("/nsg/one", [
      {
        name: "allow-everything",
        direction: "Inbound",
        access: "Allow",
        sourceAddressPrefix: "0.0.0.0/0",
        destinationPortRange: "*",
        priority: 100
      }
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "network.nsg.internet-allow-all",
        severity: "high",
        resourceId: "/nsg/one"
      })
    ]);
  });

  it("flags management ports contained in ranges", () => {
    const findings = analyzeNsgRules("/nsg/two", [
      {
        name: "remote-admin",
        direction: "Inbound",
        access: "Allow",
        sourceAddressPrefix: "Internet",
        destinationPortRange: "20-23"
      }
    ]);

    expect(findings[0]).toMatchObject({
      checkId: "network.nsg.management-port-from-internet",
      evidence: {
        exposedPorts: [{ port: 22, service: "SSH" }]
      }
    });
  });

  it("does not flag outbound, deny, or private-source rules", () => {
    const findings = analyzeNsgRules("/nsg/three", [
      {
        name: "outbound",
        direction: "Outbound",
        access: "Allow",
        sourceAddressPrefix: "Internet",
        destinationPortRange: "*"
      },
      {
        name: "deny-rdp",
        direction: "Inbound",
        access: "Deny",
        sourceAddressPrefix: "Internet",
        destinationPortRange: "3389"
      },
      {
        name: "private-ssh",
        direction: "Inbound",
        access: "Allow",
        sourceAddressPrefix: "10.0.0.0/8",
        destinationPortRange: "22"
      }
    ]);

    expect(findings).toEqual([]);
  });
});
