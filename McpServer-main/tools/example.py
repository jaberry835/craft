"""
tools/example.py – Example Tool Patterns
==========================================
These tools exist to demonstrate the recommended patterns for this codebase.
Copy any pattern that fits your use case, rename it, and build from there.

Delete this file (and its registration in tools/__init__.py) once you have
added your own real tools.

Patterns covered
-----------------
  Pattern 1 – Sync tool with primitive inputs and a Pydantic output model.
              Best for: simple transformations, lookups, calculations.

  Pattern 2 – Async tool with Context (logging + progress reporting).
              Best for: I/O-bound work, database queries, API calls.

  Pattern 3 – Tool that accesses shared resources from the lifespan context.
              Best for: tools that need DB connections, HTTP clients, caches.

  Pattern 4 – OBO (On-Behalf-Of) downstream API call stub.
              Best for: tools that must call an Entra ID-protected API as the calling user.

  Pattern 5 – Cert identity downstream call stub.
              Best for: tools that read the caller's identity from a client certificate
              (extracted by ClientCertificateMiddleware) and call a downstream API.
              Covers both the case where the downstream API requires mTLS (outbound
              server cert on the httpx client) and where it needs user identity
              forwarded as a trusted header.

Why Pydantic output models?
----------------------------
FastMCP converts Pydantic models to JSON Schema automatically, giving LLMs
a precise description of what the tool returns and enabling structured output
parsing.  Always prefer a Pydantic model over a plain dict for tool returns.
"""

import logging
from typing import Annotated

from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Output models – define the shape of data returned by each tool.
# ---------------------------------------------------------------------------

class EchoResult(BaseModel):
    """Result of the echo tool."""
    original: str = Field(description="The original input message.")
    upper: str = Field(description="The message converted to upper case.")
    length: int = Field(description="Character length of the original message.")


class ItemSummary(BaseModel):
    """A single item in a list result."""
    id: int
    name: str
    description: str | None = None


class ListResult(BaseModel):
    """Paginated list of items."""
    items: list[ItemSummary]
    total: int = Field(description="Total number of items returned.")


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------

