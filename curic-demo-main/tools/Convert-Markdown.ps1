[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Path = ".",

    [ValidateSet("docx", "pdf", "both")]
    [string]$Format = "both",

    [switch]$Recurse,
    [switch]$Overwrite
)

$ErrorActionPreference = "Stop"

$python = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $python) {
    throw "Python is required but was not found on PATH. Install Python, then rerun this script."
}

$scriptPath = Join-Path $PSScriptRoot "convert_markdown.py"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Conversion script not found: $scriptPath"
}

$requirementsPath = Join-Path $PSScriptRoot "requirements.txt"
if (-not (Test-Path -LiteralPath $requirementsPath)) {
    throw "tools/requirements.txt is missing. Restore the tools package files and rerun."
}

$arguments = @(
    $scriptPath,
    "--path", $Path,
    "--format", $Format
)

if ($Recurse) {
    $arguments += "--recurse"
}

if ($Overwrite) {
    $arguments += "--overwrite"
}

& $python.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Markdown conversion failed with exit code $LASTEXITCODE."
}