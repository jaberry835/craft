"""
Entra ID Token Validation
Validates JWT tokens from Microsoft Entra ID (Azure Government).
"""
import jwt
from jwt import PyJWKClient
from typing import Optional
from dataclasses import dataclass
from functools import lru_cache

from config import get_settings
from observability import get_logger, should_log_auth

settings = get_settings()
logger = get_logger(__name__)


@dataclass
class UserInfo:
    """Authenticated user information."""
    user_id: str
    email: str
    name: str
    roles: list[str]
    token: str  # Original token for pass-through


@lru_cache()
def get_jwks_client() -> PyJWKClient:
    """Get cached JWKS client for token validation."""
    jwks_uri = (
        f"{settings.azure_authority_host}/{settings.azure_tenant_id}"
        "/discovery/v2.0/keys"
    )
    return PyJWKClient(jwks_uri)


def validate_token(token: str) -> Optional[dict]:
    """
    Validate an Entra ID JWT token.
    Returns decoded claims if valid, None otherwise.
    """
    try:
        jwks_client = get_jwks_client()
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        
        # Support both Azure Government and Commercial issuer formats
        # v1.0 tokens: https://sts.windows.net/{tenant}/
        # v2.0 tokens: https://login.microsoftonline.com/{tenant}/v2.0 (Commercial)
        # v2.0 tokens: https://login.microsoftonline.us/{tenant}/v2.0 (Government)
        # The authority host is configurable via AZURE_AUTHORITY_HOST env var
        valid_issuers = [
            f"{settings.azure_authority_host}/{settings.azure_tenant_id}/v2.0",
            f"https://sts.windows.net/{settings.azure_tenant_id}/",
            # Include both Commercial and Government issuers for flexibility
            f"https://login.microsoftonline.com/{settings.azure_tenant_id}/v2.0",
            f"https://login.microsoftonline.us/{settings.azure_tenant_id}/v2.0",
        ]
        
        # Audience can be with or without api:// prefix
        valid_audiences = [
            settings.azure_client_id,
            f"api://{settings.azure_client_id}",
        ]
        
        # First decode without issuer validation to see what we got
        unverified = jwt.decode(token, options={"verify_signature": False})
        actual_issuer = unverified.get("iss", "")
        if should_log_auth():
            logger.info(f"Token issuer: {actual_issuer}")
            logger.info(f"Token audience: {unverified.get('aud', '')}")
        
        decoded = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=valid_audiences,  # Accept multiple audiences
            issuer=valid_issuers  # Accept multiple issuers
        )
        return decoded
    except jwt.ExpiredSignatureError:
        logger.warning("Token expired")
        return None
    except jwt.InvalidTokenError as e:
        logger.warning(f"Invalid token: {e}")
        return None
    except Exception as e:
        logger.error(f"Token validation error: {e}")
        return None


def get_user_from_token(token: str) -> Optional[UserInfo]:
    """Extract user information from validated token."""
    claims = validate_token(token)
    if not claims:
        return None
    
    return UserInfo(
        user_id=claims.get("oid", claims.get("sub", "")),
        email=claims.get("preferred_username", claims.get("email", "")),
        name=claims.get("name", ""),
        roles=claims.get("roles", []),
        token=token
    )
