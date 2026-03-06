from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.middleware import AuthMiddleware
from auth.token_validator import UserInfo
from routes.health_routes import router as health_router


def _build_test_app():
    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(health_router)
    return app


def _auth_headers():
    return {"Authorization": "Bearer test-token"}


def test_smoke_liveness_endpoint_with_auth_middleware(monkeypatch):
    """Smoke: app serves liveness endpoint through middleware stack."""
    from auth import middleware as auth_middleware

    monkeypatch.setattr(
        auth_middleware,
        "get_user_from_token",
        lambda _token: UserInfo(
            user_id="u1",
            email="u1@example.com",
            name="U1",
            roles=["User"],
            token="test-token",
        ),
    )

    app = _build_test_app()
    with TestClient(app) as client:
        response = client.get("/api/health/live", headers=_auth_headers())

    assert response.status_code == 200
    payload = response.json()
    assert payload["alive"] is True
    assert "timestamp" in payload


def test_smoke_readiness_reports_not_ready_when_cosmos_not_initialized(monkeypatch):
    """Smoke: readiness endpoint returns false when Cosmos client is missing."""
    from auth import middleware as auth_middleware
    import routes.health_routes as health_routes

    monkeypatch.setattr(
        auth_middleware,
        "get_user_from_token",
        lambda _token: UserInfo(
            user_id="u1",
            email="u1@example.com",
            name="U1",
            roles=["User"],
            token="test-token",
        ),
    )

    # Simulate uninitialized Cosmos client.
    monkeypatch.setattr(health_routes.cosmos_service, "client", None, raising=False)

    app = _build_test_app()
    with TestClient(app) as client:
        response = client.get("/api/health/ready", headers=_auth_headers())

    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is False
