"""
TokenReader
Handles authentication via Easy Auth header or JWT Bearer token validation
"""
import base64
import json
import logging
from typing import Dict, Tuple, Optional
import jwt
import requests
from jwt import PyJWKClient


class TokenReader:
    """Handles authentication and extraction of user login from headers"""
    
    def __init__(self, tenant_id: str, authority_host: str, audience: str):
        """
        Initialize the token reader
        
        Args:
            tenant_id: Azure AD tenant ID
            authority_host: Authority host URL (e.g., https://login.microsoftonline.us)
            audience: Expected audience for JWT validation
        """
        if not tenant_id:
            raise ValueError("AZURE_TENANT_ID is required")
        if not audience:
            raise ValueError("API_AUDIENCE is required")
        
        self.logger = logging.getLogger(__name__)
        self.tenant_id = tenant_id
        self.authority_host = authority_host.rstrip('/')
        self.audience = audience
        
        # Construct metadata endpoint
        self.authority = f"{self.authority_host}/{self.tenant_id}/v2.0"
        self.metadata_url = f"{self.authority}/.well-known/openid-configuration"
        
        # Valid issuers (v1 and v2 formats)
        self.valid_issuers = [
            f"{self.authority_host}/{self.tenant_id}/v2.0",  # v2
            f"{self.authority_host}/{self.tenant_id}/",      # v1
            f"https://sts.windows.net/{self.tenant_id}/"     # STS v1
        ]
        
        self.logger.info(f"TokenReader initialized for tenant {tenant_id}")
    
    async def get_login_async(self, headers: Dict[str, str]) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Extract and validate user login from request headers
        
        Args:
            headers: Request headers dictionary (case-insensitive)
            
        Returns:
            Tuple of (is_authenticated, login, error_message)
        """
        # Try Easy Auth header first
        easy_auth_header = headers.get('x-ms-client-principal')
        if easy_auth_header:
            try:
                result = self._parse_easy_auth_header(easy_auth_header)
                if result[0]:
                    return result
            except Exception as e:
                self.logger.warning(f"Failed to parse Easy Auth header: {str(e)}")
                # Fall through to JWT validation
        
        # Fall back to JWT Bearer token validation
        auth_header = headers.get('authorization')
        if not auth_header:
            return (False, None, "Missing Authorization header")
        
        # Parse Bearer token
        parts = auth_header.split(' ', 1)
        if len(parts) != 2 or parts[0].lower() != 'bearer':
            return (False, None, "Invalid Authorization header")
        
        token = parts[1]
        if not token:
            return (False, None, "Invalid Authorization header")
        
        # Validate JWT
        return await self._validate_jwt_async(token)
    
    def _parse_easy_auth_header(self, header_value: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Parse X-MS-CLIENT-PRINCIPAL Easy Auth header
        
        Args:
            header_value: Base64-encoded JSON principal
            
        Returns:
            Tuple of (is_authenticated, login, error_message)
        """
        try:
            # Decode base64
            decoded = base64.b64decode(header_value).decode('utf-8')
            principal = json.loads(decoded)
            
            # Extract claims
            claims = principal.get('claims', [])
            
            # Look for login claim (upn, preferred_username, name)
            for claim in claims:
                claim_type = claim.get('typ', '')
                if claim_type in ['upn', 'preferred_username', 'name']:
                    login = claim.get('val')
                    if login:
                        self.logger.info(f"Authenticated via Easy Auth: {login}")
                        return (True, login, None)
            
            return (False, None, "No login claim found in Easy Auth header")
            
        except Exception as e:
            self.logger.error(f"Error parsing Easy Auth header: {str(e)}")
            raise
    
    async def _validate_jwt_async(self, token: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Validate JWT Bearer token
        
        Args:
            token: JWT token string
            
        Returns:
            Tuple of (is_authenticated, login, error_message)
        """
        try:
            # Get OpenID configuration
            response = requests.get(self.metadata_url)
            response.raise_for_status()
            oidc_config = response.json()
            
            jwks_uri = oidc_config.get('jwks_uri')
            if not jwks_uri:
                return (False, None, "JWKS URI not found in metadata")
            
            # Get signing keys
            jwks_client = PyJWKClient(jwks_uri)
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            
            # Decode and validate token
            # Note: validating issuer but NOT audience (identity-only validation)
            # This allows tokens for ARM/ADX/custom APIs to be accepted
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                issuer=None,  # We'll validate manually
                options={
                    "verify_aud": False,  # Skip audience validation (identity-only)
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_iss": False  # We'll validate manually
                }
            )
            
            # Manually validate issuer against accepted list
            token_issuer = payload.get('iss', '').rstrip('/')
            if not any(token_issuer == issuer.rstrip('/') for issuer in self.valid_issuers):
                return (False, None, f"Invalid issuer: {token_issuer}")
            
            # Extract login claim
            login = (
                payload.get('upn') or
                payload.get('preferred_username') or
                payload.get('name') or
                payload.get('oid')
            )
            
            if not login:
                return (False, None, "No login claim found in token")
            
            self.logger.info(f"Authenticated via JWT: {login}")
            return (True, login, None)
            
        except jwt.ExpiredSignatureError:
            return (False, None, "Token has expired")
        except jwt.InvalidTokenError as e:
            return (False, None, f"Token validation failed: {str(e)}")
        except Exception as e:
            self.logger.error(f"Error validating JWT: {str(e)}", exc_info=True)
            return (False, None, f"Token validation failed: {str(e)}")
