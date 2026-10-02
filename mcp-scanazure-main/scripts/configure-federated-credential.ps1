[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$ApplicationObjectId,

  [Parameter(Mandatory)]
  [string]$ManagedIdentityPrincipalId,

  [Parameter(Mandatory)]
  [string]$TenantId,

  [string]$Name = "mcp-scanazure-appservice",

  [string]$Description = "App Service managed identity assertion for MCP OBO"
)

$ErrorActionPreference = "Stop"

$issuer = "https://login.microsoftonline.com/$TenantId/v2.0"
$parameters = @{
  name = $Name
  issuer = $issuer
  subject = $ManagedIdentityPrincipalId
  description = $Description
  audiences = @("api://AzureADTokenExchange")
}
$path = Join-Path ([IO.Path]::GetTempPath()) "$([guid]::NewGuid()).json"

try {
  $parameters | ConvertTo-Json -Depth 4 | Set-Content -Path $path -Encoding utf8NoBOM
  $existing = az ad app federated-credential list `
    --id $ApplicationObjectId `
    --query "[?name=='$Name'] | [0]" `
    --output json | ConvertFrom-Json

  if ($null -eq $existing) {
    az ad app federated-credential create `
      --id $ApplicationObjectId `
      --parameters $path `
      --only-show-errors `
      --output none
    Write-Host "Created federated credential '$Name'."
  } else {
    az ad app federated-credential update `
      --id $ApplicationObjectId `
      --federated-credential-id $existing.id `
      --parameters $path `
      --only-show-errors `
      --output none
    Write-Host "Updated federated credential '$Name'."
  }
} finally {
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}
