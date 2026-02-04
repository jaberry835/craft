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

If the external A2A agent runs in the same Azure Entra ID tenant as your AgentChatV2 instance, authentication works automatically:

```
User Token → Orchestrator → A2A HTTP Call → External Agent → MCP Tools
```

**Requirements:**
- Same Entra ID tenant
- External agent accepts tokens with your app's audience (`aud` claim)
- OR external agent is configured as a multi-tenant application
- No additional scopes required beyond what the user already has

**How it works:**
1. User authenticates to AgentChatV2 (gets access token)
2. Orchestrator delegates to external A2A agent
3. User's token is passed via `Authorization: Bearer {token}` header
4. External agent validates token and executes on behalf of user
5. Any MCP tools on the external agent use the same token

### Different Audience

If the external agent has its own App Registration with a different client ID, it may reject your tokens because the `aud` claim doesn't match.

**Solutions:**

1. **Configure external app to accept your tokens**
   - Add your app's client ID as an authorized client application

2. **Multi-tenant app registration**
   - Configure the external agent's app registration as multi-tenant
   - Accept tokens from any tenant in your organization

3. **On-Behalf-Of (OBO) flow** (not currently implemented)
   - Exchange the user's token for a token with the external agent's audience

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

## Token Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgentChatV2                               │
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │  User    │───▶│ Orchestrator │───▶│ A2A Tool Wrapper      │  │
│  │  Token   │    │    Agent     │    │ (passes user_token)   │  │
│  └──────────┘    └──────────────┘    └───────────┬───────────┘  │
│                                                   │              │
└───────────────────────────────────────────────────┼──────────────┘
                                                    │
                                    HTTP POST with  │
                                    Authorization:  │
                                    Bearer {token}  │
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
- [Microsoft Agent Framework A2A Integration](https://learn.microsoft.com/en-us/agent-framework/user-guide/hosting/agent-to-agent-integration)
- [Main README](../README.md)
