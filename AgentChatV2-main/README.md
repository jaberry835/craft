# AgentChatV2 - Multi-Agent Chat Platform

A production-ready, ChatGPT-style interface for multi-agent orchestration using Microsoft Agent Framework with Agent-to-Agent (A2A) protocol. Designed for Azure Government deployment.

## Features

- **Multi-Agent Orchestration**: Magentic pattern with A2A protocol for agent-to-agent communication
- **A2A Protocol**: JSON-RPC over HTTP for inter-agent communication with chatter events
- **Dynamic Agent Configuration**: Admin UI to configure agents, prompts, and MCP tools
- **MCP Integration**: Connect agents to external tools via Model Context Protocol
- **Agent Chatter**: Real-time visibility into specialist agent activity (tool calls, results, tokens)
- **Chat History**: CosmosDB-backed with continuation token pagination
- **Document Upload**: File indexing with Azure AI Search embeddings
- **Authentication**: Microsoft Entra ID with token pass-through to MCP
- **Observability**: Configurable logging with category toggles (auth, A2A, MCP, agent)
- **Token Management**: Token usage tracking per agent call

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Angular Frontend                         │
│  ┌─────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────────┐ │
│  │  Chat   │  │   Admin     │  │  Agent   │  │  Chatter      │ │
│  │  UI     │  │   Panel     │  │ Selector │  │  Events       │ │
│  └─────────┘  └─────────────┘  └──────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │ SSE (chatter + content)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      FastAPI Backend                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐│
│  │    Auth     │  │   Agent      │  │      Orchestrator       ││
│  │  Middleware │  │   Manager    │  │     (ChatAgent)         ││
│  └─────────────┘  └──────────────┘  └─────────────────────────┘│
│                           │                                     │
│              A2A Protocol │ (JSON-RPC + chatter metadata)       │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              /a2a/{agent_id} Endpoints                      ││
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐               ││
│  │  │   ADX     │  │  Investi- │  │ Fictional │  ...          ││
│  │  │  Agent    │  │   gator   │  │   API     │               ││
│  │  └───────────┘  └───────────┘  └───────────┘               ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐│
│  │  CosmosDB   │  │    MCP       │  │      Azure AI           ││
│  │   Service   │  │   Client     │  │      Search             ││
│  └─────────────┘  └──────────────┘  └─────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌───────────┐   ┌───────────┐
        │ CosmosDB │   │  MCP      │   │   Azure   │
        │          │   │  Server   │   │   OpenAI  │
        └──────────┘   └───────────┘   └───────────┘
```

## A2A Protocol Flow

The orchestrator communicates with specialist agents using the A2A (Agent-to-Agent) protocol:

```
Orchestrator Agent
       │
       ├─── _create_a2a_tool_with_chatter()  (creates callable tool)
       │
       └─── call_agent_direct()  (HTTP POST to /a2a/{agent_id})
                   │
                   ▼
            JSON-RPC Request
            {
              "method": "message/send",
              "params": {"message": {...}}
            }
                   │
                   ▼
         Specialist ChatAgent  ──► MCP Tools (with token passthrough)
                   │
                   ▼
            JSON-RPC Response
            {
              "result": {"message": {...}},
              "metadata": {
                "chatter_events": [...],   // Tool calls, results, durations
                "tokens_input": 1234,
                "tokens_output": 567
              }
            }
```

### Chatter Events

Agent chatter provides real-time visibility into specialist agent activity:

| Event Type | Description |
|------------|-------------|
| `thinking` | Agent is processing |
| `tool_call` | Agent is calling an MCP tool |
| `tool_result` | Tool execution completed (with duration) |
| `delegation` | Agent delegating to another agent |
| `content` | Agent producing response content |

## Quick Start

### Prerequisites
- Python 3.12+
- Node.js 20+
- Azure CLI with Azure Government cloud configured
- Azure Developer CLI (`azd`)

### Azure Government Setup

```bash
# Configure Azure CLI for Government cloud
az cloud set --name AzureUSGovernment
az login

# Initialize with Azure Developer CLI
azd init
azd up
```

### Local Development

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate  # Windows
pip install -r requirements.txt
cp .env.example .env  # Configure your settings
python -m uvicorn main:app --reload --port 5000

# Frontend (new terminal)
cd frontend
npm install
npm start
```

Open http://localhost:4200 to access the application.

### Environment Variables

See `backend/.env.example` for required configuration.

## Microsoft Entra ID Configuration

### App Registration Setup

The application requires a Microsoft Entra ID (Azure AD) app registration for authentication.

#### Required: Admin App Role

