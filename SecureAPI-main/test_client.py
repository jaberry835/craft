#!/usr/bin/env python3
"""
Test client for the two-layer auth API.

Auth model under test
----------------------
  Layer 1 — mTLS:      caller presents caller.crt + caller.key at TLS handshake.
  Layer 2 — OBO header: caller passes the user's public cert (base64 DER) in
                         the X-User-Cert header.  No user private key needed.

Scenarios
----------
  1. Valid caller cert + valid user cert header  →  200 on all endpoints
  2. No caller cert                              →  TLS handshake rejected
  3. Valid caller cert, no X-User-Cert header    →  400 Bad Request
  4. Valid caller cert, tampered user cert       →  400 Bad Request
  5. Valid caller cert, self-signed user cert    →  400 Bad Request
                                                    (not issued by our CA)

Usage:
    python test_client.py

The server must already be running:
    python app.py
"""

import base64
import json
import os
import sys

try:
    import requests
    from requests.exceptions import ConnectionError, SSLError
    from cryptography.hazmat.primitives import serialization
    from cryptography.x509 import load_pem_x509_certificate
    from cryptography import x509
    from cryptography.hazmat.primitives.asymmetric import rsa as rsa_mod
    from cryptography.hazmat.primitives import hashes
    import datetime
except ImportError:
    sys.exit(
        "Missing dependencies: run  pip install requests cryptography  then try again."
    )

BASE_URL    = "https://localhost:5005"
CA_CERT     = "certs/ca.crt"
CALLER_CERT = ("certs/caller.crt", "certs/caller.key")
USER_CERT_HEADER = "X-User-Cert"

ENDPOINTS = [
    ("/",       "root — caller + user greeting"),
    ("/data",   "data — protected records with identities"),
    ("/status", "status — service info"),
]

SEP = "-" * 65


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_certs():
    needed = [CA_CERT, CALLER_CERT[0], CALLER_CERT[1],
              "certs/user-alice.crt", "certs/user-bob.crt"]
    missing = [p for p in needed if not os.path.exists(p)]
    if missing:
        sys.exit(
            "Certificate files not found:\n"
            + "\n".join(f"  {p}" for p in missing)
            + "\nRun  python create_certs.py  first."
        )


def _pretty(data) -> str:
    return json.dumps(data, indent=2)


def _cert_pem_to_b64der(pem_path: str) -> str:
    """Load a PEM cert file and return the base64-encoded DER bytes."""
    with open(pem_path, "rb") as fh:
        pem_data = fh.read()
    cert = load_pem_x509_certificate(pem_data)
    der = cert.public_bytes(serialization.Encoding.DER)
    return base64.b64encode(der).decode("ascii")


def _make_self_signed_cert_b64() -> str:
    """
    Generate a throw-away self-signed cert at runtime (not signed by our CA)
    to test that the API correctly rejects it.
    """
    key = rsa_mod.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, "rogue-user")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    der = cert.public_bytes(serialization.Encoding.DER)
    return base64.b64encode(der).decode("ascii")


def _get(path: str, *, user_cert_b64: str | None, label: str) -> None:
    url = f"{BASE_URL}{path}"
    headers = {}
    if user_cert_b64 is not None:
        headers[USER_CERT_HEADER] = user_cert_b64

    print(f"  [{label}]")
    print(f"  GET {url}")
    print(f"  {USER_CERT_HEADER}: {'<present>' if user_cert_b64 else '<absent>'}")
    try:
        resp = requests.get(
            url,
            cert=CALLER_CERT,
            verify=CA_CERT,
            headers=headers,
            timeout=5,
        )
        status_mark = "✓" if resp.status_code == 200 else "✗"
        print(f"  Status : {resp.status_code}  {status_mark}")
        print(f"  Body   : {_pretty(resp.json())}")
    except SSLError as exc:
        print(f"  SSLError (unexpected): {exc}")
    except ConnectionError:
        print("  ConnectionError — is the server running?  (python app.py)")
    except Exception as exc:
        print(f"  Error : {exc}")


# ---------------------------------------------------------------------------
# Test scenarios
# ---------------------------------------------------------------------------

def scenario_valid(user_cn: str, cert_path: str) -> None:
    print(f"\nScenario 1: valid caller cert + valid X-User-Cert ({user_cn})")
    print(SEP)
    user_b64 = _cert_pem_to_b64der(cert_path)
    for path, description in ENDPOINTS:
        _get(path, user_cert_b64=user_b64, label=description)
        print()


def scenario_no_caller_cert() -> None:
    print(f"\nScenario 2: no caller certificate (TLS handshake should be rejected)")
    print(SEP)
    url = f"{BASE_URL}/"
    print(f"  GET {url}  (no caller cert)")
    try:
        requests.get(url, verify=CA_CERT, timeout=5)
        print("  UNEXPECTED SUCCESS — server did not enforce mTLS!")
    except SSLError:
        print("  SSLError  ✓  server rejected the connection (no caller cert)")
    except ConnectionError:
        print("  ConnectionError  ✓  server dropped the connection (no caller cert)")
    except Exception as exc:
        print(f"  Error : {exc}")


def scenario_missing_user_cert_header() -> None:
    print(f"\nScenario 3: valid caller cert, missing X-User-Cert header  →  expect 400")
    print(SEP)
    _get("/", user_cert_b64=None, label="no X-User-Cert header")


def scenario_tampered_user_cert() -> None:
    print(f"\nScenario 4: valid caller cert, tampered X-User-Cert  →  expect 400")
    print(SEP)
    # Load a real cert's DER, flip some bytes in the middle, re-encode.
    with open("certs/user-alice.crt", "rb") as fh:
        pem_data = fh.read()
    cert = load_pem_x509_certificate(pem_data)
    der = bytearray(cert.public_bytes(serialization.Encoding.DER))
    # Corrupt bytes near the signature area (last 20 bytes).
    for i in range(1, 21):
        der[-i] ^= 0xFF
    tampered_b64 = base64.b64encode(bytes(der)).decode("ascii")
    _get("/", user_cert_b64=tampered_b64, label="tampered DER bytes")


def scenario_rogue_user_cert() -> None:
    print(f"\nScenario 5: valid caller cert, self-signed user cert (not our CA)  →  expect 400")
    print(SEP)
    rogue_b64 = _make_self_signed_cert_b64()
    _get("/", user_cert_b64=rogue_b64, label="self-signed cert not from our CA")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    _check_certs()

    print("=" * 65)
    print("Two-Layer Auth API  —  Test Client")
    print("Auth model:  mTLS (caller) + X-User-Cert header (user identity)")
    print("=" * 65)

    # Scenario 1a — Alice
    scenario_valid("user-alice", "certs/user-alice.crt")

    # Scenario 1b — Bob (same endpoints, different user identity)
    print(f"\nScenario 1b: same caller, different user (user-bob)")
    print(SEP)
    bob_b64 = _cert_pem_to_b64der("certs/user-bob.crt")
    _get("/", user_cert_b64=bob_b64, label="user-bob via X-User-Cert")
    print()

    scenario_no_caller_cert()
    print()

    scenario_missing_user_cert_header()
    print()

    scenario_tampered_user_cert()
    print()

    scenario_rogue_user_cert()

    print(f"\n{'=' * 65}")
    print("Done.")


if __name__ == "__main__":
    main()
