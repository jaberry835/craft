from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import routes.admin_routes as admin_routes


@pytest.mark.parametrize(
    "allow_bypass,roles,should_raise",
    [
        (False, ["User"], True),
        (False, ["Admin"], False),
        (True, ["User"], False),
    ],
)
def test_require_admin_respects_explicit_dev_bypass(monkeypatch, allow_bypass, roles, should_raise):
    monkeypatch.setattr(admin_routes.settings, "environment", "development", raising=False)
    monkeypatch.setattr(admin_routes.settings, "allow_dev_auth_bypass", allow_bypass, raising=False)

    request = SimpleNamespace(
        state=SimpleNamespace(
            user=SimpleNamespace(email="user@example.com", roles=roles, user_id="u1")
        )
    )

    if should_raise:
        with pytest.raises(HTTPException):
            admin_routes.require_admin(request)
    else:
        user = admin_routes.require_admin(request)
        assert user.email == "user@example.com"
