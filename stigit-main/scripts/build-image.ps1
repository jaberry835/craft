[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ParameterFile,

    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$settings = Get-Content -LiteralPath $ParameterFile -Raw | ConvertFrom-Json

function Resolve-RepoPath {
    param([Parameter(Mandatory)][string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }
    return (Join-Path $repoRoot $Path)
}

function Assert-CommandAvailable {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on this runner."
    }
}

Assert-CommandAvailable -Name 'Connect-AzAccount'
Assert-CommandAvailable -Name 'New-AzResourceGroupDeployment'

$baselinePath = Resolve-RepoPath $settings.baselinePath
$overlayPath = Resolve-RepoPath $settings.overlayPath
$exceptionsPath = Resolve-RepoPath $settings.exceptionsPath

foreach ($path in @($baselinePath, $overlayPath, $exceptionsPath)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required file not found: $path"
    }
}

Write-Host "Preparing Azure Image Builder deployment for $($settings.imageTemplateName)"

& (Join-Path $PSScriptRoot 'deploy-image-builder.ps1') `
    -Settings $settings `
    -BaselinePath $baselinePath `
    -OverlayPath $overlayPath `
    -ExceptionsPath $exceptionsPath `
    -TemplateFile (Join-Path $repoRoot 'image-builder\image-template.json') `
    -SkipBuild:$SkipBuild
