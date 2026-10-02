import hashlib
import hmac

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from officeautomation.config import Settings


class AuthenticationMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in {"/", "/healthz", "/api/v1/docs", "/api/v1/openapi.json"}:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        owner_id = self._authenticate(headers)
        if owner_id is None:
            response = JSONResponse(
                status_code=401,
                content={
                    "error": {
                        "code": "UNAUTHORIZED",
                        "message": "Invalid credentials",
                        "details": {},
                    }
                },
            )
            await response(scope, receive, send)
            return

        scope.setdefault("state", {})["owner_id"] = owner_id
        await self.app(scope, receive, send)

    def _authenticate(self, headers: Headers) -> str | None:
        if self.settings.auth_mode == "disabled":
            return headers.get("x-owner-id", "local-user")

        if self.settings.auth_mode == "api_key":
            provided = headers.get("x-api-key", "")
            expected = self.settings.api_key.get_secret_value() if self.settings.api_key else ""
            if expected and hmac.compare_digest(provided, expected):
                digest = hashlib.sha256(expected.encode()).hexdigest()[:16]
                return f"api-key:{digest}"
            return None

        return None
