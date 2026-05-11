# Entra App Registration Setup for Junior VS Code Sign-In

This guide documents the two Entra app registrations needed so Junior can use **`vscode.authentication.getSession`** to acquire bearer tokens for APIM (or any protected web API) from inside VS Code.

Use this guide when:

1. `junior.azureOpenAI.authMode` or `junior.copilotCli.providerBearerTokenSource` is `vscode-auth-session`.
2. APIM (or your backend) validates incoming `Authorization: Bearer ...` against an Entra app audience.
3. You want VS Code to prompt the user with the standard Microsoft sign-in flow rather than asking the user to paste a raw bearer token.

This is the pattern that was needed to get past `AADSTS500113` ("reply URL not registered") in real-world testing, including for sovereign-cloud tenants.

## What You Are Building

You need **two Entra app registrations** that work together:

1. **API app registration** — represents the protected API. Exposes a delegated scope (typically `user_impersonation`). APIM validates incoming bearer tokens whose `aud` matches this app. If APIM is already working with bearer auth today, this is the app you already have.
2. **VS Code client app registration** — a separate client app used only for the interactive sign-in flow from the VS Code extension. VS Code can be told to use a custom client app via two special "scope" entries: `VSCODE_CLIENT_ID:<id>` and `VSCODE_TENANT:<tenant>`. Those are not real OAuth scopes — they are markers VS Code interprets to override the default sign-in app and tenant.

The split is intentional:

1. **Client app** = who is logging in.
2. **API app** = what resource the token is for.

## How the Flow Works

Junior calls:

```ts
vscode.authentication.getSession(providerId, scopes, { createIfNone: true });
```

with:

1. The auth provider id (`microsoft` or `microsoft-sovereign-cloud`).
2. A scopes array that includes the `VSCODE_CLIENT_ID` / `VSCODE_TENANT` overrides plus the API scope.

VS Code then signs the user in using the **VS Code client app**, requests an access token whose audience is the **API app**, and hands the token back to Junior. The token should arrive with:

1. `aud` matching the API app / APIM audience.
2. `scp` containing `user_impersonation`.
3. `tid` matching the tenant in `VSCODE_TENANT`.

## App Registration 1: API App

This is the existing app registration that APIM already trusts. Open **Microsoft Entra admin center** → **App registrations** → your existing app and verify the items below.

### Expose an API

Under **Expose an API**:

1. Confirm the **Application ID URI** exists, usually `api://<api-app-id>`.
2. Add a delegated scope named `user_impersonation`.

Suggested scope values:

1. Scope name: `user_impersonation`
2. Who can consent: `Admins and users`
3. Admin consent display name: `Access Junior API`
4. Admin consent description: `Allows the app to access Junior API on behalf of the signed-in user`
5. User consent display name: `Access Junior API`
6. User consent description: `Allow this app to access Junior API on your behalf`

### Leave APIM Audience Setup Alone

If APIM already validates tokens against this app, do not change it. The point of the new VS Code client app is to fix who performs the interactive login, not to change the API that APIM protects.

The matching APIM policy looks like this (see [APIM-FOUNDRY-BEARER-SETUP.md](APIM-FOUNDRY-BEARER-SETUP.md) for the full version):

```xml
<validate-azure-ad-token
  tenant-id="<your-tenant-id>"
  header-name="Authorization"
  failed-validation-httpcode="401"
  failed-validation-error-message="Unauthorized">
  <audiences>
    <audience>api://<api-app-id></audience>
    <audience><api-app-id></audience>
  </audiences>
</validate-azure-ad-token>
```

## App Registration 2: VS Code Client App

Create a new app registration for the VS Code login flow.

Go to **App registrations** → **New registration**:

1. Name: `Junior VS Code Client`
2. Supported account types:
   - `Single tenant` if only one tenant will ever sign in.
   - `Multitenant` if users from customer tenants need to sign in.
3. Redirect URI: leave blank for now and add it on the next step.

### Configure Redirect URIs

This is the part that matters most for the `AADSTS500113` error.

Open the new VS Code client app → **Authentication** → **Platform configurations** and add **both** of the platforms below.

#### Web Platform

Click **Add a platform** → **Web** and enter:

