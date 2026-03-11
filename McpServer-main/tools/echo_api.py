"""
tools/echo_api.py – Simple Echo API Tools
==========================================
These tools wrap the Simple Echo API defined in openapi.json.
They demonstrate the recommended pattern for calling an external HTTP API:

  1. Pydantic models mirror the API's response schemas (machine-readable output).
  2. Private _call_* functions contain the HTTP logic and are unit-testable
     without a running MCP server (see tests/test_tools.py).
  3. Public @mcp.tool() wrappers pull the shared httpx.AsyncClient from the
     lifespan context and delegate to the private functions.

CONFIGURATION
-------------
Set ECHO_API_BASE_URL in .env (or as an Azure Application Setting):
    ECHO_API_BASE_URL=https://your-api.azurewebsites.net

The httpx.AsyncClient is created ONCE at server startup in server.py lifespan()
and reused for every request. This avoids the overhead of opening a new TCP
connection per tool call.

ADDING MORE API WRAPPERS
------------------------
Copy this file as a template:
  1. Replace the Pydantic response models with your API's schemas.
  2. Implement _call_* functions for each endpoint you want to expose.
  3. Register them in register_*_tools() and add two lines to tools/__init__.py.
"""

import logging
from datetime import datetime
from typing import Annotated

import httpx
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field

from config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Response models
# These mirror the API's JSON schemas exactly so Pydantic validates the
# response and FastMCP can generate accurate JSON Schema for the LLM.
# ---------------------------------------------------------------------------

class EchoApiResult(BaseModel):
    """Response from the /echo endpoint."""
    echo: str = Field(description="The echoed message (may be transformed by the API).")
    original_message: str = Field(description="The original message as received by the API.")


class CompanyInfo(BaseModel):
    """Core company identity information."""
    name: str = Field(description="Company name.")
    description: str = Field(description="Short company description.")
    industry: str = Field(description="Industry sector.")
    founded_year: int = Field(description="Year the company was founded.")
    headquarters: str = Field(description="Headquarters location.")


class LocationInfo(BaseModel):
    """Physical location details for a company."""
    address: str = Field(description="Street address.")
    city: str = Field(description="City.")
    country: str = Field(description="Country (non-US per the API's data).")
    postal_code: str = Field(description="Postal / ZIP code.")
    coordinates: str | None = Field(default=None, description="GPS coordinates as 'lat,lon' or None.")


class IPCompanyResult(BaseModel):
    """Response from the IP company lookup endpoint."""
    original_ip: str = Field(description="The IP address that was looked up.")
    company: CompanyInfo = Field(description="Fictional company attributed to this IP.")
    associated_ips: list[str] = Field(description="Other IP addresses associated with the same company.")
    location: LocationInfo = Field(description="Company location details.")
    confidence_score: float = Field(ge=0.0, le=1.0, description="Attribution confidence (0.0 = low, 1.0 = certain).")


class DeviceInfo(BaseModel):
    """A single device entry in a company's network inventory."""
    ip_address: str = Field(description="IPv4 address of the device.")
    device_type: str = Field(description="Device type, e.g. 'server', 'router', 'workstation'.")
    hostname: str = Field(description="Hostname of the device.")
    location: str = Field(description="Physical location of the device.")
    last_seen: datetime = Field(description="UTC datetime the device was last seen online.")


class CompanyDevicesResult(BaseModel):
    """Response from the company devices endpoint."""
    company_name: str = Field(description="The company name that was queried.")
    total_devices: int = Field(ge=0, description="Total number of devices returned.")
    devices: list[DeviceInfo] = Field(description="Full device inventory list.")
    network_summary: str = Field(description="Prose summary of the company's network infrastructure.")


class CompanySummaryResult(BaseModel):
    """Response from the company summary endpoint."""
    company: CompanyInfo = Field(description="Core company information.")
    location: LocationInfo = Field(description="Company location details.")
    business_summary: str = Field(description="Detailed business description.")
    key_facts: list[str] = Field(description="Bullet-point key facts about the company.")
    recent_news: list[str] = Field(description="Fictional recent news headlines about the company.")


# ---------------------------------------------------------------------------
# Private implementation functions
#
# Keeping HTTP logic here (outside the @mcp.tool() closures) means these
# functions can be called directly in tests without a running MCP server.
# See tests/test_tools.py for the mock-based unit test pattern.
# ---------------------------------------------------------------------------

