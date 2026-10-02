import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { resolve } from "node:path";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCloudProfile, type CloudProfile } from "../src/cloud/profile.js";
import { loadConfig } from "../src/config.js";
import { createApplication } from "../src/server.js";
import { ResourceGraphClient } from "../src/azure/resourceGraph.js";
import { entraCallerIdentity } from "../src/scan/identity.js";

class FakeCredential implements TokenCredential {
  async getToken(_scopes: string | string[]): Promise<AccessToken> {
    return { token: "unused", expiresOnTimestamp: Date.now() + 60_000 };
  }
}

let cloud: CloudProfile;

beforeAll(async () => {
  cloud = await loadCloudProfile(
    resolve(process.cwd(), "cloud-profiles", "azurecloud.json")
  );
});

function createTestApp(environment: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    CORS_ALLOWED_ORIGINS: "https://spa.example.test",
    AZURE_TENANT_ID: "tenant-1",
    ...environment
  });
  return createApplication({
    config,
    resolvedCloud: {
      profile: cloud,
      discovery: { attempted: true, succeeded: true }
    },
    capabilities: {
      resourceManager: { status: "available", detail: "test" },
      resourceGraphProvider: { status: "available", detail: "test" }
    },
    credential: new FakeCredential(),
    resourceGraph: createFakeResourceGraph(),
    listSubscriptions: async () => [
      {
        subscriptionId: "sub-1",
        displayName: "Workload",
        state: "Enabled",
        tenantId: "tenant-1"
      }
    ]
  });
}

function createAuthenticatedTestApp(resolveRequest = false) {
  const config = loadConfig({
    AUTH_MODE: "obo",
    AZURE_TENANT_ID: "tenant-1",
    ENTRA_SERVER_CLIENT_ID: "server-client",
    ENTRA_ALLOWED_CLIENT_IDS: "spa-client",
    ENTRA_CLIENT_SECRET: "test-secret",
    ENTRA_RESOURCE_URI: "https://scanner.example.test",
    CORS_ALLOWED_ORIGINS: "https://spa.example.test"
  });
  return createApplication({
    config,
    resolvedCloud: {
      profile: cloud,
      discovery: { attempted: true, succeeded: true }
    },
    capabilities: {
      resourceManager: { status: "unknown", detail: "per caller" },
      resourceGraphProvider: { status: "unknown", detail: "per caller" }
    },
    resourceGraph: createFakeResourceGraph(),
    listSubscriptions: async () => [
      {
        subscriptionId: "sub-1",
        displayName: "Workload",
        state: "Enabled",
        tenantId: "tenant-1"
      }
    ],
    ...(resolveRequest
      ? {
          authenticatedRequestResolver: async () => ({
            caller: entraCallerIdentity("obo", "tenant-1", "object-1"),
            credential: new FakeCredential()
          })
        }
      : {})
  });
}

