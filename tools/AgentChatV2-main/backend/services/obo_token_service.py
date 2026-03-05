"""
On-Behalf-Of (OBO) Token Exchange Service

Exchanges a user's access token for a new token scoped to a different app
registration within the same Entra ID tenant.  This enables cross-app A2A calls
where the calling app (App A) needs to invoke an external A2A agent protected
by a different app registration (App B).

The exchanged token preserves the user's identity (oid, name, roles) so the
remote agent can enforce per-user authorization and audit.

Credential priority:
  1. Client certificate (.pfx) — preferred; typical for development
  2. Client secret             — fallback; typical for production

Caching:
  Exchanged tokens are cached by (user_token_hash, target_client_id) with
  automatic expiry based on the token's `expires_in` value.
"""
import time
import hashlib
from typing import Optional

import msal

from config import get_settings
from observability import get_logger, should_log_a2a

settings = get_settings()
logger = get_logger(__name__)


class OboTokenService:
    """Handles OBO token exchange with per-target caching."""

    def __init__(self):
        # Cache: { (user_hash, target_client_id) -> (expires_at, access_token) }
        self._cache: dict[tuple[str, str], tuple[float, str]] = {}
        self._msal_app: Optional[msal.ConfidentialClientApplication] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def is_available(self) -> bool:
        """True when we have the credentials needed for OBO exchange."""
        return bool(
            settings.azure_tenant_id
            and settings.azure_client_id
            and (settings.azure_client_certificate_path or settings.azure_client_secret)
        )

    async def exchange_token(
        self,
        user_token: str,
        target_client_id: str,
        target_scope: Optional[str] = None,
    ) -> str:
        """
        Exchange a user token for one scoped to *target_client_id*.

        Args:
            user_token:       The user's current Bearer token (aud = our app).
            target_client_id: The client ID of the remote app registration.
            target_scope:     Explicit scope string.  Defaults to
                              ``api://{target_client_id}/.default``.

        Returns:
            A new access token whose ``aud`` matches the target app.

        Raises:
            RuntimeError: If OBO prerequisites are missing or the exchange fails.
        """
        if not self.is_available:
            raise RuntimeError(
                "OBO token exchange requires AZURE_TENANT_ID, AZURE_CLIENT_ID, "
                "and either AZURE_CLIENT_CERTIFICATE_PATH or AZURE_CLIENT_SECRET."
            )

        scope = target_scope or f"api://{target_client_id}/.default"

        # --- Cache lookup ---
        cache_key = self._cache_key(user_token, target_client_id)
        cached = self._cache.get(cache_key)
        if cached:
            expires_at, token = cached
            # Refresh 60 s before actual expiry to avoid edge-case 401s
            if time.time() < expires_at - 60:
                if should_log_a2a():
                    logger.debug(f"OBO cache hit for target {target_client_id}")
                return token

        # --- Perform OBO exchange ---
        app = self._get_msal_app()
        result = app.acquire_token_on_behalf_of(
            user_assertion=user_token,
            scopes=[scope],
        )

        if "access_token" not in result:
            error_desc = result.get("error_description", result.get("error", "unknown"))
            logger.error(f"OBO token exchange failed for target {target_client_id}: {error_desc}")
            raise RuntimeError(f"OBO token exchange failed: {error_desc}")

        new_token = result["access_token"]
        expires_in = result.get("expires_in", 3600)
        expires_at = time.time() + int(expires_in)

        # Store in cache
        self._cache[cache_key] = (expires_at, new_token)

        if should_log_a2a():
            logger.info(
                f"OBO exchanged token for target {target_client_id} "
                f"(expires_in={expires_in}s)"
            )

        return new_token

    def clear_cache(self) -> None:
        """Flush all cached OBO tokens."""
        self._cache.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_msal_app(self) -> msal.ConfidentialClientApplication:
        """Lazily create the MSAL ConfidentialClientApplication.

        Prefers client certificate over client secret when both are configured.
        """
        if self._msal_app is not None:
            return self._msal_app

        authority = f"{settings.azure_authority_host}/{settings.azure_tenant_id}"

        # Determine client credential — certificate takes precedence
        if settings.azure_client_certificate_path:
            credential = self._load_certificate_credential()
            logger.info("OBO: using client certificate credential")
        elif settings.azure_client_secret:
            credential = settings.azure_client_secret
            logger.info("OBO: using client secret credential")
        else:
            raise RuntimeError("No client secret or certificate configured for OBO")

        self._msal_app = msal.ConfidentialClientApplication(
            client_id=settings.azure_client_id,
            client_credential=credential,
            authority=authority,
        )
        return self._msal_app

    def _load_certificate_credential(self) -> dict:
        """Load a .pfx certificate file and return the MSAL credential dict.

        MSAL for Python accepts a dict with ``private_key`` (PEM string),
        ``thumbprint`` (hex SHA-1 of the DER cert), and optionally
        ``public_certificate`` (PEM string for SNI).
        """
        import os
        from cryptography.hazmat.primitives.serialization import pkcs12, Encoding, PrivateFormat, NoEncryption
        from cryptography.hazmat.primitives import hashes

        pfx_path = settings.azure_client_certificate_path
        pfx_password = settings.azure_client_certificate_password.encode() if settings.azure_client_certificate_password else None

        if not os.path.exists(pfx_path):
            raise FileNotFoundError(f"Certificate file not found: {pfx_path}")

        with open(pfx_path, "rb") as f:
            pfx_data = f.read()

        private_key, certificate, _additional = pkcs12.load_key_and_certificates(
            pfx_data, pfx_password
        )

        if private_key is None or certificate is None:
            raise ValueError(f"Could not extract key/cert from {pfx_path}")

        # PEM-encode the private key
        private_key_pem = private_key.private_bytes(
            Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
        ).decode("utf-8")

        # PEM-encode the public certificate (for SNI — Subject Name / Issuer auth)
        public_cert_pem = certificate.public_bytes(Encoding.PEM).decode("utf-8")

        # SHA-1 thumbprint of the DER-encoded certificate
        thumbprint = certificate.fingerprint(hashes.SHA1()).hex()

        return {
            "private_key": private_key_pem,
            "thumbprint": thumbprint,
            "public_certificate": public_cert_pem,
        }

    @staticmethod
    def _cache_key(user_token: str, target_client_id: str) -> tuple[str, str]:
        """Produce a cache key from the user token and target app."""
        token_hash = hashlib.sha256(user_token.encode()).hexdigest()[:16]
        return (token_hash, target_client_id)


# Global singleton
obo_token_service = OboTokenService()
