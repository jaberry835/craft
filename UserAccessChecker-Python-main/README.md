# UserAccessChecker Azure Function (Python)


https://accesschecker-python.azurewebsites.us/api/user-access


HTTP-triggered Azure Function that authenticates callers with Microsoft Entra ID and queries Azure Cosmos DB for a user's access string by login name. Designed for Azure Government (authority host login.microsoftonline.us).

## Configuration
Set the following environment variables (`.env` file for local dev):

- AZURE_TENANT_ID: 03f141f3-496d-4319-bbea-a3e9286cab10
- AZURE_AUTHORITY_HOST: https://login.microsoftonline.us
- API_AUDIENCE: api://5e9822c5-f870-4acb-b2e6-1852254d9cbb
- AZURE_COSMOS_DB_ENDPOINT: https://chat-db.documents.azure.us:443/
- AZURE_COSMOS_DB_DATABASE: ChatDatabase
- AZURE_COSMOS_DB_CONTAINER: UserAccess
- AZURE_COSMOS_DB_KEY: (optional, uses managed identity if not provided)
- COSMOS_PARTITION_KEY_PATH: /LoginID

Copy `.env.sample` to `.env` and fill in your values for local development.

Cosmos container expected document shape:

```
{
  "id": "95095fca-08b8-4c92-ad8f-f90922df27b1d",
  "LoginID": "adamrud@FedAIRS.onmicrosoft.us",
  "Access": "confidential"
}
```

## Authentication
- Prefer App Service Authentication (Easy Auth): X-MS-CLIENT-PRINCIPAL header used.
- Fallback: Bearer JWT validation using OpenID Connect metadata from the tenant on the specified authority host.
- Extracted login claims: upn, preferred_username, name, or oid.

## Running locally
Install Python 3.9+ and Azure Functions Core Tools v4. Then:

```pwsh
# Create virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Copy and configure environment variables
Copy-Item .env.sample .env
# Edit .env with your actual values

# Start function
func start
```

Call:

```pwsh
# With Easy Auth locally disabled, pass a valid Bearer token for audience API_AUDIENCE
# Or simulate Easy Auth header if needed for local tests.
Invoke-RestMethod -Uri http://localhost:7071/api/user-access -Headers @{ Authorization = "Bearer <token>" }
```

## Deployment notes
- Assign a user-assigned or system-assigned managed identity to the Function App.
- Grant the identity "Cosmos DB Built-in Data Reader" on the Cosmos account or the target database/container.
- Configure the app settings as above in the Function App.

### Container Deployment to Azure

The function app is deployed as a Docker container to an Azure Function App on an Elastic Premium (or Dedicated) plan.

#### Prerequisites
- Azure CLI (`az`) logged in
- Docker (optional — you can build in ACR directly)
- An Azure Container Registry (ACR), e.g. `dituacr.azurecr.us`
- An Azure Function App configured for Linux container deployment

#### 1. Build and push the container image

**Option A — Build in ACR (no local Docker needed):**
```pwsh
az acr build --registry dituacr --image useraccesschecker:latest .
```

**Option B — Build locally and push:**
```pwsh
az acr login --name dituacr
docker build -t dituacr.azurecr.us/useraccesschecker:latest .
docker push dituacr.azurecr.us/useraccesschecker:latest
```

#### 2. Point the Function App to the ACR image

```pwsh
az functionapp config container set `
  --name accesschecker-python `
  --resource-group agentchatv2 `
  --registry-server dituacr.azurecr.us `
  --image "dituacr.azurecr.us/useraccesschecker:latest"
```

#### 3. Enable managed identity for ACR image pulls

The Function App's managed identity must have the **AcrPull** role on the ACR.

```pwsh
# Get the Function App's system-assigned managed identity principal ID
$principalId = az functionapp identity show `
  --name accesschecker-python `
  --resource-group agentchatv2 `
  --query principalId -o tsv

# Get the ACR resource ID
$acrId = az acr show --name dituacr --query id -o tsv

