# AAA Azure Container Deployment Plan

Status: Ready for Validation

## Goal

Build AAA entirely on the air-gapped development VM, stage a complete runtime artifact under `dist`, create a runtime-only container image from that artifact, and push the image to Azure Container Registry.

## Constraints

- No application compilation or npm installation occurs in the Docker build.
- Docker copies only the staged runtime artifact from `dist`.
- The development VM has the approved Node.js, npm dependencies/cache, Docker-compatible container tooling, Azure CLI, and network access to the target ACR.
- Browser automation remains optional; App Service uses bridge mode or disabled mode rather than local Playwright.

## Planned Artifacts

- `deploy/Dockerfile`: runtime-only Linux image using `node:24-alpine` by default. It copies `dist` to `/app/dist`, `dist/config` to `/app/config`, and `dist/template` to `/app/template`, creates writable logs/data directories, and starts `node dist/index.js`. It performs no npm install or application build.
- `.dockerignore`: sends only `dist` and the Dockerfile to the local Docker daemon.
- `scripts/build-runtime.mjs`: bundles the server and all third-party runtime dependencies on the development VM, then assembles the client, template, safe model configuration, and empty container-safe project registry under `dist`.
- `scripts/New-ContainerArtifact.ps1`: compatibility command that runs the complete local build and verifies that `dist` contains no `node_modules`.
- `scripts/Push-AcrImage.ps1`: verifies Azure CLI and local Docker, selects the requested subscription, resolves the ACR login server, uses `az acr login`, builds locally with `--pull=false`, applies the immutable ACR tag, and runs `docker push`. It never invokes `az acr build`.
- `docs/container-deployment.md`: documents offline prerequisites, artifact contents, commands, App Service settings, and persistent storage expectations.

## Artifact Contract

`dist` is the complete build artifact and the only application content copied into the image:

```text
dist/
	config/agent-connections.json
	config/projects.json
	client/
	index.js
	index.js.map
	package.json
	template/
	artifact-manifest.json
```

The staging script creates `config/projects.json` with an empty project list rather than copying the development VM's Windows path. At first start, AAA creates its managed starter project from the bundled template.

The runtime build fails if any third-party package import remains unresolved or Playwright package code enters the bundle. It bundles pure-JavaScript fallbacks instead of optional native WebSocket accelerators and excludes workstation-only Playwright. Each build smoke-tests an isolated copy in the Docker directory layout without `node_modules`, including disabled/bridge launch rejection and an explicit error for unsupported local browser mode. These host-side tests do not replace Linux image validation.

## Validation

- Run the local build and focused deployment-script checks.
- Verify the staged artifact contains bundled server/client assets, templates, and safe config.
- Verify the artifact contains no `node_modules` and starts outside the repository.
- Validate PowerShell syntax and repository lint/tests.
- Docker image build and runtime smoke test are conditional because Docker is not currently installed or available on this development VM.
- An ACR push occurs only when the generated push script is explicitly invoked with an approved registry and tag.

### All validation checks pass

- [ ] 1. Core Validation (CLI, auth, build, validate, what-if)
- [ ] 2. Docker Build (containerized deployment)
- [ ] 3. Azure Policy Validation

### Validation proof and blockers

- PASS: Azure CLI 2.86.0 is installed and authenticated.
- PASS: `npm run build` and `npm run lint` complete successfully.
- Historical PASS (before layout update): `npm run build` created the self-contained `dist/runtime` artifact on Windows.
- PASS: The artifact contains no `node_modules` or unresolved third-party imports.
- Historical PASS (before layout update): A copy of only `dist/runtime` started outside the repository and served HTTP 200 without access to repository dependencies.
- PASS: The staged entrypoint served `GET /api/auth/config` with HTTP 200.
- PASS: PowerShell syntax, immutable-tag rejection, and the copy-only Dockerfile contract were validated.
- BLOCKED: Docker is not installed or available on `PATH`, so the Linux image cannot be built or inspected on this VM yet.
- BLOCKED: No target ACR name, immutable image tag, App Service resource, resource group, or region was supplied, so ACR authorization and Azure Policy checks cannot run.
- NOT APPLICABLE YET: No infrastructure provisioning was requested or generated, so there is no Bicep validation or what-if operation.

## Azure Context

- Current CLI context: `Jacks-ATU-Sub` (the push script still requires or confirms an explicit subscription ID)
- Registry: Required script parameter; must already exist
- Repository: Script parameter, default `aaa-security-workbench`
- Image tag: Required immutable script parameter, such as a release number or commit SHA; `latest` is rejected
- Target: Azure App Service for Containers

The script uses the signed-in Azure CLI identity and `az acr login`; ACR admin credentials are not enabled or stored.

## Runtime Settings

- `PORT=8080`
- `AAA_HOST=0.0.0.0`
- `AAA_PROJECT_TEMPLATE=/app/template`
- `AAA_BROWSER_MODE=bridge` when the bridge transport is available; otherwise `disabled`
- Microsoft Entra, model, and storage values are supplied as App Service settings or managed-identity configuration, never baked into the image.
- Writable project/session data must use configured external storage or an App Service persistent mount; image-layer data is ephemeral.

## Approval

Approved and implemented. Local artifact staging and runtime smoke validation passed. Docker image validation and ACR push remain pending because Docker is not currently available on this development VM and no target ACR/tag was supplied.
