"""
tools/secure_api.py – Secure API Tools (mTLS + OBO User Cert)
=============================================================
These tools wrap the Secure API (default: https://localhost:5005) which
enforces two independent layers of identity on every request:

  Layer 1 – Mutual TLS (caller authentication)
      The MCP server presents its own client certificate (caller.crt +
      caller.key) during the TLS handshake.  The Secure API rejects the
      connection if the cert is absent or not signed by the trusted CA.
      This is handled automatically by the shared secure_http_client
      configured in server.py lifespan().

  Layer 2 – On-Behalf-Of user identity (X-User-Cert header)
      The calling agent/app sends the user's **public** certificate as a
      base64-encoded DER string in the X-User-Cert HTTP header on every
      request to the MCP server.  The MCP server reads it via the
      UserCertMiddleware (see auth/user_cert_context.py) and forwards it
      in the same X-User-Cert header to the Secure API.  The Secure API
      verifies the CA signature, checks validity, and extracts the user's
      Common Name as the acting identity.

HOW THE USER CERT FLOWS
-----------------------
  Caller → MCP Server:  X-User-Cert HTTP header on POST /mcp
  MCP Server → Tool:    get_user_cert() contextvar (set by middleware)
  Tool → Secure API:    X-User-Cert HTTP header on the outbound request

The header value is the same at both hops — base64-encoded DER of the
user's public certificate.  The MCP server never holds user private keys.
It only receives the public cert (which is safe to transmit) and forwards
it downstream.

For local development/testing with MCP Inspector, use the `encode_user_cert`
helper tool to get the base64 DER value, then set X-User-Cert as a custom
header on the Inspector's HTTP requests.

CONFIGURATION
-------------
Set these in .env or as environment variables:
    SECURE_API_BASE_URL=https://localhost:5005
    SECURE_API_CALLER_CERT_PATH=certs/caller.crt
    SECURE_API_CALLER_KEY_PATH=certs/caller.key
    SECURE_API_CA_CERT_PATH=certs/ca.crt
    SECURE_API_CERTS_DIR=certs

The mTLS httpx.AsyncClient (secure_http_client) is created ONCE at startup in
server.py lifespan() and reused for every request.
"""

import base64
import logging
from pathlib import Path
from typing import Annotated

import httpx
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field

from auth.user_cert_context import get_user_cert
from config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helper: encode a PEM certificate file as base64 DER for X-User-Cert header
# ---------------------------------------------------------------------------

def encode_user_cert_header(pem_path: str | Path) -> str:
    """
    Read a PEM certificate file and return base64-encoded DER suitable
    for the X-User-Cert header.

    PEM is just base64(DER) wrapped in BEGIN/END markers, so no external
    crypto library is needed – we strip the markers, decode the base64 to
    get raw DER bytes, then re-encode as a single unbroken base64 string.
    """
    pem_text = Path(pem_path).read_text(encoding="ascii")
    lines = [
        line.strip()
        for line in pem_text.splitlines()
        if line.strip() and not line.strip().startswith("-----")
    ]
    der_bytes = base64.b64decode("".join(lines))
    return base64.b64encode(der_bytes).decode("ascii")


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class AuthInfo(BaseModel):
    """Auth configuration from the /status endpoint."""

    layer1: str = Field(description="Description of Layer 1 auth (mTLS).")
    layer2: str = Field(description="Description of Layer 2 auth (user cert header).")
    caller_allowlist: list[str] = Field(description="CNs allowed to call this API.")
    user_cert_required: bool = Field(description="Whether X-User-Cert header is required.")


class SecureApiStatusResult(BaseModel):
    """Response from GET /status."""

    status: str = Field(description="Service status, e.g. 'running'.")
    service: str = Field(description="Service name.")
    version: str = Field(description="API version.")
    auth: AuthInfo = Field(description="Auth configuration details.")


class SecureApiGreetingResult(BaseModel):
    """Response from GET / (caller + user greeting)."""

    status: str = Field(description="Request status, e.g. 'ok'.")
    message: str = Field(description="Human-readable greeting message.")
    caller_cn: str = Field(description="Common Name from the caller's mTLS certificate.")
    user_cn: str = Field(description="Common Name from the user's certificate in X-User-Cert.")
    auth_method: str = Field(description="Description of the auth method used.")


class ProtectedData(BaseModel):
    """The protected_data sub-object from GET /data."""

    count: int = Field(description="Number of records returned.")
    records: list[str] = Field(description="The protected record values.")
    note: str = Field(default="", description="Optional note about the data.")


class SecureApiDataResult(BaseModel):
    """Response from GET /data (fetch protected records)."""

    status: str = Field(description="Request status, e.g. 'success'.")
    caller_cn: str = Field(description="Common Name from the caller's mTLS certificate.")
    user_cn: str = Field(description="Common Name from the user's certificate in X-User-Cert.")
    protected_data: ProtectedData = Field(description="The protected records and metadata.")


# ---------------------------------------------------------------------------
# Private implementation functions
#
# These are kept outside the @mcp.tool() closures so they can be tested
# directly with a mocked httpx.AsyncClient (see tests/test_tools.py).
# ---------------------------------------------------------------------------

async def _call_secure_status(
    http_client: httpx.AsyncClient,
    base_url: str,
) -> SecureApiStatusResult:
    """Call GET /status — no user cert needed, but mTLS is still required."""
    try:
        response = await http_client.get(f"{base_url}/status")
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Secure API /status returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Secure API at {base_url}: {exc}") from exc
    logger.debug("GET /status → %s %s", response.status_code, response.text[:500])
    return SecureApiStatusResult.model_validate(response.json())


