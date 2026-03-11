"""
auth/obo.py – Layer 2: On-Behalf-Of (OBO) Token Exchange
===========================================================
This module provides the OBO helper that tools use to call downstream
protected APIs *as the requesting user*.

WHAT IS THE OBO FLOW AND WHY DO WE NEED IT?
============================================
Imagine this call chain:

    [User / AI Agent]
          |
          |  Bearer token (user's identity)
          v
    [This MCP Server]  <-- Layer 1 validates the token
          |
          |  We want to call Microsoft Graph (or your internal API)
          |  and have it see the USER's identity, not our service account.
          v
    [Downstream API]   <-- receives a new token still representing the user

Without OBO, the downstream API would see the MCP server's service identity,
which means:
  - Row-level security is broken (you'd get all rows, not just the user's).
  - Audit logs show the service account, not the real user.
  - Fine-grained permission checks can't be enforced.

The OBO flow solves this by exchanging tokens:
  1. The MCP server presents ITS OWN credentials to Entra ID.
  2. It ALSO presents the user's incoming token as proof that it's acting on
     behalf of that user.
  3. Entra ID issues a new token that identifies the user but is scoped to
     the downstream API.

PREREQUISITES
=============
  1. 'uv sync --extra auth' (installs msal)
  2. This server's app registration has delegated permissions to the
     downstream API (configured in Azure Portal > App Registrations >
     API Permissions).
  3. An admin has granted consent for those permissions.
  4. The MSAL ConfidentialClientApplication is initialised in server.py
     lifespan() and stored as lifespan_context["msal_app"].

USAGE (inside a tool in tools/your_feature.py)
================================================
    from auth.obo import get_obo_token

    async def my_tool(ctx: Context) -> dict:
        # Extract the user's token from the request (put there by Layer 1).
        auth_header = ctx.request_context.request.headers.get("Authorization", "")
        incoming_token = auth_header.removeprefix("Bearer ").strip()

        # Exchange it for a downstream-scoped token.
        msal_app = ctx.request_context.lifespan_context["msal_app"]
        graph_token = await get_obo_token(
            incoming_token=incoming_token,
            scopes=["https://graph.microsoft.com/User.Read"],
            msal_app=msal_app,
        )

        # Call the downstream API normally.
        async with httpx.AsyncClient() as client:
            r = await client.get(
                "https://graph.microsoft.com/v1.0/me",
                headers={"Authorization": f"Bearer {graph_token}"},
            )
            r.raise_for_status()
            return r.json()

USING CERT IDENTITY IN TOOLS (no OBO token exchange needed)
============================================================
When Layer 1 authentication is done with a client certificate rather than a
Bearer token, there is no incoming access token to exchange.  The user's
identity is expressed entirely by the certificate's claims.

There are TWO complementary mechanisms for working with certificates in tools:

A) FORWARDING THE RAW CERT TO A DOWNSTREAM API (X-User-Cert header)
--------------------------------------------------------------------
If the downstream API validates the certificate itself, your tool just
forwards the raw base-64 DER value using the ContextVar-based helper in
auth/user_cert_context.py:

    from auth.user_cert_context import get_user_cert

    async def my_tool(ctx: Context) -> dict:
        user_cert_b64 = get_user_cert()   # '' if header not present
        if not user_cert_b64:
            raise ValueError("X-User-Cert header required.")

        response = await secure_http_client.get(
            "https://downstream/data",
            headers={"X-User-Cert": user_cert_b64},
        )
        return response.json()

See tools/secure_api.py for a working example of this pattern.
The middleware (auth/user_cert_context.UserCertMiddleware) is always-on and
propagates the header value via a ContextVar — see its docstring for details.

B) EXTRACTING CERT CLAIMS FOR LOCAL ACCESS CONTROL
----------------------------------------------------
If the MCP server itself needs to read the certificate's subject, issuer,
or thumbprint (e.g. for security-trimming database queries), enable
ClientCertificateMiddleware from auth/verifier.py.  That middleware parses
the DER certificate, validates issuer/thumbprint against config, and stores
the parsed claims in the ASGI scope as scope["cert_identity"]:

    async def my_tool(ctx: Context) -> dict:
        # NOTE: FastMCP does not expose the raw ASGI scope to tools.
        # If you need parsed cert claims inside a tool, use a ContextVar
        # approach similar to auth/user_cert_context.py.
        # The verifier.py docstring shows how to extend the middleware
        # to set a ContextVar alongside (or instead of) scope["cert_identity"].
        ...

In most deployments you will use pattern (A) — forward the cert header.
Pattern (B) is for cases where the MCP server itself must inspect identity.

USING CERT IDENTITY TO CALL ENTRA ID-PROTECTED DOWNSTREAM APIs
---------------------------------------------------------------
If your tools also need to call services protected by Entra ID, you have
two paths (both require the 'auth' optional dependency group):

Path A – Service account (simplest, no per-user security trimming downstream)
    Acquire a token using the MCP server's own credentials:

        import msal
        # Initialise once in server.py lifespan():
        msal_app = msal.ConfidentialClientApplication(
            client_id=settings.azure_client_id,
            client_credential=settings.azure_client_secret,  # or a cert credential
            authority=f"https://login.microsoftonline.com/{settings.azure_tenant_id}",
        )
        # Inside the tool:
        result = msal_app.acquire_token_for_client(
            scopes=["https://graph.microsoft.com/.default"]
        )
        service_token = result["access_token"]
        # Call the downstream API as the MCP server's service principal.
        # The downstream API will see the service account, NOT the user.

Path B – Entra ID Certificate-Based Authentication (CBA) for per-user tokens
    Requires that the caller's certificate be linked to an Azure AD user account
    (configured in Entra ID under the user's Authentication methods).
    This lets you obtain a proper delegated access token for the user.

    Step 1: In the Azure Portal, enable CBA for the tenant:
              Entra ID → Security → Authentication methods → Certificate-based authentication
    Step 2: Upload or link the client certificate to the target user's account.
    Step 3: In your tool, use the MSAL CBA flow (acquire_token_by_username_password
            will NOT work for certs – use acquire_token_by_device_flow or the
            CBA-specific MSAL REST API call).  The practical approach today is:

        # Use the acquire_token_on_behalf_of equivalent for cert auth:
        # As of MSAL Python 1.28.x, the recommended path for cert principal OBO
        # is to configure the MCP server's Entra ID app to allow CBA, then
        # use a custom assertion flow.  Consult the MSAL Python docs for the
        # latest on "certificate-based OBO" as this area is evolving.
        # Reference: https://learn.microsoft.com/en-us/entra/identity/authentication/
        #            concept-certificate-based-authentication

DECISION GUIDE
--------------
  Your call uses a client cert and ...
    ... only calls this MCP server's own tools (no downstream APIs):
        → Use cert claims directly for authz/security trimming (Path above)
    ... needs to call a downstream API that requires mTLS (not Entra ID):
        → Configure the shared httpx.AsyncClient in server.py lifespan()
          with an ssl.SSLContext loaded with the MCP SERVER'S OWN cert.
          The user's cert is not involved – their private key never left
          their machine.  Forward the user's UPN via a trusted header
          (e.g. X-Forwarded-User) once the mTLS connection is established.
          The downstream API must only accept that header from this server's
          cert/IP – that trust is what makes the assertion secure.
          Full guide: _call_echo() docstring in tools/echo_api.py,
          and Pattern 5 in tools/example.py.
    ... needs to call a downstream API but per-user trimming is not required:
        → Use Path A (service account token)
    ... needs per-user security trimming downstream AND cert is linked to Entra ID user:
        → Use Path B (CBA delegated token)
    ... needs per-user trimming AND you also have a Bearer token:
        → Use the OBO flow below (get_obo_token)

---------------------------------------------------------------------------

CACHING
=======
MSAL's acquire_token_on_behalf_of() performs an automatic token cache
lookup before hitting the network.  The default in-memory cache works for
single-instance deployments.

For multi-instance Azure deployments (multiple Container App replicas),
use a distributed cache.  MSAL supports pluggable token caches:

    from msal_extensions import PersistedTokenCache, FilePersistence
    # Or use a Redis / Azure Cache for Redis-backed cache.
    cache = PersistedTokenCache(FilePersistence("/tmp/token_cache.bin"))
    msal_app = msal.ConfidentialClientApplication(..., token_cache=cache)

MULTIPLE DOWNSTREAM APIS
=========================
Call get_obo_token() once per downstream API with the appropriate scopes.
MSAL will cache each token separately.

    graph_token  = await get_obo_token(incoming_token, ["https://graph.microsoft.com/User.Read"], msal_app)
    my_api_token = await get_obo_token(incoming_token, ["api://my-internal-api/.default"], msal_app)
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # msal is in the optional 'auth' dependency group.
    # At runtime it is only imported when actually needed.
    import msal

logger = logging.getLogger(__name__)


async def get_obo_token(
    *,
    incoming_token: str,
    scopes: list[str],
    msal_app: "msal.ConfidentialClientApplication",
) -> str:
    """
    Exchange an incoming user Bearer token for a token scoped to a downstream API.

    Args:
        incoming_token: The validated Bearer token received by the MCP server.
                        Extract it from the Authorization header in the tool.
        scopes:         The OAuth 2.0 scopes for the downstream API.
                        Examples:
                          ["https://graph.microsoft.com/User.Read"]
                          ["api://my-internal-api/Data.Read"]
        msal_app:       The MSAL ConfidentialClientApplication instance
                        created in server.py lifespan() and stored in
                        the lifespan context.

    Returns:
        An access token string for use as:  Authorization: Bearer <token>

    Raises:
        RuntimeError: If the OBO exchange fails (includes the MSAL error detail).
        ValueError:   If incoming_token is empty.
    """

    if not incoming_token:
        raise ValueError("incoming_token must not be empty. Has Layer 1 auth been configured?")

    # MSAL's acquire_token_on_behalf_of is synchronous; we run it in a
    # thread-pool executor so it does not block the asyncio event loop.
    loop = asyncio.get_running_loop()

    def _sync_obo() -> dict:
        return msal_app.acquire_token_on_behalf_of(
            user_assertion=incoming_token,
            scopes=scopes,
        )

    result: dict = await loop.run_in_executor(None, _sync_obo)

    if "access_token" not in result:
        error = result.get("error", "unknown_error")
        description = result.get("error_description", "No description provided.")
        logger.error("OBO token exchange failed: %s – %s", error, description)
        raise RuntimeError(f"OBO token exchange failed ({error}): {description}")

    logger.debug("OBO token successfully acquired for scopes: %s", scopes)
    return result["access_token"]