The Admin UI requires users to have an `admin` role. You must configure this in your app registration:

1. **Create the App Role:**
   - Azure Portal → **Microsoft Entra ID** → **App registrations**
   - Select your app (Client ID: `5e9822c5-f870-4acb-b2e6-1852254d9cbb`)
   - Go to **App roles** → **Create app role**:
     | Field | Value |
     |-------|-------|
     | Display name | `Admin` |
     | Allowed member types | `Users/Groups` |
     | Value | `admin` |
     | Description | `Administrators can manage agents and settings` |
   - Click **Apply**

2. **Create a Security Group (recommended):**
   - Azure Portal → **Microsoft Entra ID** → **Groups** → **New group**
   - Group type: `Security`
   - Group name: `AgentChatAdmin`
   - Add members who should have admin access

3. **Assign the Group to the Admin Role:**
   - Azure Portal → **Enterprise applications** (not App registrations)
   - Find and select your application
   - Go to **Users and groups** → **Add user/group**
   - Select your `AgentChatAdmin` group
   - Select the `Admin` role
   - Click **Assign**

4. **Sign out and back in** to get a new token with the admin role.

#### How It Works

- Users in the `AgentChatAdmin` group receive `roles: ["admin"]` in their JWT token
- The backend checks for this role on `/api/admin/*` endpoints
- Regular users (without admin role) can still use chat features via `/api/chat/*` endpoints

#### Endpoints by Role

| Endpoint Pattern | Required Role | Description |
|-----------------|---------------|-------------|
| `/api/chat/*` | Any authenticated user | Chat, sessions, agent selection |
| `/api/admin/*` | `admin` | Agent configuration, MCP servers, system settings |
| `/api/health` | None | Health check (public) |

## Azure RBAC Requirements

Both local development (Azure CLI credentials) and production deployment (App Service managed identity) require RBAC roles.

### Required Roles

| Azure Resource | Role | Purpose |
|---------------|------|---------|
| **Azure OpenAI** | `Cognitive Services OpenAI User` | Call chat completions and embeddings APIs |
| **Cosmos DB** | `Cosmos DB Built-in Data Contributor` | Read/write sessions, messages, and agent configs |
| **Azure AI Search** | `Search Index Data Contributor` | Query and write documents to search indexes |
| **Storage Account** | `Storage Blob Data Contributor` | Upload and read documents |

### Production: App Service Managed Identity

When deploying to Azure App Service, assign roles to the backend's **system-assigned managed identity**.

#### 1. Get the Managed Identity Principal ID

```powershell
$rg = "AgentChatV2"
$apiApp = "app-agentchat-api"

# Get the managed identity principal ID
$principalId = az webapp identity show -g $rg -n $apiApp --query principalId -o tsv
Write-Host "Backend App Identity: $principalId"
```

#### 2. Azure OpenAI Role

```powershell
$openaiName = "your-openai-resource"

az role assignment create `
  --role "Cognitive Services OpenAI User" `
  --assignee-object-id $principalId `
  --assignee-principal-type ServicePrincipal `
  --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$rg/providers/Microsoft.CognitiveServices/accounts/$openaiName"
```

#### 3. Cosmos DB Data Plane Role