```text
https://vscode.dev/redirect
```

Used by VS Code's custom-client override flow in web-style sign-in paths.

#### Mobile and Desktop Applications Platform

Click **Add a platform** → **Mobile and desktop applications** and under **Custom redirect URIs** add:

```text
ms-appx-web://Microsoft.AAD.BrokerPlugin/<your-client-app-id>
```

Replace `<your-client-app-id>` with the **Application (client) ID** of the VS Code client app you are currently editing.

Summary of which URI goes where:

| Redirect URI | Platform |
|---|---|
| `https://vscode.dev/redirect` | Web |
| `ms-appx-web://Microsoft.AAD.BrokerPlugin/<client-app-id>` | Mobile and desktop applications |

If you only register the Web URI, desktop VS Code uses the broker/native sign-in path, sees no matching reply URL, and fails with `AADSTS500113`.

### Grant the VS Code Client App Permission to Call the API

Still in the VS Code client app:

1. Go to **API permissions** → **Add a permission** → **My APIs**.
2. Pick the API app from step 1.
3. Add the delegated permission `user_impersonation`.
4. Click **Grant admin consent** if your tenant requires it.

## Authorize the VS Code Client App on the API App

Go back to the **API app**.

Under **Expose an API** → **Authorized client applications**:

1. Add the **Application (client) ID** of the new VS Code client app.
2. Authorize it for the `user_impersonation` scope.
3. Also add VS Code's built-in client id and authorize it for the same scope:

   ```text
   aebc6443-996d-45c2-90f0-388ff96faa56
   ```

   This is the well-known client id used by the bundled VS Code Microsoft authentication provider. Pre-authorizing it lets the standard sign-in path consent without an extra prompt the first time a user signs in, even before the `VSCODE_CLIENT_ID` override kicks in.

This makes the relationship explicit: both the VS Code client app and the built-in VS Code first-party client are allowed to request `api://<api-app-id>/user_impersonation` from the API app.

## Update Junior Settings

Keep your existing auth provider, and change `authScopes` so VS Code uses the new client app for sign-in and the existing API app for the token audience.

### Local Agent (Azure OpenAI / APIM Bearer Mode)

```jsonc
{
  "junior.agentProvider": "local",
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://<your-apim-host>.azure-api.net",
  "junior.azureOpenAI.wireApi": "responses",
  "junior.azureOpenAI.authMode": "vscode-auth-session",
  "junior.azureOpenAI.bearerTokenSource": "vscode-auth-session",
  "junior.azureOpenAI.authProviderId": "microsoft",
  "junior.azureOpenAI.authScopes": [
    "VSCODE_CLIENT_ID:<new-vscode-client-app-id>",
    "VSCODE_TENANT:<tenant-id>",
    "api://<existing-api-app-id>/user_impersonation"
  ]
}
```

After saving settings, run **Junior: Sign In for Azure/APIM Bearer Mode** to establish the session.

### Copilot CLI BYOK Bearer Mode

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.providerBaseUrl": "https://<your-apim-host>.azure-api.net",
  "junior.copilotCli.providerType": "azure",
  "junior.copilotCli.providerWireApi": "responses",
  "junior.copilotCli.providerBearerTokenSource": "vscode-auth-session",
  "junior.copilotCli.providerAuthProviderId": "microsoft",
  "junior.copilotCli.providerAuthScopes": [
    "VSCODE_CLIENT_ID:<new-vscode-client-app-id>",
    "VSCODE_TENANT:<tenant-id>",
    "api://<existing-api-app-id>/user_impersonation"
  ]
}
```

After saving settings, run **Junior: Sign In for Copilot CLI Bearer Mode** to establish the session.

### Sovereign / Government Cloud

If the tenant lives in Azure US Government, Azure China, or another sovereign cloud, switch the auth provider id and add the matching VS Code environment settings. The `VSCODE_CLIENT_ID` / `VSCODE_TENANT` / API scope pattern stays the same.

```jsonc
{
  "junior.copilotCli.providerAuthProviderId": "microsoft-sovereign-cloud",
  "microsoft-sovereign-cloud.environment": "custom",
  "microsoft-sovereign-cloud.customEnvironment": {
    "name": "Gov",
    "portalUrl": "https://portal.azure.us/",
    "activeDirectoryEndpointUrl": "https://login.microsoftonline.us/",
    "activeDirectoryResourceId": "https://management.azure.us/",
    "resourceManagerEndpointUrl": "https://management.azure.us/",
    "managementEndpointUrl": "https://management.azure.us/"
  },
  "junior.copilotCli.providerAuthScopes": [
    "VSCODE_CLIENT_ID:<gov-vscode-client-app-id>",
    "VSCODE_TENANT:<gov-tenant-id>",
    "api://<gov-api-app-id>/user_impersonation"
  ]
}
```

For the well-known clouds, `microsoft-sovereign-cloud.environment` can also be set to `AzureUSGovernment` or `AzureChinaCloud` instead of using a `custom` block.

## What Junior's Code Is Doing

Junior calls `vscode.authentication.getSession(providerId, scopes, { createIfNone: true })`. The behavior is driven entirely by:

1. The provider id.
2. The `scopes` array.

If the scopes only include `api://.../user_impersonation`, VS Code uses its default first-party client. Adding `VSCODE_CLIENT_ID` and `VSCODE_TENANT` is what tells VS Code "use my client app and my tenant for this sign-in." The Junior source code does not change between the default-client and custom-client setups — only the settings change.

