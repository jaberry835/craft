# Air-gapped App Service container deployment

AAA uses a self-contained runtime artifact built entirely on the Windows development VM. TypeScript validation, Vite bundling, and server dependency bundling happen before Docker runs. The Dockerfile only copies `dist/runtime` into an approved Node.js runtime image.

## Development VM prerequisites

- The repository dependencies and npm cache are already populated from the approved package feed.
- Node.js 22.12 or later (below 25), npm 10 or later, PowerShell 7, Azure CLI, and a Docker-compatible engine are installed.
- The approved Linux Node 22 base image is loaded into the local image store. The push script checks it with `docker image inspect` and builds with `--pull=false`.
- The Azure CLI identity has `AcrPush` on the existing registry. ACR admin credentials are not required.

## Build the runtime locally

```powershell
npm run build
```

This creates `dist/runtime`, including the browser client, one bundled Node.js server entrypoint, source map, default project template, safe configuration, and an empty data directory. Server dependencies are compiled into the bundle by esbuild. The artifact contains no `node_modules`, package manager metadata, or platform-specific native modules.

The build fails if an unresolved third-party package import remains. Local Playwright is deliberately omitted from the App Service bundle because container deployments use disabled or bridge browser mode. It deliberately excludes the development VM's project paths and data.

## Build locally and push to ACR

```powershell
./scripts/Push-AcrImage.ps1 `
  -SubscriptionId '<subscription-guid>' `
  -AcrName '<registry-name>' `
  -Repository 'aaa-security-workbench' `
  -Tag '<immutable-release-or-commit>' `
  -BaseImage '<approved-node-22-image:tag>'
```

The script runs the full local build, selects the subscription, resolves the registry login server, signs in with `az acr login`, runs the local Docker build, and pushes the resulting ACR tag. It does not use `az acr build`. Use `-SkipStage` only when `dist/runtime` was built and verified immediately beforehand.

## App Service settings

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