"""
config.py – Application Settings
==================================
All configuration is driven by environment variables so the same Docker image
can be deployed to development, staging, and production without rebuilding.

For local development, copy .env.example to .env and edit as needed.
Pydantic-settings will automatically load values from .env.

Precedence (highest to lowest):
  1. Actual environment variables (set in Azure Container Apps / App Service)
  2. Values in .env (local development only – not committed to source control)
  3. Defaults defined in this file

Adding a new setting
---------------------
1. Add a field to the Settings class below with a sensible default and description.
2. Add the corresponding variable to .env.example.
3. Access it anywhere via:  from config import settings; settings.your_field
"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Load .env file if present (silently ignored if missing)
        env_file=".env",
        env_file_encoding="utf-8",
        # Allow both UPPER_CASE and lower_case env var names
        case_sensitive=False,
        # Ignore unexpected env vars instead of raising ValidationError
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # Server identity
    # ------------------------------------------------------------------
    server_name: str = Field(
        default="my-mcp-server",
        description="Display name shown to LLM clients that connect to this server.",
    )
    server_instructions: str = Field(
        default="An MCP server providing tools for your application.",
        description=(
            "Free-text description sent to LLM clients explaining what this "
            "server does and how to use its tools."
        ),
    )

    # ------------------------------------------------------------------
    # Network
    # ------------------------------------------------------------------
    host: str = Field(default="0.0.0.0", description="Bind address.")
    port: int = Field(default=8000, description="Listening port.")
    debug: bool = Field(
        default=False,
        description="Enable uvicorn hot-reload and verbose logging. Never True in production.",
    )
    log_level: str = Field(
        default="INFO",
        description="Logging verbosity: DEBUG | INFO | WARNING | ERROR | CRITICAL",
    )

    # ------------------------------------------------------------------
    # CORS
    # In production, replace ["*"] with your actual front-end origins,
    # e.g. ["https://myapp.azurewebsites.net", "https://my-portal.example.com"]
    # ------------------------------------------------------------------
    cors_origins: list[str] = Field(
        default=["*"],
        description=(
            "Allowed CORS origins. Use [\"*\"] for development only. "
            "Restrict to specific domains in production."
        ),
    )

    # ------------------------------------------------------------------
    # Authentication (all commented out – enable when adding auth)
    #
    # These settings are consumed by:
    #   - auth/verifier.py  (Layer 1 – validate incoming Bearer tokens)
    #   - auth/obo.py       (Layer 2 – On-Behalf-Of downstream calls)
    #   - server.py lifespan (MSAL app initialisation)
    #
    # Uncomment one block at a time as you implement each layer.
    # ------------------------------------------------------------------

    # --- Generic OIDC (works with any provider) -------------------------
    # oidc_jwks_uri: str = Field(
    #     default="",
    #     description=(
    #         "JWKS endpoint for the OIDC provider's public signing keys. "
    #         "Examples: "
    #         "Entra ID:  https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys  "
    #         "Cognito:   https://cognito-idp.{region}.amazonaws.com/{pool_id}/.well-known/jwks.json  "
    #         "Okta:      https://{domain}/oauth2/default/v2/keys  "
    #         "Auth0:     https://{domain}/.well-known/jwks.json"
    #     ),
    # )
    # oidc_issuer: str = Field(
    #     default="",
    #     description=(
    #         "Expected 'iss' claim in incoming JWTs. Must match the provider. "
    #         "Examples: "
    #         "Entra ID:  https://login.microsoftonline.com/{tenant}/v2.0  "
    #         "Cognito:   https://cognito-idp.{region}.amazonaws.com/{pool_id}  "
    #         "Okta:      https://{domain}/oauth2/default  "
    #         "Auth0:     https://{domain}/"
    #     ),
    # )
    # oidc_audience: str = Field(
    #     default="",
    #     description=(
    #         "Expected 'aud' claim in incoming JWTs. Typically the API "
    #         "identifier or client ID registered with the provider."
    #     ),
    # )

    # --- Entra ID / Azure AD (convenience – computes OIDC URLs from tenant) ---
    # azure_tenant_id: str = Field(
    #     default="",
    #     description="Azure AD tenant ID (GUID or domain, e.g. contoso.onmicrosoft.com).",
    # )
    # azure_client_id: str = Field(
    #     default="",
    #     description="App registration client ID for THIS MCP server.",
    # )
    # azure_client_secret: str = Field(
    #     default="",
    #     description=(
    #         "Client secret for this server's app registration. "
    #         "In production, prefer a managed identity or Key Vault reference."
    #     ),
    # )
    # expected_audience: str = Field(
    #     default="",
    #     description=(
    #         "The 'aud' claim expected in incoming JWT tokens. "
    #         "Typically 'api://<azure_client_id>' or the full Application ID URI."
    #     ),
    # )

    # --- Client Certificate ------------------------------------------------
    # cert_header: str = Field(
    #     default="X-ARR-ClientCert",
    #     description=(
    #         "HTTP header that carries the base-64 DER client certificate. "
    #         "Azure App Service / Front Door uses X-ARR-ClientCert."
    #     ),
    # )
    # allowed_cert_issuers: list[str] = Field(
    #     default=[],
    #     description=(
    #         "List of acceptable certificate Issuer strings, e.g. "
    #         "['CN=My Enterprise CA, O=Contoso']. Empty list = accept any issuer."
    #     ),
    # )
    # allowed_cert_thumbprints: list[str] = Field(
    #     default=[],
    #     description=(
    #         "List of allowed SHA-256 certificate thumbprints (hex). "
    #         "Empty list = skip thumbprint check."
    #     ),
    # )

    # --- Simple API Key (alternative to Entra ID) ----------------------
    # api_key: str = Field(
    #     default="",
    #     description="Static API key for simple authentication. Use Entra ID in production.",
    # )

    # ------------------------------------------------------------------
    # External API base URLs
    # Add one field per downstream service this server calls.
    # ------------------------------------------------------------------
    echo_api_base_url: str = Field(
        default="http://localhost:8080",
        description=(
            "Base URL for the Simple Echo API (no trailing slash). "
            "Example: https://my-echo-api.azurewebsites.net"
        ),
    )

    # ------------------------------------------------------------------
    # Secure API (mTLS + OBO User Cert)
    # ------------------------------------------------------------------
    secure_api_base_url: str = Field(
        default="https://localhost:5005",
        description="Base URL for the Secure API (no trailing slash).",
    )
    secure_api_caller_cert_path: str = Field(
        default="certs/caller.crt",
        description="Path to the caller's PEM certificate for outbound mTLS.",
    )
    secure_api_caller_key_path: str = Field(
        default="certs/caller.key",
        description="Path to the caller's PEM private key for outbound mTLS.",
    )
    secure_api_ca_cert_path: str = Field(
        default="certs/ca.crt",
        description="Path to the CA certificate used to verify the Secure API server.",
    )
    secure_api_certs_dir: str = Field(
        default="certs",
        description="Directory containing user certificate files (e.g. user-alice.crt).",
    )


# Module-level singleton – import this everywhere:
#   from config import settings
settings = Settings()
