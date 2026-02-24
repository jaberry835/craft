"""
Shared authentication utilities for the MCP server.
Contains credential classes used by multiple tool modules for OBO (On-Behalf-Of) flow.
"""

import os
import logging
import time
import base64
import json
from typing import Optional

import msal

logger = logging.getLogger(__name__)


class TokenResponse:
    """Standard token response object compatible with Azure SDK expectations."""
    def __init__(self, token: str, expires_on: int):
        self.token = token
        self.expires_on = expires_on


class SimpleTokenCredential:
    """Simple credential wrapper for pre-obtained access tokens.
    
    Use when the user's token is already scoped for the target resource
    (e.g., token audience already matches the downstream service).
    """

    def __init__(self, access_token: str):
        self.access_token = access_token
        logger.info("🔧 SimpleTokenCredential created")

        # Try to parse token expiration for better expires_on value
        self._actual_expires_on = None
        try:
            parts = access_token.split('.')
            if len(parts) >= 2:
                payload = parts[1]
                payload += '=' * (4 - len(payload) % 4)
                decoded = base64.b64decode(payload)
                token_data = json.loads(decoded)
                exp = token_data.get('exp')
                if exp:
                    self._actual_expires_on = exp
                    logger.info(f"🔍 SimpleTokenCredential: parsed token expiration: {exp}")
        except Exception as e:
            logger.debug(f"Could not parse token expiration: {e}")

    def get_token(self, *scopes, **kwargs) -> TokenResponse:
        """Return the pre-obtained token in the format expected by Azure SDK."""
        logger.info(f"🔄 SimpleTokenCredential.get_token called with scopes: {scopes}")

        expires_on = self._actual_expires_on if self._actual_expires_on else (int(time.time()) + 3600)
        logger.info(f"🔍 SimpleTokenCredential returning token with expires_on: {expires_on}")

        return TokenResponse(
            token=self.access_token,
            expires_on=expires_on
        )


class OnBehalfOfCredential:
    """Custom credential class for On-Behalf-Of flow using MSAL.

    Supports two authentication methods:
    1. Client secret (if AZURE_CLIENT_SECRET is set)
    2. Certificate (if AZURE_CLIENT_CERTIFICATE_PATH and AZURE_CLIENT_CERTIFICATE_THUMBPRINT are set)

    Certificate takes precedence if both are configured.
    """

    def __init__(self, tenant_id: str, client_id: str, user_assertion: str,
                 client_secret: str = None, certificate_path: str = None,
                 certificate_thumbprint: str = None):
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.certificate_path = certificate_path
        self.certificate_thumbprint = certificate_thumbprint
        self.user_assertion = user_assertion
        self._token_cache = {}

        if not client_secret and not certificate_path:
            raise ValueError("Either client_secret or certificate_path must be provided")

    def _get_certificate_credential(self):
        """Load certificate from PFX file and return MSAL credential dict."""
        try:
            from cryptography.hazmat.primitives.serialization import pkcs12
            from cryptography.hazmat.primitives import serialization

            with open(self.certificate_path, 'rb') as f:
                pfx_bytes = f.read()

            private_key, certificate, _ = pkcs12.load_key_and_certificates(pfx_bytes, None)

            if not private_key:
                raise Exception("PFX file does not contain a private key")

            private_key_pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            ).decode('utf-8')

            logger.info(f"Successfully loaded certificate from {self.certificate_path}")

            return {
                "private_key": private_key_pem,
                "thumbprint": self.certificate_thumbprint
            }

        except Exception as e:
            logger.error(f"Failed to load certificate from file: {e}")
            raise

    def get_token(self, *scopes, **kwargs) -> TokenResponse:
        """Get access token using On-Behalf-Of flow."""
        scope_key = "|".join(scopes)

        # Check cache first
        if scope_key in self._token_cache:
            cached_token = self._token_cache[scope_key]
            if hasattr(cached_token, 'expires_on') and cached_token.expires_on > time.time():
                return cached_token

        try:
            authority_base = os.getenv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.us")

            if self.certificate_path:
                client_credential = self._get_certificate_credential()
                logger.info(f"Using certificate authentication (thumbprint: {self.certificate_thumbprint[:8]}...)")
            else:
                client_credential = self.client_secret
                logger.info("Using client secret authentication")

            app = msal.ConfidentialClientApplication(
                self.client_id,
                authority=f"{authority_base}/{self.tenant_id}",
                client_credential=client_credential
            )

            target_scope = scopes[0] if scopes else os.getenv("OBO_SCOPE", "https://kusto.kusto.usgovcloudapi.net/.default")
            result = app.acquire_token_on_behalf_of(
                user_assertion=self.user_assertion,
                scopes=[target_scope]
            )

            if "access_token" in result:
                token_response = TokenResponse(
                    token=result['access_token'],
                    expires_on=result.get('expires_in', 3600) + int(time.time())
                )

                self._token_cache[scope_key] = token_response
                logger.info("Successfully acquired token via On-Behalf-Of flow")
                return token_response
            else:
                error_msg = result.get('error_description', result.get('error', 'Unknown error'))
                logger.error(f"Failed to acquire token via OBO: {error_msg}")
                raise Exception(f"Failed to acquire token via On-Behalf-Of flow: {error_msg}")

        except Exception as e:
            logger.error(f"Error in On-Behalf-Of token acquisition: {e}")
            raise


