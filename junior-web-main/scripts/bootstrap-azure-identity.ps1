[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DisplayName,
  [string]$SignInAudience = 'AzureADMyOrg',
  [string[]]$RedirectUris = @('http://localhost:5173'),
  [string[]]$LogoutUrls = @(),
  [string[]]$IdentifierUris = @(),
  [string[]]$AdminPrincipalObjectIds = @(),
  [string[]]$UserPrincipalObjectIds = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: az'
}

function Write-Step {
  param(
    [int]$Number,
    [string]$Title,
    [string]$Detail
  )

  Write-Host ''
  Write-Host ("[{0}/7] {1}" -f $Number, $Title) -ForegroundColor Cyan
  if ($Detail) {
    Write-Host $Detail -ForegroundColor DarkGray
  }
}

function Invoke-AzCli {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  $output = & az @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    $joinedOutput = ($output | Out-String)
    Write-Error $joinedOutput
    if ($joinedOutput -match 'AADSTS50076' -or $joinedOutput -match 'claims-challenge') {
      throw 'Azure CLI needs an MFA or claims-challenge login for this write operation. Run the login command shown by Azure CLI, preferably with --use-device-code, then rerun this script.'
    }

    throw 'Azure CLI command failed.'
  }

  $output
}

function Invoke-AzCliJson {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  $json = Invoke-AzCli @Arguments
  if (-not $json) {
    return $null
  }

  $json | ConvertFrom-Json -Depth 20
}

function Invoke-AzRestWithJsonBody {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,
    [Parameter(Mandatory = $true)]
    [string]$Uri,
    [Parameter(Mandatory = $true)]
    [string]$JsonBody
  )

  $tempFile = [System.IO.Path]::GetTempFileName()
  try {
    Set-Content -Path $tempFile -Value $JsonBody -Encoding utf8NoBOM
    Invoke-AzCli rest --method $Method --uri $Uri --headers "Content-Type=application/json" --body "@$tempFile" | Out-Null
  } finally {
    Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
  }
}

function Ensure-AzLogin {
  $output = & az account show 2>&1
  if ($LASTEXITCODE -eq 0) {
    return
  }

  Write-Host 'No active Azure CLI session was found. Starting az login with device code...' -ForegroundColor Yellow
  $loginOutput = & az login --use-device-code 2>&1
  if ($LASTEXITCODE -ne 0) {
    $joinedOutput = ($loginOutput | Out-String)
    Write-Error $joinedOutput
    throw 'Azure CLI login failed.'
  }
}

function Normalize-StringArray {
  param([string[]]$Values)

  $normalized = [System.Collections.Generic.List[string]]::new()
  foreach ($value in $Values) {
    foreach ($segment in ($value -split ',')) {
      $trimmed = $segment.Trim()
      if ($trimmed -and -not $normalized.Contains($trimmed)) {
        $normalized.Add($trimmed)
      }
    }
  }

  Write-Output -NoEnumerate ([string[]]$normalized.ToArray())
}

function New-AppRoleDefinition {
  param(
    [string]$Value,
    [string]$RoleDisplayName,
    [string]$Description,
    [object[]]$ExistingRoles
  )

  $existing = $ExistingRoles | Where-Object { $_.value -eq $Value } | Select-Object -First 1
  $roleId = if ($existing) { $existing.id } else { [guid]::NewGuid().Guid }

  @{
    allowedMemberTypes = @('User')
    description = $Description
    displayName = $RoleDisplayName
    id = $roleId
    isEnabled = $true
    origin = 'Application'
    value = $Value
  }
}

function Merge-AppRoles {
  param([object[]]$ExistingRoles)

  $preserved = @($ExistingRoles | Where-Object { $_.value -notin @('Junior.Admin', 'Junior.User') })
  $adminRole = New-AppRoleDefinition -Value 'Junior.Admin' -RoleDisplayName 'Junior Admin' -Description 'Can access admin pages and admin APIs in Junior Workbench.' -ExistingRoles $ExistingRoles
  $userRole = New-AppRoleDefinition -Value 'Junior.User' -RoleDisplayName 'Junior User' -Description 'Can access workspace-scoped features in Junior Workbench.' -ExistingRoles $ExistingRoles
  @($preserved + $adminRole + $userRole)
}

