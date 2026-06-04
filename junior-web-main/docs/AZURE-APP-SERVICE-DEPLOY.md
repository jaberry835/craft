# Azure App Service Deploy

This is the simplest deployment path for Junior Workbench.

The default path is:

1. Deploy into an existing Azure App Service web app.
2. Do not create or inspect plans unless you explicitly ask for that.

For an existing web app, you do not need to pass `-AppServicePlan`.

The repo includes a deployment script for this flow:

```powershell
npm run azure:deploy:pwsh -- -ResourceGroup <rg> -AppName <app-name>
```

If the web app does not exist yet and you want the script to create it in an existing plan, pass both `-CreateIfMissing` and the plan name:

```powershell
npm run azure:deploy:pwsh -- -ResourceGroup <rg> -AppName <app-name> -CreateIfMissing -AppServicePlan <existing-plan-name>
```

## Prerequisites

Make sure these are already in place:

1. Azure CLI is installed.
2. You are signed in with `az login`.
3. Node.js and npm are installed.
4. The target resource group already exists.
5. The target App Service plan already exists if you want the script to create the web app for you.

For an existing web app, the required inputs are only:

1. `-ResourceGroup`
2. `-AppName`

There is also a separate script for App Service deployment settings:

```powershell
npm run azure:configure-appservice:pwsh -- -ResourceGroup <rg> -AppName <app-name>
```

If deployment runs from a VM by using that VM's system-assigned managed identity, grant that identity `Website Contributor` on the target web app.

Example role assignment:

```powershell
az role assignment create \
	--assignee-object-id <vm-system-assigned-principal-id> \
	--assignee-principal-type ServicePrincipal \
	--role "Website Contributor" \
	--scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<app-name>
```

This role is for deployment operations against the web app. It is separate from any runtime roles the application needs for Blob Storage, Cosmos DB, Key Vault, Azure OpenAI, or Azure AI Search.

## What The Script Does

The deployment script:

1. Runs `npm run build:deploy`.
2. Builds the client app with Vite into `dist/client`.
3. Bundles the server with esbuild into a single `dist/server/index.js`.
4. Stages a deployable package in `.deploy/package`.
5. Creates a zip package.
6. Deploys the zip to Azure App Service with `az webapp deploy`.

The deploy package does not contain `node_modules`. The server bundle has all runtime dependencies inlined at build time.

When the web app already exists, the script does not look up the App Service plan and does not try to create anything.
The deploy path does not run `npm install` on App Service.

## Typical Deploy Steps

### Build Only

Create the self-contained deployment package locally:

```powershell
npm run build:deploy
```

That package is written to `.deploy/package` and contains:

1. `client/` — built React assets from Vite.
2. `server/index.js` — single bundled Node server produced by esbuild.
3. `config/` and `data/` — seed configuration and workspace data.
4. `package.json` — minimal manifest with `"start": "node server/index.js"` and no `dependencies`.

There is no `node_modules` in the package. All runtime dependencies are inlined into the server bundle.

This is the deployable unit. The deployment path uploads this package as-is; App Service does not install packages during deploy.

### Configure App Service Settings

Run this separately when you need the web app configured for package deployment:

```powershell
npm run azure:configure-appservice:pwsh -- -ResourceGroup <rg> -AppName <app-name>
```

By default, that script sets:

1. `WEBSITE_RUN_FROM_PACKAGE=1`
2. `SCM_DO_BUILD_DURING_DEPLOYMENT=false`
3. `NODE_ENV=production`

If you want it to also set the Linux startup command:

```powershell
npm run azure:configure-appservice:pwsh -- -ResourceGroup <rg> -AppName <app-name> -StartupCommand 'npm start'
```

### Build And Deploy

From the repo root:

```powershell
az login
npm install
npm run azure:deploy:pwsh -- -ResourceGroup <rg> -AppName <app-name>
```

This is the normal command for redeploying code to an existing web app.

### Deploy Without Building

If the package already exists locally, deploy it without rebuilding:

```powershell
npm run azure:deploy:pwsh -- -ResourceGroup <rg> -AppName <app-name> -SkipBuild
```

This is the preferred redeploy flow after a successful `npm run build:deploy`.

If the app does not exist yet, use:

```powershell
npm run azure:deploy:pwsh -- -ResourceGroup <rg> -AppName <app-name> -CreateIfMissing -AppServicePlan <existing-plan-name>
```

## App Settings

Code deployment and app configuration are separate.

After the web app exists, configure its application settings for:

1. Identity
2. Azure OpenAI or Foundry connection settings
3. Blob storage
4. Cosmos DB
5. Key Vault

Use these docs for that setup:

1. [README-identity.md](README-identity.md)
2. [AZURE-PERSISTENCE-DEPLOYMENT.md](AZURE-PERSISTENCE-DEPLOYMENT.md)
3. [CONFIGURATION.md](CONFIGURATION.md)

### Apply A Local .env File To App Service

For getting started quickly, you can push a local env file's contents up as App Service application settings:

```powershell
npm run azure:apply-env:pwsh -- -ResourceGroup <rg> -AppName <app-name> -EnvFile .env.appservice
```

Behavior:

1. Reads `KEY=VALUE` pairs from the file (`#` comments and blank lines are ignored, optional `export ` prefix is supported, surrounding single or double quotes are stripped).
2. Verifies the target web app exists.
3. Applies the keys as application settings via `az webapp config appsettings set`. App Service restarts the app after this update.
4. By default the script is additive: it only writes the keys present in the file. Pass `-Replace` to also remove existing user-defined settings that are not in the file (`WEBSITE_*`, `SCM_*`, `APPSETTING_*`, `DIAGNOSTICS_*`, `APPLICATIONINSIGHTS_*`, `APPINSIGHTS_*`, `WEBSITES_*`, and `NODE_ENV` are preserved).

Recommended practice:

1. Do not push your local `.env` directly. Keep `.env` for local development.
2. Maintain a separate file like `.env.appservice` that only contains the production-shape values for the web app.
3. Add both files to `.gitignore`.
4. Treat secrets as a temporary measure here. Plan to move them to Key Vault references (`@Microsoft.KeyVault(SecretUri=...)`) once the basic deploy is healthy.

### Grant Runtime Roles To The Web App's Managed Identity

The deployed app authenticates to Cosmos DB, Storage, Key Vault, Azure OpenAI, and Azure AI Search via the web app's system-assigned managed identity. One script enables that identity (if needed) and grants the runtime data-plane roles in one pass:

```powershell
npm run azure:grant-runtime-roles:pwsh -- `
  -ResourceGroup j-ai-rg `
  -AppName jr-wrkspc `
  -EnableIdentity `
  -CosmosAccount jb-cosmos1 `
  -StorageAccount <storage-account> `
  -KeyVaultName <vault-name> `
  -AzureOpenAiAccount <aoai-account> `
  -SearchService <search-service>
```

Each Azure resource parameter is optional. Pass only the ones the app actually uses; the others are skipped.

What it grants:

1. Cosmos DB: `Cosmos DB Built-in Data Contributor` at the account scope (data-plane role; control-plane Contributor does not grant data access).
2. Blob Storage: `Storage Blob Data Contributor` at the storage account scope. Use `-StorageRole Reader` for read-only.
3. Key Vault: `Key Vault Secrets User` at the vault scope. Use `-KeyVaultRole Officer` if the app must write secrets.
4. Azure OpenAI: `Cognitive Services OpenAI User` at the cognitive services account scope.
5. Azure AI Search: `Search Index Data Reader` at the search service scope.

Each resource parameter accepts an optional `*ResourceGroup` companion if the resource lives in a different resource group than the web app:

```powershell
-CosmosResourceGroup, -StorageResourceGroup, -KeyVaultResourceGroup,
-AzureOpenAiResourceGroup, -SearchResourceGroup
```

The script is idempotent: re-running it skips role assignments that already exist. Restart the web app once after the first successful run so the runtime picks up the new identity and roles:

```powershell
az webapp restart --resource-group <rg> --name <app-name>
```

These runtime roles are separate from any deployment role (`Website Contributor`) granted to a build VM's identity.

## Notes

- The deploy package is created at `.deploy/package`.
- The deploy package does not include `node_modules`. The server is bundled by esbuild into `server/index.js` with all runtime dependencies inlined.
- esbuild is a `devDependency` and only runs on the build machine. It is not deployed.
- For an existing web app, the default path just pushes the prepared zip package.
- Use the separate App Service settings script when you need to update `WEBSITE_RUN_FROM_PACKAGE`, `SCM_DO_BUILD_DURING_DEPLOYMENT`, or `NODE_ENV`.
- If a VM system-assigned identity is used for deployment, grant it `Website Contributor` on the target web app.
- If you use `-CreateIfMissing` on a Linux App Service plan, the script sets the startup command to `npm start`.
- If Azure CLI prompts for MFA or a claims challenge, complete the login flow and rerun the script.