async def _call_secure_greeting(
    http_client: httpx.AsyncClient,
    base_url: str,
    user_cert_b64: str,
) -> SecureApiGreetingResult:
    """Call GET / with X-User-Cert header."""
    try:
        response = await http_client.get(
            f"{base_url}/",
            headers={"X-User-Cert": user_cert_b64},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Secure API / returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Secure API at {base_url}: {exc}") from exc
    logger.debug("GET / → %s %s", response.status_code, response.text[:500])
    return SecureApiGreetingResult.model_validate(response.json())


async def _call_secure_data(
    http_client: httpx.AsyncClient,
    base_url: str,
    user_cert_b64: str,
) -> SecureApiDataResult:
    """Call GET /data with X-User-Cert header."""
    try:
        response = await http_client.get(
            f"{base_url}/data",
            headers={"X-User-Cert": user_cert_b64},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Secure API /data returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Secure API at {base_url}: {exc}") from exc
    logger.debug("GET /data → %s %s", response.status_code, response.text[:500])
    return SecureApiDataResult.model_validate(response.json())


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------

def register_secure_api_tools(mcp: FastMCP) -> None:
    """Register all Secure API tools with the MCP server."""

    # -----------------------------------------------------------------------
    # Tool: encode_user_cert  (dev/test convenience)
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="encode_user_cert",
        description=(
            "DEV/TEST ONLY – Read a PEM certificate file from the server's "
            "certs/ directory and return its base64-encoded DER representation. "
            "In production, the calling agent sends the user's cert in the "
            "X-User-Cert HTTP header – this tool is not needed."
        ),
    )
    async def encode_user_cert_tool(
        cert_name: Annotated[
            str,
            Field(
                description=(
                    "Name of the certificate file in the certs/ directory, "
                    "without the .crt extension (e.g. 'user-alice')."
                ),
            ),
        ],
        ctx: Context,
    ) -> dict:
        """
        Reads a PEM certificate from certs/{cert_name}.crt, converts it to
        base64-encoded DER, and returns the string.  Use this value as the
        X-User-Cert HTTP header when calling this MCP server.
        """
        cert_path = Path(settings.secure_api_certs_dir) / f"{cert_name}.crt"
        if not cert_path.exists():
            raise FileNotFoundError(f"Certificate not found: {cert_path}")

        b64_value = encode_user_cert_header(cert_path)
        await ctx.info(f"Encoded {cert_path} → {len(b64_value)} chars of base64 DER")
        return {
            "cert_name": cert_name,
            "user_cert_b64": b64_value,
            "usage_hint": (
                "Set this value as the X-User-Cert HTTP header on requests "
                "to the MCP server. The secure_api tools will read it "
                "automatically from the header."
            ),
        }

    # -----------------------------------------------------------------------
    # Tool: secure_api_status
    # Wraps: GET /status
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="secure_api_status",
        description=(
            "Check the status of the Secure API. Returns service info, "
            "version, and authentication configuration including the caller "
            "allow-list. Requires mTLS but does NOT require a user certificate."
        ),
    )
    async def secure_api_status(ctx: Context) -> SecureApiStatusResult:
        """
        Calls GET /status on the Secure API.

        The mTLS client cert is handled automatically by the shared
        secure_http_client configured in server.py lifespan().
        """
        await ctx.info("Checking Secure API status")
        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context[
            "secure_http_client"
        ]
        return await _call_secure_status(http_client, settings.secure_api_base_url)

    # -----------------------------------------------------------------------
    # Tool: secure_api_greeting
    # Wraps: GET /
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="secure_api_greeting",
        description=(
            "Send a greeting request to the Secure API on behalf of a user. "
            "Requires mTLS (handled automatically) and the user's public "
            "certificate in the X-User-Cert HTTP header. Returns the caller "
            "CN, user CN, and a greeting message."
        ),
    )
    async def secure_api_greeting(ctx: Context) -> SecureApiGreetingResult:
        """
        Calls GET / on the Secure API with the user's public cert in the
        X-User-Cert header (base64-encoded DER).

        The user cert is read from the incoming X-User-Cert HTTP header
        (set by the calling agent, propagated by UserCertMiddleware).
        """
        user_cert_b64 = get_user_cert()
        if not user_cert_b64:
            raise ValueError(
                "X-User-Cert header is required. The calling agent must send "
                "the user's public certificate as base64-encoded DER in this header."
            )
        await ctx.info("Sending greeting to Secure API")
        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context[
            "secure_http_client"
        ]
        return await _call_secure_greeting(
            http_client, settings.secure_api_base_url, user_cert_b64
        )

    # -----------------------------------------------------------------------
    # Tool: secure_api_data
    # Wraps: GET /data
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="secure_api_data",
        description=(
            "Fetch protected records from the Secure API on behalf of a user. "
            "Requires mTLS (handled automatically) and the user's public "
            "certificate in the X-User-Cert HTTP header. Returns the caller "
            "CN, user CN, and the protected data records."
        ),
    )
    async def secure_api_data(ctx: Context) -> SecureApiDataResult:
        """
        Calls GET /data on the Secure API with the user's public cert in the
        X-User-Cert header (base64-encoded DER).

        The user cert is read from the incoming X-User-Cert HTTP header
        (set by the calling agent, propagated by UserCertMiddleware).
        """
        user_cert_b64 = get_user_cert()
        if not user_cert_b64:
            raise ValueError(
                "X-User-Cert header is required. The calling agent must send "
                "the user's public certificate as base64-encoded DER in this header."
            )
        await ctx.info("Fetching protected data from Secure API")
        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context[
            "secure_http_client"
        ]
        return await _call_secure_data(
            http_client, settings.secure_api_base_url, user_cert_b64
        )
