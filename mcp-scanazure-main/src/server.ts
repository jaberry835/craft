import type { TokenCredential } from "@azure/core-auth";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import cors, { type CorsOptions } from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import { rateLimit } from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import {
  callApiTool,
  createLandingPage,
  createOpenApiDocument,
  listApiTools,
  type ToolDescription
} from "./api.js";
import type { CloudCapabilities } from "./cloud/capabilities.js";
import type { ResolvedCloud } from "./cloud/profile.js";
import type { AppConfig } from "./config.js";
import { createMcpServer, type McpServerDependencies } from "./mcp/createServer.js";
import type { ResourceGraphClient } from "./azure/resourceGraph.js";
import { VERSION } from "./version.js";
import { ResourceGraphClient as DefaultResourceGraphClient } from "./azure/resourceGraph.js";
import { ArmReadClient } from "./azure/arm.js";
import { InMemoryScanStore } from "./scan/store.js";
import { ScanManager } from "./scan/orchestrator.js";
import { localCallerIdentity, type CallerIdentity } from "./scan/identity.js";
import { listSubscriptions } from "./azure/subscriptions.js";
import {
  AuthenticationError,
  EntraRequestAuthenticator,
  protectedResourceMetadata,
  type AuthenticatedRequest
} from "./auth/entra.js";

export interface ApplicationDependencies {
  config: AppConfig;
  resolvedCloud: ResolvedCloud;
  capabilities: CloudCapabilities;
  credential?: TokenCredential;
  listSubscriptions?: McpServerDependencies["listSubscriptions"];
  resourceGraph?: ResourceGraphClient;
  scanManager?: ScanManager;
  scanStore?: InMemoryScanStore;
  callerIdentityResolver?: (request: express.Request) => CallerIdentity;
  authenticatedRequestResolver?: (
    request: express.Request
  ) => Promise<AuthenticatedRequest>;
}

