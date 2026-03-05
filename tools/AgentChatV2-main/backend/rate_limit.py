"""
Rate Limiting
Per-user rate limits using slowapi.  Falls back to client IP for
unauthenticated requests.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from config import get_settings

settings = get_settings()


def _rate_limit_key(request: Request) -> str:
    """
    Extract a rate-limit key from the request.
    Prefer the authenticated user_id (set by AuthMiddleware) so every user
    gets their own bucket regardless of shared IPs or proxies.
    Fall back to the client IP for public / unauthenticated endpoints.
    """
    user = getattr(request.state, "user", None)
    if user and hasattr(user, "user_id"):
        return user.user_id
    return get_remote_address(request)


# Global limiter instance
# default_limits applies to every endpoint that does NOT have its own @limiter.limit()
limiter = Limiter(
    key_func=_rate_limit_key,
    default_limits=[settings.rate_limit_default],
    storage_uri="memory://",
    strategy="fixed-window",
)
