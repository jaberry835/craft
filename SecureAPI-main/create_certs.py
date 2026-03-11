#!/usr/bin/env python3
"""
Generate test certificates for the two-layer auth API.

Certificate hierarchy
----------------------
  certs/ca.crt / ca.key             — root CA (signs everything)
  certs/server.crt / server.key     — API server
  certs/caller.crt / caller.key     — the calling service
                                       (has its own private key, used for mTLS)
  certs/user-alice.crt / .key       — user identity cert for Alice
  certs/user-bob.crt / .key         — user identity cert for Bob

    NOTE: In a realistic deployment the user private keys would never leave
    the user's device.  They are generated here purely so you can inspect
    them.  The caller only needs the public cert  (.crt)  to populate the
    X-User-Cert header.

Usage:
    python create_certs.py
"""

import datetime
import ipaddress
import os
import sys

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
except ImportError:
    sys.exit(
        "Missing dependency: run  pip install cryptography  then try again."
    )

CERTS_DIR = "certs"
KEY_SIZE = 2048
CA_DAYS = 3650   # 10 years
LEAF_DAYS = 365  # 1 year


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _new_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=KEY_SIZE)


def _save_key(key: rsa.RSAPrivateKey, path: str) -> None:
    with open(path, "wb") as fh:
        fh.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    print(f"  wrote  {path}")


def _save_cert(cert: x509.Certificate, path: str) -> None:
    with open(path, "wb") as fh:
        fh.write(cert.public_bytes(serialization.Encoding.PEM))
    print(f"  wrote  {path}")


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


# ---------------------------------------------------------------------------
# CA
# ---------------------------------------------------------------------------

def generate_ca():
    print("[ CA ] generating key and self-signed certificate ...")
    key = _new_key()

    name = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "TestState"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test CA Org"),
        x509.NameAttribute(NameOID.COMMON_NAME, "Test Root CA"),
    ])

    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=CA_DAYS))
        .add_extension(
            x509.BasicConstraints(ca=True, path_length=None), critical=True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=True,
                crl_sign=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    return key, cert


# ---------------------------------------------------------------------------
# Server certificate
# ---------------------------------------------------------------------------

def generate_server_cert(ca_key, ca_cert):
    print("[ Server ] generating key and certificate ...")
    key = _new_key()

    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "TestState"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test Server Org"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])

    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=LEAF_DAYS))
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        # Subject Alternative Names — required by modern TLS clients
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            ]),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    return key, cert


# ---------------------------------------------------------------------------
# Caller / service certificate  (used for mTLS — caller owns the private key)
# ---------------------------------------------------------------------------

def generate_caller_cert(ca_key, ca_cert, common_name: str = "test-caller"):
    print(f"[ Caller ] generating key and certificate (CN={common_name}) ...")
    key = _new_key()

    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "TestState"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test Caller Org"),
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
    ])

    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=LEAF_DAYS))
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    return key, cert


# ---------------------------------------------------------------------------
# User identity certificate  (public cert shared with caller; private key
# stays with the user and is NOT needed by the caller or the API)
# ---------------------------------------------------------------------------

def generate_user_cert(ca_key, ca_cert, common_name: str):
    print(f"[ User   ] generating key and certificate (CN={common_name}) ...")
    key = _new_key()

    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "TestState"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Test Users Org"),
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
    ])

    now = _now()
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=LEAF_DAYS))
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        # EMAIL_PROTECTION is a common EKU for user identity certs
        .add_extension(
            x509.ExtendedKeyUsage([
                ExtendedKeyUsageOID.CLIENT_AUTH,
                ExtendedKeyUsageOID.EMAIL_PROTECTION,
            ]),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
            critical=False,
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    return key, cert


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(CERTS_DIR, exist_ok=True)
    print(f"\nGenerating test certificates in '{CERTS_DIR}/' ...\n")

    # CA
    ca_key, ca_cert = generate_ca()
    _save_key(ca_key,   os.path.join(CERTS_DIR, "ca.key"))
    _save_cert(ca_cert, os.path.join(CERTS_DIR, "ca.crt"))
    print()

    # Server
    srv_key, srv_cert = generate_server_cert(ca_key, ca_cert)
    _save_key(srv_key,   os.path.join(CERTS_DIR, "server.key"))
    _save_cert(srv_cert, os.path.join(CERTS_DIR, "server.crt"))
    print()

    # Caller service  (owns private key — used for mTLS)
    caller_key, caller_cert = generate_caller_cert(ca_key, ca_cert, "test-caller")
    _save_key(caller_key,   os.path.join(CERTS_DIR, "caller.key"))
    _save_cert(caller_cert, os.path.join(CERTS_DIR, "caller.crt"))
    print()

    # User identity certs  (caller only needs the .crt, not the .key)
    for user_cn in ("user-alice", "user-bob"):
        u_key, u_cert = generate_user_cert(ca_key, ca_cert, user_cn)
        _save_key(u_key,   os.path.join(CERTS_DIR, f"{user_cn}.key"))
        _save_cert(u_cert, os.path.join(CERTS_DIR, f"{user_cn}.crt"))

    print("\nDone.  Files created:")
    for name in sorted(os.listdir(CERTS_DIR)):
        print(f"  certs/{name}")

    print("""
Auth model reminder:
  • caller.crt + caller.key  — presented during TLS handshake (mTLS)
  • user-alice.crt           — base64-encoded DER sent in X-User-Cert header
  The caller does NOT need user-alice.key or user-bob.key.

Next steps:
  1. Start the server:  python app.py
  2. Run the tests:     python test_client.py
""")


if __name__ == "__main__":
    main()