## What to Expect in the Token

When this is working, the access token Junior logs (claims only — Junior does not print the raw token) should show:

1. `aud` matches the API app / APIM audience.
2. `scp` contains `user_impersonation`.
3. `tid` matches the tenant in `VSCODE_TENANT`.

Junior writes these claims to the **Junior** output channel for both local Azure/APIM bearer mode and Copilot CLI bearer mode. Use them to confirm the two-app setup is wired up correctly.

## Troubleshooting

### AADSTS500113: No reply address is registered

The desktop VS Code sign-in path is using the broker, but the broker redirect URI is missing on the VS Code client app. Add `ms-appx-web://Microsoft.AAD.BrokerPlugin/<client-app-id>` under **Mobile and desktop applications** on the VS Code client app.

### AADSTS65001 / Consent required

Either grant admin consent on the VS Code client app's `user_impersonation` permission, or have each user complete consent on first sign-in.

### 401 from APIM after sign-in succeeds

The token was issued, but its `aud` does not match the audience APIM is validating. Check:

1. The API app's Application ID URI matches the `<audience>` entries in the APIM `validate-azure-ad-token` policy.
2. `authScopes` references the correct `api://<api-app-id>/user_impersonation`.
3. Junior's logged `aud` claim matches the APIM audience.

### Wrong tenant signs in

Either `VSCODE_TENANT` is wrong, or it is missing. Add it explicitly so VS Code does not fall back to the user's home tenant.

### "Signed in" message shows the wrong account label

VS Code reuses an existing session for the matching provider id + scopes. Run **Accounts** → **Sign Out** for that provider (or use a different `VSCODE_TENANT` value) to force a fresh sign-in.

## Practical Checklist

**API app**

1. Existing app registration.
2. Exposes `api://<api-app-id>/user_impersonation`.
3. APIM continues trusting it as audience.
4. VS Code client app added under **Authorized client applications**.
5. VS Code's built-in client id `aebc6443-996d-45c2-90f0-388ff96faa56` also added under **Authorized client applications**.

**VS Code client app**

1. Newly created app registration.
2. Web redirect URI: `https://vscode.dev/redirect`.
3. Mobile and desktop applications redirect URI: `ms-appx-web://Microsoft.AAD.BrokerPlugin/<client-app-id>`.
4. Delegated `user_impersonation` permission on the API app.
5. Admin consent granted if required by the tenant.

**Junior settings**

1. Provider id stays the same (`microsoft` for commercial, `microsoft-sovereign-cloud` for gov).
2. `authScopes` (or `providerAuthScopes` for Copilot CLI) contains, in order:
   - `VSCODE_CLIENT_ID:<client-app-id>`
   - `VSCODE_TENANT:<tenant-id>`
   - `api://<api-app-id>/user_impersonation`
3. Run **Junior: Sign In for Azure/APIM Bearer Mode** or **Junior: Sign In for Copilot CLI Bearer Mode** once after saving.