# Assign AcrPull role
az role assignment create `
  --assignee $principalId `
  --role AcrPull `
  --scope $acrId
```

Then enable managed identity credentials for container pulls:

```pwsh
az resource update `
  --ids (az functionapp show --name accesschecker-python --resource-group agentchatv2 --query id -o tsv) `
  --set properties.siteConfig.acrUseManagedIdentityCreds=true
```

#### 4. Grant managed identity access to Cosmos DB

Assign the **Cosmos DB Built-in Data Reader** role (role ID `00000000-0000-0000-0000-000000000002`) to the Function App's identity:

```pwsh
az cosmosdb sql role assignment create `
  --account-name chat-db `
  --resource-group AOAI `
  --role-definition-id 00000000-0000-0000-0000-000000000002 `
  --principal-id $principalId `
  --scope "/"
```

#### 5. Set the Function App configuration

```pwsh
az functionapp config appsettings set `
  --name accesschecker-python `
  --resource-group agentchatv2 `
  --settings `
    FUNCTIONS_WORKER_RUNTIME=python `
    FUNCTIONS_EXTENSION_VERSION="~4" `
    AZURE_TENANT_ID="03f141f3-496d-4319-bbea-a3e9286cab10" `
    AZURE_AUTHORITY_HOST="https://login.microsoftonline.us" `
    API_AUDIENCE="api://5e9822c5-f870-4acb-b2e6-1852254d9cbb" `
    AZURE_COSMOS_DB_ENDPOINT="https://chat-db.documents.azure.us:443/" `
    AZURE_COSMOS_DB_DATABASE="ChatDatabase" `
    AZURE_COSMOS_DB_CONTAINER="UserAccess" `
    COSMOS_PARTITION_KEY_PATH="/LoginID" `
    RESPONSE_FORMAT="text"
```

#### 6. Restart and verify

```pwsh
az functionapp restart --name accesschecker-python --resource-group agentchatv2

# Check that the function is listed
az functionapp function list --name accesschecker-python --resource-group agentchatv2 -o table
```

Check **Deployment Center > Logs** in the Azure Portal to verify the container image was pulled successfully.

## Endpoints

### GET `/api/user-access`
Authenticates the caller and returns their access level string from Cosmos DB.

**Response:**
- 200 OK: `text/plain` body containing the access string.
- 401 Unauthorized: missing/invalid token or identity.
- 404 Not Found: no record for the login.

### GET `/api/get-hash`
Authenticates the caller and returns their `ss_tokens` array from Cosmos DB.

Queries the `ss_tokens` field from the user's Cosmos DB document (matched by `LoginID`) and returns it as a JSON array.

**Response:**
- 200 OK: `application/json` body containing the `ss_tokens` array (e.g. `["token1", "token2"]`).
- 401 Unauthorized: missing/invalid token or identity.
- 404 Not Found: no `ss_tokens` found for the login.
- 500 Internal Server Error: unexpected failure.

**Example call:**
```pwsh
Invoke-RestMethod -Uri https://accesschecker-python.azurewebsites.us/api/get-hash -Headers @{ Authorization = "Bearer <token>" }
```



## CosmosDB settings

Partition Key:  /LoginID
Table:  UserAccess


example content in cosmos

{
    "id": "95095fca-08b8-4c92-ad8f-f90922df27b1d",
    "LoginID": "adamrud@FedAIRS.onmicrosoft.us",
    "Access": "confidential",
    "ss_tokens": [
        "hash1",
        "hash2",
        "hash3"
    ],
    "_rid": "id1mAO0bdJABAAAAAAAAAA==",
    "_self": "dbs/id1mAA==/colls/id1mAO0bdJA=/docs/id1mAO0bdJABAAAAAAAAAA==/",
    "_etag": "\"b402a05d-0000-2b00-0000-69a07e540000\"",
    "_attachments": "attachments/",
    "_ts": 1772125780
}