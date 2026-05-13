# Uninstall any previous Junior Studio extension and install the freshly built VSIX.
# Usage:
#   pwsh -File scripts\reinstall-vsix.ps1
#   pwsh -File scripts\reinstall-vsix.ps1 -SkipUninstall      # just install
#   pwsh -File scripts\reinstall-vsix.ps1 -Quiet              # /quiet installer
#
# Closes Visual Studio first (the VSIXInstaller refuses to overwrite an extension
# that's loaded into a running devenv.exe, which is what causes the
# "already installed" / "in use" message).

[CmdletBinding()]
param(
    [string]$VsixPath = (Join-Path $PSScriptRoot '..\src\JuniorStudio.VisualStudio\bin\Debug\JuniorStudio.VisualStudio.vsix'),
    [string]$ExtensionId = 'JuniorStudio.VisualStudio.4f8ed4c9-2d7a-4e3a-98f5-42116270769f',
    [switch]$SkipUninstall,
    [switch]$SkipKillVS,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Resolve-VsixInstaller {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found at $vswhere. Is Visual Studio installed?"
    }
    $vsRoot = & $vswhere -latest -property installationPath
    if (-not $vsRoot) { throw 'vswhere returned no installationPath.' }
    $installer = Join-Path $vsRoot 'Common7\IDE\VSIXInstaller.exe'
    if (-not (Test-Path $installer)) { throw "VSIXInstaller.exe not found under $vsRoot." }
    return $installer
}

function Stop-VisualStudio {
    $procs = Get-Process devenv -ErrorAction SilentlyContinue
    if (-not $procs) { return }
    Write-Host "Closing $($procs.Count) running Visual Studio instance(s)..." -ForegroundColor Yellow
    foreach ($p in $procs) {
        try { $p.CloseMainWindow() | Out-Null } catch { }
    }
    Start-Sleep -Seconds 2
    $procs = Get-Process devenv -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        Write-Host "  Force-killing devenv.exe (PID $($p.Id))" -ForegroundColor DarkYellow
        try { $p | Stop-Process -Force } catch { }
    }
    # Give VSIXInstaller a moment to release file handles too.
    Get-Process VSIXInstaller -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

$VsixPath = (Resolve-Path -LiteralPath $VsixPath -ErrorAction Stop).Path
$installer = Resolve-VsixInstaller
Write-Host "VSIXInstaller: $installer"
Write-Host "VSIX:          $VsixPath"
Write-Host "Extension Id:  $ExtensionId"

if (-not $SkipKillVS) { Stop-VisualStudio }

$commonArgs = @()
if ($Quiet) { $commonArgs += '/quiet' }

if (-not $SkipUninstall) {
    Write-Host "`nUninstalling previous version (if any)..." -ForegroundColor Cyan
    $args = @("/uninstall:$ExtensionId") + $commonArgs
    $p = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru -NoNewWindow
    # 0 = success, 1001 = not installed (fine), 2003 = nothing to do.
    if ($p.ExitCode -notin 0, 1001, 2003) {
        Write-Warning "VSIXInstaller /uninstall returned exit code $($p.ExitCode). Continuing to install anyway."
    } else {
        Write-Host "Uninstall step complete (exit $($p.ExitCode))." -ForegroundColor Green
    }
}

Write-Host "`nInstalling $([System.IO.Path]::GetFileName($VsixPath))..." -ForegroundColor Cyan
$args = @($VsixPath) + $commonArgs
$p = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) {
    Write-Error "VSIXInstaller exited with code $($p.ExitCode)."
    exit $p.ExitCode
}
Write-Host "Install complete." -ForegroundColor Green
