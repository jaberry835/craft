"""
GetHash Function
HTTP-triggered function that authenticates and returns user ss_tokens
"""
import azure.functions as func
import json
import logging
import os

from data.user_access_repository import UserAccessRepository
from security.token_reader import TokenReader

bp = func.Blueprint()

# Initialize singletons
_token_reader = None
_repository = None


def _get_token_reader():
    """Get or create TokenReader singleton"""
    global _token_reader
    if _token_reader is None:
        _token_reader = TokenReader(
            tenant_id=os.environ.get('AZURE_TENANT_ID', ''),
            authority_host=os.environ.get('AZURE_AUTHORITY_HOST', 'https://login.microsoftonline.us'),
            audience=os.environ.get('API_AUDIENCE', '')
        )
    return _token_reader


def _get_repository():
    """Get or create UserAccessRepository singleton"""
    global _repository
    if _repository is None:
        _repository = UserAccessRepository(
            endpoint=os.environ.get('AZURE_COSMOS_DB_ENDPOINT', ''),
            database_name=os.environ.get('AZURE_COSMOS_DB_DATABASE', ''),
            container_name=os.environ.get('AZURE_COSMOS_DB_CONTAINER', '')
        )
    return _repository


@bp.route(route="get-hash", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
async def get_hash(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP GET endpoint that authenticates the caller and returns their ss_tokens

    Returns:
        200 OK: JSON array of ss_tokens
        401 Unauthorized: missing/invalid token or identity
        404 Not Found: no record for the login
    """
    logger = logging.getLogger(__name__)

    try:
        # Collect headers (case-insensitive)
        headers = {k.lower(): v for k, v in req.headers.items()}

        # Authenticate and get login
        token_reader = _get_token_reader()
        is_authenticated, login, error = await token_reader.get_login_async(headers)

        if not is_authenticated or not login:
            logger.warning(f"Authentication failed: {error}")
            return func.HttpResponse(
                error or "Unauthorized",
                status_code=401
            )

        logger.info(f"Authenticated user: {login}")

        # Query Cosmos DB for ss_tokens
        repository = _get_repository()
        ss_tokens = await repository.get_ss_tokens_by_login_async(login)

        if ss_tokens is None:
            logger.warning(f"No ss_tokens found for login: {login}")
            return func.HttpResponse(
                "Not found",
                status_code=404
            )

        logger.info(f"ss_tokens retrieved for {login}")

        # Return ss_tokens as JSON array
        return func.HttpResponse(
            json.dumps(ss_tokens),
            status_code=200,
            mimetype="application/json",
            charset="utf-8"
        )

    except Exception as e:
        logger.error(f"Error processing request: {str(e)}", exc_info=True)
        return func.HttpResponse(
            f"Internal server error: {str(e)}",
            status_code=500
        )
