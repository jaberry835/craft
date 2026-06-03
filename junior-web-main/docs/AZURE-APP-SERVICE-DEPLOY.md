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
2. Builds the client app.
3. Compiles the server.
4. Stages a deployable package in `.deploy/package`.
5. Installs production dependencies into that package locally.
6. Creates a zip package.
7. Deploys the zip to Azure App Service with `az webapp deploy`.

When the web app already exists, the script does not look up the App Service plan and does not try to create anything.
The normal deploy path also does not run `npm install` on App Service.

## Typical Deploy Steps

### Build Only

Create the self-contained deployment package locally:

```powershell
npm run build:deploy
```

That package is written to `.deploy/package` and already includes production `node_modules`.

This is the deployable unit. The normal deployment path uploads this package as-is; App Service does not install packages during deploy.

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

## Notes

- The deploy package is created at `.deploy/package`.
- The deploy package includes production `node_modules`.
- For an existing web app, the default path just pushes the prepared zip package.
- Use the separate App Service settings script when you need to update `WEBSITE_RUN_FROM_PACKAGE`, `SCM_DO_BUILD_DURING_DEPLOYMENT`, or `NODE_ENV`.
- If a VM system-assigned identity is used for deployment, grant it `Website Contributor` on the target web app.
- If you use `-CreateIfMissing` on a Linux App Service plan, the script sets the startup command to `npm start`.
- If Azure CLI prompts for MFA or a claims challenge, complete the login flow and rerun the script.