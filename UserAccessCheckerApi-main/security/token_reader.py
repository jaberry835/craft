"""
TokenReader
Handles authentication via Easy Auth header or JWT Bearer token validation.
(Ported from the Azure Function version — no Azure Functions dependency.)
"""
import base64
import json
import logging
from typing import Dict, Optional, Tuple

import jwt
import requests
from jwt import PyJWKClient


class TokenReader:
    """Handles authentication and extraction of user login from headers."""

    def __init__(self, tenant_id: str, authority_host: str, audience: str):
        if not tenant_id:
            raise ValueError("AZURE_TENANT_ID is required")
        if not audience:
            raise ValueError("API_AUDIENCE is required")

        self.logger = logging.getLogger(__name__)
        self.tenant_id = tenant_id
        self.authority_host = authority_host.rstrip("/")
        self.audience = audience

        self.authority = f"{self.authority_host}/{self.tenant_id}/v2.0"
        self.metadata_url = f"{self.authority}/.well-known/openid-configuration"

        self.valid_issuers = [
            f"{self.authority_host}/{self.tenant_id}/v2.0",
            f"{self.authority_host}/{self.tenant_id}/",
            f"https://sts.windows.net/{self.tenant_id}/",
        ]

        self.logger.info("TokenReader initialized for tenant %s", tenant_id)

    # ------------------------------------------------------------------
    async def get_login_async(
        self, headers: Dict[str, str]
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """Return (is_authenticated, login, error_message)."""

        # 1. Try Easy Auth header first
        easy_auth_header = headers.get("x-ms-client-principal")
        if easy_auth_header:
            try:
                result = self._parse_easy_auth_header(easy_auth_header)
                if result[0]:
                    return result
            except Exception as exc:
                self.logger.warning("Failed to parse Easy Auth header: %s", exc)

        # 2. Fall back to JWT Bearer token
        auth_header = headers.get("authorization")
        if not auth_header:
            return (False, None, "Missing Authorization header")

        parts = auth_header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return (False, None, "Invalid Authorization header")

        token = parts[1]
        if not token:
            return (False, None, "Invalid Authorization header")

        return await self._validate_jwt_async(token)

    # ------------------------------------------------------------------
    def _parse_easy_auth_header(
        self, header_value: str
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        try:
            decoded = base64.b64decode(header_value).decode("utf-8")
            principal = json.loads(decoded)
            claims = principal.get("claims", [])

            for claim in claims:
                claim_type = claim.get("typ", "")
                if claim_type in ("upn", "preferred_username", "name"):
                    login = claim.get("val")
                    if login:
                        self.logger.info("Authenticated via Easy Auth: %s", login)
                        return (True, login, None)

            return (False, None, "No login claim found in Easy Auth header")
        except Exception as exc:
            self.logger.error("Error parsing Easy Auth header: %s", exc)
            raise

    # ------------------------------------------------------------------
    async def _validate_jwt_async(
        self, token: str
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        try:
            response = requests.get(self.metadata_url, timeout=10)
            response.raise_for_status()
            oidc_config = response.json()

            jwks_uri = oidc_config.get("jwks_uri")
            if not jwks_uri:
                return (False, None, "JWKS URI not found in metadata")

            jwks_client = PyJWKClient(jwks_uri)
            signing_key = jwks_client.get_signing_key_from_jwt(token)

            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                options={
                    "verify_aud": False,
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_iss": False,
                },
            )

            token_issuer = payload.get("iss", "").rstrip("/")
            if not any(
                token_issuer == iss.rstrip("/") for iss in self.valid_issuers
            ):
                return (False, None, f"Invalid issuer: {token_issuer}")

            login = (
                payload.get("upn")
                or payload.get("preferred_username")
                or payload.get("name")
                or payload.get("oid")
            )
            if not login:
                return (False, None, "No login claim found in token")

            self.logger.info("Authenticated via JWT: %s", login)
            return (True, login, None)

        except jwt.ExpiredSignatureError:
            return (False, None, "Token has expired")
        except jwt.InvalidTokenError as exc:
            return (False, None, f"Token validation failed: {exc}")
        except Exception as exc:
            self.logger.error("Error validating JWT: %s", exc, exc_info=True)
            return (False, None, f"Token validation failed: {exc}")
