[CmdletBinding()]
param(
  [string]$ResourceGroup,
  [Parameter(Mandatory = $true)]
  [string]$CosmosAccount,
  [string]$CosmosResourceGroup,
  [Parameter(Mandatory = $true)]
  [string]$StorageAccount,
  [string]$StorageResourceGroup,
  [string]$Database = 'JuniorWeb',
  [string]$WorkspaceContainer = 'Workspaces',
  [string]$ConfigContainer = 'WorkspaceConfig',
  [string]$ChatContainer = 'ChatSessions',
  [string]$PendingContainer = 'PendingChanges',
  [string]$AgentsContainer = 'Agents',
  [string]$BlobContainer = 'junior-workspaces',
  [switch]$SkipAgentsContainer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: az'
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

if (-not $CosmosResourceGroup) {
  $CosmosResourceGroup = $ResourceGroup
}

if (-not $StorageResourceGroup) {
  $StorageResourceGroup = $ResourceGroup
}

if (-not $CosmosResourceGroup -or -not $StorageResourceGroup) {
  throw 'Provide -ResourceGroup or both -CosmosResourceGroup and -StorageResourceGroup.'
}

$containers = @(
  $WorkspaceContainer,
  $ConfigContainer,
  $ChatContainer,
  $PendingContainer
)

if (-not $SkipAgentsContainer) {
  $containers += $AgentsContainer
}

Write-Host "Ensuring Cosmos DB database '$Database' exists in account '$CosmosAccount'..."
Invoke-AzCli cosmosdb sql database create `
  --resource-group $CosmosResourceGroup `
  --account-name $CosmosAccount `
  --name $Database `
  --output table

foreach ($container in $containers) {
  Write-Host "Ensuring Cosmos DB container '$container' exists with partition key /partitionKey..."
  Invoke-AzCli cosmosdb sql container create `
    --resource-group $CosmosResourceGroup `
    --account-name $CosmosAccount `
    --database-name $Database `
    --name $container `
    --partition-key-path /partitionKey `
    --output table
}

Write-Host "Ensuring private blob container '$BlobContainer' exists in storage account '$StorageAccount'..."
Invoke-AzCli storage container create `
  --resource-group $StorageResourceGroup `
  --account-name $StorageAccount `
  --name $BlobContainer `
  --auth-mode login `
  --public-access off `
  --output table

Write-Host ''
Write-Host 'Bootstrap complete. Configure the app with:'
Write-Host "  COSMOS_DB_DATABASE=$Database"
Write-Host "  COSMOS_DB_WORKSPACE_CONTAINER=$WorkspaceContainer"
Write-Host "  COSMOS_DB_WORKSPACE_CONFIG_CONTAINER=$ConfigContainer"
Write-Host "  COSMOS_DB_CHAT_CONTAINER=$ChatContainer"
Write-Host "  COSMOS_DB_PENDING_CHANGE_CONTAINER=$PendingContainer"
if (-not $SkipAgentsContainer) {
  Write-Host "  COSMOS_DB_CONFIG_CONTAINER=$AgentsContainer"
}
Write-Host "  JUNIOR_WORKSPACE_BLOB_CONTAINER=$BlobContainer"
