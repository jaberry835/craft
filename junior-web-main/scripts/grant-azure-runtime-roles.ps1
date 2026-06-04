[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Target web app whose system-assigned managed identity will receive the roles.
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$AppName,

  # When set, ensure the system-assigned identity is enabled before assigning roles.
  [switch]$EnableIdentity,

  # Cosmos DB (data plane)
  [string]$CosmosAccount,
  [string]$CosmosResourceGroup,

  # Storage account (Blob data plane)
  [string]$StorageAccount,
  [string]$StorageResourceGroup,
  [ValidateSet('Reader', 'Contributor')]
  [string]$StorageRole = 'Contributor',

  # Key Vault (secret data plane)
  [string]$KeyVaultName,
  [string]$KeyVaultResourceGroup,
  [ValidateSet('User', 'Officer')]
  [string]$KeyVaultRole = 'User',

  # Azure OpenAI / Cognitive Services account
  [string]$AzureOpenAiAccount,
  [string]$AzureOpenAiResourceGroup,

  # Azure AI Search service
  [string]$SearchService,
  [string]$SearchResourceGroup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: az'
}

function Invoke-AzCli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & az @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error ($output | Out-String)
    throw 'Azure CLI command failed.'
  }
  $output
}

function Invoke-AzCliJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $json = Invoke-AzCli @Arguments
  if (-not $json) { return $null }
  $json | ConvertFrom-Json -Depth 20
}

