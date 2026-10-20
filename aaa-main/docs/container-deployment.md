# Air-gapped App Service container deployment

AAA uses a self-contained runtime artifact built entirely on the Windows development VM. TypeScript validation, Vite bundling, server compilation, and production dependency staging happen before Docker runs. The Dockerfile copies `dist` (including `dist/node_modules`) into an approved Node.js runtime image. It never runs npm install.

## Development VM prerequisites

- The repository dependencies and npm cache are already populated from the approved package feed.
- Node.js 22.12 or later (below 25), npm 10 or later, PowerShell 7, Azure CLI, and a Docker-compatible engine are installed.
- The approved Linux Node base image is loaded into the local image store (default `node:24-alpine`). The push script checks it with `docker image inspect` and builds with `--pull=false`.
- The Azure CLI identity has `AcrPush` on the existing registry. ACR admin credentials are not required.

## Build the runtime locally

```powershell
npm run build
```

This creates `dist`, including the browser client, compiled Node.js server entrypoint, source map, default project template, safe configuration, and production `node_modules`. Production packages are copied from the installed dependency tree, including nested dependencies, without downloading packages or modifying the development install. Development dependencies and Playwright are excluded. The build rejects native addons because a Windows binary cannot run in the Linux image.

The build fails if a third-party package import resolves outside the artifact. Isolated runtime tests verify the artifact starts without access to the repository's dependencies. Local Playwright is deliberately omitted from the App Service runtime because container deployments use disabled or bridge browser mode. The artifact excludes `.env`, the development VM's project paths, and data.

## Build locally and push to ACR

```powershell
./scripts/Push-AcrImage.ps1 `
  -SubscriptionId '<subscription-guid>' `
  -AcrName '<registry-name>' `
  -Repository 'aaa-security-workbench' `
  -Tag '<immutable-release-or-commit>' `
  -BaseImage '<approved-node-image:tag>'
```

The script runs the full local build, selects the subscription, resolves the registry login server, signs in with `az acr login`, runs the local Docker build, and pushes the resulting ACR tag. It does not use `az acr build`. Use `-SkipStage` only when `dist` was built and verified immediately beforehand.

## App Service settings

Import a local `.env` as App Service settings, not as a file in the image. Preview first, then apply:

```powershell
.\scripts\Set-AppServiceEnv.ps1 -SubscriptionId '<subscription-guid>' -ResourceGroup '<resource-group>' -AppName '<app-name>' -WhatIf
.\scripts\Set-AppServiceEnv.ps1 -SubscriptionId '<subscription-guid>' -ResourceGroup '<resource-group>' -AppName '<app-name>'
```

Requires PowerShell 7.2+ and an authenticated Azure CLI. Use `-EnvFile 'C:\path\to\.env'` or `-Slot 'staging'` as needed. Values are not printed, unrelated settings are preserved, and temporary JSON is removed on success or failure. Empty values are applied too; review workstation-only paths and placeholders before applying. App Service may restart.

Configure the Web App for Containers to use the pushed image and port `8080`. Set:

```text
PORT=8080
WEBSITES_PORT=8080
AAA_HOST=0.0.0.0
AAA_DATA_ROOT=/home/aaa/data
AAA_BROWSER_MODE=disabled
WEBSITES_ENABLE_APP_SERVICE_STORAGE=true
```

Use `AAA_BROWSER_MODE=bridge` after the browser bridge transport is deployed. Do not use `local` in App Service.

Set the App Service health-check path to `/api/auth/config`; it remains available without an app session and does not expose secrets. Allow at least 90 seconds for initial startup because the first run seeds a managed project from the bundled template. Supply Entra, Azure OpenAI, Cosmos DB, and storage settings through App Service configuration or managed identity. Do not place secrets in the artifact or image.

App Service's `/home` mount preserves local data across container restarts when storage is enabled. For scaled or production deployments, configure supported external persistence instead of relying on one instance's filesystem.