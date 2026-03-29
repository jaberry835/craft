<#
.SYNOPSIS
    Build, install, and uninstall the Junior VS Code extension.

.PARAMETER Action
    The action to perform: build, install, uninstall, or reinstall.

.PARAMETER DefaultSettings
    Optional path to a JSON file containing `junior.*` settings whose values
    should override configuration defaults in package.json for this build.
    These become extension defaults inside the VSIX. They do not modify a
    user's existing settings.json, and any user/workspace setting still wins.

.EXAMPLE
    .\deploy.ps1 build       # Compile and create .vsix
    .\deploy.ps1 install     # Build + install into VS Code
    .\deploy.ps1 uninstall   # Remove from VS Code
    .\deploy.ps1 reinstall   # Uninstall, rebuild, reinstall
    .\deploy.ps1 build -DefaultSettings .\settings.json
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "install", "uninstall", "reinstall")]
    [string]$Action = "install",

    [string]$DefaultSettings
)

$ErrorActionPreference = "Stop"

$ExtensionId = "ms-csu-ett.junior"
$VsixPattern = "junior-*.vsix"

function Write-Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "   $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

# Ensure we're in the project root
Set-Location $PSScriptRoot

function Set-DefaultSettingsForBuild {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageJsonPath,
        [Parameter(Mandatory = $true)]
        [string]$SettingsPath
    )

    $resolvedSettings = (Resolve-Path $SettingsPath).Path
    if (-not (Test-Path $resolvedSettings -PathType Leaf)) {
        throw "Default settings file not found: $SettingsPath"
    }

    Write-Step "Applying default settings from $resolvedSettings"

    $backupPath = Join-Path $PSScriptRoot "package.json.bak"
    Copy-Item -Path $PackageJsonPath -Destination $backupPath -Force

    try {
        $packageJson = Get-Content -Raw -Path $PackageJsonPath | ConvertFrom-Json -Depth 100
        $defaultsJson = Get-Content -Raw -Path $resolvedSettings | ConvertFrom-Json -Depth 100

        if (-not $defaultsJson -or -not ($defaultsJson -is [pscustomobject])) {
            throw "Default settings JSON must be a flat object of setting keys to values."
        }

        $configProperties = @{}
        foreach ($configGroup in $packageJson.contributes.configuration) {
            if (-not $configGroup.properties) { continue }
            foreach ($property in $configGroup.properties.PSObject.Properties) {
                $configProperties[$property.Name] = $property.Value
            }
        }

        $appliedCount = 0
        $ignoredNonJuniorCount = 0
        $ignoredUnknownCount = 0
        foreach ($setting in $defaultsJson.PSObject.Properties) {
            if (-not $setting.Name.StartsWith("junior.")) {
                Write-Warn "Skipping non-junior setting: $($setting.Name)"
                $ignoredNonJuniorCount++
                continue
            }

            if (-not $configProperties.ContainsKey($setting.Name)) {
                Write-Warn "Skipping unknown setting: $($setting.Name)"
                $ignoredUnknownCount++
                continue
            }

            $configProperties[$setting.Name].default = $setting.Value
            $appliedCount++
        }

        $packageJson | ConvertTo-Json -Depth 100 | Set-Content -Path $PackageJsonPath -Encoding utf8
        Write-Ok "Applied $appliedCount default setting override(s) to package.json for this build."
        if ($ignoredNonJuniorCount -gt 0 -or $ignoredUnknownCount -gt 0) {
            Write-Warn "Ignored $ignoredNonJuniorCount non-junior setting(s) and $ignoredUnknownCount unknown junior setting(s)."
        }
        Write-Warn "These values become VSIX defaults only. They do not write into VS Code's settings.json, and existing user/workspace values override them."
    } catch {
        Move-Item -Path $backupPath -Destination $PackageJsonPath -Force
        throw
    }

    return $backupPath
}

function Invoke-Build {
    $packageJsonPath = Join-Path $PSScriptRoot "package.json"
    $packageBackupPath = $null

    if ($DefaultSettings) {
        $packageBackupPath = Set-DefaultSettingsForBuild -PackageJsonPath $packageJsonPath -SettingsPath $DefaultSettings
    }

    try {
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
    } finally {
        if ($packageBackupPath -and (Test-Path $packageBackupPath)) {
            Move-Item -Path $packageBackupPath -Destination $packageJsonPath -Force
            Write-Ok "Restored package.json after build."
        }
    }
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
