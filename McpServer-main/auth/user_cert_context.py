"""
auth/user_cert_context.py – Per-request user certificate propagation
=====================================================================
Provides a lightweight mechanism to thread the X-User-Cert HTTP header
from the transport layer into MCP tool code using a contextvars.ContextVar.

HOW IT WORKS
------------
1. UserCertMiddleware (ASGI middleware) runs on every incoming HTTP request.
2. It reads the X-User-Cert header and stores the value in a ContextVar.
3. Any MCP tool can call ``get_user_cert()`` to retrieve the value.
4. The tool forwards it as X-User-Cert to downstream APIs — symmetric at
   both hops.

WHY ContextVar INSTEAD OF ASGI scope?
--------------------------------------
FastMCP's tool Context does not expose the raw ASGI scope or Starlette
Request to tool functions.  A ContextVar set by middleware is inherited by
all async code running in the same task, so tools can read it without any
framework-specific plumbing.

USAGE IN TOOLS
--------------
    from auth.user_cert_context import get_user_cert

    async def my_tool(ctx: Context) -> ...:
        user_cert_b64 = get_user_cert()   # empty string if not provided
        response = await http_client.get(
            "https://downstream/data",
            headers={"X-User-Cert": user_cert_b64},
        )

WIRING THE MIDDLEWARE
---------------------
In server.py create_app(), add:

    from auth.user_cert_context import UserCertMiddleware
    app.add_middleware(UserCertMiddleware)

This is ALWAYS-ON — not an auth stub.  It never rejects requests; it only
reads the header and makes it available.  Whether a downstream API rejects
the request for a missing/invalid X-User-Cert is that API's decision.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ContextVar – holds the X-User-Cert value for the current request.
# Default is empty string (no cert provided).
# ---------------------------------------------------------------------------
_user_cert_var: ContextVar[str] = ContextVar("user_cert_b64", default="")

HEADER_NAME = "X-User-Cert"


def get_user_cert() -> str:
    """Return the X-User-Cert value for the current request, or '' if absent."""
    return _user_cert_var.get()


# ---------------------------------------------------------------------------
# ASGI middleware
# ---------------------------------------------------------------------------
class UserCertMiddleware:
    """
    Lightweight ASGI middleware that reads X-User-Cert from the incoming
    HTTP request and stores it in a ContextVar so MCP tools can access it.

    This middleware does NOT validate the certificate — it only propagates
    the value.  Validation is the downstream API's responsibility (or can
    be added here later if the MCP server itself needs to verify the cert).
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            # ASGI headers are a list of [name, value] byte pairs.
            for name, value in scope.get("headers", []):
                if name.lower() == b"x-user-cert":
                    token = _user_cert_var.set(value.decode("ascii", errors="replace"))
                    try:
                        await self.app(scope, receive, send)
                    finally:
                        _user_cert_var.reset(token)
                    return

            # Header not present — clear var and proceed.
            token = _user_cert_var.set("")
            try:
                await self.app(scope, receive, send)
            finally:
                _user_cert_var.reset(token)
            return

        # Non-HTTP scope (lifespan, websocket) — pass through.
        await self.app(scope, receive, send)