async def _call_echo(
    message: str,
    http_client: httpx.AsyncClient,
    base_url: str,
    extra_headers: dict[str, str] | None = None,
) -> EchoApiResult:
    """
    Call GET /echo/{message} and return the parsed response.

    The optional `extra_headers` dict is merged into the outgoing request.
    Use it to forward user identity to the downstream API (see the
    `echo_external` tool wrapper below for the full pattern).

    -------------------------------------------------------------------------
    HOW CERTIFICATE AUTHENTICATION WORKS ACROSS THE FULL CALL CHAIN
    -------------------------------------------------------------------------
    There are TWO separate cert relationships and it is important not to
    confuse them.  The private key for a certificate NEVER leaves the machine
    that owns it, so you cannot "forward" a cert on someone else's behalf.

    SIDE A – Inbound: Agent (or caller) → this MCP server
    -------------------------------------------------------
    The calling agent (or application) holds its own cert + private key and
    performs a normal mTLS handshake with the platform in front of this server
    (Azure App Service, APIM, nginx, etc.).  The platform:
      1. Validates the cert (signature chain, expiry, issuer).
      2. Terminates the TLS connection.
      3. Injects the cert *claims* (subject, UPN, thumbprint, etc.) into an
         HTTP header that it forwards to this server.
    By the time the request arrives here the private key is gone – this server
    only ever sees the extracted identity claims.  `ClientCertificateMiddleware`
    in auth/verifier.py parses that header and stores the claims in:
        request.scope["cert_identity"]  →  {"upn": "...", "cn": "...", ...}
    See the `echo_external` tool wrapper below for how to read them.

    SIDE B – Outbound: this MCP server → Echo API
    -----------------------------------------------
    This server is a trusted service proxy.  If the Echo API requires client
    cert auth, the MCP server presents *its own* cert during the TLS handshake.
    Configure this once in server.py lifespan() when creating the http_client:

        import ssl

        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ssl_ctx.load_cert_chain(
            certfile=settings.echo_api_client_cert_path,   # PEM cert
            keyfile=settings.echo_api_client_key_path,     # PEM private key
        )
        # Optional: pin a private CA cert instead of trusting the system store
        # ssl_ctx.load_verify_locations(settings.echo_api_ca_cert_path)
        ssl_ctx.check_hostname = True
        ssl_ctx.verify_mode = ssl.CERT_REQUIRED

        http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
            verify=ssl_ctx,     # <-- the MCP server's own cert, not the user's
        )
        yield {"http_client": http_client}

    All _call_* functions share the same client, so this single change covers
    every downstream call this server makes.

    FORWARDING USER IDENTITY DOWNSTREAM
    ------------------------------------
    Because the Echo API trusts this MCP server's cert (Side B), it can safely
    trust any identity assertion the MCP server also sends – typically as a
    custom HTTP header such as X-Forwarded-User.  The Echo API must never
    accept such a header from untrusted callers; the mTLS trust is what makes
    the assertion secure.

    The `extra_headers` parameter on this function is the mechanism.  Populate
    it in the tool wrapper (see `echo_external` below) from the cert_identity
    extracted by ClientCertificateMiddleware on Side A.

    COMPARISON WITH ENTRA ID OBO
    ----------------------------
    This is the cert-auth analogue of the OBO (On-Behalf-Of) token exchange:
      - OBO:  incoming Bearer token  → exchange for scoped downstream token.
      - mTLS: incoming cert identity → server authenticates downstream with its
              own cert and asserts the user's identity via a trusted header.
    Both patterns decouple "who called me" from "how I authenticate downstream".

    SECRET STORAGE
    --------------
    Never hard-code cert paths.  Add the paths/thumbprints to config.py and
    read from environment variables.  On Azure Container Apps, mount the cert
    as a Key Vault secret volume.  On App Service, use WEBSITE_LOAD_CERTIFICATES
    with the cert's thumbprint and load it from the Windows cert store.
    """
    try:
        response = await http_client.get(
            f"{base_url}/echo/{message}",
            headers=extra_headers or {},
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Echo API returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Echo API at {base_url}: {exc}") from exc
    return EchoApiResult.model_validate(response.json())


async def _call_lookup_ip_company(
    ip_address: str,
    http_client: httpx.AsyncClient,
    base_url: str,
) -> IPCompanyResult:
    """Call GET /api/v1/ip-company/{ip_address} and return the parsed response."""
    try:
        response = await http_client.get(f"{base_url}/api/v1/ip-company/{ip_address}")
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"IP Company API returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Echo API at {base_url}: {exc}") from exc
    return IPCompanyResult.model_validate(response.json())


async def _call_get_company_devices(
    company_name: str,
    http_client: httpx.AsyncClient,
    base_url: str,
) -> CompanyDevicesResult:
    """Call GET /api/v1/company-devices/{company_name} and return the parsed response."""
    try:
        response = await http_client.get(f"{base_url}/api/v1/company-devices/{company_name}")
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Company Devices API returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Echo API at {base_url}: {exc}") from exc
    return CompanyDevicesResult.model_validate(response.json())


async def _call_get_company_summary(
    company_name: str,
    http_client: httpx.AsyncClient,
    base_url: str,
) -> CompanySummaryResult:
    """Call GET /api/v1/company-summary/{company_name} and return the parsed response."""
    try:
        response = await http_client.get(f"{base_url}/api/v1/company-summary/{company_name}")
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"Company Summary API returned HTTP {exc.response.status_code}: {exc.response.text}"
        ) from exc
    except httpx.RequestError as exc:
        raise RuntimeError(f"Could not reach Echo API at {base_url}: {exc}") from exc
    return CompanySummaryResult.model_validate(response.json())


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------

