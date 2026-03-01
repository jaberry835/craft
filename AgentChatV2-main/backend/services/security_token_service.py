"""
Security Token Service
Calls the SS Token / Access Checker API to retrieve the set of security tokens
(hashes) a user is authorized to access.  These tokens are used as AI Search
security filters so only authorized document chunks are returned.

Architecture:
- Documents in Azure Blob Storage carry an `ss_token` metadata value.
- At indexing time the token is stored on every chunk in the AI Search index.
- At query time this service fetches the user's allowed tokens and builds an
  OData `search.in` filter so unauthorized chunks never leave the index.

Caching:
- Results are cached per-user for the lifetime of the process (in-memory dict
  with a configurable TTL, default 5 minutes).  This avoids hitting the access
  checker API on every search query while still picking up permission changes
  within a reasonable window.
"""
from typing import Optional
import time

import httpx

from config import get_settings
from observability import get_logger

settings = get_settings()
logger = get_logger(__name__)

# Cache TTL in seconds – how long we reuse a user's SS token set before
# re-querying the access checker.
_CACHE_TTL_SECONDS = 300  # 5 minutes


class SecurityTokenService:
    """Manages retrieval and caching of per-user SS tokens."""

    def __init__(self):
        # Cache: { user_token_hash -> (timestamp, [tokens]) }
        self._cache: dict[str, tuple[float, list[str]]] = {}

    @property
    def is_available(self) -> bool:
        """True when the access checker endpoint is configured."""
        return bool(settings.access_checker_endpoint)

    async def get_user_ss_tokens(self, user_token: str) -> Optional[list[str]]:
        """
        Return the list of SS tokens the user is authorised for.

        Args:
            user_token: The user's bearer token (forwarded to the access checker).

        Returns:
            List of SS token strings, or None if the service is unavailable or
            the call fails.
        """
        if not self.is_available:
            logger.debug("Access checker endpoint not configured – security filtering disabled")
            return None

        if not user_token:
            logger.warning("No user token provided – cannot fetch SS tokens")
            return None

        # --- Cache lookup ---
        cache_key = self._token_hash(user_token)
        cached = self._cache.get(cache_key)
        if cached:
            ts, tokens = cached
            if time.time() - ts < _CACHE_TTL_SECONDS:
                logger.debug(f"SS token cache hit – {len(tokens)} tokens")
                return tokens
            else:
                del self._cache[cache_key]

        # --- Call the access checker API ---
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    settings.access_checker_endpoint,
                    headers={"Authorization": f"Bearer {user_token}"},
                )
                response.raise_for_status()

            tokens: list[str] = response.json()

            if not isinstance(tokens, list):
                logger.error(f"Access checker returned unexpected type: {type(tokens)}")
                return None

            # Store in cache
            self._cache[cache_key] = (time.time(), tokens)
            logger.info(f"Fetched {len(tokens)} SS tokens from access checker")
            return tokens

        except httpx.HTTPStatusError as e:
            logger.error(f"Access checker HTTP error {e.response.status_code}: {e}")
            return None
        except Exception as e:
            logger.error(f"Failed to call access checker: {e}")
            return None

    def build_security_filter(self, ss_tokens: list[str]) -> Optional[str]:
        """
        Build an OData filter expression for AI Search.

        Returns a filter like:
            search.in(ssToken, 'hash1|hash2|hash3', '|')

        Returns None if the token list is empty (which means the user has no
        access and we should return zero results).
        """
        if not ss_tokens:
            return None

        # Use pipe delimiter to avoid issues with commas inside tokens.
        joined = "|".join(ss_tokens)
        return f"search.in(ssToken, '{joined}', '|')"

    def clear_cache(self, user_token: Optional[str] = None) -> None:
        """Clear cached tokens.  If user_token is given only that entry is
        removed; otherwise the entire cache is flushed."""
        if user_token:
            key = self._token_hash(user_token)
            self._cache.pop(key, None)
        else:
            self._cache.clear()

    @staticmethod
    def _token_hash(token: str) -> str:
        """Cheap hash of the bearer token for use as a dict key.
        We only need uniqueness, not cryptographic strength."""
        import hashlib
        return hashlib.sha256(token.encode()).hexdigest()[:16]


# Global singleton
security_token_service = SecurityTokenService()