> **Important:** Cosmos DB has separate control plane and data plane RBAC. The "Cosmos DB Built-in Data Contributor" role is a **data plane role** and must be assigned via CLI (it won't appear in the Azure Portal IAM blade).

```powershell
$cosmosAccount = "chat-db"
$subId = az account show --query id -o tsv

# Cosmos DB Built-in Data Contributor role definition ID
# Reader: 00000000-0000-0000-0000-000000000001
# Contributor: 00000000-0000-0000-0000-000000000002
$roleDefId = "00000000-0000-0000-0000-000000000002"

az cosmosdb sql role assignment create `
  --account-name $cosmosAccount `
  --resource-group $rg `
  --principal-id $principalId `
  --role-definition-id $roleDefId `
  --scope "/subscriptions/$subId/resourceGroups/$rg/providers/Microsoft.DocumentDB/databaseAccounts/$cosmosAccount"
```

#### 4. Azure AI Search Role

```powershell
$searchName = "your-search-service"

az role assignment create `
  --role "Search Index Data Contributor" `
  --assignee-object-id $principalId `
  --assignee-principal-type ServicePrincipal `
  --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$rg/providers/Microsoft.Search/searchServices/$searchName"
```

#### 5. Storage Account Role (for document uploads)

```powershell
$storageName = "your-storage-account"

az role assignment create `
  --role "Storage Blob Data Contributor" `
  --assignee-object-id $principalId `
  --assignee-principal-type ServicePrincipal `
  --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$rg/providers/Microsoft.Storage/storageAccounts/$storageName"
```

### Local Development: User Assignment

For local development using Azure CLI credentials, assign roles to your user account.

**Azure OpenAI:**
```bash
OPENAI_ID=$(az cognitiveservices account show --name <openai-resource> --resource-group <rg> --query id -o tsv)

az role assignment create \
  --role "Cognitive Services OpenAI User" \
  --assignee "user@domain.com" \
  --scope $OPENAI_ID
```

**Cosmos DB (Data Plane Role):**
```bash
# Get user's principal ID
USER_ID=$(az ad user show --id "user@domain.com" --query id -o tsv)

# Assign Cosmos DB Built-in Data Contributor (data plane role)
az cosmosdb sql role assignment create \
  --account-name <cosmos-account> \
  --resource-group <rg> \
  --principal-id $USER_ID \
  --role-definition-id "00000000-0000-0000-0000-000000000002" \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<rg>/providers/Microsoft.DocumentDB/databaseAccounts/<cosmos-account>"
```

**Azure AI Search:**
```bash
SEARCH_ID=$(az search service show --name <search-service> --resource-group <rg> --query id -o tsv)

az role assignment create \
  --role "Search Index Data Contributor" \
  --assignee "user@domain.com" \
  --scope $SEARCH_ID
```

**Storage Account:**
```bash
STORAGE_ID=$(az storage account show --name <storage-account> --resource-group <rg> --query id -o tsv)

az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee "user@domain.com" \
  --scope $STORAGE_ID
```

### Role Propagation

After assigning roles, wait **5-10 minutes** for propagation, then re-authenticate:
```bash
az account clear
az login
```

## Project Structure

```
AgentChatV2/
├── backend/
│   ├── main.py               # FastAPI entry point
│   ├── config.py             # Pydantic Settings (incl. logging toggles)
│   ├── models.py             # Request/Response models
│   ├── observability.py      # Logging & telemetry with category toggles
│   ├── auth/                 # Entra ID authentication
│   │   ├── middleware.py     # Auth middleware
│   │   └── token_validator.py
│   ├── services/             # Azure service integrations
│   │   ├── cosmos_service.py # CosmosDB operations
│   │   ├── agent_manager.py  # Agent orchestration + A2A tools
│   │   ├── a2a_client.py     # A2A client (call_agent_direct)
│   │   ├── search_service.py # Azure AI Search
│   │   ├── mcp_client.py     # MCP tool connections
│   │   ├── mcp_discovery.py  # MCP tool discovery
│   │   └── embedding_service.py
│   ├── routes/               # API endpoints
│   │   ├── chat_routes.py    # Chat & sessions (SSE streaming)
│   │   ├── a2a_routes.py     # A2A protocol endpoints
│   │   ├── admin_routes.py   # Agent management
│   │   ├── document_routes.py# File upload
│   │   └── health_routes.py  # Health checks
│   ├── prompts/              # Agent prompt files
│   │   ├── orchestrator.txt  # Orchestrator instructions
│   │   ├── adx.txt          # ADX specialist prompt
│   │   └── ...
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/app/
│   │   ├── core/services/    # Angular services
│   │   ├── features/         # Page components
│   │   │   ├── chat/         # Chat interface
│   │   │   └── admin/        # Admin panel
│   │   └── shared/           # Shared components
│   ├── angular.json
│   └── package.json
├── infra/
│   └── main.bicep            # Azure infrastructure
├── azure.yaml                # Azure Developer CLI
└── README.md
```

## Orchestration Patterns

| Pattern | Description | Use Case |
|---------|-------------|----------|
| **Single** | One agent handles the request | Simple queries |
| **Sequential** | Agents process in order, passing context | Research → Analysis → Writing |
| **Concurrent** | Agents process in parallel | Multiple perspectives |
| **Magentic** | Orchestrator delegates to specialists | Complex multi-step tasks |
| **Group Chat** | Round-robin conversation | Brainstorming, debate |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat/sessions` | GET | List user sessions |
| `/api/chat/sessions` | POST | Create new session |
| `/api/chat/send` | POST | Send message (SSE stream with chatter) |
| `/api/admin/agents` | GET/POST | List/create agents |
| `/api/admin/agents/{id}` | PUT/DELETE | Update/delete agent |
| `/api/documents/upload` | POST | Upload document |
| `/api/documents/search` | GET | Search documents |
| `/api/health` | GET | Health check |
| `/a2a/agents` | GET | List available A2A agent cards |
| `/a2a/{agent_id}` | POST | A2A JSON-RPC endpoint (with chatter metadata) |

## Logging Configuration

Use environment variables to control verbose logging categories:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | Global log level (DEBUG, INFO, WARNING, ERROR) |
| `SHOW_PERFORMANCE_LOGS` | `false` | Detailed timing for AOAI, MCP, CosmosDB |
| `SHOW_AUTH_LOGS` | `false` | Token validation, header processing |
| `SHOW_A2A_LOGS` | `false` | A2A discovery, calls, responses |
| `SHOW_MCP_LOGS` | `false` | MCP headers, discovery, tool calls |
| `SHOW_AGENT_LOGS` | `false` | Agent execution, tool calls, chatter events |

Example `.env` for debugging A2A issues:
```bash
LOG_LEVEL=DEBUG
SHOW_A2A_LOGS=true
SHOW_AGENT_LOGS=true
```

## Authentication & Credentials

### Development vs Production Credentials

The application automatically uses different Azure credentials based on the `ENVIRONMENT` setting:

| Environment | Credential Type | How It Works |
|-------------|-----------------|--------------|
| `development` | `AzureCliCredential` | Uses your logged-in Azure CLI identity (`az login`) |
| `production` | `ManagedIdentityCredential` | Uses App Service's system-assigned managed identity |

**Important**: In development, you must be logged in via Azure CLI:
```bash
az cloud set --name AzureUSGovernment  # For Azure Government
az login
```

### Frontend Authentication (MSAL)

The Angular frontend uses MSAL for Azure AD authentication:

- **Token Caching**: Tokens are cached in localStorage to avoid repeated auth requests
- **Silent Refresh**: Tokens refresh automatically before expiry using iframes
- **Redirect URIs**: Must be configured in Azure AD app registration:
  - Development: `http://localhost:4200`
  - Production: `https://your-frontend-app.azurewebsites.us`

## Deployment

### Using Deployment Scripts (Recommended)

See `deploy/README.md` for detailed deployment instructions using the provided scripts.

Quick deployment to Azure Government:

```powershell
# Deploy both backend and frontend
.\deploy\deploy-all.ps1 `
    -ResourceGroup "AgentChatV2" `
    -BackendAppService "app-agentchat-api" `
    -FrontendAppService "app-agentchat-web" `
    -ContainerRegistry "myacr" `
    -Cloud "AzureUSGovernment"

# Configure app settings from .env file
.\deploy\set-appsettings-from-env.ps1 `
    -ResourceGroup "AgentChatV2" `
    -AppServiceName "app-agentchat-api" `
    -BackendUrl "https://app-agentchat-api.azurewebsites.us"
```

### Using Azure Developer CLI

Alternatively, deploy using Azure Developer CLI:

```bash
azd auth login
azd up
```

This provisions:
- App Service (backend container)
- App Service (frontend container)
- CosmosDB (serverless)
- Azure AI Search
- Application Insights
- Storage Account

## Troubleshooting

### Common Issues

#### CORS Errors in Browser Console
If you see CORS errors like "Access-Control-Allow-Origin":
1. Check backend CORS configuration includes your frontend origin
2. For Azure Government, ensure redirect URIs use `.us` domains
3. Verify the frontend is calling the correct backend URL

#### Authentication Timeout / Iframe Errors
If you see `BrowserAuthError: monitor_window_timeout`:
1. Ensure redirect URIs are correctly configured in Azure AD
2. Check that third-party cookies aren't blocked in your browser
3. The app caches tokens to minimize iframe usage - clear localStorage if issues persist

#### A2A Agent Communication Fails
If orchestrator can't reach specialist agents:
1. Verify `BACKEND_URL` is set correctly (production: full App Service URL)
2. Check that internal network allows the backend to call itself
3. Enable `SHOW_A2A_LOGS=true` for debugging

#### "Admin access required" Error
If non-admin users can't access admin features:
1. Verify the `admin` app role is created in Azure AD (see Entra ID Configuration)
2. Assign users/groups to the admin role in Enterprise Applications
3. Users must sign out and back in to get new token with roles

#### Cosmos DB "Unauthorized" Errors
1. Ensure Cosmos DB data plane RBAC is assigned (not control plane)
2. Use the `az cosmosdb sql role assignment create` command
3. Wait 5-10 minutes for role propagation

#### Azure OpenAI "Forbidden" Errors
1. Verify `Cognitive Services OpenAI User` role is assigned
2. Check the endpoint URL matches your cloud (`.azure.us` for Government)
3. Ensure `AZURE_COGNITIVE_SERVICES_SCOPE` uses correct cloud suffix

## License

MIT
