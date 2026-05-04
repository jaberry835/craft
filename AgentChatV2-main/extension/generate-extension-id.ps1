<#
.SYNOPSIS
  Generates a stable Chrome/Edge MV3 extension key + id, and (optionally)
  patches manifest.json so the extension always loads with the same id.

.DESCRIPTION
  MV3 extension ids are derived from the public key embedded in the
  manifest's top-level "key" field. Without a "key", the browser generates
  one the first time the extension is loaded, and it can change on
  reinstall / on a different machine. That breaks anything that depends on
  the id (Entra redirect URIs, backend CORS, group policy installs, etc.).

  This script:
    1. Generates a 2048-bit RSA private key (extension-key.pem).
    2. Derives the matching public key in the exact format the manifest
       wants (DER -> base64).
    3. Computes the resulting extension id (SHA-256 of the public key DER,
       first 16 bytes, hex, then mapped a-p).
    4. Optionally writes the "key" field into manifest.json so the id is
       pinned for everyone who loads this extension.

  Run this ONCE. Commit manifest.json with the "key" field. Do NOT commit
  extension-key.pem (it's a private key); add it to .gitignore. Keep the
  .pem somewhere safe in case you ever need to re-publish or rotate.

.PARAMETER PrivateKeyPath
  Where to write the RSA private key. Defaults to .\extension-key.pem.

.PARAMETER PatchManifest
  If set, writes the generated public key into manifest.json's "key" field.

.PARAMETER ManifestPath
  Path to manifest.json. Defaults to .\manifest.json (next to this script).

.EXAMPLE
  # Generate a key, see the id, but don't touch manifest.json
  .\generate-extension-id.ps1

.EXAMPLE
  # Generate a key AND patch manifest.json so the id is pinned
  .\generate-extension-id.ps1 -PatchManifest

.NOTES
  Requires either:
    * openssl on PATH (any modern Windows / Git for Windows / WSL has it), OR
    * .NET 6+ (PowerShell 7) - the script will fall back to System.Security
      .Cryptography if openssl is missing.
#>
[CmdletBinding()]
param(
  # Default to the repo root (one level above this script), NOT inside the
  # extension folder itself. If the .pem lives inside extension/ then Edge
  # will load it as part of the extension and warn that it shouldn't be there.
  [string]$PrivateKeyPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "extension-key.pem"),
  [switch]$PatchManifest,
  [string]$ManifestPath = (Join-Path $PSScriptRoot "manifest.json")
)

$ErrorActionPreference = "Stop"

function Test-Openssl {
  $null = Get-Command openssl -ErrorAction SilentlyContinue
  return $?
}

function New-RsaKeyPair-Openssl {
  param([string]$PrivPath)
  Write-Host "Generating 2048-bit RSA private key via openssl..." -ForegroundColor Cyan
  & openssl genrsa -out $PrivPath 2048 2>$null
  if ($LASTEXITCODE -ne 0) { throw "openssl genrsa failed." }

  Write-Host "Extracting SubjectPublicKeyInfo (DER) and base64-encoding..." -ForegroundColor Cyan
  # The manifest "key" field wants base64 of the SubjectPublicKeyInfo (SPKI) DER.
  $pubB64 = & openssl rsa -in $PrivPath -pubout -outform DER 2>$null | & openssl base64 -A
  if ($LASTEXITCODE -ne 0) { throw "openssl rsa -pubout failed." }
  return $pubB64
}

function New-RsaKeyPair-DotNet {
  param([string]$PrivPath)
  Write-Host "openssl not found; falling back to .NET RSA..." -ForegroundColor Yellow
  $rsa = [System.Security.Cryptography.RSA]::Create(2048)
  try {
    # PEM PKCS#8 private key
    $privPem = [System.Security.Cryptography.PemEncoding]::Write(
      [char[]]"PRIVATE KEY",
      $rsa.ExportPkcs8PrivateKey()
    )
    [System.IO.File]::WriteAllText($PrivPath, [string]::new($privPem))

    # Public key as base64 of SubjectPublicKeyInfo
    $spki = $rsa.ExportSubjectPublicKeyInfo()
    return [System.Convert]::ToBase64String($spki)
  } finally {
    $rsa.Dispose()
  }
}

