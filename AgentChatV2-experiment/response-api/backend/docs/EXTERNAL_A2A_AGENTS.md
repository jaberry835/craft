# External A2A Agents

This document covers how to integrate external A2A (Agent-to-Agent) agents into AgentChatV2.

## Overview

A2A is a standardized protocol that allows agents built with different frameworks to communicate seamlessly. AgentChatV2 can:

1. **Expose local agents** via A2A endpoints for external consumption
2. **Consume external agents** by adding them through the Admin panel

## Adding an External A2A Agent

1. Navigate to **Agent Administration**
2. Click **Add A2A Agent**
3. Enter the agent's base URL (e.g., `https://example.com/a2a/weather`)
4. Click **Discover** to fetch the agent card
5. Review the agent's name, description, and capabilities
6. Click **Add Agent** to register it

The agent will appear with an "A2A EXTERNAL" badge and can be used by the orchestrator like any local agent.

## A2A Endpoints

When you add an external agent, the system expects these standard A2A endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/agent.json` | GET | Agent card discovery |
| `/v1/card` | GET | Agent card (alternative) |
| `/v1/message` | POST | Send message (non-streaming) |
| `/v1/message:stream` | POST | Send message (streaming) |

URLs are relative to the agent's base URL.

## Authentication

### Same Entra ID Tenant (Recommended)

If the external A2A agent runs in the same Azure Entra ID tenant as your AgentChatV2 instance, authentication works automatically using the SDK's `AuthInterceptor`:

```
User Token → Orchestrator → A2AAgent (with BearerAuthInterceptor) → External Agent → MCP Tools
```

**Requirements:**
- Same Entra ID tenant
- External agent accepts tokens with your app's audience (`aud` claim)
- OR external agent is configured as a multi-tenant application
- No additional scopes required beyond what the user already has

**How it works:**
1. User authenticates to AgentChatV2 (gets access token)
2. Orchestrator delegates to external A2A agent
3. `BearerAuthInterceptor` adds the token to the A2A SDK request
4. External agent validates token and executes on behalf of user
5. Any MCP tools on the external agent use the same token

### Different Audience (OBO Flow)

If the external agent has its own App Registration with a different client ID, the
`aud` claim in the user's token won't match.  AgentChatV2 solves this automatically
with the **On-Behalf-Of (OBO)** token exchange.

**How it works:**
1. Admin sets the **Remote App Client ID** when adding the external A2A agent
2. At call time, `BearerAuthInterceptor` detects the target client ID differs from
   this app's `AZURE_CLIENT_ID`
3. `OboTokenService` exchanges the user's token at the Entra ID token endpoint:
   ```
   POST {authority}/oauth2/v2.0/token
     grant_type   = urn:ietf:params:oauth:grant-type:jwt-bearer
     client_id    = <this app's client ID>
     assertion    = <user's token>
     scope        = api://<remote app client ID>/.default
     requested_token_use = on_behalf_of
   ```
4. The exchanged token has `aud` = remote app, but preserves the user's identity
5. `BearerAuthInterceptor` sends the exchanged token to the remote agent

**Requirements:**
- Same Entra ID tenant
- This app needs a **confidential client credential**:
  - Development: set `AZURE_CLIENT_CERTIFICATE_PATH` to a `.pfx` file
  - Production: set `AZURE_CLIENT_SECRET`
- The remote app registration must expose an API scope and grant consent to this app
- The remote app must have `api://{remote_client_id}` as an Application ID URI

**Configuration (`.env`):**
```bash
# Required for OBO (in addition to existing AZURE_TENANT_ID / AZURE_CLIENT_ID)
# Development — PFX certificate:
AZURE_CLIENT_CERTIFICATE_PATH=./certs/app.pfx
AZURE_CLIENT_CERTIFICATE_PASSWORD=optional-password

# Production — client secret:
AZURE_CLIENT_SECRET=your-secret-value
```

**Per-agent configuration:**
When adding an external A2A agent in the Admin panel, set the **Remote App Client ID**
field to the `client_id` of the remote app registration.  If left blank, direct token
pass-through is used (same app registration scenario).

**Token caching:**
Exchanged tokens are cached per (user, target app) and automatically refreshed
60 seconds before expiry so subsequent calls within a session avoid redundant
token exchanges.

### Third-Party External Agents

For agents outside your organization (different tenant, different IdP), you'll need to configure stored credentials:

> ⚠️ **Note:** Stored credentials for external A2A agents are not yet implemented. This section documents the planned approach.

**Planned authentication types:**

| Type | Description | Use Case |
|------|-------------|----------|
| `none` | No authentication | Public agents |
| `bearer` | Static bearer token | API tokens, service accounts |
| `api_key` | API key in header | Third-party APIs |
| `oauth_client` | OAuth 2.0 client credentials | Machine-to-machine auth |

**Planned configuration fields:**
- `a2a_auth_type`: Authentication method
- `a2a_auth_token`: Token/API key (stored securely)
- `a2a_auth_header`: Custom header name (default: `Authorization`)

