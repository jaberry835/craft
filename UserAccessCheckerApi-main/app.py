"""
UserAccessChecker API — Flask app for Azure App Service
Replaces the get-hash Azure Function with a standard HTTP endpoint.
"""
import json
import logging
import os

from flask import Flask, jsonify, request

from security.token_reader import TokenReader
from data.user_access_repository import UserAccessRepository

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Configuration (from environment variables / App Service Application Settings)
# ---------------------------------------------------------------------------
TENANT_ID = os.environ.get("AZURE_TENANT_ID", "")
AUTHORITY_HOST = os.environ.get("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.us")
API_AUDIENCE = os.environ.get("API_AUDIENCE", "")

COSMOS_ENDPOINT = os.environ.get("AZURE_COSMOS_DB_ENDPOINT", "")
COSMOS_DATABASE = os.environ.get("AZURE_COSMOS_DB_DATABASE", "")
COSMOS_CONTAINER = os.environ.get("AZURE_COSMOS_DB_CONTAINER", "")

# ---------------------------------------------------------------------------
# Singletons (created on first request)
# ---------------------------------------------------------------------------
_token_reader: TokenReader | None = None
_repository: UserAccessRepository | None = None


def _get_token_reader() -> TokenReader:
    global _token_reader
    if _token_reader is None:
        _token_reader = TokenReader(
            tenant_id=TENANT_ID,
            authority_host=AUTHORITY_HOST,
            audience=API_AUDIENCE,
        )
    return _token_reader


def _get_repository() -> UserAccessRepository:
    global _repository
    if _repository is None:
        _repository = UserAccessRepository(
            endpoint=COSMOS_ENDPOINT,
            database_name=COSMOS_DATABASE,
            container_name=COSMOS_CONTAINER,
        )
    return _repository


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/get-hash", methods=["GET"])
async def get_hash():
    """
    Authenticate the caller and return their ss_tokens from Cosmos DB.

    Returns:
        200 — JSON array of ss_tokens
        401 — missing / invalid token or identity
        404 — no record for the login
        500 — unexpected error
    """
    logger = logging.getLogger(__name__)

    try:
        # Normalise headers to lowercase keys
        headers = {k.lower(): v for k, v in request.headers}

        # Authenticate
        token_reader = _get_token_reader()
        is_authenticated, login, error = await token_reader.get_login_async(headers)

        if not is_authenticated or not login:
            logger.warning("Authentication failed: %s", error)
            return error or "Unauthorized", 401

        logger.info("Authenticated user: %s", login)

        # Query Cosmos DB
        repository = _get_repository()
        ss_tokens = await repository.get_ss_tokens_by_login_async(login)

        if ss_tokens is None:
            logger.warning("No ss_tokens found for login: %s", login)
            return "Not found", 404

        logger.info("ss_tokens retrieved for %s", login)
        return jsonify(ss_tokens)

    except Exception as exc:
        logger.error("Error processing request: %s", exc, exc_info=True)
        return f"Internal server error: {exc}", 500


@app.route("/health", methods=["GET"])
def health():
    """Simple health-check endpoint for App Service probes."""
    return jsonify({"status": "healthy"})


# ---------------------------------------------------------------------------
# Entrypoint (local dev)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    app.run(host="0.0.0.0", port=8001, debug=True)