function New-OAuthPermissionScopeDefinition {
  param(
    [string]$Value,
    [string]$DisplayName,
    [string]$Description,
    [object[]]$ExistingScopes
  )

  $existing = $ExistingScopes | Where-Object { $_.value -eq $Value } | Select-Object -First 1
  $scopeId = if ($existing) { $existing.id } else { [guid]::NewGuid().Guid }

  @{
    adminConsentDescription = $Description
    adminConsentDisplayName = $DisplayName
    id = $scopeId
    isEnabled = $true
    type = 'User'
    userConsentDescription = $Description
    userConsentDisplayName = $DisplayName
    value = $Value
  }
}

function Merge-OAuthPermissionScopes {
  param([object[]]$ExistingScopes)

  $preserved = @($ExistingScopes | Where-Object { $_.value -ne 'Junior.Workbench.Access' })
  $accessScope = New-OAuthPermissionScopeDefinition -Value 'Junior.Workbench.Access' -DisplayName 'Access Junior Workbench' -Description 'Allows the Junior Workbench web client to call the Junior Workbench API as the signed-in user.' -ExistingScopes $ExistingScopes
  @($preserved + $accessScope)
}

function Ensure-ArrayBodyValue {
  param([string[]]$Values)

  if (@($Values).Count -eq 0) {
    return @()
  }

  Write-Output -NoEnumerate ([string[]]@($Values))
}

function Get-AppRoleId {
  param(
    [object[]]$Roles,
    [string]$Value
  )

  $role = $Roles | Where-Object { $_.value -eq $Value } | Select-Object -First 1
  if (-not $role) {
    throw "Expected app role not found: $Value"
  }

  $role.id
}

function Ensure-AppRoleAssignments {
  param(
    [string]$ServicePrincipalObjectId,
    [string[]]$PrincipalObjectIds,
    [string]$AppRoleId,
    [string]$RoleLabel
  )

  if (@($PrincipalObjectIds).Count -eq 0) {
    Write-Host "No principal object IDs were provided for $RoleLabel assignments. Skipping assignment." -ForegroundColor Yellow
    return
  }

  $existingAssignmentsResponse = Invoke-AzCliJson rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$ServicePrincipalObjectId/appRoleAssignedTo"
  $existingAssignments = @($existingAssignmentsResponse.value)

  foreach ($principalObjectId in $PrincipalObjectIds) {
    $assignmentExists = $existingAssignments | Where-Object {
      $_.principalId -eq $principalObjectId -and $_.appRoleId -eq $AppRoleId
    } | Select-Object -First 1

    if ($assignmentExists) {
      Write-Host "Assignment already exists for principal '$principalObjectId' -> $RoleLabel." -ForegroundColor DarkGray
      continue
    }

    Write-Host "Assigning $RoleLabel to principal '$principalObjectId'..." -ForegroundColor Green
    $assignmentBody = @{
      principalId = $principalObjectId
      resourceId = $ServicePrincipalObjectId
      appRoleId = $AppRoleId
    } | ConvertTo-Json -Depth 10 -Compress

    Invoke-AzRestWithJsonBody -Method POST -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$ServicePrincipalObjectId/appRoleAssignedTo" -JsonBody $assignmentBody
  }
}

$RedirectUris = Normalize-StringArray -Values $RedirectUris
$LogoutUrls = Normalize-StringArray -Values $LogoutUrls
$IdentifierUris = Normalize-StringArray -Values $IdentifierUris
$AdminPrincipalObjectIds = Normalize-StringArray -Values $AdminPrincipalObjectIds
$UserPrincipalObjectIds = Normalize-StringArray -Values $UserPrincipalObjectIds

Write-Step -Number 1 -Title 'Checking Azure CLI login context' -Detail 'The script needs Azure CLI and Microsoft Graph access so it can create or update the Entra application and service principal.'
Ensure-AzLogin
$currentAccount = Invoke-AzCliJson account show
Write-Host ("Using tenant {0} and subscription {1}." -f $currentAccount.tenantId, $currentAccount.name) -ForegroundColor Green

