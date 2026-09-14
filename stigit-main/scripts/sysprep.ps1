[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sysprep = Join-Path $env:WINDIR 'System32\Sysprep\Sysprep.exe'
if (-not (Test-Path -LiteralPath $sysprep)) {
    throw "Sysprep was not found at $sysprep"
}

& $sysprep /oobe /generalize /quiet /quit
if ($LASTEXITCODE -ne 0) {
    throw "Sysprep failed with exit code $LASTEXITCODE"
}
