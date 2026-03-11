# Secure API — Caller mTLS + On-Behalf-Of User Cert

A Flask API that enforces **two independent layers of identity** on every request:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **1 — Mutual TLS** | Caller presents `caller.crt` + `caller.key` during the TLS handshake | Authenticates the **calling service** |
| **2 — X-User-Cert header** | Caller sends the user's public certificate (base64-encoded DER) in the `X-User-Cert` header | Identifies the **end user** the caller is acting on behalf of |

The API trusts the user identity assertion *because* the caller already authenticated via mTLS — an unauthenticated caller can never reach the header-parsing code.

## Prerequisites

- **Python 3.12+**
- **OpenSSL** (only needed for the PowerShell cert generator; the Python generator uses the `cryptography` library)

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Generate test certificates
python create_certs.py

# 3. Start the server
python app.py

# 4. Run the test client (in a separate terminal)
python test_client.py
```

## Project Structure

```
├── app.py               # API server (Flask + Werkzeug mTLS)
├── create_certs.py      # Certificate generator (Python / cryptography)
├── create_certs.ps1     # Certificate generator (PowerShell / OpenSSL)
├── test_client.py       # Integration test client
├── requirements.txt     # Python dependencies
└── certs/               # Generated certificates (gitignore recommended)
    ├── ca.crt / ca.key            # Root CA
    ├── server.crt / server.key    # API server
    ├── caller.crt / caller.key    # Calling service (used for mTLS)
    ├── user-alice.crt / .key      # User Alice identity
    └── user-bob.crt / .key        # User Bob identity
```

## Generating Test Certificates

Two equivalent options:

### Option A — Python (no external tools required)

```bash
python create_certs.py
```

Uses the `cryptography` library to generate all certs into `certs/`.

### Option B — PowerShell + OpenSSL

```powershell
.\create_certs.ps1
```

Requires OpenSSL on your PATH. The script searches common install locations automatically (Git for Windows, winget, Chocolatey installs).

### Certificate Hierarchy

All leaf certificates are signed by a single self-signed Root CA:

```
Test Root CA  (ca.crt)
├── localhost        (server.crt)   — server identity, SAN: localhost + 127.0.0.1
├── test-caller      (caller.crt)   — caller service identity (mTLS client cert)
├── user-alice       (user-alice.crt) — user identity
└── user-bob         (user-bob.crt)   — user identity
```

> **Note:** The caller only needs the user `.crt` files (public cert) to build the `X-User-Cert` header. The user `.key` files are generated for completeness but would never leave the user's device in a real deployment.

## Running the Server

```bash
python app.py
```

This starts two servers:

| Server | Port | Protocol | Purpose |
|--------|------|----------|---------|
| **API** | 5005 | HTTPS (mTLS) | Main API — requires client certificate |
| **Docs** | 5006 | HTTP | Swagger UI — no auth required |

- **Swagger UI:** [http://localhost:5006/apidocs/](http://localhost:5006/apidocs/)
- **API base URL:** `https://localhost:5005`

## Configuration

Key settings at the top of [app.py](app.py):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5005` | HTTPS API port |
| `DOCS_PORT` | `5006` | HTTP Swagger UI port |
| `ALLOWED_CALLER_CNS` | `{"test-caller"}` | Caller CNs permitted via mTLS. Set to `None` to accept any CA-signed cert. |
| `REQUIRE_USER_CERT` | `True` | When `True`, every request must include a valid `X-User-Cert` header. |

## API Endpoints

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| `GET` | `/` | mTLS + X-User-Cert | Greeting showing both caller and user identities |
| `GET` | `/data` | mTLS + X-User-Cert | Protected records with caller + user context |
| `GET` | `/status` | mTLS only | Service health and auth configuration |

## Making Requests

### With the test client

```bash
python test_client.py
```

Runs five scenarios: valid requests, missing caller cert, missing user header, tampered cert, and a rogue self-signed cert.

### With curl

```bash
# Build the X-User-Cert header value
USER_CERT=$(openssl x509 -in certs/user-alice.crt -outform DER | base64 -w 0)

# Call the API
curl -s https://localhost:5005/data \
  --cert certs/caller.crt \
  --key  certs/caller.key \
  --cacert certs/ca.crt \
  -H "X-User-Cert: $USER_CERT"
```

### With Python

```python
import base64
import requests
from cryptography.x509 import load_pem_x509_certificate
from cryptography.hazmat.primitives import serialization

# Load user cert and encode as base64 DER
with open("certs/user-alice.crt", "rb") as f:
    cert = load_pem_x509_certificate(f.read())
user_cert_b64 = base64.b64encode(
    cert.public_bytes(serialization.Encoding.DER)
).decode()

resp = requests.get(
    "https://localhost:5005/data",
    cert=("certs/caller.crt", "certs/caller.key"),
    verify="certs/ca.crt",
    headers={"X-User-Cert": user_cert_b64},
)
print(resp.json())
```

## How Authentication Works

```
Client (caller)                              Server (app.py)
──────────────────                           ──────────────────
1. TLS handshake with caller.crt + key  ──►  Verify cert signed by CA
                                              Check CN in ALLOWED_CALLER_CNS
                                              ✗ reject → connection dropped

2. GET /data                            ──►  Extract caller CN from TLS session
   X-User-Cert: <base64 DER>                 Decode + parse user cert
                                              Verify CA signature on user cert
                                              Check validity window
                                              Extract user CN
                                              ✗ reject → 400 Bad Request

3.                                      ◄──  200 OK + response body
```

## Test Scenarios

The test client (`test_client.py`) covers:

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | Valid caller cert + valid user cert (Alice, then Bob) | 200 OK on all endpoints |
| 2 | No caller certificate | TLS handshake rejected (SSLError) |
| 3 | Valid caller cert, missing `X-User-Cert` header | 400 Bad Request |
| 4 | Valid caller cert, tampered user cert bytes | 400 Bad Request |
| 5 | Valid caller cert, self-signed user cert (not from our CA) | 400 Bad Request |

## Adding a New User

1. Generate a new certificate signed by the CA (use either `create_certs.py` as a reference or OpenSSL directly).
2. Give the caller service the new `.crt` file (public cert only).
3. No server changes needed — any CA-signed cert with a CN is accepted.

## Adding a New Caller Service

1. Generate a new client certificate signed by the CA.
2. Add the new caller's CN to `ALLOWED_CALLER_CNS` in [app.py](app.py).
3. Restart the server.