Write-Step -Number 2 -Title 'Looking for an existing app registration' -Detail 'If an application with the same display name already exists, the script will reuse it and make the required identity updates idempotently.'
$existingApps = @(Invoke-AzCliJson ad app list --display-name $DisplayName)
$matchingApps = @($existingApps | Where-Object { $_.displayName -eq $DisplayName })

if (@($matchingApps).Count -gt 1) {
  throw "Found multiple app registrations named '$DisplayName'. Use a unique display name or remove duplicates before running this script."
}

if (@($matchingApps).Count -eq 0) {
  Write-Host "Creating app registration '$DisplayName'..." -ForegroundColor Green
  $app = Invoke-AzCliJson ad app create --display-name $DisplayName --sign-in-audience $SignInAudience
} else {
  $app = $matchingApps[0]
  Write-Host "Reusing existing app registration '$DisplayName' ($($app.appId))." -ForegroundColor Green
}

if (@($IdentifierUris).Count -eq 0) {
  $IdentifierUris = @("api://$($app.appId)")
}

Write-Step -Number 3 -Title 'Configuring redirect URIs, logout URL, identifier URIs, API scope, and app roles' -Detail 'This step makes the Entra application usable for Junior Workbench by defining the SPA redirect URIs, optional web logout settings, the Junior.Workbench.Access API scope, and the Junior.Admin and Junior.User roles.'
$fullApp = Invoke-AzCliJson ad app show --id $app.appId
$mergedRoles = Merge-AppRoles -ExistingRoles @($fullApp.appRoles)
$mergedScopes = Merge-OAuthPermissionScopes -ExistingScopes @($fullApp.api.oauth2PermissionScopes)
$patchBody = @{
  signInAudience = $SignInAudience
  appRoles = $mergedRoles
  api = @{
    requestedAccessTokenVersion = 2
    oauth2PermissionScopes = $mergedScopes
  }
  spa = @{
    redirectUris = Ensure-ArrayBodyValue -Values $RedirectUris
  }
}

if (@($LogoutUrls).Count -gt 0) {
  $patchBody.web = @{
    logoutUrl = $LogoutUrls[0]
    implicitGrantSettings = @{
      enableAccessTokenIssuance = $false
      enableIdTokenIssuance = $false
    }
  }
}

if (@($IdentifierUris).Count -gt 0) {
  $patchBody.identifierUris = Ensure-ArrayBodyValue -Values $IdentifierUris
}

$graphPatchBody = $patchBody | ConvertTo-Json -Depth 20 -Compress
Invoke-AzRestWithJsonBody -Method PATCH -Uri "https://graph.microsoft.com/v1.0/applications/$($fullApp.id)" -JsonBody $graphPatchBody

$updatedApp = Invoke-AzCliJson ad app show --id $app.appId
$adminRoleId = Get-AppRoleId -Roles @($updatedApp.appRoles) -Value 'Junior.Admin'
$userRoleId = Get-AppRoleId -Roles @($updatedApp.appRoles) -Value 'Junior.User'
$scopeBaseUri = if (@($updatedApp.identifierUris).Count -gt 0) { $updatedApp.identifierUris[0] } else { "api://$($updatedApp.appId)" }
$accessScope = "$scopeBaseUri/Junior.Workbench.Access"
Write-Host 'App roles are configured.' -ForegroundColor Green

Write-Step -Number 4 -Title 'Ensuring the enterprise application exists' -Detail 'The enterprise application, also called the service principal, is what users and groups are assigned to in the tenant.'
$servicePrincipals = @(Invoke-AzCliJson ad sp list --filter "appId eq '$($updatedApp.appId)'")
if (@($servicePrincipals).Count -eq 0) {
  Write-Host "Creating service principal for app ID '$($updatedApp.appId)'..." -ForegroundColor Green
  $servicePrincipal = Invoke-AzCliJson ad sp create --id $updatedApp.appId
} else {
  $servicePrincipal = $servicePrincipals[0]
  Write-Host "Reusing existing service principal '$($servicePrincipal.id)'." -ForegroundColor Green
}