def get_obo_credential(user_token: str, target_scope: str) -> "SimpleTokenCredential | OnBehalfOfCredential":
    """Create an OBO credential for any downstream resource.

    High-level helper that:
    1. Decodes the user's JWT to check if it already targets the resource.
    2. If yes, wraps it in SimpleTokenCredential.
    3. If no, performs the OBO exchange via OnBehalfOfCredential.

    Args:
        user_token: The user's incoming bearer token (from the MCP request).
        target_scope: The downstream resource scope, e.g.
            'https://kusto.kusto.usgovcloudapi.net/.default' for ADX or
            'https://ossrdbms-aad.database.usgovcloudapi.net/.default' for PostgreSQL.

    Returns:
        A credential object with a .get_token() method.
    """
    logger.info(f"🔄 get_obo_credential called for scope: {target_scope}")
    logger.info(f"🔍 Token preview: {user_token[:10]}...")

    # Try to decode token to check audience
    try:
        parts = user_token.split('.')
        if len(parts) >= 2:
            payload = parts[1]
            payload += '=' * (4 - len(payload) % 4)
            decoded = base64.b64decode(payload)
            token_data = json.loads(decoded)
            audience = token_data.get('aud', '')
            logger.info(f"🔍 Token audience: {audience}")

            # Derive a keyword from the target scope for audience matching
            # e.g. 'kusto' from 'https://kusto.kusto.usgovcloudapi.net/.default'
            #      'ossrdbms' from 'https://ossrdbms-aad.database.usgovcloudapi.net/.default'
            scope_host = target_scope.split('//')[1].split('/')[0] if '//' in target_scope else ''
            scope_keyword = scope_host.split('.')[0].lower()  # e.g. 'kusto', 'ossrdbms-aad'

            if scope_keyword and scope_keyword in audience.lower():
                logger.info(f"✅ Token already targets {scope_keyword}, using directly")
                return SimpleTokenCredential(user_token)
            else:
                logger.info(f"🔄 Token audience ({audience}) doesn't match {scope_keyword}, using OBO flow")

            # Check token expiration
            exp = token_data.get('exp')
            if exp and exp < time.time():
                from datetime import datetime
                logger.error(f"❌ Token is expired at {datetime.fromtimestamp(exp)}")
                raise ValueError("User token is expired")
    except ValueError:
        raise
    except Exception as e:
        logger.warning(f"⚠️ Could not decode token, proceeding with OBO: {e}")

    # Read OBO env vars
    tenant_id = os.getenv("AZURE_TENANT_ID")
    client_id = os.getenv("AZURE_CLIENT_ID")
    client_secret = os.getenv("AZURE_CLIENT_SECRET")
    certificate_path = os.getenv("AZURE_CLIENT_CERTIFICATE_PATH")
    certificate_thumbprint = os.getenv("AZURE_CLIENT_CERTIFICATE_THUMBPRINT")

    logger.info(f"🔧 OBO config: tenant={'SET' if tenant_id else 'NOT_SET'}, "
                f"client={'SET' if client_id else 'NOT_SET'}, "
                f"secret={'SET' if client_secret else 'NOT_SET'}, "
                f"cert={'SET' if certificate_path else 'NOT_SET'}")

    if not all([tenant_id, client_id]):
        missing = [name for name, value in [
            ("AZURE_TENANT_ID", tenant_id),
            ("AZURE_CLIENT_ID", client_id)
        ] if not value]
        raise ValueError(f"Missing required environment variables for OBO flow: {', '.join(missing)}")

    if not client_secret and not certificate_path:
        raise ValueError("Missing credential: set either AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH")

    auth_method = "certificate" if certificate_path else "client secret"
    logger.info(f"🔧 Creating OnBehalfOfCredential using {auth_method}...")

    credential = OnBehalfOfCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        user_assertion=user_token,
        client_secret=client_secret,
        certificate_path=certificate_path,
        certificate_thumbprint=certificate_thumbprint
    )

    # Test the credential
    logger.info(f"🧪 Testing OBO credential for scope: {target_scope}")
    try:
        token_result = credential.get_token(target_scope)
        logger.info(f"✅ OBO token obtained successfully (preview: {token_result.token[:10]}...)")
    except Exception as token_error:
        logger.error(f"❌ Failed to get OBO token: {token_error}")
        error_str = str(token_error).lower()
        if "aadsts50013" in error_str:
            logger.error("🔍 AADSTS50013: Assertion is not valid - token may be wrong type")
        elif "aadsts500131" in error_str:
            logger.error("🔍 AADSTS500131: Invalid audience - check scope configuration")
        elif "aadsts65001" in error_str:
            logger.error("🔍 AADSTS65001: App not found - check AZURE_CLIENT_ID")
        elif "aadsts7000215" in error_str:
            logger.error("🔍 AADSTS7000215: Invalid client secret")
        raise

    return credential
