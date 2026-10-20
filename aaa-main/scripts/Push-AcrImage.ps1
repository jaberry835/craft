[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9]{5,50}$')]
    [string]$AcrName,

    [ValidatePattern('^[a-z0-9]+(?:[._/-][a-z0-9]+)*$')]
    [string]$Repository = 'aaa-security-workbench',

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$Tag,

    [string]$BaseImage = 'node:24-alpine',

    [switch]$SkipStage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Tag -eq 'latest') {
    throw 'Use an immutable image tag such as a release number or commit SHA; latest is not allowed.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dockerfile = Join-Path $repositoryRoot 'deploy/Dockerfile'
$artifactRoot = Join-Path $repositoryRoot 'dist'

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)]
        [string]$Command,

        [Parameter(ValueFromRemainingArguments)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command exited with code $LASTEXITCODE."
    }
}

foreach ($command in @('az', 'docker')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required and must be available on PATH."
    }
}

Push-Location $repositoryRoot
try {
    if (-not $SkipStage) {
        & (Join-Path $PSScriptRoot 'New-ContainerArtifact.ps1')
    }
    if (-not (Test-Path (Join-Path $artifactRoot 'artifact-manifest.json'))) {
        throw 'The self-contained runtime is missing. Run npm run build first.'
    }

    Invoke-CheckedCommand docker image inspect $BaseImage
    Invoke-CheckedCommand az account set --subscription $SubscriptionId
    Invoke-CheckedCommand az account show --output none

    $loginServer = (& az acr show --name $AcrName --query loginServer --output tsv).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $loginServer) {
        throw "Could not resolve Azure Container Registry '$AcrName'."
    }

    Invoke-CheckedCommand az acr login --name $AcrName

    $image = "$loginServer/$Repository`:$Tag"
    Invoke-CheckedCommand docker build --pull=false --file $dockerfile --build-arg "BASE_IMAGE=$BaseImage" --tag $image .
    Invoke-CheckedCommand docker image inspect $image
    Invoke-CheckedCommand docker push $image

    Write-Host "Pushed $image"
}
finally {
    Pop-Location
}