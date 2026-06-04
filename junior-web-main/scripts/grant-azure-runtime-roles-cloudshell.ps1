[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SubscriptionId = '',
  [string]$ResourceGroup = 'j-ai-rg',
  [string]$AppName = 'jr-wrkspc',

  [string]$CosmosAccount = 'jb-cosmos1',
  [string]$CosmosResourceGroup = '',

  [string]$StorageAccount = 'demodatajb',
  [string]$StorageResourceGroup = '',
  [ValidateSet('Reader', 'Contributor')]
  [string]$StorageRole = 'Contributor',

  [string]$KeyVaultName = 'jaihub2563261950',
  [string]$KeyVaultResourceGroup = '',
  [ValidateSet('User', 'Officer')]
  [string]$KeyVaultRole = 'User',

  [string]$AzureOpenAiAccount = 'jb-foundry',
  [string]$AzureOpenAiResourceGroup = '',

  [string]$SearchService = '',
  [string]$SearchResourceGroup = '',

  [switch]$SkipRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI is required. Run this from Azure Portal Cloud Shell or a machine with az installed.'
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
  if (-not $json) {
    return $null
  }

  $json | ConvertFrom-Json -Depth 20
}

function Test-AzLogin {
  $null = Invoke-AzCli account show --output json
}

function Grant-RoleAssignmentIfMissing {
  [CmdletBinding(SupportsShouldProcess = $true)]
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
    Write-Host ("  [skip] '{0}' already assigned on {1}" -f $RoleName, $Scope) -ForegroundColor DarkGray
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

function Grant-CosmosDataRoleIfMissing {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param(
    [Parameter(Mandatory = $true)][string]$AccountName,
    [Parameter(Mandatory = $true)][string]$AccountResourceGroup,
    [Parameter(Mandatory = $true)][string]$PrincipalId
  )

  $roleDefinitionId = '00000000-0000-0000-0000-000000000002'
  $account = Invoke-AzCliJson cosmosdb show --name $AccountName --resource-group $AccountResourceGroup
  $accountId = $account.id
  $roleDefinitionResourceId = "$accountId/sqlRoleDefinitions/$roleDefinitionId"

  $existing = Invoke-AzCliJson cosmosdb sql role assignment list `
    --account-name $AccountName `
    --resource-group $AccountResourceGroup

  $match = @($existing | Where-Object {
    $_.principalId -eq $PrincipalId -and $_.roleDefinitionId -eq $roleDefinitionResourceId -and $_.scope -eq '/'
  })

  if ($match.Count -gt 0) {
    Write-Host ("  [skip] Cosmos DB Built-in Data Contributor already assigned on {0}" -f $AccountName) -ForegroundColor DarkGray
    return
  }

  if ($PSCmdlet.ShouldProcess($AccountName, 'Assign Cosmos DB Built-in Data Contributor')) {
    Invoke-AzCli cosmosdb sql role assignment create `
      --account-name $AccountName `
      --resource-group $AccountResourceGroup `
      --scope '/' `
      --principal-id $PrincipalId `
      --role-definition-id $roleDefinitionId | Out-Null
    Write-Host ("  [add]  Cosmos DB Built-in Data Contributor on {0}" -f $AccountName) -ForegroundColor Green
  }
}

Test-AzLogin

if ($SubscriptionId) {
  Write-Host "Selecting subscription $SubscriptionId" -ForegroundColor Cyan
  Invoke-AzCli account set --subscription $SubscriptionId | Out-Null
}

$currentAccount = Invoke-AzCliJson account show --output json
Write-Host ("Using subscription '{0}' in tenant '{1}'." -f $currentAccount.name, $currentAccount.tenantId) -ForegroundColor Cyan

$cosmosRg = if ($CosmosResourceGroup) { $CosmosResourceGroup } else { $ResourceGroup }
$storageRg = if ($StorageResourceGroup) { $StorageResourceGroup } else { $ResourceGroup }
$keyVaultRg = if ($KeyVaultResourceGroup) { $KeyVaultResourceGroup } else { $ResourceGroup }
$openAiRg = if ($AzureOpenAiResourceGroup) { $AzureOpenAiResourceGroup } else { $ResourceGroup }
$searchRg = if ($SearchResourceGroup) { $SearchResourceGroup } else { $ResourceGroup }

Write-Host "`n[1] Enabling system-assigned identity on the web app" -ForegroundColor Cyan
$identity = Invoke-AzCliJson webapp identity assign --resource-group $ResourceGroup --name $AppName
$principalId = $identity.principalId
if (-not $principalId) {
  throw "Web app identity principalId was not returned for '$AppName'."
}
Write-Host ("  principalId = {0}" -f $principalId) -ForegroundColor Green

if ($CosmosAccount) {
  Write-Host "`n[2] Cosmos DB runtime role" -ForegroundColor Cyan
  Grant-CosmosDataRoleIfMissing -AccountName $CosmosAccount -AccountResourceGroup $cosmosRg -PrincipalId $principalId
}

if ($StorageAccount) {
  Write-Host "`n[3] Storage runtime role" -ForegroundColor Cyan
  $storageScope = (Invoke-AzCliJson storage account show --name $StorageAccount --resource-group $storageRg).id
  Grant-RoleAssignmentIfMissing -PrincipalId $principalId -RoleName "Storage Blob Data $StorageRole" -Scope $storageScope
}

if ($KeyVaultName) {
  Write-Host "`n[4] Key Vault runtime role" -ForegroundColor Cyan
  $keyVaultScope = (Invoke-AzCliJson keyvault show --name $KeyVaultName --resource-group $keyVaultRg).id
  Grant-RoleAssignmentIfMissing -PrincipalId $principalId -RoleName "Key Vault Secrets $KeyVaultRole" -Scope $keyVaultScope
}

if ($AzureOpenAiAccount) {
  Write-Host "`n[5] Azure OpenAI runtime role" -ForegroundColor Cyan
  $openAiScope = (Invoke-AzCliJson cognitiveservices account show --name $AzureOpenAiAccount --resource-group $openAiRg).id
  Grant-RoleAssignmentIfMissing -PrincipalId $principalId -RoleName 'Cognitive Services OpenAI User' -Scope $openAiScope
}

if ($SearchService) {
  Write-Host "`n[6] Azure AI Search runtime role" -ForegroundColor Cyan
  $searchScope = (Invoke-AzCliJson search service show --name $SearchService --resource-group $searchRg).id
  Grant-RoleAssignmentIfMissing -PrincipalId $principalId -RoleName 'Search Index Data Reader' -Scope $searchScope
}

if (-not $SkipRestart) {
  Write-Host "`n[7] Restarting web app" -ForegroundColor Cyan
  Invoke-AzCli webapp restart --resource-group $ResourceGroup --name $AppName | Out-Null
  Write-Host '  restart requested' -ForegroundColor Green
}

Write-Host "`nDone." -ForegroundColor Cyan
Write-Host 'Run this from Cloud Shell with an account that can create role assignments at the target scopes.' -ForegroundColor DarkGray
