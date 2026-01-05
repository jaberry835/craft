# UserAccessChecker Azure Function (Python)

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

## Response
- 200 OK: text/plain body containing the access string.
- 401 Unauthorized: missing/invalid token or identity.
- 404 Not Found: no record for the login.



## CosmosDB settings

Partition Key:  /LoginID
Table:  UserAccess
