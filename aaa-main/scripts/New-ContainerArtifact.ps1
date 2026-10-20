[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
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

Push-Location $repositoryRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required to stage the container artifact.'
    }
    Invoke-CheckedCommand npm run build

    if (-not (Test-Path -LiteralPath (Join-Path $artifactRoot 'node_modules') -PathType Container)) {
        throw 'The runtime must contain production node_modules. Run npm run build first.'
    }
    Write-Host "Self-contained container runtime is ready at $artifactRoot"
}
finally {
    Pop-Location
}