function Ensure-RoleAssignment {
  param(
    [Parameter(Mandatory = $true)][string]$PrincipalId,
    [Parameter(Mandatory = $true)][string]$RoleName,
    [Parameter(Mandatory = $true)][string]$Scope
  )

  $existing = az role assignment list `
    --assignee-object-id $PrincipalId `
    --assignee-principal-type ServicePrincipal `
    --role $RoleName `
    --scope $Scope `
    --output json 2>$null | ConvertFrom-Json

  if (@($existing).Count -gt 0) {
    Write-Host ("  [skip] '{0}' already on {1}" -f $RoleName, $Scope) -ForegroundColor DarkGray
    return
  }

  if ($PSCmdlet.ShouldProcess($Scope, "Assign '$RoleName'")) {
    Invoke-AzCli role assignment create `
      --assignee-object-id $PrincipalId `
      --assignee-principal-type ServicePrincipal `
      --role $RoleName `
      --scope $Scope | Out-Null
    Write-Host ("  [add]  '{0}' on {1}" -f $RoleName, $Scope) -ForegroundColor Green
  }
}

function Ensure-CosmosDataRole {
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][string]$AccountResourceGroup,
    [Parameter(Mandatory = $true)][string]$PrincipalId
  )

  # 00000000-0000-0000-0000-000000000002 = Cosmos DB Built-in Data Contributor (read+write)
  $roleDefinitionId = '00000000-0000-0000-0000-000000000002'

  $accountId = (Invoke-AzCliJson cosmosdb show --name $AccountName --resource-group $AccountResourceGroup).id
  $scope = $accountId  # account-wide scope. Use a database/container scope to narrow.

  $existing = Invoke-AzCliJson cosmosdb sql role assignment list `
    --account-name $AccountName `
    --resource-group $AccountResourceGroup `
    --query "[?principalId=='$PrincipalId' && roleDefinitionId == '$accountId/sqlRoleDefinitions/$roleDefinitionId']"

  if (@($existing).Count -gt 0) {
    Write-Host ("  [skip] Cosmos DB Built-in Data Contributor already on {0}" -f $AccountName) -ForegroundColor DarkGray
    return
  }

  if ($PSCmdlet.ShouldProcess($AccountName, "Assign Cosmos DB Built-in Data Contributor")) {
    Invoke-AzCli cosmosdb sql role assignment create `
      --account-name $AccountName `
      --resource-group $AccountResourceGroup `
      --scope $scope `
      --principal-id $PrincipalId `
      --role-definition-id $roleDefinitionId | Out-Null
    Write-Host ("  [add]  Cosmos DB Built-in Data Contributor on {0}" -f $AccountName) -ForegroundColor Green
  }
}

# 1. Resolve / enable managed identity on the web app
Write-Host "[1] Web app identity" -ForegroundColor Cyan
$identity = Invoke-AzCliJson webapp identity show --resource-group $ResourceGroup --name $AppName

$principalId = if ($identity -and $identity.principalId) { $identity.principalId } else { $null }

if (-not $principalId) {
  if (-not $EnableIdentity) {
    throw "Web app '$AppName' does not have a system-assigned identity. Re-run with -EnableIdentity to enable one."
  }
  Write-Host "  Enabling system-assigned managed identity..." -ForegroundColor Green
  $identity = Invoke-AzCliJson webapp identity assign --resource-group $ResourceGroup --name $AppName
  $principalId = $identity.principalId
}

Write-Host ("  principalId = {0}" -f $principalId)

# 2. Cosmos DB data plane
if ($CosmosAccount) {
  $cosmosRg = if ($CosmosResourceGroup) { $CosmosResourceGroup } else { $ResourceGroup }
  Write-Host "`n[2] Cosmos DB ($CosmosAccount in $cosmosRg)" -ForegroundColor Cyan
  Ensure-CosmosDataRole -AccountName $CosmosAccount -AccountResourceGroup $cosmosRg -PrincipalId $principalId
} else {
  Write-Host "`n[2] Cosmos DB - skipped (no -CosmosAccount)" -ForegroundColor DarkGray
}

# 3. Storage Blob data plane
if ($StorageAccount) {
  $storageRg = if ($StorageResourceGroup) { $StorageResourceGroup } else { $ResourceGroup }
  $roleName = "Storage Blob Data $StorageRole"
  Write-Host "`n[3] Storage ($StorageAccount in $storageRg) - $roleName" -ForegroundColor Cyan
  $scope = (Invoke-AzCliJson storage account show --name $StorageAccount --resource-group $storageRg).id
  Ensure-RoleAssignment -PrincipalId $principalId -RoleName $roleName -Scope $scope
} else {
  Write-Host "`n[3] Storage - skipped (no -StorageAccount)" -ForegroundColor DarkGray
}

# 4. Key Vault secret data plane
if ($KeyVaultName) {
  $kvRg = if ($KeyVaultResourceGroup) { $KeyVaultResourceGroup } else { $ResourceGroup }
  $roleName = "Key Vault Secrets $KeyVaultRole"
  Write-Host "`n[4] Key Vault ($KeyVaultName in $kvRg) - $roleName" -ForegroundColor Cyan
  $scope = (Invoke-AzCliJson keyvault show --name $KeyVaultName --resource-group $kvRg).id
  Ensure-RoleAssignment -PrincipalId $principalId -RoleName $roleName -Scope $scope
} else {
  Write-Host "`n[4] Key Vault - skipped (no -KeyVaultName)" -ForegroundColor DarkGray
}

# 5. Azure OpenAI / Cognitive Services
if ($AzureOpenAiAccount) {
  $aoRg = if ($AzureOpenAiResourceGroup) { $AzureOpenAiResourceGroup } else { $ResourceGroup }
  Write-Host "`n[5] Azure OpenAI ($AzureOpenAiAccount in $aoRg) - Cognitive Services OpenAI User" -ForegroundColor Cyan
  $scope = (Invoke-AzCliJson cognitiveservices account show --name $AzureOpenAiAccount --resource-group $aoRg).id
  Ensure-RoleAssignment -PrincipalId $principalId -RoleName 'Cognitive Services OpenAI User' -Scope $scope
} else {
  Write-Host "`n[5] Azure OpenAI - skipped (no -AzureOpenAiAccount)" -ForegroundColor DarkGray
}

# 6. Azure AI Search
if ($SearchService) {
  $searchRg = if ($SearchResourceGroup) { $SearchResourceGroup } else { $ResourceGroup }
  Write-Host "`n[6] AI Search ($SearchService in $searchRg) - Search Index Data Reader" -ForegroundColor Cyan
  $scope = (Invoke-AzCliJson search service show --name $SearchService --resource-group $searchRg).id
  Ensure-RoleAssignment -PrincipalId $principalId -RoleName 'Search Index Data Reader' -Scope $scope
} else {
  Write-Host "`n[6] AI Search - skipped (no -SearchService)" -ForegroundColor DarkGray
}

Write-Host "`nDone. Restart the web app so the runtime picks up new role assignments:" -ForegroundColor Cyan
Write-Host "  az webapp restart --resource-group $ResourceGroup --name $AppName"
