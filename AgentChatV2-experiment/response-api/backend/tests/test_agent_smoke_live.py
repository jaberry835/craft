import os

import httpx
import pytest


pytestmark = pytest.mark.live


def _base_url() -> str:
    return os.getenv("LIVE_BACKEND_URL", "http://127.0.0.1:5000").rstrip("/")


def _headers() -> dict:
    token = os.getenv("LIVE_BEARER_TOKEN", "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


def _enabled() -> bool:
    return os.getenv("LIVE_SMOKE_ENABLED", "0").strip() == "1"


@pytest.mark.skipif(not _enabled(), reason="Set LIVE_SMOKE_ENABLED=1 to run live smoke tests")
def test_live_health_endpoint_available():
    url = f"{_base_url()}/api/health"
    response = httpx.get(url, headers=_headers(), timeout=30.0)

    assert response.status_code == 200, (
        f"Live health check failed: GET {url} returned {response.status_code}. "
        f"Response body: {response.text}"
    )
    payload = response.json()
    assert "status" in payload, (
        f"Live health payload missing 'status'. Payload keys: {list(payload.keys())}"
    )
    assert "services" in payload, (
        f"Live health payload missing 'services'. Payload keys: {list(payload.keys())}"
    )


@pytest.mark.skipif(not _enabled(), reason="Set LIVE_SMOKE_ENABLED=1 to run live smoke tests")
def test_live_chat_agents_endpoint_available():
    url = f"{_base_url()}/api/chat/agents"
    response = httpx.get(url, headers=_headers(), timeout=30.0)

    assert response.status_code == 200, (
        f"Live agents check failed: GET {url} returned {response.status_code}. "
        f"Response body: {response.text}"
    )
    payload = response.json()
    assert "agents" in payload, (
        f"Agents payload missing 'agents'. Payload keys: {list(payload.keys())}"
    )
    assert isinstance(payload["agents"], list), (
        f"Expected 'agents' to be a list, got {type(payload['agents']).__name__}"
    )
