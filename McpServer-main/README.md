# Using uv in Secure/Air-Gapped Environments

`uv` works well in regulated, offline, or air-gapped environments. To use your own internal package index (PyPI mirror or custom repository), set the index URL when installing:

```
uv pip install --index-url <your-internal-url> -r requirements.txt
```
Or set the environment variable:
```
set UV_INDEX_URL=<your-internal-url>
uv pip install -r requirements.txt
```

You do **not** need to manually edit the `uv.lock` file. `uv` will honor your index URL and fetch packages from your mirror, even if the lock file lists external URLs. If your mirror is complete, all packages will resolve internally.

---
# Python MCP Server

A clean, extensible [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server built with Python and [FastMCP](https://github.com/jlowin/fastmcp), designed to be hosted on Azure and extended by your team.

## Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Quick Start (Local)](#quick-start-local)
- [Working without uv](#working-without-uv)
- [Testing](#testing)
- [How to Add a New Tool](#how-to-add-a-new-tool)
- [Authentication Guide](#authentication-guide)
  - [Layer 1: Protecting the MCP Server](#layer-1-protecting-the-mcp-server)
  - [Layer 2: On-Behalf-Of (OBO) Flows](#layer-2-on-behalf-of-obo-flows)
- [Configuration Reference](#configuration-reference)
- [Deploying to Azure](#deploying-to-azure)
- [Architecture Decisions](#architecture-decisions)

---

## Overview

This server uses the **Streamable HTTP transport**, which means clients connect over plain HTTPS. That makes it:

- Easy to host on Azure (Container Apps, App Service, or any HTTPS endpoint).
- Accessible from AI agents, web applications, and CI pipelines – not just local Claude Desktop.
- Deployable behind any standard HTTP load balancer.

The codebase is deliberately minimal. The goal is that a junior developer can:
1. Read this README once.
2. Copy an example tool, rename it, and ship their feature.
3. Understand exactly where and how to add authentication when required.

---

## Project Structure

```
McpServer/
│
├── server.py            # Entry point. Creates FastMCP + Starlette ASGI app.
│                        # Add middleware here (CORS, auth).
│
├── config.py            # All settings loaded from environment variables.
│                        # Add new settings here, then use them via `settings.field`.
│
├── tools/
│   ├── __init__.py      # Registers all tool modules. Add new imports here.
│   ├── example.py       # Five documented patterns for writing tools.
│   │                    # Copy one as the starting point for new features.
│   └── secure_api.py    # Working example: mTLS tools that forward the
│                        # X-User-Cert header to a downstream Secure API.
│
├── auth/
│   ├── __init__.py
│   ├── verifier.py      # Layer 1: ASGI middleware stubs for Entra ID,
│   │                    # client certificate, and API key auth.
│   │                    # Full implementation guide included as comments.
│   ├── obo.py           # Layer 2: OBO token exchange helper + cert identity guide.
│   └── user_cert_context.py  # Always-on ASGI middleware + ContextVar for
│                              # propagating X-User-Cert header into tools.
│
├── tests/
│   ├── __init__.py
│   └── test_tools.py    # Unit and integration tests. Examples for every pattern.
│
├── pyproject.toml       # Dependencies and project metadata (managed by uv).
├── Dockerfile           # Multi-stage production image.
├── .dockerignore
├── .env.example         # Template for local development secrets.
└── README.md            # This file.
```

---

## Quick Start (Local)

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) package manager  
  Install with: `pip install uv` or `winget install astral-sh.uv`

### 1 – Clone and install

```bash
# Clone or open the repository, then:
cd McpServer

# Install dependencies
uv sync
```

### 2 – Configure environment

```bash
cp .env.example .env
# Edit .env if you need non-default values (optional for local dev)
```

### 3 – Start the server

```bash
# Option A: run directly (uvicorn with hot-reload)
uv run python server.py

# Option B: convenience script defined in pyproject.toml
uv run serve
```

The server starts at `http://localhost:8000`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe – always returns `{"status": "ok"}` |
| `POST /mcp` | MCP protocol endpoint (Streamable HTTP) |

### 4 – Explore with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is the quickest way to interact with your tools:

```bash
uv run mcp dev server.py
```

This opens a browser-based UI where you can invoke any registered tool, see inputs and outputs, and inspect the protocol messages in real time.

### 5 – Connect from Claude Desktop (optional)

To test with the full Claude Desktop client, add this to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "uv",
      "args": ["run", "python", "server.py"],
      "cwd": "/path/to/McpServer"
    }
  }
}
```

---

## Working without uv

`uv` is the recommended package manager because it is fast and handles virtual environments automatically. If you cannot install it, the project works equally well with the Python tooling that ships with every Python installation.

### 1 – Create and activate a virtual environment

```bash
# Create a .venv folder in the project directory
python -m venv .venv

# Activate it:
# Windows (PowerShell)
.venv\Scripts\Activate.ps1
# Windows (Command Prompt)
.venv\Scripts\activate.bat
# macOS / Linux
source .venv/bin/activate
```

> You will need to re-run the activation command in every new terminal session.

### 2 – Install dependencies

```bash
pip install -e .
```

To include the optional `auth` extras (msal, azure-identity, PyJWT):

```bash
pip install -e ".[auth]"
```

### 3 – Start the server

```bash
python server.py
```

### 4 – Explore with MCP Inspector

```bash
python -m mcp dev server.py
```

### 5 – Run tests

```bash
pip install -e ".[dev]"    # installs pytest, pytest-asyncio, httpx
pytest
pytest -v
```

### uv ↔ pip equivalents quick reference

| uv command | pip / venv equivalent |
|---|---|
| `uv sync` | `python -m venv .venv && pip install -e .` |
| `uv sync --extra auth` | `pip install -e ".[auth]"` |
| `uv run python server.py` | `python server.py` (venv active) |
| `uv run pytest` | `pytest` (venv active) |
| `uv run mcp dev server.py` | `python -m mcp dev server.py` (venv active) |

---

## Testing

```bash
# Run all tests
uv run pytest

# Verbose mode
uv run pytest -v

# A specific test file
uv run pytest tests/test_tools.py
```

Tests are in `tests/test_tools.py`. They include:

- **`test_health_endpoint_returns_200`** – integration test using `httpx.AsyncClient` against the real ASGI app.
- **`test_echo_*`** – unit tests for the echo tool's output model.
- **`test_list_items_*`** – tests for the list tool's logic.
- **`test_obo_*`** – verifies the OBO helper raises correctly on empty input.

When you add a new tool, add a matching test following the same patterns.

---

## How to Add a New Tool

Adding a tool takes three steps and no changes to `server.py`.

### Step 1 – Create your tool file

Create `tools/my_feature.py`. Use one of the patterns from `tools/example.py`:

```python
# tools/my_feature.py
import logging
from typing import Annotated

from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class MyResult(BaseModel):
    """Define your output shape here. FastMCP turns this into JSON Schema."""
    answer: str
    source: str


def register_my_feature_tools(mcp: FastMCP) -> None:
    """Register all tools in this module."""

    @mcp.tool(
        name="my_tool",
        description="One clear sentence describing what this tool does.",
    )
    async def my_tool(
        query: Annotated[str, Field(description="What to look up.")],
        ctx: Context,
    ) -> MyResult:
        """
        Docstring is shown to the LLM alongside the description.
        Keep it concise and accurate.
        """
        await ctx.info(f"Processing query: {query}")

        # Your business logic here.
        result = await some_async_call(query)

        return MyResult(answer=result, source="my-data-source")
```

### Step 2 – Register it

Open `tools/__init__.py` and add two lines:

```python
from tools.my_feature import register_my_feature_tools   # add this import

def register_tools(mcp: FastMCP) -> None:
    register_example_tools(mcp)
    register_my_feature_tools(mcp)   # add this call
```

### Step 3 – Add tests

Add a test in `tests/test_tools.py` following the existing patterns.

That's it. No changes to `server.py`, `config.py`, or the Dockerfile.

### Tool design tips

| Do | Avoid |
|---|---|
| Use `Annotated[type, Field(description="...")]` for every parameter | Leaving descriptions empty |
| Return a Pydantic model for structured data | Returning bare `dict` |
| Use `async def` for any I/O (DB, HTTP, filesystem) | Blocking I/O in sync functions |
| Use `ctx.info()` / `ctx.debug()` for progress visibility | `print()` statements |
| Raise `ValueError` / `RuntimeError` with a clear message on bad input | Silent failures |

---

## Authentication Guide

The server ships with **no authentication enabled** – all requests are accepted. This section explains how to add it when your team is ready.

There are two distinct authentication concerns:

```
[Caller / AI Agent]
       │
       │  "Can this caller use the MCP server at all?"
       │   ──► Layer 1: Bearer token / API key middleware
       ▼
[This MCP Server]
       │
       │  "Can this tool access downstream API X as this user?"
       │   ──► Layer 2: OBO token exchange
       ▼
[Downstream API / Microsoft Graph / Internal Service]
```

---

### Layer 1: Protecting the MCP Server

**File:** `auth/verifier.py`  
**Where to activate:** `server.py` → `create_app()` function

#### Option A – Generic OIDC Bearer Token (any provider)

Works with **any** OIDC-compliant identity provider: Azure Entra ID, AWS Cognito, Okta, Auth0, Keycloak, PingFederate, etc. The middleware validates RS256-signed JWTs using the provider's public JWKS endpoint.

**Setup steps:**

```bash
# 1. Install auth dependencies
uv sync --extra auth
```

In `.env` (values differ per provider — see `.env.example` for examples):
```env
OIDC_JWKS_URI=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/jwks.json
OIDC_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123
OIDC_AUDIENCE=your-api-client-id
```

In `config.py` – uncomment the Generic OIDC fields.

In `server.py` `create_app()`:
```python
from auth.verifier import GenericOidcBearerTokenMiddleware
app.add_middleware(
    GenericOidcBearerTokenMiddleware,
    jwks_uri=settings.oidc_jwks_uri,
    issuer=settings.oidc_issuer,
    audience=settings.oidc_audience,
)
```

The **full JWT validation implementation** is documented as a copy-paste block in `auth/verifier.py` → `GenericOidcBearerTokenMiddleware`. Replace the stub `__call__` method with it.

#### Option B – Azure Entra ID (convenience wrapper)

A thin wrapper around Option A that computes the JWKS URI and issuer URL from just the Entra ID tenant ID. This is the easiest path for Azure-hosted services.

Tokens are short-lived JWTs signed with Azure's public keys — no shared secrets to rotate.

**How the flow works:**

1. The calling client (AI agent, application) acquires a token from Entra ID for the scope `api://<your-server-client-id>/.default`.
2. The client sends the token as `Authorization: Bearer <token>` with every request.
3. The `EntraIDBearerTokenMiddleware` in `auth/verifier.py` validates:
   - Signature (against Azure's public JWKS endpoint).
   - Issuer (must be `https://login.microsoftonline.com/<tenant>/v2.0`).
   - Audience (must match your app registration).
   - Expiry.
4. Invalid tokens receive a `401 Unauthorized` response before any tool code runs.

**Setup steps:**

```bash
# 1. Install auth dependencies
uv sync --extra auth
```

In the Azure Portal:
1. Create an **App Registration** for this MCP server.
2. Expose an API with Application ID URI: `api://<client-id>`.
3. Add a scope: `mcp.access` (used by callers to request access).
4. Create a client secret (or upload a certificate).

In `.env`:
```env
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-secret
EXPECTED_AUDIENCE=api://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

In `config.py` – uncomment the Entra ID fields.

In `server.py` `create_app()` – uncomment the middleware block:
```python
from auth.verifier import EntraIDBearerTokenMiddleware
app.add_middleware(
    EntraIDBearerTokenMiddleware,
    tenant_id=settings.azure_tenant_id,
    audience=settings.expected_audience,
)
```

The **full JWT validation implementation** is documented as a copy-paste block in `auth/verifier.py`. Replace the stub `__call__` method with it.

#### Option C – API Key (simpler, no OBO support)

Suitable for internal APIs or development environments where full identity delegation is not needed.

In `server.py` `create_app()`:
```python
from auth.verifier import ApiKeyMiddleware
app.add_middleware(ApiKeyMiddleware, api_key=settings.api_key)
```

`ApiKeyMiddleware` is already fully implemented in `auth/verifier.py` — no stub to fill in.

#### Option D – Client Certificate (mTLS)

For enterprise B2B scenarios where the calling system is identified by an X.509 certificate rather than a password or token. Common when:
- The caller is a machine/service rather than an interactive user.
- Your organisation already has a PKI issuing certificates.
- The certificate carries rich identity claims (UPN, department) from an enterprise CA.
- You want mutual TLS without the Entra ID app registration overhead.

**How Azure delivers the certificate to your code:**

| Hosting platform | Header that carries the cert | How to enable |
|---|---|---|
| Azure App Service | `X-ARR-ClientCert` (base64 DER) | `az webapp update --client-cert-enabled true --client-cert-mode Required` |
| Azure API Management (in front of Container Apps) | Custom header you define in APIM policy (e.g. `X-Client-Cert`) | Configure "validate-client-certificate" policy in APIM |
| Self-managed nginx/ingress | `ssl_client_cert` or similar | Set in ingress config |

> **Security note:** The cert arrives as a plain HTTP header. Protect your app from direct access (bypass the platform) using Azure VNet integration or IP allowlists, and always validate the cert's issuer in the middleware.

**What the middleware validates:**
1. The header is present and contains a valid DER-encoded certificate.
2. The certificate is not expired.
3. The issuer is in your `allowed_issuers` list (your enterprise CA's subject string).
4. Optionally, the thumbprint is in your `allowed_thumbprints` list.

**What the middleware extracts and makes available to tools:**
- `subject` — the full RFC 4514 subject string.
- `cn` — the Common Name attribute.
- `upn` — the User Principal Name from the Subject Alternative Name extension (typically `user@domain.com`).
- `issuer` — the issuing CA's subject string.
- `thumbprint` — SHA-256 fingerprint in hex.

**Activating the middleware** in `server.py` `create_app()`:
```python
from auth.verifier import ClientCertificateMiddleware
app.add_middleware(
    ClientCertificateMiddleware,
    cert_header="X-ARR-ClientCert",                        # or your platform's header
    allowed_issuers=["CN=My Enterprise CA, O=Contoso"],    # restrict to your CA
    # allowed_thumbprints=["ab12cd34..."],                 # optionally pin specific certs
)
```

The **full implementation** (certificate parsing, expiry check, issuer/thumbprint validation, claim extraction) is documented as a copy-paste block in `auth/verifier.py` → `ClientCertificateMiddleware`.

---

### Layer 2: On-Behalf-Of (OBO) Flows

**File:** `auth/obo.py`  
**Used in:** individual tool functions

The OBO flow lets a specific tool call a downstream API (Microsoft Graph, your internal service) using the **requesting user's identity**, not the MCP server's service account.

#### Why this matters

Without OBO, every Graph API call would return data for the service account, not the user. Row-level security and audit trails would be broken.

#### How it works

```
1. User's token  ──►  MCP server validates it (Layer 1)
2. MCP server presents: its own credentials + user's token ──►  Entra ID
3. Entra ID returns: a new token scoped to the downstream API, still identifying the user
4. Tool calls the downstream API with the new token
```

#### Enabling OBO in a tool

**Prerequisites:**
- Layer 1 Entra ID auth is configured and working.
- This server's app registration has been granted delegated permissions to the downstream API.
- An admin has granted consent.
- `uv sync --extra auth` has been run.

**Step 1 – Initialise the MSAL app** in `server.py` `lifespan()`:

```python
import msal

msal_app = msal.ConfidentialClientApplication(
    client_id=settings.azure_client_id,
    client_credential=settings.azure_client_secret,
    authority=f"https://login.microsoftonline.com/{settings.azure_tenant_id}",
)
yield {"msal_app": msal_app}
```

**Step 2 – Call `get_obo_token()`** inside your tool:

```python
from auth.obo import get_obo_token

async def my_tool(ctx: Context) -> dict:
    # Extract the Bearer token the user sent.
    auth_header = ctx.request_context.request.headers.get("Authorization", "")
    incoming_token = auth_header.removeprefix("Bearer ").strip()

    # Exchange it for a Graph-scoped token via OBO.
    msal_app = ctx.request_context.lifespan_context["msal_app"]
    graph_token = await get_obo_token(
        incoming_token=incoming_token,
        scopes=["https://graph.microsoft.com/User.Read"],
        msal_app=msal_app,
    )

    # Call the downstream API as the user.
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://graph.microsoft.com/v1.0/me",
            headers={"Authorization": f"Bearer {graph_token}"},
        )
        r.raise_for_status()
        return r.json()
```

The `get_user_profile` stub in `tools/example.py` has this exact code block commented out — uncomment and adapt it.

#### Multiple downstream APIs

Call `get_obo_token()` once per API. MSAL caches the resulting tokens automatically:

```python
graph_token    = await get_obo_token(incoming_token, ["https://graph.microsoft.com/Mail.Read"], msal_app)
internal_token = await get_obo_token(incoming_token, ["api://my-internal-api/.default"],        msal_app)
```

#### Multiple downstream APIs

Call `get_obo_token()` once per API. MSAL caches the resulting tokens automatically:

```python
graph_token    = await get_obo_token(incoming_token, ["https://graph.microsoft.com/Mail.Read"], msal_app)
internal_token = await get_obo_token(incoming_token, ["api://my-internal-api/.default"],        msal_app)
```

#### Multi-replica token cache

MSAL's default in-memory cache does not survive restarts or work across multiple Container App replicas. For production, use a distributed cache (Redis):

```bash
uv add msal-extensions
```

Then initialise with a shared cache backend — see the comments in `auth/obo.py`.

---

### Layer 2 (cert variant): Forwarding User Certificates to Downstream APIs

**Files:** `auth/user_cert_context.py` (middleware + ContextVar), `tools/secure_api.py` (working example)  
**Guide:** `auth/obo.py` → "USING CERT IDENTITY IN TOOLS" section

When Layer 1 uses client certificates instead of Bearer tokens, there is no token to exchange. The most common pattern is to **forward the raw certificate** to the downstream API via the `X-User-Cert` HTTP header — the downstream API validates it.

The `UserCertMiddleware` in `auth/user_cert_context.py` reads the incoming `X-User-Cert` header and stores it in a `ContextVar`. Any tool can retrieve it:

```python
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
```

See `tools/secure_api.py` for a complete working example with mTLS + user cert forwarding.

> **Why ContextVar?** FastMCP does not expose the raw ASGI scope to tool functions. A `ContextVar` set by middleware is inherited by all async code in the same task, so tools can read it without framework-specific plumbing. See the docstring in `auth/user_cert_context.py` for details.

#### Calling Entra ID-protected downstream APIs with a cert identity

If your tools also need to call Entra ID-protected services AND you want per-user security trimming there too, `auth/obo.py` covers three options:

| Scenario | Approach |
|---|---|
| Downstream API doesn't need the user's identity | Acquire a service-account token with `acquire_token_for_client()` |
| Cert is linked to an Entra ID user (CBA configured) | Use Entra ID Certificate-Based Authentication to get a delegated token |
| You also have a Bearer token alongside the cert | Use the standard OBO flow (`get_obo_token()`) |

Full decision guidance and code patterns are in `auth/obo.py` → "USING CERT IDENTITY IN TOOLS" section.

---

## Configuration Reference

All settings are environment variables. Copy `.env.example` to `.env` for local development. In Azure, set these as Application Settings.

| Variable | Default | Description |
|---|---|---|
| `SERVER_NAME` | `my-mcp-server` | Display name shown to LLM clients |
| `SERVER_INSTRUCTIONS` | (see file) | Free-text description of this server sent to the LLM |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8000` | Listening port |
| `DEBUG` | `false` | Enable hot-reload. **Never `true` in production** |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `CORS_ORIGINS` | `["*"]` | JSON list of allowed origins. Restrict in production |
| `OIDC_JWKS_URI` | — | JWKS endpoint for the OIDC provider's public signing keys |
| `OIDC_ISSUER` | — | Expected `iss` claim in incoming JWTs |
| `OIDC_AUDIENCE` | — | Expected `aud` claim in incoming JWTs |
| `AZURE_TENANT_ID` | — | Entra ID tenant (convenience wrapper computes OIDC URLs) |
| `AZURE_CLIENT_ID` | — | This server's app registration client ID |
| `AZURE_CLIENT_SECRET` | — | Client secret. Use Key Vault reference in production |
| `EXPECTED_AUDIENCE` | — | Expected `aud` claim (Entra ID convenience wrapper) |
| `API_KEY` | — | Static API key (alternative to Bearer tokens) |
| `CERT_HEADER` | `X-ARR-ClientCert` | HTTP header carrying the base-64 DER client cert |
| `ALLOWED_CERT_ISSUERS` | `[]` | JSON list of acceptable certificate Issuer strings |
| `ALLOWED_CERT_THUMBPRINTS` | `[]` | JSON list of allowed SHA-256 thumbprints (hex) |

---

## Deploying to Azure

### Azure Container Apps (recommended)

Container Apps is the recommended hosting platform for MCP servers because it handles:
- Automatic HTTPS termination.
- Scale-to-zero for cost efficiency.
- Built-in health probes (uses the `/health` endpoint).
- Managed identity (avoids storing credentials in env vars).

```bash
# 1. Build and push the image to Azure Container Registry
az acr build --registry <your-registry> --image mcp-server:latest .

# 2. Create a Container App
az containerapp create \
  --name mcp-server \
  --resource-group <your-rg> \
  --image <your-registry>.azurecr.io/mcp-server:latest \
  --ingress external \
  --target-port 8000 \
  --env-vars \
      SERVER_NAME=my-mcp-server \
      LOG_LEVEL=INFO \
      CORS_ORIGINS='["https://my-app.example.com"]'

# 3. Set sensitive values as secrets (not plain env vars)
az containerapp secret set \
  --name mcp-server \
  --resource-group <your-rg> \
  --secrets azure-client-secret=<your-secret>
```

### Key Vault references (production)

Never put secrets in Application Settings as plain text. Reference them from Key Vault:

```bash
# Store the secret in Key Vault
az keyvault secret set \
  --vault-name <your-kv> \
  --name azure-client-secret \
  --value <your-secret>

# Grant the Container App's managed identity access to Key Vault
az keyvault set-policy \
  --name <your-kv> \
  --object-id <container-app-managed-identity-object-id> \
  --secret-permissions get
```

Then reference it in the Container App environment variable:
```
AZURE_CLIENT_SECRET=@Microsoft.KeyVault(SecretUri=https://<your-kv>.vault.azure.net/secrets/azure-client-secret/)
```

### Azure App Service

If you prefer App Service:

```bash
az webapp create \
  --name mcp-server \
  --resource-group <your-rg> \
  --plan <your-plan> \
  --deployment-container-image-name <your-registry>.azurecr.io/mcp-server:latest

az webapp config appsettings set \
  --name mcp-server \
  --resource-group <your-rg> \
  --settings WEBSITES_PORT=8000 LOG_LEVEL=INFO
```

### Health probe configuration

Both Container Apps and App Service will automatically use the `/health` endpoint. No additional configuration needed — the Dockerfile already includes a `HEALTHCHECK` directive.

---

## Architecture Decisions

### Why FastMCP?

FastMCP provides a decorator-driven API (`@mcp.tool()`) that keeps tool definitions close to their logic and eliminates protocol boilerplate. The alternative (low-level `mcp.Server`) requires more code for no benefit in most scenarios.

### Why Streamable HTTP instead of stdio?

`stdio` transport requires the client to spawn the server as a subprocess — suitable for Claude Desktop but not for cloud hosting. Streamable HTTP is a standard HTTPS endpoint that works with any HTTP client, load balancer, and hosting platform.

### Why `stateless_http=True`?

With `stateless_http=True`, every request is self-contained. The server can be scaled to multiple replicas behind a load balancer without sticky sessions. The trade-off is that per-session state is not preserved between tool calls — use the lifespan context for process-level shared state instead.

### Why separate `tools/`, `auth/`, and `config.py`?

Each file has a single responsibility:
- `server.py` — wiring only (FastMCP + ASGI + middleware).
- `config.py` — all settings in one place.
- `tools/` — all business logic, one file per feature domain.
- `auth/` — all authentication concerns, isolated from tools.

A developer adding a feature touches only `tools/`. A developer adding authentication touches only `auth/` and the two commented-out sections in `server.py` / `config.py`.
