"""
Authentication Middleware
Extracts and validates Entra ID tokens, sets request context.
"""
import uuid
import time
import re
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from observability import request_id_ctx, user_id_ctx, get_logger, should_log_performance, should_log_auth, log_performance_summary
from .token_validator import get_user_from_token, UserInfo

logger = get_logger(__name__)

# Paths that don't require authentication
PUBLIC_PATHS = {"/", "/health", "/docs", "/openapi.json", "/redoc", "/a2a/agents"}

# Patterns for paths that don't require authentication (use regex)
# - Document content: accessed via direct browser link - document ID serves as capability token
# - A2A agent cards: GET requests for agent discovery (POST requests still require auth)
PUBLIC_PATH_PATTERNS = [
    re.compile(r"^/api/documents/[a-f0-9-]+/content$"),  # Document content viewing
    re.compile(r"^/a2a/[a-f0-9-]+$"),  # A2A agent card discovery (GET only - checked in _is_public_path)
]


def _is_public_path(path: str, method: str = "GET") -> bool:
    """Check if the path is public (no auth required)."""
    if path in PUBLIC_PATHS:
        return True
    if path.startswith("/health"):
        return True
    # Check regex patterns
    for pattern in PUBLIC_PATH_PATTERNS:
        if pattern.match(path):
            # A2A endpoints: GET is public (discovery), POST requires auth (execution)
            if path.startswith("/a2a/") and method != "GET":
                return False
            return True
    return False


def _cors_error_response(status_code: int, content: dict, request: Request) -> JSONResponse:
    """Create a JSONResponse with CORS headers for error responses."""
    response = JSONResponse(status_code=status_code, content=content)
    # Add CORS headers so the browser can read the error
    origin = request.headers.get("origin", "*")
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


class AuthMiddleware(BaseHTTPMiddleware):
    """Middleware for authentication and request context."""
    
    async def dispatch(self, request: Request, call_next):
        # Generate request ID for tracing
        request_id = str(uuid.uuid4())
        request_id_ctx.set(request_id)
        
        request_start = time.perf_counter()
        
        # Allow CORS preflight requests through without auth
        if request.method == "OPTIONS":
            response = await call_next(request)
            return response
        
        # Check if path requires auth (pass method for A2A: GET is public, POST requires auth)
        path = request.url.path
        if _is_public_path(path, request.method):
            response = await call_next(request)
            self._log_request_performance(request, response, request_start)
            return response
        
        # Extract authorization header
        auth_header = request.headers.get("Authorization", "")
        if should_log_auth():
            logger.info(f"Auth middleware: header present={bool(auth_header)}, length={len(auth_header)}, path={request.url.path}")
        
        if not auth_header.startswith("Bearer "):
            # For development, create a mock user
            from config import get_settings
            settings = get_settings()
            if settings.environment == "development":
                dev_user = UserInfo(
                    user_id="dev-user-id",
                    email="dev@localhost",
                    name="Development User",
                    roles=["Admin"],  # Give admin access in dev
                    token=""
                )
                user_id_ctx.set(dev_user.user_id)
                request.state.user = dev_user
                request.state.token = None
                try:
                    response = await call_next(request)
                    self._log_request_performance(request, response, request_start)
                    return response
                except Exception as e:
                    logger.error(f"Dev mode request failed for {request.url.path}: {e}", exc_info=True)
                    return _cors_error_response(
                        status_code=500,
                        content={"error": f"Internal server error: {str(e)}"},
                        request=request
                    )
            else:
                return _cors_error_response(
                    status_code=401,
                    content={"error": "Authorization header required"},
                    request=request
                )
        
        token = auth_header[7:]  # Remove "Bearer " prefix
        
        # Validate token and extract user info
        token_start = time.perf_counter()
        user = get_user_from_token(token)
        token_validation_ms = (time.perf_counter() - token_start) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "auth_token_validation", {
                "duration_ms": round(token_validation_ms, 2),
                "valid": user is not None
            })
        
        if not user:
            return _cors_error_response(
                status_code=401,
                content={"error": "Invalid or expired token"},
                request=request
            )
        
        # Set context for logging and downstream use
        user_id_ctx.set(user.user_id)
        request.state.user = user
        request.state.token = token  # Store for MCP pass-through
        
        logger.debug(f"Authenticated user: {user.email}")
        
        response = await call_next(request)
        self._log_request_performance(request, response, request_start)
        return response
    
    def _log_request_performance(self, request: Request, response, request_start: float) -> None:
        """Log overall request performance."""
        if should_log_performance():
            duration_ms = (time.perf_counter() - request_start) * 1000
            log_performance_summary(logger, "http_request", {
                "duration_ms": round(duration_ms, 2),
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code
            })


def get_current_user(request: Request) -> UserInfo | None:
    """Get the current authenticated user from request state."""
    return getattr(request.state, "user", None)


def get_user_token(request: Request) -> str | None:
    """Get the user's bearer token for pass-through to MCP."""
    return getattr(request.state, "token", None)


def require_admin(request: Request) -> bool:
    """Check if user has admin role."""
    user = get_current_user(request)
    if not user:
        return False
    return "Admin" in user.roles or "admin" in user.roles