## Token Flow Diagrams

### Same App Registration (direct pass-through)

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgentChatV2                               │
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │  User    │───▶│ Orchestrator │───▶│ A2AAgent (SDK)        │  │
│  │  Token   │    │    Agent     │    │ + BearerAuthInterceptor│  │
│  └──────────┘    └──────────────┘    └───────────┬───────────┘  │
│                                                   │              │
└───────────────────────────────────────────────────┼──────────────┘
                                                    │
                                    A2A Protocol    │  (user token
                                    (via SDK)       │   passed as-is)
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External A2A Agent                            │
│                                                                  │
│  ┌───────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ Token from    │───▶│   Agent      │───▶│   MCP Tools      │  │
│  │ request.state │    │   Execution  │    │   (with token)   │  │
│  └───────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Different App Registration (OBO exchange)

```
┌──────────────────────────────────────────────────────────────────────┐
│                        AgentChatV2 (App A)                            │
│                                                                       │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────────────────┐ │
│  │  User    │──▶│ Orchestrator │──▶│ BearerAuthInterceptor         │ │
│  │  Token   │   │    Agent     │   │  ├── target_client_id ≠ ours  │ │
│  │ (aud=A)  │   └──────────────┘   │  └── calls OboTokenService   │ │
│  └──────────┘                      └──────────────┬────────────────┘ │
│                                                    │                  │
│                         ┌──────────────────────────┤                  │
│                         │ OboTokenService           │                  │
│                         │  POST /oauth2/v2.0/token  │                  │
│                         │  grant_type=jwt-bearer    │                  │
│                         │  assertion=user_token     │                  │
│                         │  scope=api://App-B/.def   │                  │
│                         └──────────┬───────────────┘                  │
│                                    │ new token (aud=B)                │
│                                    ▼                                  │
│                         ┌──────────────────────┐                      │
│                         │ A2AAgent (SDK)       │                      │
│                         │ sends exchanged token│                      │
│                         └──────────┬───────────┘                      │
└────────────────────────────────────┼──────────────────────────────────┘
                                     │
                     A2A Protocol    │  (exchanged token
                     (via SDK)       │   aud=App-B)
                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    External A2A Agent (App B)                         │
│                                                                       │
│  ┌───────────────┐   ┌──────────────┐   ┌──────────────────┐        │
│  │ Token from    │──▶│   Agent      │──▶│   MCP Tools      │        │
│  │ request.state │   │   Execution  │   │   (with token)   │        │
│  │ (aud=B ✓)    │   └──────────────┘   └──────────────────┘        │
│  └───────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

## Exposing Your Agents to External Systems

Your local agents are automatically exposed via A2A endpoints:

| Endpoint | Description |
|----------|-------------|
| `/.well-known/agent.json` | Lists all A2A-enabled agents |
| `/a2a/{agent_id}` | Base URL for an agent (returns card on GET) |
| `/a2a/{agent_id}/.well-known/agent.json` | Agent card (SDK standard) |
| `/a2a/{agent_id}/v1/card` | Agent card (explicit path) |
| `/a2a/{agent_id}/v1/message` | Send message |
| `/a2a/{agent_id}/v1/message:stream` | Send message with streaming |

### Copying the A2A URL

In the Admin panel, each specialist agent displays its A2A URL with a copy button. This URL can be:
- Pasted into a browser to view the agent card JSON
- Used by external A2A clients for discovery
- Added to other AgentChatV2 instances as an external agent

### Disabling A2A for an Agent

By default, all local agents are exposed via A2A. To disable:

1. Edit the agent in Admin
2. Set `a2a_enabled: false` in the agent configuration

> **Note:** Orchestrator agents are not exposed via A2A (they coordinate internally).

## Troubleshooting

### Discovery Fails (404)

- Verify the base URL is correct (no trailing `/v1/card`)
- Check that the external agent exposes `/.well-known/agent.json`
- Ensure the agent is running and accessible

### Authentication Errors (401/403)

- Verify same Entra ID tenant
- Check that the external agent's app registration accepts your tokens
- Verify the user has required permissions/scopes
- Check token expiration

### Agent Not Appearing in Chat

- Refresh the agent list in Admin
- Verify the agent was added successfully (check for "A2A EXTERNAL" badge)
- Check browser console for errors

### MCP Tools Fail on External Agent

- Token may not have required scopes for the external agent's MCP tools
- External MCP server may require different authentication
- Check external agent's logs for detailed errors

## Best Practices

1. **Use same tenant** when possible for seamless token flow
2. **Test discovery** before adding to verify connectivity
3. **Monitor chatter events** to see what external agents are doing
4. **Use orchestrator pattern** - don't call external agents directly from UI
5. **Implement proper scopes** if external agents need specific permissions

## Related Documentation

- [A2A Protocol Specification](https://a2a-protocol.org/latest/)
- [Microsoft Agent Framework A2A Integration](https://learn.microsoft.com/en-us/agent-framework/integrations/a2a?pivots=programming-language-python)
- [Main README](../README.md)
