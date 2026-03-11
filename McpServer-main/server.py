"""
server.py – MCP Server Entry Point
====================================
This module wires up the FastMCP instance, registers all tools, and builds
the ASGI application that exposes the server over Streamable HTTP.

Transport choice
----------------
We use the Streamable HTTP transport because:
  - It works over standard HTTP/HTTPS, ideal for Azure hosting.
  - It supports server-sent events for streaming responses.
  - It is accessible from web clients, AI agents, and CI pipelines.
  - It operates behind any HTTP load balancer (Azure Container Apps, App Service).

How to add a new tool
---------------------
1. Create a file in the tools/ directory (e.g., tools/my_feature.py).
2. Define your tool functions using @mcp.tool() (see tools/example.py for patterns).
3. Expose a register_* function from your module.
4. Import and call it in tools/__init__.py.
That's it – no changes needed here.

How to add authentication
--------------------------
See auth/verifier.py for a full guide.  The short version:
  1. Uncomment the middleware line in create_app() below.
  2. Fill in the Azure settings in config.py / .env.
  3. Initialise the MSAL app in the lifespan() context manager below.
"""

import logging
import ssl
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx
import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from config import settings
from tools import register_tools

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan – startup / shutdown
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastMCP) -> AsyncIterator[dict]:
    """
    Run once on server startup; tear down on shutdown.

    The dict yielded here becomes the 'lifespan context' that every tool can
    access via:
        ctx.request_context.lifespan_context["your_key"]

    Add expensive-to-create, shared objects here:
      - Database connection pools
      - HTTP client sessions (httpx.AsyncClient)
      - AI/ML model handles

    AUTHENTICATION HOOK
    -------------------
    When you add authentication (see auth/verifier.py), initialise the MSAL
    ConfidentialClientApplication here so it is created once per process and
    reused across all requests.  Example:

        import msal
        msal_app = msal.ConfidentialClientApplication(
            client_id=settings.azure_client_id,
            client_credential=settings.azure_client_secret,
            authority=f"https://login.microsoftonline.com/{settings.azure_tenant_id}",
        )
        yield {"msal_app": msal_app}

    Then inside any tool that needs OBO:
        msal_app = ctx.request_context.lifespan_context["msal_app"]
    """
    logger.info("Server starting up – initialising shared resources...")

    # Shared async HTTP client – used by all tools that call external APIs.
    # A single client reuses TCP connections across tool calls (connection pooling),
    # which is significantly faster than creating a new client per request.
    #
    # Add more shared objects here as needed (DB pools, MSAL app, etc.).
    # Each key you add here is accessible in any tool via:
    #     ctx.request_context.lifespan_context["your_key"]
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(30.0),   # 30 s total; tune per your API's SLA
        follow_redirects=True,
    )

    # ------------------------------------------------------------------
    # mTLS client for the Secure API (caller.crt + caller.key + ca.crt)
    #
    # This is the "Side B" outbound mTLS client described throughout the
    # project docs.  The ssl.SSLContext carries:
    #   - load_cert_chain: the MCP server's own identity (caller cert+key)
    #   - load_verify_locations: the CA cert to verify the Secure API server
    #
    # All tools in tools/secure_api.py share this single client so the TLS
    # handshake + connection pooling happens once, not per tool call.
    # ------------------------------------------------------------------
    caller_cert = Path(settings.secure_api_caller_cert_path)
    caller_key = Path(settings.secure_api_caller_key_path)
    ca_cert = Path(settings.secure_api_ca_cert_path)

    if caller_cert.exists() and caller_key.exists():
        secure_ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        secure_ssl_ctx.load_cert_chain(
            certfile=str(caller_cert),
            keyfile=str(caller_key),
        )
        if ca_cert.exists():
            secure_ssl_ctx.load_verify_locations(str(ca_cert))
        logger.info("mTLS client configured for Secure API (cert: %s)", caller_cert)
    else:
        secure_ssl_ctx = True  # fall back to default TLS verification
        logger.warning(
            "Secure API caller cert/key not found (%s, %s) – "
            "secure_http_client will use default TLS (no mTLS).",
            caller_cert,
            caller_key,
        )

    secure_http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(30.0),
        follow_redirects=True,
        verify=secure_ssl_ctx,
    )

    yield {
        "http_client": http_client,
        "secure_http_client": secure_http_client,
    }

    # Clean up – close both HTTP clients gracefully.
    await secure_http_client.aclose()
    await http_client.aclose()
    logger.info("Server shutting down – released shared resources.")