Write-Step -Number 5 -Title 'Assigning app roles when principal IDs were provided' -Detail 'This step is optional. If you pass user or group object IDs, the script will assign Junior.Admin or Junior.User automatically.'
Ensure-AppRoleAssignments -ServicePrincipalObjectId $servicePrincipal.id -PrincipalObjectIds $AdminPrincipalObjectIds -AppRoleId $adminRoleId -RoleLabel 'Junior.Admin'
Ensure-AppRoleAssignments -ServicePrincipalObjectId $servicePrincipal.id -PrincipalObjectIds $UserPrincipalObjectIds -AppRoleId $userRoleId -RoleLabel 'Junior.User'

Write-Step -Number 6 -Title 'Explaining what the app should expect at runtime' -Detail 'Junior Workbench currently trusts normalized identity headers from an upstream Entra-aware auth layer rather than validating bearer tokens directly in Node.'
Write-Host 'Configure your deployed app or reverse proxy to forward these claims as headers:' -ForegroundColor Green
Write-Host '  x-junior-user-id      <- oid or another stable subject identifier'
Write-Host '  x-junior-display-name <- name'
Write-Host '  x-junior-tenant-id    <- tid'
Write-Host '  x-junior-roles        <- roles, for example Junior.Admin,Junior.User'

Write-Step -Number 7 -Title 'Printing the values you will need next' -Detail 'These are the app registration outputs and the app settings you will carry into the hosting layer and Junior Workbench configuration.'
Write-Host ''
Write-Host 'App registration summary:' -ForegroundColor Green
Write-Host "  Display name: $($updatedApp.displayName)"
Write-Host "  Application (client) ID: $($updatedApp.appId)"
Write-Host "  Application object ID: $($updatedApp.id)"
Write-Host "  Enterprise application object ID: $($servicePrincipal.id)"
Write-Host "  Sign-in audience: $SignInAudience"
if (@($RedirectUris).Count -gt 0) {
  Write-Host '  Redirect URIs:'
  foreach ($uri in $RedirectUris) {
    Write-Host "    - $uri"
  }
}
if (@($LogoutUrls).Count -gt 0) {
  Write-Host '  Logout URLs:'
  foreach ($uri in $LogoutUrls) {
    Write-Host "    - $uri"
  }
}
if (@($IdentifierUris).Count -gt 0) {
  Write-Host '  Identifier URIs:'
  foreach ($uri in $IdentifierUris) {
    Write-Host "    - $uri"
  }
}

Write-Host ''
Write-Host 'Set these in the deployed Junior Workbench app:' -ForegroundColor Green
Write-Host '  JUNIOR_IDENTITY_MODE=entra-msal'
Write-Host "  JUNIOR_ENTRA_TENANT_ID=$($currentAccount.tenantId)"
Write-Host "  JUNIOR_ENTRA_CLIENT_ID=$($updatedApp.appId)"
Write-Host "  JUNIOR_ENTRA_API_AUDIENCE=$scopeBaseUri"
Write-Host "  JUNIOR_ENTRA_SCOPES=$accessScope"
Write-Host "  JUNIOR_ENTRA_AUTHORITY=https://login.microsoftonline.com/$($currentAccount.tenantId)"
if (@($RedirectUris).Count -gt 0) {
  Write-Host "  JUNIOR_ENTRA_REDIRECT_URI=$($RedirectUris[0])"
  Write-Host "  JUNIOR_ENTRA_POST_LOGOUT_REDIRECT_URI=$($RedirectUris[0])"
}
Write-Host '  JUNIOR_ADMIN_ROLES=admin,Junior.Admin'
Write-Host '  JUNIOR_USER_ROLES=Junior.User,Junior.Admin,admin'

Write-Host ''
Write-Host 'Manual next steps outside this script:' -ForegroundColor Yellow
Write-Host '  1. Assign real users or groups to Junior.Admin and Junior.User if you did not pass principal object IDs today.'
Write-Host '  2. Configure the app to request the printed Junior.Workbench.Access scope through MSAL.'
Write-Host '  3. Keep local fallback limited to localhost or explicit development runs.'
Write-Host '  4. If you use trusted-header mode instead, configure App Service Authentication or your reverse proxy to require Entra sign-in and map the x-junior-* headers listed above.'