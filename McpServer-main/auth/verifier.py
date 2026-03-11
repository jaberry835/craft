"""
auth/verifier.py – Layer 1: MCP Server Access Authentication
===============================================================
This module contains guidance and stubs for validating who is allowed to
call this MCP server.

TWO LAYERS OF AUTHENTICATION
==============================

  Layer 1 – Who can call the MCP server?  (THIS FILE)
  ----------------------------------------------------
  Implemented as ASGI middleware that runs before any tool is invoked.
  Every HTTP request is checked for a valid Bearer token, API key, or
  client certificate depending on which mechanism you choose.

  Layer 2 – What can individual tools do on behalf of the user?  (auth/obo.py)
  -----------------------------------------------------------------------------
  Implemented inside specific tools.  The tool takes the user's validated
  identity (from the token or the cert) and uses it to call downstream APIs
  with the user's own permissions.  The exact technique differs per auth method:
    - Entra ID Bearer → OBO token exchange (see auth/obo.py)
    - Client certificate → cert claim extraction (see ClientCertificateMiddleware
      below and the USING CERT IDENTITY IN TOOLS section in auth/obo.py)

CHOOSING A BEARER TOKEN PROVIDER
==================================
Any standards-compliant OIDC provider that issues RS256-signed JWTs will work.
The GenericOidcBearerTokenMiddleware validates tokens from ANY provider —
you just configure three settings:

  OIDC_JWKS_URI   – where to fetch the provider's public signing keys
  OIDC_ISSUER     – expected 'iss' claim in the JWT
  OIDC_AUDIENCE   – expected 'aud' claim in the JWT

Common examples:

  Provider         OIDC_JWKS_URI                                                          OIDC_ISSUER
  ──────────────── ──────────────────────────────────────────────────────────────────────── ──────────────────────────────────────────────────
  Azure Entra ID   https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys          https://login.microsoftonline.com/{tenant}/v2.0
  AWS Cognito      https://cognito-idp.{region}.amazonaws.com/{pool_id}/.well-known/jwks.json   https://cognito-idp.{region}.amazonaws.com/{pool_id}
  Okta             https://{okta-domain}/oauth2/default/v2/keys                           https://{okta-domain}/oauth2/default
  Auth0            https://{auth0-domain}/.well-known/jwks.json                            https://{auth0-domain}/
  Keycloak         https://{host}/realms/{realm}/protocol/openid-connect/certs             https://{host}/realms/{realm}

For Azure Entra ID specifically, a convenience wrapper (EntraIDBearerTokenMiddleware)
is provided that computes the JWKS URI and issuer from just the tenant ID.

IMPLEMENTATION ROADMAP (Generic OIDC)
======================================
STEP 1 – Install auth dependencies
    uv sync --extra auth
    # Adds: PyJWT[crypto] (and msal, azure-identity if you also need OBO)

STEP 2 – Configure settings (config.py + .env)
    Uncomment the OIDC fields in config.py and add values to .env:
      OIDC_JWKS_URI=<your-provider's-jwks-endpoint>
      OIDC_ISSUER=<your-provider's-issuer-url>
      OIDC_AUDIENCE=<your-api-identifier-or-client-id>

STEP 3 – Activate the middleware in server.py
    In create_app(), uncomment the middleware block:
      from auth.verifier import GenericOidcBearerTokenMiddleware
      app.add_middleware(
          GenericOidcBearerTokenMiddleware,
          jwks_uri=settings.oidc_jwks_uri,
          issuer=settings.oidc_issuer,
          audience=settings.oidc_audience,
      )

IMPLEMENTATION ROADMAP (Azure Entra ID convenience wrapper)
============================================================
STEP 1 – Install auth dependencies
    uv sync --extra auth

STEP 2 – Create the App Registration in Azure Portal
  a) Create "App Registration A" for this MCP server (the resource / API).
     - Add an Application ID URI:  api://<client-id>
     - Add a scope:  api://<client-id>/mcp.access  (used by callers)
     - Add a client secret (or upload a certificate).
  b) Create "App Registration B" for each calling application.
     - Grant it the scope from App Registration A.

STEP 3 – Configure settings (config.py + .env)
    Uncomment the Entra ID fields in config.py and add values to .env:
      AZURE_TENANT_ID=<your-tenant-id>
      AZURE_CLIENT_ID=<server-app-registration-client-id>
      AZURE_CLIENT_SECRET=<server-app-registration-client-secret>
      EXPECTED_AUDIENCE=api://<server-app-registration-client-id>

STEP 4 – Activate the middleware in server.py
    from auth.verifier import EntraIDBearerTokenMiddleware
    app.add_middleware(
        EntraIDBearerTokenMiddleware,
        tenant_id=settings.azure_tenant_id,
        audience=settings.expected_audience,
    )

STEP 5 – Initialise MSAL in server.py lifespan() (if using OBO)
    import msal
    msal_app = msal.ConfidentialClientApplication(
        client_id=settings.azure_client_id,
        client_credential=settings.azure_client_secret,
        authority=f"https://login.microsoftonline.com/{settings.azure_tenant_id}",
    )
    yield {"msal_app": msal_app}

STEP 6 – Add OBO calls to individual tools (see auth/obo.py)

ALTERNATIVE: API Key Authentication
-------------------------------------
For simpler scenarios (internal APIs, development environments) you can use
a static API key.  The stub is included in the ApiKeyMiddleware class below.
Note: API keys do not support OBO flows – use Entra ID for those.

ALTERNATIVE: Client Certificate (mTLS) Authentication
-------------------------------------------------------
For enterprise B2B scenarios where the calling system (AI agent host, internal
service) is identified by an X.509 certificate rather than a password or token.
The stub and full implementation guide are in the ClientCertificateMiddleware
class below.  Identity propagation to tools is covered in auth/obo.py.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# ===========================================================================
# GenericOidcBearerTokenMiddleware
# ===========================================================================
# CURRENT STATE: Passthrough stub (no validation performed).
# ACTIVATE: Replace the __call__ body with the full implementation shown in
#           the class docstring, then follow the STEP guide above.
#
# Works with ANY OIDC-compliant identity provider (Azure Entra ID, AWS
# Cognito, Okta, Auth0, Keycloak, PingFederate, etc.).
# ===========================================================================
class GenericOidcBearerTokenMiddleware:
    """
    ASGI middleware that validates Bearer tokens from any OIDC provider.

    Constructor args (all from config.py / .env):
        jwks_uri  – The provider's JWKS endpoint (public signing keys).
        issuer    – Expected 'iss' claim in the JWT.
        audience  – Expected 'aud' claim in the JWT.

    FULL IMPLEMENTATION (copy-paste when ready)
    --------------------------------------------
    Replace the __call__ body below with this production-ready implementation.
    Requires:  uv sync --extra auth  (installs PyJWT[crypto])

        import jwt                      # pip install PyJWT[crypto]
        from jwt import PyJWKClient

        class GenericOidcBearerTokenMiddleware:
            def __init__(self, app, *, jwks_uri: str, issuer: str, audience: str) -> None:
                self.app = app
                self._issuer = issuer
                self._audience = audience
                self._jwks_client = PyJWKClient(
                    jwks_uri,
                    cache_keys=True,   # Cache keys; one HTTPS fetch per key rotation
                )

            async def __call__(self, scope, receive, send) -> None:
                if scope["type"] == "http":
                    headers = {k: v for k, v in scope.get("headers", [])}
                    raw_auth = headers.get(b"authorization", b"").decode()

                    if not raw_auth.startswith("Bearer "):
                        await _send_401(scope, receive, send, "Missing Bearer token")
                        return

                    token = raw_auth.split(" ", 1)[1]
                    try:
                        signing_key = self._jwks_client.get_signing_key_from_jwt(token)
                        jwt.decode(
                            token,
                            signing_key,
                            algorithms=["RS256"],
                            audience=self._audience,
                            issuer=self._issuer,
                        )
                    except jwt.PyJWTError as exc:
                        logger.warning("Token validation failed: %s", exc)
                        await _send_401(scope, receive, send, "Invalid token")
                        return

                await self.app(scope, receive, send)
    """

    def __init__(self, app: Any, *, jwks_uri: str = "", issuer: str = "", audience: str = "") -> None:
        self.app = app
        self._jwks_uri = jwks_uri
        self._issuer = issuer
        self._audience = audience
        logger.warning(
            "GenericOidcBearerTokenMiddleware is currently a NO-OP STUB. "
            "Follow the steps in auth/verifier.py to enable real validation."
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        # STUB: passes all requests through without validating the token.
        # Replace this entire method body with the implementation in the docstring.
        await self.app(scope, receive, send)


# ===========================================================================
# EntraIDBearerTokenMiddleware – convenience wrapper for Azure Entra ID
# ===========================================================================
# Computes the JWKS URI and issuer URL from the tenant ID so Azure shops
# only need to configure AZURE_TENANT_ID + EXPECTED_AUDIENCE.
# Under the hood it delegates to GenericOidcBearerTokenMiddleware.
#
# If you are NOT using Azure Entra ID, use GenericOidcBearerTokenMiddleware
# directly with OIDC_JWKS_URI / OIDC_ISSUER / OIDC_AUDIENCE.
# ===========================================================================
_ENTRA_JWKS_TEMPLATE = (
    "https://login.microsoftonline.com/{tenant_id}"
    "/discovery/v2.0/keys"
)
_ENTRA_ISSUER_TEMPLATE = (
    "https://login.microsoftonline.com/{tenant_id}/v2.0"
)


class EntraIDBearerTokenMiddleware:
    """
    Thin wrapper around GenericOidcBearerTokenMiddleware that fills in the
    Microsoft-specific JWKS and issuer URLs from just the tenant_id.

    Usage in server.py create_app():
        from auth.verifier import EntraIDBearerTokenMiddleware
        app.add_middleware(
            EntraIDBearerTokenMiddleware,
            tenant_id=settings.azure_tenant_id,
            audience=settings.expected_audience,
        )
    """

    def __init__(self, app: Any, *, tenant_id: str = "", audience: str = "") -> None:
        self._inner = GenericOidcBearerTokenMiddleware(
            app,
            jwks_uri=_ENTRA_JWKS_TEMPLATE.format(tenant_id=tenant_id),
            issuer=_ENTRA_ISSUER_TEMPLATE.format(tenant_id=tenant_id),
            audience=audience,
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self._inner(scope, receive, send)


# ===========================================================================
# ApiKeyMiddleware (alternative – simpler but no OBO support)
# ===========================================================================
class ApiKeyMiddleware:
    """
    Simple API key middleware for scenarios that do not require OBO.

    Usage (server.py create_app):
        from auth.verifier import ApiKeyMiddleware
        app.add_middleware(
            ApiKeyMiddleware,
            api_key=settings.api_key,
            header_name="X-Api-Key",   # or "Authorization" with "ApiKey <key>"
        )

    Clients must send:
        X-Api-Key: <your-secret-key>

    SECURITY NOTE
    -------------
    - Store the key in Azure Key Vault and load it via an environment variable.
    - Rotate keys regularly.
    - This mechanism does NOT support user-identity-aware OBO flows.
      Use Entra ID if you need per-user token delegation.
    """

    def __init__(
        self,
        app: Any,
        *,
        api_key: str,
        header_name: str = "X-Api-Key",
    ) -> None:
        self.app = app
        self._api_key = api_key.encode()
        self._header_name = header_name.lower().encode()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            provided = headers.get(self._header_name, b"")
            if provided != self._api_key:
                await _send_401(scope, receive, send, "Invalid or missing API key")
                return
        await self.app(scope, receive, send)


# ===========================================================================
# ClientCertificateMiddleware – mTLS / client certificate identity
# ===========================================================================
# CURRENT STATE: Passthrough stub (no validation performed).
# ACTIVATE: Replace the __call__ body with the full implementation shown in
#           the class docstring, then follow the STEP guide in the docstring.
# ===========================================================================
class ClientCertificateMiddleware:
    """
    ASGI middleware that authenticates callers by their X.509 client certificate.

    WHY USE THIS INSTEAD OF BEARER TOKENS?
    ---------------------------------------
    Client certificate auth is preferred in several scenarios:
      - System-to-system (B2B) integrations where the caller is a service, not
        a human, and issuing OAuth clients is operationally heavyweight.
      - Environments where PKI is already the enterprise standard.
      - Zero-trust architectures that mandate mutual TLS (mTLS) for every call.
      - When the certificate itself carries rich identity claims (UPN, email,
        department) issued by an enterprise CA.

    HOW AZURE DELIVERS THE CERTIFICATE TO YOUR CODE
    ------------------------------------------------
    Azure does NOT pass client certs directly to the application over TCP.
    Instead the platform terminates TLS and forwards the validated certificate
    in an HTTP header.  Which header depends on the hosting service:

      Azure App Service
        Header: X-ARR-ClientCert
        Value:  Base64-encoded DER (no PEM markers)
        Enable: az webapp update \\
                    --name <app> \\
                    --resource-group <rg> \\
                    --client-cert-enabled true \\
                    --client-cert-mode Required

      Azure API Management (APIM) in front of Container Apps
        Header: Configure in APIM policy – common choices:
                  X-Client-Cert-Subject  (extracted CN/subject)
                  X-Client-Cert-Thumbprint
                  X-Client-Cert           (base64 DER, full cert)
        APIM validates the cert itself; your code only needs to trust
        the forwarded header (and protect the backend from direct access).

      Self-managed nginx / ingress
        Header: ssl_client_cert (NGINX) or similar.
        Must be configured explicitly in the ingress config.

    SECURITY WARNING – HEADER SPOOFING
    ------------------------------------
    Because the certificate arrives as an HTTP header, a malicious caller
    who can reach the app directly (bypassing the Azure front-end) could
    craft a fake header.  Mitigate this by:
      1. Restricting inbound traffic to the Azure platform's IP ranges only.
         (App Service: IP restrictions; Container Apps: VNet integration)
      2. Verifying the cert's issuer against a trusted CA allowlist.
      3. Optionally verifying the cert's thumbprint against a known-good list.

    FULL IMPLEMENTATION (copy-paste when ready)
    --------------------------------------------
    Replace the __call__ body below with this implementation.
    Requires: the 'cryptography' package (already a transitive dependency).

        import base64
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes
        from cryptography.x509.oid import ExtensionOID, NameOID
        import datetime

        class ClientCertificateMiddleware:
            def __init__(
                self,
                app,
                *,
                cert_header: str = "X-ARR-ClientCert",
                allowed_issuers: list[str] | None = None,   # e.g. ["CN=My Enterprise CA"]
                allowed_thumbprints: list[str] | None = None,  # SHA-256 hex strings
            ) -> None:
                self.app = app
                self._cert_header = cert_header.lower().encode()
                self._allowed_issuers = allowed_issuers or []
                self._allowed_thumbprints = allowed_thumbprints or []

            async def __call__(self, scope, receive, send) -> None:
                if scope["type"] == "http":
                    headers = {k.lower(): v for k, v in scope.get("headers", [])}
                    raw_b64 = headers.get(self._cert_header, b"")

                    if not raw_b64:
                        await _send_401(scope, receive, send, "Client certificate required")
                        return

                    try:
                        der = base64.b64decode(raw_b64)
                        cert = x509.load_der_x509_certificate(der)
                    except Exception:
                        await _send_401(scope, receive, send, "Malformed client certificate")
                        return

                    # 1. Check expiry.
                    now = datetime.datetime.now(datetime.timezone.utc)
                    if cert.not_valid_before_utc > now or cert.not_valid_after_utc < now:
                        await _send_401(scope, receive, send, "Client certificate is expired")
                        return

                    # 2. Check issuer allowlist (if configured).
                    issuer = cert.issuer.rfc4514_string()
                    if self._allowed_issuers and issuer not in self._allowed_issuers:
                        await _send_401(scope, receive, send, "Untrusted certificate issuer")
                        return

                    # 3. Check thumbprint allowlist (if configured).
                    if self._allowed_thumbprints:
                        thumbprint = cert.fingerprint(hashes.SHA256()).hex()
                        if thumbprint not in self._allowed_thumbprints:
                            await _send_401(scope, receive, send, "Certificate thumbprint not allowed")
                            return

                    # 4. Extract identity claims and attach them to the ASGI scope
                    #    so tools can read them (see USING CERT IDENTITY IN TOOLS
                    #    in auth/obo.py for how to read these in a tool).
                    subject_cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
                    upn = _extract_upn_from_san(cert)   # see helper below
                    scope.setdefault("cert_identity", {
                        "subject": cert.subject.rfc4514_string(),
                        "cn": subject_cn[0].value if subject_cn else "",
                        "upn": upn,
                        "issuer": issuer,
                        "thumbprint": cert.fingerprint(hashes.SHA256()).hex(),
                        "not_after": cert.not_valid_after_utc.isoformat(),
                    })

                await self.app(scope, receive, send)

        def _extract_upn_from_san(cert: x509.Certificate) -> str:
            \"\"\"
            Extract the User Principal Name (UPN) from the Subject Alternative
            Name extension's otherName field.  Enterprise CAs typically embed
            the AD UPN (user@domain.com) here.
            Returns an empty string if no UPN is found.
            \"\"\"
            try:
                san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME)
                for name in san.value:
                    # UPN is encoded as an rfc822Name (email) or as an otherName
                    # with OID 1.3.6.1.4.1.311.20.2.3 (szOID_NT_PRINCIPAL_NAME).
                    if hasattr(name, "value") and "@" in str(getattr(name, "value", "")):
                        return str(name.value)
            except Exception:
                pass
            return ""

    STEP GUIDE (follow in order)
    ----------------------------
    STEP 1: Decide which Azure service forwards the cert and note the header name.
    STEP 2: Restrict direct-to-app network access (VNet / IP allowlist).
    STEP 3: Add allowed_issuers and/or allowed_thumbprints to the middleware init.
    STEP 4: Activate in server.py create_app():

        from auth.verifier import ClientCertificateMiddleware
        app.add_middleware(
            ClientCertificateMiddleware,
            cert_header="X-ARR-ClientCert",       # adjust for your platform
            allowed_issuers=["CN=My Enterprise CA, O=Contoso"],
        )

    STEP 5: In tools that need to act on the cert identity, read the claims
            injected into the ASGI scope.  See the CERT IDENTITY section in
            auth/obo.py for ready-to-use patterns, and Pattern 5 in
            tools/example.py for a commented stub you can copy.

    INBOUND vs OUTBOUND mTLS – THEY ARE INDEPENDENT
    -------------------------------------------------
    This middleware handles INBOUND validation only.  It answers:
    "Is the entity calling this MCP server who they claim to be?"

    A certificate's private key NEVER leaves the machine that owns it.
    The calling agent's private key stays with the agent.  The platform
    (App Service, APIM, nginx) uses it to verify the TLS handshake and
    then discards the connection.  This middleware only ever sees the
    extracted cert claims that the platform forwards in an HTTP header.
    There is no way to "pass on" or "forward" someone else's cert –
    only their verified identity claims (UPN, CN, thumbprint, etc.).

    For OUTBOUND mTLS (this MCP server calling another API that requires
    a client certificate), configure the MCP SERVER'S OWN ssl.SSLContext
    on the shared httpx.AsyncClient in server.py lifespan():

        import ssl
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ssl_ctx.load_cert_chain(
            certfile=settings.downstream_api_cert_path,   # this server's cert
            keyfile=settings.downstream_api_key_path,     # this server's key
        )
        http_client = httpx.AsyncClient(verify=ssl_ctx, ...)
        yield {"http_client": http_client}

    Once the outbound mTLS connection is established, the downstream API
    trusts this server and can also trust a user identity header the server
    adds (e.g. X-Forwarded-User: alice@contoso.com).  The downstream API
    MUST only accept that header over the mTLS connection, not from arbitrary
    callers.  Full guide: _call_echo() docstring in tools/echo_api.py.

    COMBINING WITH ENTRA ID OBO
    ----------------------------
    If your downstream APIs are protected by Entra ID, you have two options
    once the cert identity is verified:

    Option A – Certificate-based Entra ID token acquisition
        Use MSAL to acquire an Entra ID token on behalf of the cert identity.
        This works when the certificate is registered in Entra ID as a
        credential for a service principal or as a user certificate linked
        to an Azure AD user.  See the MSAL docs for
        acquire_token_by_client_credentials with a certificate credential.

    Option B – UPN-based delegated token (requires federated trust setup)
        If the cert's UPN matches an Azure AD user, you can use the
        Azure AD certificate-based authentication (CBA) flow to acquire
        a delegated access token for that user without a password.
        This is more complex but preserves full user-level security trimming.
        Docs: https://learn.microsoft.com/en-us/entra/identity/authentication/
              concept-certificate-based-authentication
    """

    def __init__(
        self,
        app: Any,
        *,
        cert_header: str = "X-ARR-ClientCert",
        allowed_issuers: list[str] | None = None,
        allowed_thumbprints: list[str] | None = None,
    ) -> None:
        self.app = app
        self._cert_header = cert_header
        self._allowed_issuers = allowed_issuers or []
        self._allowed_thumbprints = allowed_thumbprints or []
        logger.warning(
            "ClientCertificateMiddleware is currently a NO-OP STUB. "
            "Follow the steps in auth/verifier.py to enable real validation."
        )

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        # STUB: passes all requests through without validating the certificate.
        # Replace this entire method body with the implementation in the docstring.
        await self.app(scope, receive, send)


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

async def _send_401(scope: Any, receive: Any, send: Any, detail: str = "Unauthorized") -> None:
    """Send an HTTP 401 response."""
    import json

    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 401,
            "headers": [
                [b"content-type", b"application/json"],
                [b"content-length", str(len(body)).encode()],
                [b"www-authenticate", b'Bearer realm="mcp-server"'],
            ],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})
