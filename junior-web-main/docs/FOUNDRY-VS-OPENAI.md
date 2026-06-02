# Microsoft Foundry Versus Generic OpenAI

This document explains how Junior Workbench connects to Microsoft Foundry endpoints versus a generic OpenAI endpoint, and what would need to differ operationally.

## Current Product Boundary

Junior Workbench currently has first-class support for Azure-hosted model connections under the `azure-openai` connector type.

That includes Azure-hosted endpoint patterns such as:

- Azure OpenAI resource endpoints such as `https://your-resource.openai.azure.com`
- Microsoft Foundry project endpoints such as `https://your-account.services.ai.azure.com/api/projects/your-project/openai/v1/responses`
- Microsoft Foundry OpenAI-compatible v1 endpoints such as `https://your-account.services.ai.azure.com/openai/v1/`

Generic OpenAI endpoints such as `https://api.openai.com/v1` are not currently modeled as a separate connector type in the product.

In other words:

- Foundry is supported through the existing Azure connector flow.
- Public OpenAI is not yet a first-class runtime target.

## High-Level Difference

The biggest difference is identity and authorization.

- Microsoft Foundry can use Microsoft Entra ID, managed identity, Azure RBAC, and Foundry project-scoped permissions.
- Generic OpenAI uses an OpenAI API key and does not participate in Azure RBAC or managed identity.

## Endpoint Examples

### Microsoft Foundry Project Endpoint

Typical endpoint:

```text
https://your-account.services.ai.azure.com/api/projects/your-project/openai/v1/responses
```

Characteristics:

- Hostname family: `*.services.ai.azure.com`
- Scope or audience for Entra tokens: `https://ai.azure.com/.default`
- Authorization can use managed identity or another Entra credential
- Access is controlled by Foundry RBAC on the Foundry resource or Foundry project

### Microsoft Foundry OpenAI-Compatible Endpoint

Typical endpoints:

```text
https://your-account.services.ai.azure.com/openai/v1/
https://your-resource.openai.azure.com/openai/v1/
```

Characteristics:

- Uses the OpenAI-compatible `v1` path shape
- Can be called with OpenAI-compatible client libraries
- Still remains Azure-hosted and can still use Entra authentication
- Can represent Foundry-hosted model access even though the request shape looks more like a standard OpenAI client flow
- In Foundry documentation, `https://ai.azure.com/.default` is the relevant Entra scope for Foundry-hosted v1 usage

### Azure OpenAI Resource

Typical endpoint:

```text
https://your-resource.openai.azure.com/openai/v1
```

Characteristics:

- Hostname family: `*.openai.azure.com`
- Scope or audience for Entra tokens: `https://cognitiveservices.azure.com/.default`
- Authorization can use Entra ID or API key
- Access is controlled by Azure permissions on the Azure OpenAI resource

### Generic OpenAI

Typical endpoint:

```text
https://api.openai.com/v1
```

Characteristics:

- Hostname family: `api.openai.com`
- No Azure token audience or Entra scope
- Authorization is normally an OpenAI API key sent as a bearer token
- No Azure RBAC, no managed identity, no Foundry project roles

## Foundry Has Two Connection Styles

When people say "Foundry endpoint," they can mean one of two things:

- A Foundry project endpoint under `*.services.ai.azure.com/api/projects/...`
- An OpenAI-compatible Foundry `v1` endpoint under either `*.services.ai.azure.com/openai/v1/` or, in some scenarios, `*.openai.azure.com/openai/v1/`

Those are both Azure-hosted and both can participate in Entra-based authentication, but they are not the same operational surface.

- The project endpoint is the clearest expression of Foundry project RBAC.
- The OpenAI-compatible Foundry endpoint is closer to standard OpenAI client usage and is designed to reduce client-side differences.

## Authentication Model Differences

### Foundry

Foundry is the most Azure-native option.

Junior Workbench can authenticate to Foundry endpoints using `DefaultAzureCredential`, which means it can use:

- a developer's Azure CLI sign-in in local development
- Visual Studio Code or developer tool credentials
- a VM, App Service, or other hosted managed identity in Azure

This works only if two things are true:

- the process can reach the endpoint on the network
- the identity has the required Foundry permissions

For Foundry project endpoints, a successful token is not enough by itself. The calling identity also needs Foundry RBAC on the project or parent resource. If the app returns a `PermissionDenied` error mentioning `Microsoft.CognitiveServices/accounts/AIServices/agents/write`, that means authentication worked but authorization is still missing.

For OpenAI-compatible Foundry `v1` endpoints, the request shape looks more like standard OpenAI usage, but the endpoint is still Azure-hosted. You should still treat it as an Azure identity and permission problem rather than as a public OpenAI API-key-only problem.

### Generic OpenAI

Generic OpenAI is simpler from a config perspective but less integrated with Azure platform identity.

The runtime would normally:

- store an OpenAI API key as a secret
- send that key on each request
- avoid Azure token acquisition entirely

There is no Azure managed identity path for the public OpenAI API.

## Authorization And Permissions

### Foundry

Foundry authorization is role-based.

Common implications:

- The VM or App Service managed identity must be granted a Foundry role.
- The role must be assigned at the right scope, usually the Foundry project for project endpoints.
- Network reachability and token acquisition can succeed even while the request still fails with a permission error.