function Get-ExtensionIdFromKey {
  param([string]$PubKeyBase64)
  # Chrome extension id derivation:
  #   id = first 32 hex chars of sha256(SPKI_DER), with each hex digit
  #        mapped 0->a, 1->b, ..., f->p
  $spki = [System.Convert]::FromBase64String($PubKeyBase64)
  $sha  = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($spki)
  } finally {
    $sha.Dispose()
  }
  $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
  $first32 = $hex.Substring(0, 32)
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $first32.ToCharArray()) {
    $digit = [Convert]::ToInt32([string]$c, 16)
    [void]$sb.Append([char](97 + $digit)) # 97 = 'a'
  }
  return $sb.ToString()
}

function Update-ManifestKey {
  param(
    [string]$Path,
    [string]$PubKeyBase64
  )
  if (-not (Test-Path $Path)) {
    throw "manifest.json not found at $Path"
  }
  $json = Get-Content -Raw -Path $Path | ConvertFrom-Json
  # Add or update the "key" field. PowerShell preserves member order on round-trip via ConvertTo-Json.
  if ($json.PSObject.Properties.Name -contains "key") {
    $json.key = $PubKeyBase64
  } else {
    $json | Add-Member -MemberType NoteProperty -Name "key" -Value $PubKeyBase64
  }
  $out = $json | ConvertTo-Json -Depth 20
  # ConvertTo-Json escapes forward slashes as \/ which is harmless but ugly. Undo.
  $out = $out -replace '\\/', '/'
  Set-Content -Path $Path -Value $out -Encoding UTF8
  Write-Host "Wrote `"key`" to $Path" -ForegroundColor Green
}

# --- main ---

if (Test-Path $PrivateKeyPath) {
  Write-Host "Private key already exists at $PrivateKeyPath. Reusing it." -ForegroundColor Yellow
  if (Test-Openssl) {
    $pubB64 = & openssl rsa -in $PrivateKeyPath -pubout -outform DER 2>$null | & openssl base64 -A
    if ($LASTEXITCODE -ne 0) { throw "Failed to read existing private key with openssl." }
  } else {
    $pem = Get-Content -Raw -Path $PrivateKeyPath
    $rsa = [System.Security.Cryptography.RSA]::Create()
    try {
      $rsa.ImportFromPem($pem)
      $spki = $rsa.ExportSubjectPublicKeyInfo()
      $pubB64 = [System.Convert]::ToBase64String($spki)
    } finally {
      $rsa.Dispose()
    }
  }
} else {
  if (Test-Openssl) {
    $pubB64 = New-RsaKeyPair-Openssl -PrivPath $PrivateKeyPath
  } else {
    $pubB64 = New-RsaKeyPair-DotNet -PrivPath $PrivateKeyPath
  }
  Write-Host "Private key written to $PrivateKeyPath" -ForegroundColor Green
  Write-Host "  ** Add this file to .gitignore. Do NOT commit it. **" -ForegroundColor Yellow
}

$extensionId = Get-ExtensionIdFromKey -PubKeyBase64 $pubB64

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Extension id: $extensionId" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Use this id in:" -ForegroundColor White
Write-Host "  * Entra app registration redirect URI (SPA platform):"
Write-Host "      https://$extensionId.chromiumapp.org/oauth2"
Write-Host "  * AgentChatV2 backend CORS allowlist (cors_origins):"
Write-Host "      chrome-extension://$extensionId"
Write-Host ""

if ($PatchManifest) {
  Update-ManifestKey -Path $ManifestPath -PubKeyBase64 $pubB64
  Write-Host "manifest.json now contains the public key. Re-load the extension."
} else {
  Write-Host "manifest.json was NOT modified. Re-run with -PatchManifest to pin the id." -ForegroundColor Yellow
  Write-Host "Or copy this value manually into manifest.json as a top-level field:"
  Write-Host ""
  Write-Host "  `"key`": `"$pubB64`""
  Write-Host ""
}
