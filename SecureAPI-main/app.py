#!/usr/bin/env python3
"""
Secure API with two-layer identity model.

Layer 1 — Caller authentication via mutual TLS
    The calling service authenticates itself using its own certificate +
    private key during the TLS handshake.  If the caller cannot present a
    certificate signed by our CA the connection is rejected before any
    application code runs.  The caller's CN must also appear in
    ALLOWED_CALLER_CNS.

Layer 2 — User identity via on-behalf-of header
    The caller acts on behalf of a user.  It passes the user's DER
    certificate (base64-encoded) in the  X-User-Cert  request header.
    The caller does NOT need the user's private key — it only forwards the
    public certificate to assert which user it is acting for.
    The API validates the user cert (CA signature + validity window) and
    derives the user's CN from it.

Trust model
-----------
    The API trusts the caller's identity assertion (the X-User-Cert header)
    *because* the caller already authenticated via mTLS.  An unauthenticated
    caller cannot reach the header-parsing code, so it cannot spoof a user
    identity.

Certificate files expected in certs/
--------------------------------------
    ca.crt / ca.key          — root CA
    server.crt / server.key  — this API server
    caller.crt / caller.key  — the calling service (has its private key)
    user-alice.crt           — user Alice  (public cert only shared with caller)
    user-bob.crt             — user Bob    (public cert only shared with caller)

Endpoints
---------
    GET /        Greeting showing both caller and user identities.
    GET /data    Protected records with caller + user context.
    GET /status  Service health and auth configuration.

Usage
-----
    1. Generate certs:  python create_certs.py
    2. Start server:    python app.py
    3. Run tests:       python test_client.py
"""

import base64
import datetime
import logging
import os
import ssl
import sys
import threading

try:
    from cryptography import x509
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
    from cryptography.x509 import load_der_x509_certificate, load_pem_x509_certificate
except ImportError:
    sys.exit("Missing dependency: run  pip install cryptography  then try again.")

from flasgger import Swagger
from flask import Flask, jsonify, request
from werkzeug.serving import WSGIRequestHandler, run_simple

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HOST = "0.0.0.0"
PORT = 5005
DOCS_PORT = 5006
CERTS_DIR = "certs"

# Caller service CNs permitted to call this API (mTLS layer).
# Set to None to accept any cert signed by the CA (auth only, no CN check).
ALLOWED_CALLER_CNS = {"test-caller"}

# HTTP header the caller uses to pass the user's public certificate.
USER_CERT_HEADER = "X-User-Cert"

# When True, every request must carry a valid X-User-Cert header.
REQUIRE_USER_CERT = True

# Loaded at startup — used to verify user cert signatures.
_ca_cert: x509.Certificate | None = None

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-5s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("secureapi")

