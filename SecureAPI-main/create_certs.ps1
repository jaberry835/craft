<#
.SYNOPSIS
    Generate test certificates for the two-layer auth API using OpenSSL.
    Alternative to create_certs.py — requires OpenSSL on your PATH.

.DESCRIPTION
    Creates certificates for the caller+OBO-user auth model:

      ca.crt / ca.key             — root CA
      server.crt / server.key     — API server
      caller.crt / caller.key     — calling service (owns private key; used for mTLS)
      user-alice.crt / .key       — user Alice identity cert
      user-bob.crt / .key         — user Bob identity cert

    NOTE: The caller only needs the user .crt files (not .key) to build the
          X-User-Cert header.  The .key files are generated for completeness.

.NOTES
    OpenSSL is available via:
      - Git for Windows   (C:\Program Files\Git\usr\bin\openssl.exe)
      - winget install    ShiningLight.OpenSSL
      - Chocolatey        choco install openssl
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Locate OpenSSL
# ---------------------------------------------------------------------------
$candidatePaths = @(
    "openssl",
    "C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
    "C:\Program Files\OpenSSL\bin\openssl.exe",
    "C:\Program Files\Git\usr\bin\openssl.exe",
    "C:\Program Files (x86)\Git\usr\bin\openssl.exe"
)

$openssl = $null
foreach ($candidate in $candidatePaths) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) {
        $openssl = $candidate
        break
    }
}

if (-not $openssl) {
    Write-Error @"
OpenSSL was not found.  Install it with one of:
  winget install ShiningLight.OpenSSL
  choco install openssl
  (or install Git for Windows, which bundles OpenSSL)
"@
    exit 1
}

$version = (& $openssl version 2>&1)
Write-Host "Using: $version" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Directories and subject strings
# ---------------------------------------------------------------------------
$certsDir = "certs"
if (-not (Test-Path $certsDir)) { New-Item -ItemType Directory $certsDir | Out-Null }

$caSubject     = "/C=US/ST=TestState/O=Test CA Org/CN=Test Root CA"
$srvSubject    = "/C=US/ST=TestState/O=Test Server Org/CN=localhost"
$callerSubject = "/C=US/ST=TestState/O=Test Caller Org/CN=test-caller"
$aliceSubject  = "/C=US/ST=TestState/O=Test Users Org/CN=user-alice"
$bobSubject    = "/C=US/ST=TestState/O=Test Users Org/CN=user-bob"

# ---------------------------------------------------------------------------
# CA
# ---------------------------------------------------------------------------
Write-Host "`n[ CA ] generating key and self-signed certificate ..." -ForegroundColor Green

& $openssl genrsa -out "$certsDir\ca.key" 2048
& $openssl req -new -x509 -days 3650 `
    -key "$certsDir\ca.key" `
    -out "$certsDir\ca.crt" `
    -subj $caSubject

# ---------------------------------------------------------------------------
# Server certificate  (signed by CA, with SAN for localhost)
# ---------------------------------------------------------------------------
Write-Host "`n[ Server ] generating key and certificate ..." -ForegroundColor Green

# Extensions config — SAN required by modern TLS clients
$serverExtFile = "$certsDir\server_ext.cnf"
@"
[req_ext]
subjectAltName = DNS:localhost, IP:127.0.0.1
"@ | Out-File -FilePath $serverExtFile -Encoding ascii

& $openssl genrsa -out "$certsDir\server.key" 2048
& $openssl req -new `
    -key "$certsDir\server.key" `
    -out "$certsDir\server.csr" `
    -subj $srvSubject
& $openssl x509 -req -days 365 `
    -in  "$certsDir\server.csr" `
    -CA  "$certsDir\ca.crt" `
    -CAkey "$certsDir\ca.key" `
    -CAcreateserial `
    -out "$certsDir\server.crt" `
    -extfile $serverExtFile `
    -extensions req_ext

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Caller certificate  (signed by CA — caller has its own private key for mTLS)
# ---------------------------------------------------------------------------
Write-Host "`n[ Caller ] generating key and certificate ..." -ForegroundColor Green

& $openssl genrsa -out "$certsDir\caller.key" 2048
& $openssl req -new `
    -key "$certsDir\caller.key" `
    -out "$certsDir\caller.csr" `
    -subj $callerSubject
& $openssl x509 -req -days 365 `
    -in  "$certsDir\caller.csr" `
    -CA  "$certsDir\ca.crt" `
    -CAkey "$certsDir\ca.key" `
    -CAcreateserial `
    -out "$certsDir\caller.crt"

# ---------------------------------------------------------------------------
# User identity certificates  (signed by CA — caller only needs the .crt)
# ---------------------------------------------------------------------------
Write-Host "`n[ User - Alice ] generating key and certificate ..." -ForegroundColor Green

& $openssl genrsa -out "$certsDir\user-alice.key" 2048
& $openssl req -new `
    -key "$certsDir\user-alice.key" `
    -out "$certsDir\user-alice.csr" `
    -subj $aliceSubject
& $openssl x509 -req -days 365 `
    -in  "$certsDir\user-alice.csr" `
    -CA  "$certsDir\ca.crt" `
    -CAkey "$certsDir\ca.key" `
    -CAcreateserial `
    -out "$certsDir\user-alice.crt"

Write-Host "`n[ User - Bob ] generating key and certificate ..." -ForegroundColor Green

& $openssl genrsa -out "$certsDir\user-bob.key" 2048
& $openssl req -new `
    -key "$certsDir\user-bob.key" `
    -out "$certsDir\user-bob.csr" `
    -subj $bobSubject
& $openssl x509 -req -days 365 `
    -in  "$certsDir\user-bob.csr" `
    -CA  "$certsDir\ca.crt" `
    -CAkey "$certsDir\ca.key" `
    -CAcreateserial `
    -out "$certsDir\user-bob.crt"

# ---------------------------------------------------------------------------
# Clean up temporary files
# ---------------------------------------------------------------------------
Remove-Item "$certsDir\server.csr",     "$certsDir\caller.csr", `
            "$certsDir\user-alice.csr", "$certsDir\user-bob.csr", `
            $serverExtFile,             "$certsDir\ca.srl" `
            -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "`nDone.  Files created:" -ForegroundColor Cyan
Get-ChildItem $certsDir | ForEach-Object { Write-Host "  certs\$($_.Name)" }

Write-Host @"

Auth model reminder:
  * caller.crt + caller.key  — presented during TLS handshake (mTLS)
  * user-alice.crt            — base64-encoded DER sent in X-User-Cert header
  The caller does NOT need user-alice.key or user-bob.key.

Next steps:
  1. Start the server:  python app.py
  2. Run the tests:     python test_client.py
"@ -ForegroundColor Yellow