def register_example_tools(mcp: FastMCP) -> None:
    """Register all example tools with the MCP server."""

    # =======================================================================
    # Pattern 1 – Sync tool with a typed Pydantic output
    #
    # Use this pattern for:
    #   - Pure functions (no I/O, no async needed)
    #   - Simple lookups or transformations
    #
    # Key points:
    #   - Annotated[type, Field(...)] adds descriptions to the JSON Schema,
    #     which helps the LLM understand what each parameter is for.
    #   - Return a Pydantic model for machine-readable structured output.
    # =======================================================================
    @mcp.tool(
        name="echo",
        description=(
            "Echoes a message back with metadata. "
            "Demonstrates the simplest tool pattern – copy this as a starting point."
        ),
    )
    def echo(
        message: Annotated[str, Field(description="The message to echo back.")],
    ) -> EchoResult:
        """
        Minimal working example of a synchronous MCP tool.

        Copy this function, rename it, change the inputs/output model, and
        implement your business logic in place of the return statement.
        """
        return EchoResult(
            original=message,
            upper=message.upper(),
            length=len(message),
        )

    # =======================================================================
    # Pattern 2 – Async tool with Context
    #
    # Use this pattern for:
    #   - Any I/O-bound work (DB queries, HTTP calls, file reads)
    #   - Long-running operations where progress reporting is useful
    #
    # The Context parameter (ctx) provides:
    #   await ctx.debug/info/warning/error(msg)  – structured logging
    #   await ctx.report_progress(n, total, msg) – streaming progress to client
    #   ctx.request_context.lifespan_context     – shared resources (Pattern 3)
    #
    # FastMCP injects Context automatically – do NOT include it in the tool
    # description or annotate it with Field().
    # =======================================================================
    @mcp.tool(
        name="list_items",
        description=(
            "Returns a list of items demonstrating async tools, "
            "logging, and progress reporting."
        ),
    )
    async def list_items(
        limit: Annotated[
            int,
            Field(default=5, ge=1, le=100, description="Maximum number of items to return (1-100)."),
        ],
        ctx: Context,
    ) -> ListResult:
        """
        Async tool that demonstrates Context usage.

        Replace the simulated loop with a real database query or API call.
        """
        await ctx.info(f"Fetching up to {limit} items...")

        items: list[ItemSummary] = []

        for i in range(1, limit + 1):
            # Report progress so the client can show a progress indicator.
            await ctx.report_progress(i, limit, f"Processing item {i} of {limit}")

            # --- Replace this block with your real data retrieval logic ---
            items.append(
                ItemSummary(
                    id=i,
                    name=f"Item {i}",
                    description=f"Auto-generated description for item {i}.",
                )
            )
            # ---------------------------------------------------------------

        await ctx.info(f"Returning {len(items)} items.")
        return ListResult(items=items, total=len(items))

    # =======================================================================
    # Pattern 3 – Accessing shared resources from the lifespan context
    #
    # Resources such as database pools, HTTP clients, or MSAL apps are
    # initialised ONCE in the lifespan() function in server.py and then
    # accessed here via ctx.request_context.lifespan_context.
    #
    # This avoids creating a new connection on every tool call.
    # =======================================================================
    @mcp.tool(
        name="get_server_info",
        description="Returns metadata about this server, demonstrating lifespan context access.",
    )
    async def get_server_info(ctx: Context) -> dict:
        """
        Demonstrates how to read from the lifespan context.

        After you initialise a shared resource in server.py lifespan(), retrieve
        it here with:
            resource = ctx.request_context.lifespan_context["your_key"]
        """
        # Read from the lifespan context.  The dict is populated in server.py.
        lifespan_ctx: dict = ctx.request_context.lifespan_context

        # Example of what you might expose here in a real server.
        return {
            "lifespan_keys": list(lifespan_ctx.keys()),
            "note": (
                "Initialise shared objects in the lifespan() context manager "
                "in server.py and retrieve them via "
                "ctx.request_context.lifespan_context['your_key']."
            ),
        }

    # =======================================================================
    # Pattern 4 – On-Behalf-Of (OBO) downstream API call stub
    #
    # Use this pattern when a tool must call a protected API (e.g. Microsoft
    # Graph, an internal service) *as* the user who triggered the tool call.
    #
    # This preserves:
    #   - Row-level security in the downstream API
    #   - Audit trails showing the real user identity
    #   - Security trimming of results
    #
    # Prerequisites:
    #   1. Layer 1 auth configured (auth/verifier.py)
    #   2. MSAL app initialised in server.py lifespan()
    #   3. 'auth' optional dependencies installed (uv sync --extra auth)
    #
    # See auth/obo.py for the full implementation.
    # =======================================================================
    @mcp.tool(
        name="get_user_profile",
        description=(
            "(Stub) Returns the calling user's Microsoft Graph profile. "
            "Requires OBO authentication – see auth/obo.py to enable."
        ),
    )
    async def get_user_profile(ctx: Context) -> dict:
        """
        OBO pattern stub.

        When auth is configured, uncomment the block below.
        The three steps are:
          1. Extract the user's bearer token from the request headers.
          2. Call get_obo_token() to exchange it for a Graph-scoped token.
          3. Call the downstream API with the new token.
        """

        # ------------------------------------------------------------------
        # TODO: Uncomment once authentication is configured.
        # ------------------------------------------------------------------
        # import httpx
        # from auth.obo import get_obo_token
        #
        # # Step 1 – Extract the user's incoming bearer token.
        # auth_header: str = ctx.request_context.request.headers.get("Authorization", "")
        # incoming_token = auth_header.removeprefix("Bearer ").strip()
        #
        # # Step 2 – Exchange for a Graph-scoped token via MSAL OBO.
        # msal_app = ctx.request_context.lifespan_context["msal_app"]
        # graph_token = await get_obo_token(
        #     incoming_token=incoming_token,
        #     scopes=["https://graph.microsoft.com/User.Read"],
        #     msal_app=msal_app,
        # )
        #
        # # Step 3 – Call the downstream API as the user.
        # async with httpx.AsyncClient() as client:
        #     response = await client.get(
        #         "https://graph.microsoft.com/v1.0/me",
        #         headers={"Authorization": f"Bearer {graph_token}"},
        #     )
        #     response.raise_for_status()
        #     return response.json()
        # ------------------------------------------------------------------

        return {
            "status": "stub",
            "message": (
                "OBO authentication is not yet configured. "
                "See auth/obo.py and the Pattern 4 comments in tools/example.py."
            ),
        }

    # =======================================================================
    # Pattern 5 – Cert identity + outbound mTLS call stub
    #
    # THE TWO SIDES OF CERT AUTH – KEY INSIGHT
    # -----------------------------------------
    # A certificate's private key NEVER leaves the machine that owns it.
    # There are therefore two completely independent cert relationships:
    #
    # Side A (INBOUND): Agent → platform → this MCP server
    #   The calling agent sends the user's PUBLIC certificate in the
    #   X-User-Cert HTTP header.  UserCertMiddleware (auth/user_cert_context.py)
    #   reads it and stores it in a ContextVar.  Tools call get_user_cert()
    #   to retrieve it — no tool parameter needed.
    #
    # Side B (OUTBOUND): this MCP server → downstream API
    #   If the downstream API requires mTLS, the MCP SERVER presents ITS OWN
    #   cert and private key during the TLS handshake.  This is configured
    #   ONCE on the shared secure_http_client in server.py lifespan() via
    #   ssl.SSLContext.  The user's cert is not involved here.
    #
    # FORWARDING USER IDENTITY
    # ------------------------
    # The tool forwards the X-User-Cert header downstream — the same header
    # name and value at both hops.  Because the downstream API trusts the
    # MCP server's cert (Side B), it can trust the forwarded user cert.
    # The downstream API MUST only accept this header over the mTLS
    # connection — not from arbitrary callers.
    #
    # See tools/secure_api.py for the real, working implementation.
    # =======================================================================
    @mcp.tool(
        name="get_user_data",
        description=(
            "(Stub) Returns data for the calling user, identified by their "
            "certificate in the X-User-Cert HTTP header. Demonstrates the "
            "cert identity + outbound mTLS call pattern. "
            "See tools/secure_api.py for the real implementation."
        ),
    )
    async def get_user_data(ctx: Context) -> dict:
        """
        Cert identity downstream call pattern stub.

        The user's certificate arrives as the X-User-Cert HTTP header,
        propagated by UserCertMiddleware into a ContextVar.  Call
        get_user_cert() to retrieve it.

        Uncomment the block below once your secure_http_client is configured.
        """

        # ------------------------------------------------------------------
        # TODO: Uncomment once secure_http_client is configured in lifespan.
        # ------------------------------------------------------------------
        # from auth.user_cert_context import get_user_cert
        #
        # user_cert_b64 = get_user_cert()
        # if not user_cert_b64:
        #     raise ValueError(
        #         "X-User-Cert header is required. The calling agent must "
        #         "send the user's public certificate as base64-encoded DER."
        #     )
        #
        # http_client: httpx.AsyncClient = (
        #     ctx.request_context.lifespan_context["secure_http_client"]
        # )
        # response = await http_client.get(
        #     "https://internal-api.example.com/data",
        #     headers={"X-User-Cert": user_cert_b64},
        # )
        # response.raise_for_status()
        # return response.json()
        # ------------------------------------------------------------------

        return {
            "status": "stub",
            "message": (
                "Cert identity authentication is not yet configured. "
                "See tools/secure_api.py for a working implementation using "
                "get_user_cert() from auth/user_cert_context.py."
            ),
        }