Typical minimum role for project-style access:

- `Foundry User` on the target Foundry project

For OpenAI-compatible Foundry endpoints, the exact required role depends on whether the target is operating as Foundry-hosted model access or as an Azure OpenAI resource path. The important distinction for this codebase is that these remain Azure permissions, not public OpenAI API-key permissions.

### Generic OpenAI

Generic OpenAI authorization is key-based.

Common implications:

- If the API key is valid, the request is authorized.
- There is no separate Azure RBAC troubleshooting path.
- There is no Azure portal IAM assignment for the public OpenAI endpoint.

## What Junior Workbench Does Today

For Azure-hosted connectors, the product now surfaces diagnostics in the admin screens so you can see:

- endpoint host
- endpoint type
- auth mode
- effective credential scope
- deployment or model name
- API version
- whether an API key is stored

That helps distinguish these cases:

- wrong endpoint family
- wrong token audience
- missing API key
- Foundry RBAC failure after successful authentication

The connector configuration also supports an explicit endpoint type. This matters for air-gapped, private DNS, sovereign, and custom-hostname environments where hostname-based auto-detection might not be reliable.

The supported endpoint types are:

- `foundry-project`
- `openai-v1`
- `azure-openai-legacy`
- `auto`

## Configuring A Foundry Connection In Junior Workbench

Use the existing Azure OpenAI connector and set:

- endpoint to either your Foundry project endpoint or your Foundry OpenAI-compatible `v1` endpoint
- endpoint type to match the request shape you expect
- authentication to `Microsoft Entra ID`
- credential scope to blank for auto-detection, or explicitly `https://ai.azure.com/.default` when you are targeting Foundry-hosted endpoints

Operational expectations:

- the app can use managed identity in Azure
- the calling identity needs Azure-side permissions, and for project endpoints specifically that usually means Foundry RBAC
- project-style endpoints should show `Foundry project` as the endpoint type in connectivity diagnostics
- OpenAI-compatible Foundry endpoints should still be treated as Azure-hosted endpoints, not as public OpenAI

Recommended endpoint type mapping:

- `foundry-project` for `.../api/projects/.../openai/v1/responses`
- `openai-v1` for `.../openai/v1/`, `.../chat/completions`, or `.../responses` style Azure-hosted endpoints
- `azure-openai-legacy` for classic Azure OpenAI deployment-style base endpoints

For air-gapped or custom-host environments, do not depend on `auto` unless the endpoint structure is intentionally mirrored from the public shapes. Set endpoint type explicitly and override `credentialScope` when the audience differs from the public Azure defaults.

## What Would Need To Change To Support Generic OpenAI First-Class

If the product should support public OpenAI directly, the clean design would be to add a new connector type instead of overloading the Azure connector.

Recommended differences:

- add a new connector type such as `openai`
- require API key authentication only
- default the endpoint to `https://api.openai.com/v1`
- remove Azure cloud and credential scope fields for that connector type
- store the OpenAI API key in the same secret-management path used for other connector secrets
- show connectivity diagnostics that focus on key presence, endpoint reachability, and model availability rather than Entra scope or Azure RBAC

That keeps the UI honest because a public OpenAI connection does not behave like Azure OpenAI or Foundry.

## Troubleshooting Differences

### If Foundry Fails

Check these in order:

- identify which Foundry endpoint style you are using:
	- `*.services.ai.azure.com/api/projects/...` project endpoint
	- `*.services.ai.azure.com/openai/v1/` or `*.openai.azure.com/openai/v1/` OpenAI-compatible Foundry endpoint
- confirm the connector endpoint type matches that shape instead of relying on `auto` for custom hostnames
- auth mode is `Microsoft Entra ID` unless you have intentionally chosen a key-based Azure flow
- effective scope matches the Azure-hosted endpoint you are targeting; for Foundry-hosted endpoint flows that is typically `https://ai.azure.com/.default`
- network path from the host can reach the endpoint
- managed identity or user identity has the required Azure-side permissions, and for project endpoints specifically a Foundry role on the project

Typical failure patterns:

- `401` with audience mismatch means the token scope is wrong
- `403` or `PermissionDenied` with `AIServices/agents/write` means the identity lacks Foundry RBAC

### If Generic OpenAI Fails

Check these in order:

- endpoint is `https://api.openai.com/v1` or another intended OpenAI-compatible endpoint
- API key is present and current
- model name matches what the account can access
- outbound network rules allow the call

Typical failure patterns:

- `401` usually means missing or invalid API key
- `404` can mean wrong model or wrong endpoint path
- rate-limit errors are account and quota issues, not Azure IAM issues

## Recommendation

Use Microsoft Foundry when you want:

- managed identity
- Entra authentication
- Azure RBAC
- project-scoped operational control inside Azure

Use generic OpenAI only when you explicitly want a non-Azure OpenAI account and are comfortable with API-key-only authentication.

For the current Junior Workbench codebase, Foundry project endpoints, Foundry OpenAI-compatible endpoints, and Azure OpenAI all fit the existing Azure connector architecture. Public OpenAI support would be a deliberate product extension rather than a small config tweak.