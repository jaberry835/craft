# UserAccessChecker API (Python / Flask)

A lightweight Flask API that authenticates callers with Microsoft Entra ID and queries Azure Cosmos DB for a user's `ss_tokens` by login name. Designed for deployment to **Azure App Service** (Linux Python). Works with Azure Government (`login.microsoftonline.us`).

> This is a standalone App Service replacement for the `get-hash` Azure Function in [UserAccessChecker-Python](https://github.com/adamruderman/UserAccessChecker-Python).

---

## Configuration

Set the following as **environment variables** (`.env` file locally, or **App Service → Configuration → Application Settings** in Azure):

| Variable | Example | Description |
|---|---|---|
| `AZURE_TENANT_ID` | `03f141f3-496d-4319-bbea-a3e9286cab10` | Entra ID tenant |
| `AZURE_AUTHORITY_HOST` | `https://login.microsoftonline.us` | Authority (use `https://login.microsoftonline.com` for commercial) |
| `API_AUDIENCE` | `api://5e9822c5-f870-4acb-b2e6-1852254d9cbb` | App registration audience |
| `AZURE_COSMOS_DB_ENDPOINT` | `https://chat-db.documents.azure.us:443/` | Cosmos DB endpoint |
| `AZURE_COSMOS_DB_DATABASE` | `ChatDatabase` | Database name |
| `AZURE_COSMOS_DB_CONTAINER` | `UserAccess` | Container name |

Copy `.env.sample` to `.env` and fill in your values for local development.

---

## Cosmos DB Setup

### 1. Create the Cosmos DB account, database, and container

You can use the Azure Portal or the CLI:

```pwsh
# Variables
$resourceGroup = "myResourceGroup"
$accountName   = "chat-db"
$databaseName  = "ChatDatabase"
$containerName = "UserAccess"

# Create the Cosmos DB account (Azure Government example)
az cosmosdb create `
  --name $accountName `
  --resource-group $resourceGroup `
  --kind GlobalDocumentDB `
  --locations regionName=usgovvirginia failoverPriority=0

# Create the database
az cosmosdb sql database create `
  --account-name $accountName `
  --resource-group $resourceGroup `
  --name $databaseName

# Create the container with partition key /LoginID
az cosmosdb sql container create `
  --account-name $accountName `
  --resource-group $resourceGroup `
  --database-name $databaseName `
  --name $containerName `
  --partition-key-path "/LoginID"
```

### 2. Container settings

| Setting | Value |
|---|---|
| Partition key | `/LoginID` |
| Container name | `UserAccess` |

### 3. Sample document

Insert a document like this (Portal → Data Explorer → New Item, or use the SDK):

```json
{
    "id": "95095fca-08b8-4c92-ad8f-f90922df27b1d",
    "LoginID": "adamrud@FedAIRS.onmicrosoft.us",
    "Access": "confidential",
    "ss_tokens": [
        "hash1",
        "hash2",
        "hash3"
    ]
}
```

The key fields are:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique document ID (any GUID) |
| `LoginID` | string | The user's UPN / email — must match the `upn` or `preferred_username` claim from Entra ID |
| `Access` | string | Access level label (not used by `get-hash`, but part of the schema) |
| `ss_tokens` | string[] | Array of token strings returned by the `/get-hash` endpoint |

### 4. Insert sample data via CLI

```pwsh
az cosmosdb sql container create `
  --account-name chat-db `
  --resource-group myResourceGroup `
  --database-name ChatDatabase `
  --name UserAccess `
  --partition-key-path "/LoginID"

# Then use Data Explorer in the Portal, or the Python SDK:
python -c "
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential
client = CosmosClient('https://chat-db.documents.azure.us:443/', credential=DefaultAzureCredential())
container = client.get_database_client('ChatDatabase').get_container_client('UserAccess')
container.upsert_item({
    'id': '95095fca-08b8-4c92-ad8f-f90922df27b1d',
    'LoginID': 'youruser@yourtenant.onmicrosoft.us',
    'Access': 'confidential',
    'ss_tokens': ['hash1', 'hash2', 'hash3']
})
print('Done')
"
```

---

## Authentication

The API accepts two authentication methods (checked in order):

1. **App Service Easy Auth** — `X-MS-CLIENT-PRINCIPAL` header (base64-encoded JSON). Used automatically when App Service Authentication is enabled.
2. **JWT Bearer token** — `Authorization: Bearer <token>` header. The token is validated against the tenant's OpenID Connect metadata. Issuer is checked; audience validation is intentionally skipped to allow identity-only tokens.

Extracted login claims (in priority order): `upn`, `preferred_username`, `name`, `oid`.

---

## Running Locally

### Prerequisites
- Python 3.10+
- An Entra ID app registration with the audience configured
- A Cosmos DB account with sample data (see above)
- Managed identity access **or** `az login` session with Cosmos DB reader role

### Steps

```pwsh
# Create and activate virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Copy and edit environment variables
Copy-Item .env.sample .env
# Edit .env with your actual values

# Run the app
python app.py
```

The API starts on **http://localhost:8001**.

### Test with Postman or PowerShell

```pwsh
# Get a token for your app registration audience
$token = az account get-access-token --resource api://<your-app-id> --query accessToken -o tsv

# Call the endpoint
Invoke-RestMethod -Uri http://localhost:8001/get-hash -Headers @{ Authorization = "Bearer $token" }
```

---

## Endpoints

### `GET /get-hash`

Authenticates the caller and returns their `ss_tokens` array from Cosmos DB (matched by `LoginID`).

**Headers:**
- `Authorization: Bearer <token>` — a valid Entra ID JWT

**Responses:**

| Status | Body | Description |
|---|---|---|
| 200 OK | `["hash1", "hash2", "hash3"]` | JSON array of ss_tokens |
| 401 Unauthorized | error message | Missing / invalid token or no identity claim |
| 404 Not Found | `"Not found"` | No document matching the authenticated login |
| 500 Internal Server Error | error message | Unexpected failure |

### `GET /health`

Simple health-check endpoint (no auth required).

**Response:** `{"status": "healthy"}`

---

## Deploy to Azure App Service

### 1. Create the App Service

```pwsh
$resourceGroup = "myResourceGroup"
$planName      = "myAppServicePlan"
$appName       = "useraccesschecker-api"

# Create a Linux App Service Plan
az appservice plan create `
  --name $planName `
  --resource-group $resourceGroup `
  --is-linux `
  --sku B1

# Create the Web App (Python 3.11)
az webapp create `
  --name $appName `
  --resource-group $resourceGroup `
  --plan $planName `
  --runtime "PYTHON:3.11"
```

### 2. Configure application settings

```pwsh
az webapp config appsettings set `
  --name $appName `
  --resource-group $resourceGroup `
  --settings `
    AZURE_TENANT_ID="<your-tenant-id>" `
    AZURE_AUTHORITY_HOST="https://login.microsoftonline.us" `
    API_AUDIENCE="api://<your-app-id>" `
    AZURE_COSMOS_DB_ENDPOINT="https://chat-db.documents.azure.us:443/" `
    AZURE_COSMOS_DB_DATABASE="ChatDatabase" `
    AZURE_COSMOS_DB_CONTAINER="UserAccess"
```

### 3. Set the startup command

```pwsh
az webapp config set `
  --name $appName `
  --resource-group $resourceGroup `
  --startup-file "gunicorn --bind=0.0.0.0:8000 --timeout 120 app:app"
```

### 4. Grant managed identity access to Cosmos DB

```pwsh
# Enable system-assigned managed identity
az webapp identity assign --name $appName --resource-group $resourceGroup

$principalId = az webapp identity show --name $appName --resource-group $resourceGroup --query principalId -o tsv

# Assign Cosmos DB Built-in Data Reader role
az cosmosdb sql role assignment create `
  --account-name chat-db `
  --resource-group myResourceGroup `
  --role-definition-id 00000000-0000-0000-0000-000000000002 `
  --principal-id $principalId `
  --scope "/"
```

### 5. Deploy the code

**Option A — ZIP deploy:**
```pwsh
Compress-Archive -Path * -DestinationPath deploy.zip -Force
az webapp deploy --name $appName --resource-group $resourceGroup --src-path deploy.zip --type zip
```

**Option B — Local Git:**
```pwsh
az webapp deployment source config-local-git --name $appName --resource-group $resourceGroup
# Then git remote add azure <url> && git push azure main
```

### 6. Verify

```pwsh
Invoke-RestMethod -Uri "https://$appName.azurewebsites.us/health"
```

---

## Project Structure

```
UserAccessCheckerApi/
├── app.py                          # Flask app — routes & entrypoint
├── requirements.txt                # Python dependencies
├── .env.sample                     # Environment variable template
├── .gitignore
├── startup.txt                     # Gunicorn startup command reference
├── data/
│   ├── __init__.py
│   └── user_access_repository.py   # Cosmos DB queries
└── security/
    ├── __init__.py
    └── token_reader.py             # Easy Auth + JWT authentication
```
