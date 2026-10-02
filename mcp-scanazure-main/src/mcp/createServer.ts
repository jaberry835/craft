import type { TokenCredential } from "@azure/core-auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSubscriptions, type AzureSubscription } from "../azure/subscriptions.js";
import type { CloudProfile } from "../cloud/profile.js";
import type { AppConfig } from "../config.js";
import { accessSchema, callerSchema, createEnvelope, errorSchema } from "../envelope.js";
import { ResourceGraphClient } from "../azure/resourceGraph.js";
import { registerInventoryTools } from "./inventoryTools.js";
import { VERSION } from "../version.js";
import { registerNetworkTools } from "./networkTools.js";
import { ArmReadClient } from "../azure/arm.js";
import { registerServiceTools } from "./serviceTools.js";
import { registerGovernanceTools } from "./governanceTools.js";
import { registerNistTools } from "./nistTools.js";
import { registerScanTools } from "./scanTools.js";
import type { ScanManager } from "../scan/orchestrator.js";
import type { CallerIdentity } from "../scan/identity.js";
import { registerPhase8aTools } from "./phase8aTools.js";

const subscriptionSchema = z.object({
  subscriptionId: z.string(),
  displayName: z.string(),
  state: z.string(),
  tenantId: z.string().nullable()
});

const listSubscriptionsOutputSchema = {
  tool: z.literal("list_subscriptions"),
  generatedAt: z.iso.datetime(),
  tenantId: z.string().nullable(),
  scope: z.object({
    level: z.literal("tenant")
  }),
  caller: callerSchema,
  access: accessSchema,
  summary: z.object({
    total: z.number().int().nonnegative(),
    byState: z.record(z.string(), z.number().int().nonnegative())
  }),
  data: z.array(subscriptionSchema),
  page: z
    .object({
      nextPageToken: z.string().nullable(),
      returned: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().nullable()
    })
    .nullable(),
  portalLinks: z.record(z.string(), z.string()),
  errors: z.array(errorSchema)
};

export interface McpServerDependencies {
  config: AppConfig;
  cloud: CloudProfile;
  credential: TokenCredential;
  listSubscriptions?: typeof listSubscriptions;
  resourceGraph?: ResourceGraphClient;
  scanManager?: ScanManager;
  caller?: CallerIdentity;
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: "mcp-scanazure",
    version: VERSION
  });

  server.registerTool(
    "list_subscriptions",
    {
      title: "List Azure subscriptions",
      description:
        "Lists every Azure subscription visible to the signed-in user. This operation is read-only.",
      inputSchema: {},
      outputSchema: listSubscriptionsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async () => {
      try {
        const subscriptions = await (dependencies.listSubscriptions ?? listSubscriptions)({
          credential: dependencies.credential,
          cloud: dependencies.cloud,
          apiVersion: dependencies.config.subscriptionsApiVersion
        });
        const structuredContent = createEnvelope({
          tool: "list_subscriptions",
          tenantId: dependencies.config.tenantId ?? null,
          authMode: dependencies.config.authMode,
          scope: { level: "tenant" },
          summary: {
            total: subscriptions.length,
            byState: countByState(subscriptions)
          },
          data: subscriptions,
          page: {
            nextPageToken: null,
            returned: subscriptions.length,
            total: subscriptions.length
          },
          portalLinks: {
            subscriptions: `${dependencies.cloud.portalUrl}/#view/Microsoft_Azure_Billing/SubscriptionsBladeV2`
          },
          accessNotes:
            dependencies.config.authMode === "none"
              ? ["Using DefaultAzureCredential because AUTH_MODE=none"]
              : []
        });

        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  tool: "list_subscriptions",
                  code: "AzureSubscriptionListFailed",
                  message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );

  const resourceGraph =
    dependencies.resourceGraph ??
    new ResourceGraphClient({
      credential: dependencies.credential,
      cloud: dependencies.cloud,
      apiVersion: dependencies.config.resourceGraphApiVersion,
      maxRetries: dependencies.config.resourceGraphMaxRetries
    });
  registerInventoryTools(server, {
    config: dependencies.config,
    cloud: dependencies.cloud,
    resourceGraph
  });
  registerNetworkTools(server, {
    config: dependencies.config,
    cloud: dependencies.cloud,
    resourceGraph
  });
  const arm = new ArmReadClient(dependencies.credential, dependencies.cloud);
  registerServiceTools(server, {
    config: dependencies.config,
    cloud: dependencies.cloud,
    resourceGraph,
    arm
  });
  registerGovernanceTools(server, {
    config: dependencies.config,
    cloud: dependencies.cloud,
    resourceGraph,
    listSubscriptions: () =>
      (dependencies.listSubscriptions ?? listSubscriptions)({
        credential: dependencies.credential,
        cloud: dependencies.cloud,
        apiVersion: dependencies.config.subscriptionsApiVersion
      })
  });
  registerPhase8aTools(server, {
    config: dependencies.config,
    cloud: dependencies.cloud,
    credential: dependencies.credential,
    resourceGraph
  });
  registerNistTools(server, {
    config: dependencies.config,
    cloud: dependencies.cloud,
    resourceGraph,
    arm,
    credential: dependencies.credential
  });
  if (dependencies.scanManager && dependencies.caller) {
    registerScanTools(server, {
      config: dependencies.config,
      cloud: dependencies.cloud,
      manager: dependencies.scanManager,
      caller: dependencies.caller
    });
  }

  return server;
}

function countByState(subscriptions: AzureSubscription[]): Record<string, number> {
  return subscriptions.reduce<Record<string, number>>((counts, subscription) => {
    counts[subscription.state] = (counts[subscription.state] ?? 0) + 1;
    return counts;
  }, {});
}