export function createApplication(dependencies: ApplicationDependencies): Express {
  const app = express();
  if (process.env.WEBSITE_SITE_NAME) {
    app.set("trust proxy", 1);
  }
  const corsOptions = createCorsOptions(dependencies.config.corsAllowedOrigins);
  const scanStore = dependencies.scanStore ?? new InMemoryScanStore({
    ttlMilliseconds: dependencies.config.scan.ttlMilliseconds,
    maximumScans: dependencies.config.scan.maximumScans,
    maximumScansPerCaller: dependencies.config.scan.maximumScansPerCaller,
    maximumBytes: dependencies.config.scan.maximumBytes
  });
  const localCredential =
    dependencies.config.authMode === "none"
      ? requireCredential(dependencies.credential)
      : null;
  const authenticator =
    dependencies.config.authMode === "none"
      ? null
      : dependencies.authenticatedRequestResolver
        ? null
        : new EntraRequestAuthenticator(
            dependencies.config,
            dependencies.resolvedCloud.profile
          );
  let toolCatalogPromise: Promise<ToolDescription[]> | undefined;

  const createServer = (
    requestContext: AuthenticatedRequest
  ) => {
    const requestServices = createRequestServices(
      dependencies,
      scanStore,
      requestContext.credential
    );
    return createMcpServer({
      config: dependencies.config,
      cloud: dependencies.resolvedCloud.profile,
      credential: requestContext.credential,
      ...(dependencies.listSubscriptions
        ? { listSubscriptions: dependencies.listSubscriptions }
        : {}),
      resourceGraph: requestServices.resourceGraph,
      scanManager: requestServices.scanManager,
      caller: requestContext.caller
    });
  };
  const getToolCatalog = (): Promise<ToolDescription[]> => {
    if (!toolCatalogPromise) {
      const documentationCredential =
        localCredential ?? new DocumentationCredential();
      const documentationContext: AuthenticatedRequest = {
        caller: localCallerIdentity(dependencies.config.tenantId),
        credential: documentationCredential
      };
      toolCatalogPromise = listApiTools(createServer(documentationContext)).catch(
        (error: unknown) => {
          toolCatalogPromise = undefined;
          throw error;
        }
      );
    }
    return toolCatalogPromise;
  };

  app.disable("x-powered-by");
  app.use(cors(corsOptions));
  app.use((_request, response, next) => {
    response.set({
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use("/mcp", createRequestRateLimiter(dependencies, true));
  app.use("/api", createRequestRateLimiter(dependencies, false));

  app.get("/", async (_request, response, next) => {
    try {
      response.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
      );
      response.type("html").send(createLandingPage(await getToolCatalog()));
    } catch (error) {
      next(error);
    }
  });

  app.get("/openapi.json", async (_request, response, next) => {
    try {
      response.json(
        createOpenApiDocument(
          await getToolCatalog(),
          dependencies.config.authMode !== "none"
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.use(
    "/swagger",
    (
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction
    ) => {
      response.set(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'"
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(null, {
      customSiteTitle: "MCP Azure Scanner API",
      swaggerOptions: {
        url: "/openapi.json",
        persistAuthorization: true
      }
    })
  );

  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      version: VERSION,
      authMode: dependencies.config.authMode,
      cloud: dependencies.resolvedCloud.profile.name,
      cloudDiscovery: dependencies.resolvedCloud.discovery,
      capabilities: dependencies.capabilities
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_request, response) => {
    if (dependencies.config.authMode === "none") {
      return response.status(404).json({ error: "AuthenticationDisabled" });
    }
    return response.json(
      protectedResourceMetadata(
        dependencies.config,
        dependencies.resolvedCloud.profile
      )
    );
  });

  app.get("/api/tools", async (_request, response, next) => {
    try {
      response.json({ tools: await getToolCatalog() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tools/:toolName", async (request, response) => {
    let requestContext: AuthenticatedRequest;
    try {
      requestContext = await authenticateRequest(
        request,
        dependencies,
        localCredential,
        authenticator
      );
    } catch (error) {
      sendAuthenticationError(response, error, dependencies.config);
      return;
    }

    if (!isRecord(request.body)) {
      response.status(400).json({
        error: "InvalidRequestBody",
        message: "The request body must be a JSON object"
      });
      return;
    }

    try {
      const tools = await getToolCatalog();
      if (!tools.some((tool) => tool.name === request.params.toolName)) {
        response.status(400).json({
          error: "UnknownTool",
          message: `Unknown tool: ${request.params.toolName}`
        });
        return;
      }
      const result = await callApiTool(
        createServer(requestContext),
        request.params.toolName,
        request.body
      );
      response.status(result.statusCode).json(result.body);
    } catch (error) {
      if (
        error instanceof McpError &&
        (error.code === ErrorCode.InvalidParams ||
          error.code === ErrorCode.MethodNotFound)
      ) {
        response.status(400).json({
          error: error.code === ErrorCode.MethodNotFound
            ? "UnknownTool"
            : "InvalidToolArguments",
          message: error.message
        });
        return;
      }
      console.error("REST tool request failed", error);
      response.status(500).json({
        error: "InternalServerError",
        message: "The REST tool request could not be completed"
      });
    }
  });

  app.post("/mcp", async (request, response) => {
    let requestContext: AuthenticatedRequest;
    try {
      requestContext = await authenticateRequest(
        request,
        dependencies,
        localCredential,
        authenticator
      );
    } catch (error) {
      sendAuthenticationError(response, error, dependencies.config);
      return;
    }
    const server = createServer(requestContext);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    try {
      await server.connect(transport);
      response.once("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32_603,
            message: "Internal server error"
          },
          id: null
        });
      }

    }
  });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : "Request failed";
    response.status(403).json({ error: "RequestRejected", message });
  };
  app.use(errorHandler);

  return app;
}

function createRequestServices(
  dependencies: ApplicationDependencies,
  scanStore: InMemoryScanStore,
  credential: TokenCredential
): {
  resourceGraph: ResourceGraphClient;
  scanManager: ScanManager;
} {
  const resourceGraph =
    dependencies.resourceGraph ??
    new DefaultResourceGraphClient({
      credential,
      cloud: dependencies.resolvedCloud.profile,
      apiVersion: dependencies.config.resourceGraphApiVersion,
      maxRetries: dependencies.config.resourceGraphMaxRetries
    });
  const subscriptionLister = () =>
    (dependencies.listSubscriptions ?? listSubscriptions)({
      credential,
      cloud: dependencies.resolvedCloud.profile,
      apiVersion: dependencies.config.subscriptionsApiVersion
    });
  const scanManager =
    dependencies.scanManager ??
    new ScanManager({
      store: scanStore,
      resourceGraph,
      arm: new ArmReadClient(credential, dependencies.resolvedCloud.profile),
      credential,
      cloud: dependencies.resolvedCloud.profile,
      listSubscriptions: subscriptionLister,
      nistInitiativeIds: dependencies.config.nistInitiativeIds,
      nistNamePatterns: dependencies.config.nistNamePatterns,
      keyVaultApiVersion: dependencies.config.keyVaultApiVersion,
      keyVaultExpiryWarningDays: dependencies.config.keyVaultExpiryWarningDays,
      concurrency: dependencies.config.scan.concurrency
    });
  return { resourceGraph, scanManager };
}

async function authenticateRequest(
  request: express.Request,
  dependencies: ApplicationDependencies,
  localCredential: TokenCredential | null,
  authenticator: EntraRequestAuthenticator | null
): Promise<AuthenticatedRequest> {
  if (dependencies.config.authMode === "none") {
    return {
      caller: dependencies.callerIdentityResolver
        ? dependencies.callerIdentityResolver(request)
        : localCallerIdentity(dependencies.config.tenantId),
      credential: localCredential!
    };
  }
  return dependencies.authenticatedRequestResolver
    ? dependencies.authenticatedRequestResolver(request)
    : authenticator!.authenticate(request);
}

function sendAuthenticationError(
  response: express.Response,
  error: unknown,
  config: AppConfig
): void {
  if (error instanceof AuthenticationError) {
    response.set(
      "WWW-Authenticate",
      createBearerChallenge(config.entra?.resourceUri)
    );
    response.status(error.statusCode).json({
      error: "invalid_token",
      error_description: error.message
    });
    return;
  }
  console.error("Authentication dependency failed", error);
  response.status(503).json({
    error: "authentication_unavailable",
    error_description: "Authentication could not be completed"
  });
}

function createRequestRateLimiter(
  dependencies: ApplicationDependencies,
  mcpResponse: boolean
) {
  return rateLimit({
    windowMs: dependencies.config.rateLimit.windowMilliseconds,
    limit: dependencies.config.rateLimit.maximumRequests,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(_request, response) {
      if (mcpResponse) {
        response.status(429).json({
          jsonrpc: "2.0",
          error: {
            code: -32_029,
            message: "Too many MCP requests"
          },
          id: null
        });
        return;
      }
      response.status(429).json({
        error: "TooManyRequests",
        message: "Too many API requests"
      });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class DocumentationCredential implements TokenCredential {
  getToken(): Promise<never> {
    return Promise.reject(
      new Error("Documentation generation cannot request Azure tokens")
    );
  }
}

function requireCredential(
  credential: TokenCredential | undefined
): TokenCredential {
  if (!credential) {
    throw new Error("AUTH_MODE=none requires a process Azure credential");
  }
  return credential;
}

function createBearerChallenge(resourceUri: string | undefined): string {
  const metadata = resourceUri
    ? `${resourceUri.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`
    : "/.well-known/oauth-protected-resource";
  return `Bearer resource_metadata="${metadata}"`;
}

function createCorsOptions(allowedOrigins: ReadonlySet<string>): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin is not allowed: ${origin}`));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Accept",
      "Mcp-Session-Id",
      "Mcp-Protocol-Version",
      "Last-Event-ID"
    ],
    exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
    credentials: false,
    maxAge: 600
  };
}

function methodNotAllowed(
  _request: express.Request,
  response: express.Response
): express.Response {
  return response.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32_000,
      message: "Method not allowed"
    },
    id: null
  });
}