# ---------------------------------------------------------------------------
# Swagger / OpenAPI configuration
# ---------------------------------------------------------------------------
_SWAGGER_TEMPLATE = {
    "swagger": "2.0",
    "info": {
        "title": "Secure API — Caller mTLS + OBO User Cert",
        "version": "2.0.0",
        "description": """
## Authentication

This API enforces **two independent layers** of identity on every request.

### Layer 1 — Mutual TLS (caller authentication)

The calling service must present a client certificate (`caller.crt` + `caller.key`)
during the TLS handshake.  The server rejects the connection at the transport
layer if the certificate is absent or was not signed by the trusted CA.  
The caller's Common Name must also appear in the server's allow-list.

> **Swagger UI cannot perform the TLS handshake for you.**  
> Use `curl`, Postman, or the provided `test_client.py` when making real calls.

### Layer 2 — On-Behalf-Of user identity (header)

The authenticated caller passes the **user's public certificate** in the
`X-User-Cert` request header as **base64-encoded DER**.  The server:

1. Decodes the base64 value.
2. Parses it as a DER X.509 certificate.
3. Verifies the CA signature — only certs signed by the trusted CA are accepted.
4. Checks the validity window (not-before / not-after).
5. Extracts the user's Common Name as the acting identity.

The caller does **not** need the user's private key.

## Generating the X-User-Cert header value

```python
import base64
from cryptography.x509 import load_pem_x509_certificate
from cryptography.hazmat.primitives import serialization

with open("certs/user-alice.crt", "rb") as f:
    cert = load_pem_x509_certificate(f.read())

der = cert.public_bytes(serialization.Encoding.DER)
header_value = base64.b64encode(der).decode()
```

```bash
# Or with openssl + base64:
openssl x509 -in certs/user-alice.crt -outform DER | base64 -w 0
```

## curl example

```bash
USER_CERT=$(openssl x509 -in certs/user-alice.crt -outform DER | base64 -w 0)

curl -s https://localhost:5005/data \\
  --cert certs/caller.crt \\
  --key  certs/caller.key \\
  --cacert certs/ca.crt \\
  -H "X-User-Cert: $USER_CERT"
```
        """,
    },
    "host": "localhost:5005",
    "basePath": "/",
    "schemes": ["https"],
    "consumes": ["application/json"],
    "produces": ["application/json"],
    "securityDefinitions": {
        "CallerMTLS": {
            "type": "apiKey",
            "name": "X-Client-Cert-CN",
            "in": "header",
            "description": (
                "**Transport-layer credential — not a real HTTP header.**  "
                "The caller must present `caller.crt` + `caller.key` during "
                "the TLS handshake.  This entry documents the requirement; "
                "Swagger UI cannot perform mTLS for you."
            ),
        },
        "UserCertHeader": {
            "type": "apiKey",
            "name": "X-User-Cert",
            "in": "header",
            "description": (
                "Base64-encoded DER of the user\'s public X.509 certificate, "
                "signed by the trusted CA.  No user private key required."
            ),
        },
    },
    "security": [
        {"CallerMTLS": []},
        {"UserCertHeader": []},
    ],
    "definitions": {
        "ErrorResponse": {
            "type": "object",
            "properties": {
                "error":  {"type": "string", "example": "Bad Request"},
                "detail": {"type": "string", "example": "Missing required header: X-User-Cert"},
            },
        },
    },
    "paths": {
        "/": {
            "get": {
                "summary": "Caller + user greeting",
                "tags": ["Identity"],
                "parameters": [
                    {
                        "name": "X-User-Cert",
                        "in": "header",
                        "required": True,
                        "type": "string",
                        "description": (
                            "Base64-encoded DER of the user's public X.509 certificate. "
                            "Must be signed by the trusted CA."
                        ),
                    }
                ],
                "responses": {
                    "200": {
                        "description": "Both identities validated successfully.",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "status":      {"type": "string", "example": "ok"},
                                "message":     {"type": "string", "example": "Request accepted. Caller 'test-caller' is acting on behalf of user 'user-alice'."},
                                "caller_cn":   {"type": "string", "example": "test-caller"},
                                "user_cn":     {"type": "string", "example": "user-alice"},
                                "auth_method": {"type": "string", "example": "mTLS (caller) + X-User-Cert header (user identity)"},
                            },
                        },
                    },
                    "400": {
                        "description": "X-User-Cert header is missing, malformed, expired, or not signed by the trusted CA.",
                        "schema": {"$ref": "#/definitions/ErrorResponse"},
                    },
                    "403": {
                        "description": "Caller CN is not in the server allow-list.",
                        "schema": {"$ref": "#/definitions/ErrorResponse"},
                    },
                },
            },
        },
        "/data": {
            "get": {
                "summary": "Fetch protected records",
                "tags": ["Data"],
                "parameters": [
                    {
                        "name": "X-User-Cert",
                        "in": "header",
                        "required": True,
                        "type": "string",
                        "description": (
                            "Base64-encoded DER of the user's public X.509 certificate. "
                            "Must be signed by the trusted CA."
                        ),
                    }
                ],
                "responses": {
                    "200": {
                        "description": "Records returned successfully.",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "status":    {"type": "string", "example": "success"},
                                "caller_cn": {"type": "string", "example": "test-caller"},
                                "user_cn":   {"type": "string", "example": "user-alice"},
                                "protected_data": {
                                    "type": "object",
                                    "properties": {
                                        "records": {"type": "array", "items": {"type": "string"}, "example": ["alpha", "beta", "gamma"]},
                                        "count": {"type": "integer", "example": 3},
                                        "note": {"type": "string"},
                                    },
                                },
                            },
                        },
                    },
                    "400": {
                        "description": "X-User-Cert header is missing, malformed, expired, or not signed by the trusted CA.",
                        "schema": {"$ref": "#/definitions/ErrorResponse"},
                    },
                    "403": {
                        "description": "Caller CN is not in the server allow-list.",
                        "schema": {"$ref": "#/definitions/ErrorResponse"},
                    },
                },
            },
        },
        "/status": {
            "get": {
                "summary": "Service status",
                "tags": ["Health"],
                "responses": {
                    "200": {
                        "description": "Service is running.",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "service": {"type": "string", "example": "Secure API — caller mTLS + OBO user cert"},
                                "version": {"type": "string", "example": "2.0.0"},
                                "status":  {"type": "string", "example": "running"},
                                "auth": {
                                    "type": "object",
                                    "properties": {
                                        "layer1":             {"type": "string"},
                                        "layer2":             {"type": "string"},
                                        "caller_allowlist":   {"type": "array", "items": {"type": "string"}},
                                        "user_cert_required": {"type": "boolean"},
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
}

_SWAGGER_CONFIG = {
    "headers": [],
    "specs": [
        {
            "endpoint": "apispec",
            "route": "/apispec.json",
            "rule_filter": lambda rule: True,
            "model_filter": lambda tag: True,
        }
    ],
    "static_url_path": "/flasgger_static",
    "swagger_ui": True,
    "specs_route": "/docs",
}


# ---------------------------------------------------------------------------
# Custom request handler — injects caller cert info into the WSGI environ
# ---------------------------------------------------------------------------
class MutualTLSRequestHandler(WSGIRequestHandler):
    """Extend Werkzeug's handler to expose the peer (caller) cert in environ."""

    def make_environ(self):
        environ = super().make_environ()
        ssl_sock = getattr(self, "request", None) or getattr(self, "connection", None)
        if ssl_sock and hasattr(ssl_sock, "getpeercert"):
            peer_cert = ssl_sock.getpeercert()
            if peer_cert:
                environ["SSL_CALLER_CERT"] = peer_cert
                for rdns in peer_cert.get("subject", []):
                    for attr, value in rdns:
                        if attr == "commonName":
                            environ["SSL_CALLER_CN"] = value
        return environ


# ---------------------------------------------------------------------------
# Flask application
# ---------------------------------------------------------------------------
app = Flask(__name__)
Swagger(app, config=_SWAGGER_CONFIG, template=_SWAGGER_TEMPLATE)


def _caller_cn() -> str | None:
    """Return the mTLS-authenticated caller's Common Name, or None."""
    return request.environ.get("SSL_CALLER_CN")


def _validate_user_cert(cert_b64: str) -> str:
    """
    Decode and validate a base64-encoded DER user certificate.

    Checks:
      - Valid base64 and parseable as a DER certificate.
      - Validity window (not before / not after).
      - Signature verifies against the loaded CA public key.
      - Certificate carries a Common Name.

    Returns the user's CN on success, raises ValueError on any failure.
    The error messages are intentionally generic to avoid leaking internals.
    """
    try:
        der = base64.b64decode(cert_b64, validate=True)
    except Exception:
        raise ValueError("X-User-Cert is not valid base64")

    try:
        cert = load_der_x509_certificate(der)
    except Exception:
        raise ValueError("X-User-Cert could not be parsed as a DER certificate")

    now = datetime.datetime.now(datetime.timezone.utc)
    if now < cert.not_valid_before_utc or now > cert.not_valid_after_utc:
        raise ValueError("User certificate is expired or not yet valid")

    # Verify the cert was signed by our CA.
    try:
        _ca_cert.public_key().verify(
            cert.signature,
            cert.tbs_certificate_bytes,
            PKCS1v15(),
            cert.signature_hash_algorithm,
        )
    except (InvalidSignature, Exception):
        raise ValueError("User certificate was not signed by the trusted CA")

    cn_attrs = cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
    if not cn_attrs:
        raise ValueError("User certificate contains no Common Name")

    # The full cert is available here — additional subject fields can be
    # extracted the same way, e.g.:
    #   cert.subject.get_attributes_for_oid(x509.oid.NameOID.EMAIL_ADDRESS)
    #   cert.subject.get_attributes_for_oid(x509.oid.NameOID.ORGANIZATION_NAME)
    #   cert.subject.get_attributes_for_oid(x509.oid.NameOID.ORGANIZATIONAL_UNIT_NAME)
    # Extensions (SANs, custom OIDs, etc.) are also accessible:
    #   cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
    # To expose these, return the full cert object instead of just the CN.

    return cn_attrs[0].value


# --- Authorization hook ------------------------------------------------------

@app.before_request
def require_authorized_caller():
    """
    Layer 1: verify the caller's mTLS CN is in the allow-list.
    This runs before every request; a 403 here aborts the request.
    """
    if ALLOWED_CALLER_CNS is None:
        return  # CN check disabled; any cert signed by the CA is accepted

    cn = _caller_cn()
    if cn not in ALLOWED_CALLER_CNS:
        log.warning("REJECTED  caller=%s  path=%s  reason=caller_not_allowed  status=403", cn, request.path)
        return (
            jsonify({
                "error": "Forbidden",
                "detail": (
                    f"Caller CN '{cn}' is not in the authorized list. "
                    "Add it to ALLOWED_CALLER_CNS in app.py."
                ),
            }),
            403,
        )


def _resolve_user_identity() -> tuple[str | None, str | None]:
    """
    Layer 2: extract and validate the on-behalf-of user certificate from
    the X-User-Cert header.

    Returns (user_cn, error_message).  If the header is absent and
    REQUIRE_USER_CERT is False, returns (None, None).
    """
    cert_b64 = request.headers.get(USER_CERT_HEADER)

    if cert_b64 is None:
        if REQUIRE_USER_CERT:
            return None, f"Missing required header: {USER_CERT_HEADER}"
        return None, None

    try:
        user_cn = _validate_user_cert(cert_b64)
        return user_cn, None
    except ValueError as exc:
        return None, str(exc)


@app.after_request
def log_request(response):
    caller = _caller_cn() or "unknown"
    user = request.environ.get("RESOLVED_USER_CN", "-")
    log.info(
        "%s  caller=%s  user=%s  %s %s  status=%s",
        request.remote_addr, caller, user, request.method, request.path,
        response.status_code,
    )
    return response


# --- Endpoints ---------------------------------------------------------------

@app.get("/")
def index():
    """
    Greeting — shows both authenticated identities.
    ---
    summary: Caller + user greeting
    tags:
      - Identity
    parameters:
      - name: X-User-Cert
        in: header
        required: true
        type: string
        description: >
          Base64-encoded DER of the user's public X.509 certificate.
          Must be signed by the trusted CA.
    responses:
      200:
        description: Both identities validated successfully.
        schema:
          type: object
          properties:
            status:      {type: string, example: ok}
            message:     {type: string, example: "Request accepted. Caller 'test-caller' is acting on behalf of user 'user-alice'."}
            caller_cn:   {type: string, example: test-caller}
            user_cn:     {type: string, example: user-alice}
            auth_method: {type: string, example: "mTLS (caller) + X-User-Cert header (user identity)"}
      400:
        description: X-User-Cert header is missing, malformed, expired, or not signed by the trusted CA.
        schema:
          $ref: '#/definitions/ErrorResponse'
      403:
        description: Caller CN is not in the server allow-list.
        schema:
          $ref: '#/definitions/ErrorResponse'
    """
    user_cn, err = _resolve_user_identity()
    if err:
        log.warning("BAD_REQUEST  caller=%s  path=/  error=%s", _caller_cn(), err)
        return jsonify({"error": "Bad Request", "detail": err}), 400

    request.environ["RESOLVED_USER_CN"] = user_cn
    return jsonify({
        "status": "ok",
        "message": (
            f"Request accepted. Caller '{_caller_cn()}' is acting on behalf "
            f"of user '{user_cn}'."
        ),
        "caller_cn": _caller_cn(),
        "user_cn": user_cn,
        "auth_method": "mTLS (caller) + X-User-Cert header (user identity)",
    })


@app.get("/data")
def get_data():
    """
    Protected data — returns records with full caller + user context.
    ---
    summary: Fetch protected records
    tags:
      - Data
    parameters:
      - name: X-User-Cert
        in: header
        required: true
        type: string
        description: >
          Base64-encoded DER of the user's public X.509 certificate.
          Must be signed by the trusted CA.
    responses:
      200:
        description: Records returned successfully.
        schema:
          type: object
          properties:
            status:    {type: string, example: success}
            caller_cn: {type: string, example: test-caller}
            user_cn:   {type: string, example: user-alice}
            protected_data:
              type: object
              properties:
                records:
                  type: array
                  items: {type: string}
                  example: [alpha, beta, gamma]
                count: {type: integer, example: 3}
                note:  {type: string}
      400:
        description: X-User-Cert header is missing, malformed, expired, or not signed by the trusted CA.
        schema:
          $ref: '#/definitions/ErrorResponse'
      403:
        description: Caller CN is not in the server allow-list.
        schema:
          $ref: '#/definitions/ErrorResponse'
    """
    user_cn, err = _resolve_user_identity()
    if err:
        log.warning("BAD_REQUEST  caller=%s  path=/data  error=%s", _caller_cn(), err)
        return jsonify({"error": "Bad Request", "detail": err}), 400

    request.environ["RESOLVED_USER_CN"] = user_cn
    return jsonify({
        "status": "success",
        "caller_cn": _caller_cn(),
        "user_cn": user_cn,
        "protected_data": {
            "records": ["alpha", "beta", "gamma"],
            "count": 3,
            "note": (
                f"Data fetched by caller '{_caller_cn()}' "
                f"on behalf of user '{user_cn}'."
            ),
        },
    })


@app.get("/status")
def status():
    """
    Service health and auth configuration.
    ---
    summary: Service status
    tags:
      - Health
    responses:
      200:
        description: Service is running.
        schema:
          type: object
          properties:
            service:  {type: string, example: "Secure API — caller mTLS + OBO user cert"}
            version:  {type: string, example: "2.0.0"}
            status:   {type: string, example: running}
            auth:
              type: object
              properties:
                layer1:             {type: string}
                layer2:             {type: string}
                caller_allowlist:   {type: array, items: {type: string}}
                user_cert_required: {type: boolean}
    """
    return jsonify({
        "service": "Secure API — caller mTLS + OBO user cert",
        "version": "2.0.0",
        "auth": {
            "layer1": "mutual TLS — caller certificate required at TLS handshake",
            "layer2": "X-User-Cert header — base64-encoded DER of user's public cert",
            "caller_allowlist": (
                sorted(ALLOWED_CALLER_CNS) if ALLOWED_CALLER_CNS else "disabled"
            ),
            "user_cert_required": REQUIRE_USER_CERT,
        },
        "status": "running",
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def _load_ca_cert() -> x509.Certificate:
    ca_path = os.path.join(CERTS_DIR, "ca.crt")
    if not os.path.exists(ca_path):
        sys.exit(
            f"CA certificate not found: {ca_path}\n"
            "Run  python create_certs.py  first."
        )
    with open(ca_path, "rb") as fh:
        return load_pem_x509_certificate(fh.read())


def _build_ssl_context() -> ssl.SSLContext:
    for filename in ("server.crt", "server.key"):
        path = os.path.join(CERTS_DIR, filename)
        if not os.path.exists(path):
            sys.exit(
                f"Certificate file not found: {path}\n"
                "Run  python create_certs.py  first."
            )

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    # CERT_REQUIRED forces the TLS handshake to fail if the caller does not
    # present a certificate signed by our CA — no app code is reached.
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.load_cert_chain(
        certfile=os.path.join(CERTS_DIR, "server.crt"),
        keyfile=os.path.join(CERTS_DIR, "server.key"),
    )
    ctx.load_verify_locations(cafile=os.path.join(CERTS_DIR, "ca.crt"))
    return ctx


if __name__ == "__main__":
    _ca_cert = _load_ca_cert()
    ssl_ctx = _build_ssl_context()

    # --- Docs-only HTTP server (no TLS, no auth) ----------------------------
    # Serves Swagger UI on a separate port so browsers can view the docs
    # without needing a client certificate for the mTLS handshake.
    docs_app = Flask(__name__)
    Swagger(docs_app, template=_SWAGGER_TEMPLATE, config=_SWAGGER_CONFIG)

    @docs_app.route("/")
    def docs_redirect():
        from flask import redirect
        return redirect("/apidocs/")

    def _run_docs_server():
        run_simple(HOST, DOCS_PORT, docs_app, use_reloader=False)

    docs_thread = threading.Thread(target=_run_docs_server, daemon=True)
    docs_thread.start()

    print(f"Starting API  on  https://localhost:{PORT}")
    print(f"Swagger docs  on  http://localhost:{DOCS_PORT}/apidocs/")
    print("Auth model:")
    print("  Layer 1 — mTLS: caller must present caller.crt + caller.key")
    print("  Layer 2 — OBO:  X-User-Cert header (base64 DER of user's public cert)\n")

    run_simple(
        HOST,
        PORT,
        app,
        ssl_context=ssl_ctx,
        request_handler=MutualTLSRequestHandler,
        use_reloader=False,
    )
