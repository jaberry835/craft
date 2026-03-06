from types import SimpleNamespace

import pytest

import routes.health_routes as health_routes


class _FakeIndexClient:
    def __init__(self):
        self.requested = None

    def get_index(self, name):
        self.requested = name
        return {"name": name}


@pytest.mark.asyncio
async def test_check_search_uses_search_service_index_name(monkeypatch):
    fake_client = _FakeIndexClient()
    fake_search_service = SimpleNamespace(index_client=fake_client, index_name="documents-index")

    monkeypatch.setattr(health_routes, "search_service", fake_search_service)

    result = await health_routes.check_search()

    assert result.status == "healthy"
    assert fake_client.requested == "documents-index"
