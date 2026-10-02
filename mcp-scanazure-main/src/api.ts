import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./version.js";

export interface ToolDescription {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface ApiToolResult {
  statusCode: number;
  body: unknown;
}

export async function listApiTools(server: McpServer): Promise<ToolDescription[]> {
  return withMcpClient(server, async (client) => {
    const result = await client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {})
    }));
  });
}

export async function callApiTool(
  server: McpServer,
  toolName: string,
  arguments_: Record<string, unknown>
): Promise<ApiToolResult> {
  return withMcpClient(server, async (client) => {
    const result = await client.callTool({
      name: toolName,
      arguments: arguments_
    }) as CallToolResult;

    if (result.isError) {
      return {
        statusCode: 502,
        body: {
          error: "ToolExecutionFailed",
          tool: toolName,
          content: result.content
        }
      };
    }

    return {
      statusCode: 200,
      body: result.structuredContent ?? { content: result.content }
    };
  });
}

export function createOpenApiDocument(
  tools: ToolDescription[],
  authenticationRequired: boolean
): Record<string, unknown> {
  const security = authenticationRequired ? [{ bearerAuth: [] }] : [];
  const paths: Record<string, unknown> = {
    "/healthz": {
      get: {
        operationId: "getHealth",
        summary: "Get service health",
        responses: {
          "200": {
            description: "Service health and Azure cloud capabilities",
            content: {
              "application/json": { schema: { type: "object" } }
            }
          }
        }
      }
    },
    "/api/tools": {
      get: {
        operationId: "listTools",
        summary: "List REST and MCP tools",
        description:
          "Returns every available tool and its exact JSON input and output schemas.",
        responses: {
          "200": {
            description: "Tool catalog",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tools: {
                      type: "array",
                      items: { type: "object" }
                    }
                  },
                  required: ["tools"]
                }
              }
            }
          }
        }
      }
    }
  };

  for (const tool of tools) {
    paths[`/api/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.title ?? tool.name,
        description: tool.description,
        security,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema
            }
          }
        },
        responses: {
          "200": {
            description: "Successful tool result",
            content: {
              "application/json": {
                schema: tool.outputSchema ?? { type: "object" }
              }
            }
          },
          "400": { description: "Invalid tool name or arguments" },
          "401": { description: "Missing or invalid bearer token" },
          "429": { description: "Request rate limit exceeded" },
          "502": { description: "Azure tool execution failed" }
        }
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "MCP Azure Scanner API",
      version: VERSION,
      description:
        "Read-only Azure inventory, security, governance, and NIST evidence tools. The REST operations use the same handlers as the MCP tools."
    },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Entra access token for the API's access_as_user scope. Not required when AUTH_MODE=none."
        }
      }
    }
  };
}

export function createLandingPage(tools: ToolDescription[]): string {
  const toolItems = tools
    .map(
      (tool) =>
        `<li><code>${escapeHtml(tool.name)}</code> - ${escapeHtml(tool.description ?? tool.title ?? "")}</li>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Azure Scanner</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #172033; background: #f4f7fb; }
    main { max-width: 960px; margin: 0 auto; padding: 3rem 1.5rem; }
    h1 { font-size: 2.5rem; margin-bottom: .5rem; }
    h2 { margin-top: 2.5rem; }
    .card { background: white; border: 1px solid #dbe3ef; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    code { background: #edf2f8; border-radius: 4px; padding: .15rem .35rem; }
    a { color: #075da8; }
    li { margin: .55rem 0; }
  </style>
</head>
<body>
<main>
  <h1>MCP Azure Scanner</h1>
  <p>Read-only Azure inventory, security, governance, and NIST evidence through MCP and REST.</p>
  <div class="card">
    <h2>Connect with MCP</h2>
    <p>Use the Streamable HTTP transport at <code>POST /mcp</code>. Production clients authenticate with an Entra bearer token.</p>
  </div>
  <div class="card">
    <h2>Call the REST API</h2>
    <p>Call a tool at <code>POST /api/tools/{toolName}</code> with the MCP tool arguments as the JSON body.</p>
    <p><a href="/swagger/">Open interactive Swagger API documentation</a> or <a href="/openapi.json">download the OpenAPI document</a>.</p>
  </div>
  <h2>Available tools</h2>
  <ul>${toolItems}</ul>
</main>
</body>
</html>`;
}

async function withMcpClient<T>(
  server: McpServer,
  action: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    name: "mcp-scanazure-rest-api",
    version: VERSION
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  );
}
