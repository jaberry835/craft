import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { ArmReadClient } from "../src/azure/arm.js";
import type { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import { loadCloudProfile, type CloudProfile } from "../src/cloud/profile.js";
import { loadConfig } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { ScanManager } from "../src/scan/orchestrator.js";
import { InMemoryScanStore } from "../src/scan/store.js";

const subscriptionId = "11111111-1111-1111-1111-111111111111";
let cloud: CloudProfile;

class FakeCredential implements TokenCredential {
  async getToken(): Promise<AccessToken> {
    return { token: "test", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

beforeAll(async () => {
  cloud = await loadCloudProfile(resolve(process.cwd(), "cloud-profiles", "azurecloud.json"));
});

describe("scan MCP contracts", () => {
  it("starts, polls, and retrieves a stable paged section", async () => {
    const manager = new ScanManager({
      store: new InMemoryScanStore({
        ttlMilliseconds: 60_000,
        maximumScans: 10,
        maximumScansPerCaller: 5,
        maximumBytes: 1_000_000
      }),
      resourceGraph: {} as ResourceGraphClient,
      arm: {} as ArmReadClient,
      listSubscriptions: async () => [],
      nistInitiativeIds: new Set(),
      nistNamePatterns: [],
      concurrency: 1,
      sectionRunners: {
        inventory: async () => ({
          data: {
            resources: [
              { id: "/one", name: "one", type: "microsoft.storage/storageaccounts", resourceGroup: "rg-one" },
              { id: "/two", name: "two", type: "microsoft.compute/virtualmachines", resourceGroup: "rg-two" }
            ]
          },
          itemCount: 2
        })
      }
    });
    const app = createApplication({
      config: loadConfig({ AZURE_TENANT_ID: "tenant-one" }),
      resolvedCloud: {
        profile: cloud,
        discovery: { attempted: true, succeeded: true }
      },
      capabilities: {
        resourceManager: { status: "available", detail: "test" },
        resourceGraphProvider: { status: "available", detail: "test" }
      },
      credential: new FakeCredential(),
      resourceGraph: {} as ResourceGraphClient,
      scanManager: manager,
      listSubscriptions: async () => []
    });
    await initialize(app);

    const started = parse(await call(app, "start_scan", { subscriptionId }));
    expect(started.result.structuredContent).toMatchObject({
      tool: "start_scan",
      summary: { state: expect.stringMatching(/queued|running/) }
    });
    const scanId = String(started.result.structuredContent.summary.scanId);
    await manager.waitFor(scanId);

    const status = parse(await call(app, "get_scan_status", { scanId }));
    expect(status.result.structuredContent).toMatchObject({
      tool: "get_scan_status",
      summary: {
        scanId,
        state: "completed",
        completedSections: 1,
        totalSections: 1,
        percentComplete: 100
      },
      data: [{ name: "inventory", state: "completed", itemCount: 2 }]
    });

    const result = parse(await call(app, "get_scan_result", {
      scanId,
      section: "inventory",
      resourceType: "microsoft.storage/storageaccounts",
      pageSize: 1
    }));
    expect(result.result.structuredContent).toMatchObject({
      tool: "get_scan_result",
      summary: {
        scanId,
        section: "inventory",
        matchedItemCount: 1
      },
      data: {
        items: [{ id: "/one", name: "one" }]
      },
      page: { returned: 1, total: 1 }
    });
  });
});

type App = ReturnType<typeof createApplication>;
interface McpResponse {
  result: {
    structuredContent: {
      tool: string;
      summary: Record<string, unknown>;
      data: unknown;
      page: unknown;
    };
  };
}

async function initialize(app: App): Promise<void> {
  await request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "scan-test", version: "1.0.0" }
      }
    })
    .expect(200);
}

async function call(app: App, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args }
    })
    .expect(200);
  return response.text;
}

function parse(text: string): McpResponse {
  const raw = text.startsWith("event:")
    ? text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim()
    : text;
  if (!raw) throw new Error("Missing MCP response");
  return JSON.parse(raw) as McpResponse;
}
