<#
.SYNOPSIS
    Build, install, and uninstall the Junior VS Code extension.

.PARAMETER Action
    The action to perform: build, install, uninstall, or reinstall.

.EXAMPLE
    .\deploy.ps1 build       # Compile and create .vsix
    .\deploy.ps1 install     # Build + install into VS Code
    .\deploy.ps1 uninstall   # Remove from VS Code
    .\deploy.ps1 reinstall   # Uninstall, rebuild, reinstall
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "install", "uninstall", "reinstall")]
    [string]$Action = "install"
)

$ErrorActionPreference = "Stop"

$ExtensionId = "ms-csu-ett.secure-chat"
$VsixPattern = "secure-chat-*.vsix"

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "   $msg" -ForegroundColor Red }

# Ensure we're in the project root
Set-Location $PSScriptRoot

function Invoke-Build {
    Write-Step "Installing dependencies"
    npm install | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Step "Compiling TypeScript"
    npm run compile | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed" }

    # Remove old .vsix files
    Get-ChildItem -Path . -Filter $VsixPattern -ErrorAction SilentlyContinue |
        Remove-Item -Force

    Write-Step "Packaging extension (.vsix)"
    npx @vscode/vsce package --no-dependencies | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }

    $vsix = Get-ChildItem -Path . -Filter $VsixPattern | Select-Object -First 1
    if (-not $vsix) { throw "No .vsix file found after packaging" }

    Write-Ok "Created: $($vsix.Name)"
    return $vsix.FullName
}

function Invoke-Install {
    $vsixPath = Invoke-Build

    Write-Step "To install, open VS Code and run:"
    Write-Ok "Ctrl+Shift+P > 'Extensions: Install from VSIX...' > select:"
    Write-Ok $vsixPath
}

function Invoke-Uninstall {
    Write-Step "To uninstall, open VS Code and run:"
    Write-Ok "Ctrl+Shift+P > 'Extensions: Uninstall' on Junior"
}

function Invoke-Reinstall {
    Invoke-Uninstall
    Invoke-Install
}

switch ($Action) {
    "build"     { Invoke-Build     | Out-Null }
    "install"   { Invoke-Install   }
    "uninstall" { Invoke-Uninstall }
    "reinstall" { Invoke-Reinstall }
}

Write-Host ""