describe("HTTP server", () => {
  it("reports health and cloud discovery", async () => {
    const response = await request(createTestApp()).get("/healthz").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      authMode: "none",
      cloud: "AzureCloud",
      cloudDiscovery: { attempted: true, succeeded: true },
      capabilities: {
        resourceManager: { status: "available" },
        resourceGraphProvider: { status: "available" }
      }
    });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("rate limits repeated MCP requests with a JSON-RPC error", async () => {
    const app = createTestApp({
      MCP_RATE_LIMIT_WINDOW_SECONDS: "60",
      MCP_RATE_LIMIT_MAX_REQUESTS: "1"
    });
    await initializeMcp(app);

    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
      .expect(429);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32_029, message: "Too many MCP requests" },
      id: null
    });
  });

  it("allows configured CORS origins and answers preflight", async () => {
    const response = await request(createTestApp())
      .options("/mcp")
      .set("Origin", "https://spa.example.test")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type")
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://spa.example.test"
    );
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("rejects unconfigured browser origins", async () => {
    const response = await request(createTestApp())
      .get("/healthz")
      .set("Origin", "https://not-allowed.example.test")
      .expect(403);

    expect(response.body.error).toBe("RequestRejected");
  });

  it("publishes protected-resource metadata without requiring a token", async () => {
    const response = await request(createAuthenticatedTestApp())
      .get("/.well-known/oauth-protected-resource")
      .expect(200);

    expect(response.body).toEqual({
      resource: "https://scanner.example.test",
      authorization_servers: [
        "https://login.microsoftonline.com/tenant-1/v2.0"
      ],
      bearer_methods_supported: ["header"],
      scopes_supported: ["api://server-client/access_as_user"]
    });
  });

  it("returns a Bearer challenge when an authenticated MCP request has no token", async () => {
    const response = await request(createAuthenticatedTestApp())
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      })
      .expect(401);

    expect(response.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="https://scanner.example.test/.well-known/oauth-protected-resource"'
    );
    expect(response.body).toMatchObject({ error: "invalid_token" });
  });

  it("uses the authenticated caller and delegated credential for MCP tools", async () => {
    const app = createAuthenticatedTestApp(true);
    await initializeMcp(app, "Bearer validated-by-test-resolver");

    const response = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer validated-by-test-resolver")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_subscriptions", arguments: {} }
      })
      .expect(200);
    const payload = parseMcpResponse<TestMcpResponse>(response.text);

    expect(payload.result.structuredContent).toMatchObject({
      tenantId: "tenant-1",
      caller: { authMode: "obo" },
      summary: { total: 1 }
    });
  });

  it("initializes MCP and calls list_subscriptions with structured JSON", async () => {
    const app = createTestApp();
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
          clientInfo: { name: "test-client", version: "1.0.0" }
        }
      })
      .expect(200);

    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_subscriptions", arguments: {} }
      })
      .expect(200);

    const payload = parseMcpResponse<TestMcpResponse>(response.text);
    expect(payload.result.structuredContent).toMatchObject({
      tool: "list_subscriptions",
      tenantId: "tenant-1",
      scope: { level: "tenant" },
      caller: { authMode: "none" },
      summary: { total: 1, byState: { Enabled: 1 } },
      data: [{ subscriptionId: "sub-1", displayName: "Workload" }]
    });
  });

  it("calls inventory_resources with a schema-valid structured response", async () => {
    const app = createTestApp();
    await initializeMcp(app);

    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "inventory_resources",
          arguments: {
            subscriptionId: "11111111-1111-1111-1111-111111111111",
            pageSize: 50
          }
        }
      })
      .expect(200);

    const payload = parseMcpResponse<InventoryMcpResponse>(response.text);
    expect(payload.result.isError).not.toBe(true);
    expect(payload.result.structuredContent).toMatchObject({
      tool: "inventory_resources",
      summary: {
        total: 1,
        byType: { "microsoft.storage/storageaccounts": 1 },
        complete: true
      },
      data: [{ name: "storeone", category: "storage" }],
      page: { returned: 1, total: 1 }
    });
  });

  it("calls inventory_network with a schema-valid structured response", async () => {
    const app = createTestApp();
    await initializeMcp(app);

    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "inventory_network",
          arguments: {
            subscriptionId: "11111111-1111-1111-1111-111111111111",
            pageSize: 20
          }
        }
      })
      .expect(200);

    const payload = parseMcpResponse<NetworkMcpResponse>(response.text);
    expect(payload.result.isError).not.toBe(true);
    expect(payload.result.structuredContent).toMatchObject({
      tool: "inventory_network",
      summary: {
        totalResources: 1,
        complete: true
      },
      page: { returned: 1, total: 1 }
    });
  });

  it("calls list_role_assignments with the Phase 5 structured contract", async () => {
    const app = createTestApp();
    await initializeMcp(app);

    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "list_role_assignments",
          arguments: {
            subscriptionId: "11111111-1111-1111-1111-111111111111",
            privilegedOnly: true,
            pageSize: 20
          }
        }
      })
      .expect(200);

    const payload = parseMcpResponse<RoleMcpResponse>(response.text);
    expect(payload.result.isError).not.toBe(true);
    expect(payload.result.structuredContent).toMatchObject({
      tool: "list_role_assignments",
      access: { status: "full" },
      summary: { total: 1, privileged: 1 },
      data: [{ roleName: "Owner", privileged: true }],
      page: { returned: 1, total: 1 }
    });
  });

  it("calls get_nist_status with the Phase 6 structured contract", async () => {
    const app = createTestApp();
    await initializeMcp(app);

    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "get_nist_status",
          arguments: {
            subscriptionId: "11111111-1111-1111-1111-111111111111"
          }
        }
      })
      .expect(200);

    const payload = parseMcpResponse<NistMcpResponse>(response.text);
    expect(payload.result.isError).not.toBe(true);
    expect(payload.result.structuredContent).toMatchObject({
      tool: "get_nist_status",
      access: { status: "full" },
      summary: {
        standard: "NIST SP 800-53 Rev. 5",
        enabled: true,
        availability: "available",
        source: "defender"
      }
    });
  });
});