def register_echo_api_tools(mcp: FastMCP) -> None:
    """Register all Simple Echo API tools with the MCP server."""

    # -----------------------------------------------------------------------
    # Tool: echo_external
    # Wraps: GET /echo/{message}
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="echo_external",
        description=(
            "Send a message to the external Simple Echo API and receive it back. "
            "Returns the echoed text and the original message as sent."
        ),
    )
    async def echo_external(
        message: Annotated[str, Field(description="The text to send to the echo API.")],
        ctx: Context,
    ) -> EchoApiResult:
        """
        Calls GET /echo/{message} on the configured Simple Echo API
        (ECHO_API_BASE_URL).  Useful for connectivity tests.
        """
        await ctx.info(f"Calling echo API with message: {message!r}")

        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context["http_client"]

        # ------------------------------------------------------------------
        # FORWARDING USER IDENTITY WHEN CERT AUTH IS ENABLED
        # ------------------------------------------------------------------
        # If ClientCertificateMiddleware (auth/verifier.py) is active, it
        # has already validated the inbound client cert and extracted the
        # user's identity into request.scope["cert_identity"].  The private
        # key is NOT here – it stayed on the calling agent.  What we have is
        # only the verified identity claims (UPN, subject, etc.).
        #
        # The http_client is configured in server.py lifespan() with the
        # MCP server's own cert for its outbound mTLS connection to the
        # Echo API.  Because the Echo API trusts that server cert, it can
        # also trust identity assertions the server adds as HTTP headers.
        #
        # To enable this pattern, replace the call below with:
        #
        #   identity = ctx.request_context.request.scope.get("cert_identity", {})
        #   upn = identity.get("upn", "")
        #   if not upn:
        #       raise ValueError("No UPN in client certificate – cannot identify caller.")
        #   extra_headers = {"X-Forwarded-User": upn}
        #   return await _call_echo(message, http_client, settings.echo_api_base_url, extra_headers)
        #
        # The X-Forwarded-User header name is a convention; agree it with
        # the Echo API team and ensure the API ONLY accepts it from this
        # server's IP/cert (otherwise any caller could spoof the header).
        # ------------------------------------------------------------------

        return await _call_echo(message, http_client, settings.echo_api_base_url)

    # -----------------------------------------------------------------------
    # Tool: lookup_ip_company
    # Wraps: GET /api/v1/ip-company/{ip_address}
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="lookup_ip_company",
        description=(
            "Look up the company associated with an IP address. "
            "Returns company details, related IP ranges, location, "
            "and a confidence score (0.0–1.0)."
        ),
    )
    async def lookup_ip_company(
        ip_address: Annotated[
            str,
            Field(description="IPv4 address to look up, e.g. '203.0.113.42'."),
        ],
        ctx: Context,
    ) -> IPCompanyResult:
        """
        Calls GET /api/v1/ip-company/{ip_address}.

        Returns fictional attribution data: the company linked to the IP,
        other IPs associated with that company, their location, and a
        confidence score indicating how reliable the attribution is.
        """
        await ctx.info(f"Looking up company for IP: {ip_address}")
        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context["http_client"]
        return await _call_lookup_ip_company(ip_address, http_client, settings.echo_api_base_url)

    # -----------------------------------------------------------------------
    # Tool: get_company_devices
    # Wraps: GET /api/v1/company-devices/{company_name}
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="get_company_devices",
        description=(
            "Get the network device inventory for a company: IP addresses, "
            "hostnames, device types, locations, and last-seen timestamps."
        ),
    )
    async def get_company_devices(
        company_name: Annotated[
            str,
            Field(description="The company name whose devices should be listed."),
        ],
        ctx: Context,
    ) -> CompanyDevicesResult:
        """
        Calls GET /api/v1/company-devices/{company_name}.

        Returns a list of all devices attributed to the company along with
        a prose summary of the company's network infrastructure.
        """
        await ctx.info(f"Getting devices for company: {company_name!r}")
        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context["http_client"]
        return await _call_get_company_devices(company_name, http_client, settings.echo_api_base_url)

    # -----------------------------------------------------------------------
    # Tool: get_company_summary
    # Wraps: GET /api/v1/company-summary/{company_name}
    # -----------------------------------------------------------------------
    @mcp.tool(
        name="get_company_summary",
        description=(
            "Get a comprehensive profile of a company: industry details, "
            "headquarters, key facts, and recent news."
        ),
    )
    async def get_company_summary(
        company_name: Annotated[
            str,
            Field(description="The company name to summarise."),
        ],
        ctx: Context,
    ) -> CompanySummaryResult:
        """
        Calls GET /api/v1/company-summary/{company_name}.

        Returns a detailed company profile including CompanyInfo, LocationInfo,
        a free-text business summary, bullet-point key facts, and recent
        fictitious news items.
        """
        await ctx.info(f"Getting summary for company: {company_name!r}")
        http_client: httpx.AsyncClient = ctx.request_context.lifespan_context["http_client"]
        return await _call_get_company_summary(company_name, http_client, settings.echo_api_base_url)