# ---------------------------------------------------------------------------
# FastMCP instance
# ---------------------------------------------------------------------------
#
# stateless_http=True
#   Disables in-memory session state so the server scales horizontally
#   without sticky sessions.  This is the recommended setting for Azure
#   Container Apps (multiple replicas).
#   If you need persistent per-client sessions, set this to False and
#   configure session affinity on your Azure load balancer.
#
mcp = FastMCP(
    name=settings.server_name,
    instructions=settings.server_instructions,
    lifespan=lifespan,
    stateless_http=True,
)

# Register all tools from the tools/ package.
# To add more tools, edit tools/__init__.py – nothing changes here.
register_tools(mcp)


# ---------------------------------------------------------------------------
# Health check
# Registered as a FastMCP custom route so it lives in the same Starlette app
# as the /mcp endpoint. This avoids a double-mount path problem that would
# occur if we wrapped streamable_http_app() in a second Starlette app with
# Mount("/mcp", ...) – doing so makes the effective endpoint /mcp/mcp and
# causes the outer router to issue 307 redirects that break MCP clients.
# ---------------------------------------------------------------------------
@mcp.custom_route("/health", methods=["GET"])
async def _health_check(_: Request) -> JSONResponse:
    """Liveness probe – returns 200 so Azure knows the container is running."""
    return JSONResponse({"status": "ok", "server": settings.server_name})


# ---------------------------------------------------------------------------
# ASGI application
# ---------------------------------------------------------------------------
def create_app() -> Starlette:
    """
    Build the ASGI application.

    Layout
    ------
    GET  /health  – liveness probe for Azure health checks
    *    /mcp     – all MCP traffic (handled by FastMCP)

    Why no outer Starlette wrapper
    --------------------------------
    FastMCP's streamable_http_app() creates a Starlette app with a
    Route("/mcp", ...) at its root.  If we mount that inside a second
    Starlette app with Mount("/mcp", ...), the effective path becomes
    /mcp/mcp and the outer router issues spurious 307 redirects that
    break MCP clients (inspectors, agents, etc.).
    Instead, we use streamable_http_app() directly as the ASGI app and
    register the health endpoint via mcp.custom_route() above.

    AUTHENTICATION HOOK
    -------------------
    To add Bearer-token / Entra ID authentication, add the middleware below
    **before** the CORS middleware so that auth runs first.  Call
    app.add_middleware() immediately after `app = mcp.streamable_http_app()`:

        from auth.verifier import EntraIDBearerTokenMiddleware
        app.add_middleware(
            EntraIDBearerTokenMiddleware,
            tenant_id=settings.azure_tenant_id,
            audience=settings.expected_audience,
        )

    For an API-key approach or custom auth, the same pattern applies – just
    swap in your middleware class.  See auth/verifier.py for ready-to-use stubs.
    """
    # Use FastMCP's own Starlette app directly (health route registered above
    # via @mcp.custom_route, so it is already included in the routes list).
    app = mcp.streamable_http_app()

    # ------------------------------------------------------------------
    # USER CERT PROPAGATION MIDDLEWARE – always on.
    # Reads X-User-Cert from the incoming HTTP header and stores it in a
    # ContextVar so tools can call get_user_cert() to retrieve it.
    # This is NOT an auth gate – it only propagates the value.
    # ------------------------------------------------------------------
    from auth.user_cert_context import UserCertMiddleware
    app.add_middleware(UserCertMiddleware)

    # ------------------------------------------------------------------
    # AUTHENTICATION MIDDLEWARE – uncomment and configure when ready.
    # Order matters: auth middleware should be added BEFORE CORS so that
    # unauthenticated requests are rejected before CORS headers are sent.
    # ------------------------------------------------------------------
    # from auth.verifier import EntraIDBearerTokenMiddleware
    # app.add_middleware(
    #     EntraIDBearerTokenMiddleware,
    #     tenant_id=settings.azure_tenant_id,
    #     audience=settings.expected_audience,
    # )

    # CORS middleware – restrict allow_origins to known domains in production.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        # Mcp-Session-Id must be exposed so browser-based MCP clients can
        # read it and include it in subsequent requests.
        expose_headers=["Mcp-Session-Id"],
    )

    return app


# ---------------------------------------------------------------------------
# Module-level ASGI app – referenced by uvicorn and Dockerfile CMD
# ---------------------------------------------------------------------------
app = create_app()


# ---------------------------------------------------------------------------
# Local development entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
    )