interface TestMcpResponse {
  result: {
    structuredContent: {
      tool: string;
      tenantId: string | null;
      scope: { level: string };
      caller: { authMode: string };
      summary: { total: number; byState: Record<string, number> };
      data: Array<{ subscriptionId: string; displayName: string }>;
    };
  };
}

interface InventoryMcpResponse {
  result: {
    isError?: boolean;
    structuredContent: {
      tool: string;
      summary: {
        total: number;
        byType: Record<string, number>;
        complete: boolean;
      };
      data: Array<{ name: string; category: string }>;
      page: { returned: number; total: number };
    };
  };
}

interface NetworkMcpResponse {
  result: {
    isError?: boolean;
    structuredContent: {
      tool: string;
      summary: { totalResources: number; complete: boolean };
      page: { returned: number; total: number };
    };
  };
}

interface RoleMcpResponse {
  result: {
    isError?: boolean;
    structuredContent: {
      tool: string;
      access: { status: string };
      summary: { total: number; privileged: number };
      data: Array<{ roleName: string; privileged: boolean }>;
      page: { returned: number; total: number };
    };
  };
}

interface NistMcpResponse {
  result: {
    isError?: boolean;
    structuredContent: {
      tool: string;
      access: { status: string };
      summary: {
        standard: string;
        enabled: boolean | null;
        availability: string;
        source: string;
      };
    };
  };
}

function parseMcpResponse<T>(text: string): T {
  if (text.startsWith("event:")) {
    const dataLine = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      throw new Error(`MCP SSE response did not contain data: ${text}`);
    }
    return JSON.parse(dataLine.slice("data:".length).trim()) as T;
  }
  return JSON.parse(text) as T;
}

async function initializeMcp(
  app: ReturnType<typeof createTestApp>,
  authorization?: string
): Promise<void> {
  const pending = request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream");
  if (authorization) {
    pending.set("Authorization", authorization);
  }
  await pending.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      }
    })
    .expect(200);
}

function createFakeResourceGraph(): ResourceGraphClient {
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const data = body.query.includes("SecurityResources")
      ? [
          {
            id: "/subscriptions/11111111-1111-1111-1111-111111111111/providers/Microsoft.Security/regulatoryComplianceStandards/NIST_SP_800-53_Rev_5",
            name: "NIST_SP_800-53_Rev_5",
            type: "microsoft.security/regulatorycompliancestandards",
            subscriptionId: "11111111-1111-1111-1111-111111111111",
            properties: {
              displayName: "NIST SP 800-53 Rev. 5",
              state: "Passed",
              passedControls: 1,
              failedControls: 0
            }
          }
        ]
      : body.query.includes("AuthorizationResources")
      ? [
          {
            id: "/subscriptions/11111111-1111-1111-1111-111111111111/providers/Microsoft.Authorization/roleAssignments/role-one",
            name: "role-one",
            scope: "/subscriptions/11111111-1111-1111-1111-111111111111",
            principalId: "principal-one",
            principalType: "ServicePrincipal",
            roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/owner",
            roleName: "Owner",
            roleType: "BuiltInRole",
            condition: "",
            permissions: [{ actions: ["*"] }]
          }
        ]
      : body.query.includes("| summarize")
      ? [
          {
            key: body.query.includes("tolower(type)")
              ? "microsoft.storage/storageaccounts"
              : body.query.includes("tostring(location)")
                ? "eastus"
                : "rg-one",
            count: 1
          }
        ]
      : [
          {
            id: "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-one/providers/Microsoft.Storage/storageAccounts/storeone",
            name: "storeone",
            type: "microsoft.storage/storageaccounts",
            category: "storage",
            location: "eastus",
            resourceGroup: "rg-one",
            subscriptionId: "11111111-1111-1111-1111-111111111111",
            tags: {}
          }
        ];
    return new Response(
      JSON.stringify({
        totalRecords: data.length,
        count: data.length,
        resultTruncated: false,
        data
      }),
      { status: 200 }
    );
  };

  return new ResourceGraphClient({
    credential: new FakeCredential(),
    cloud,
    apiVersion: "2022-10-01",
    maxRetries: 0,
    fetcher
  });
}
