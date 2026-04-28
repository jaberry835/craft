import pytest

from services.cosmos_service import CosmosDBService


class _DummyMessagesContainer:
    def __init__(self):
        self.created_items = []

    async def create_item(self, item):
        self.created_items.append(item)


@pytest.mark.asyncio
async def test_save_message_increments_from_snake_case_session_field(monkeypatch):
    service = CosmosDBService()
    service.messages_container = _DummyMessagesContainer()

    async def fake_get_session(session_id, user_id):
        return {"id": session_id, "message_count": 3}

    updated = {}

    async def fake_update_session(session_id, user_id, updates):
        updated.update(updates)
        return updates

    monkeypatch.setattr(service, "get_session", fake_get_session)
    monkeypatch.setattr(service, "update_session", fake_update_session)

    await service.save_message(
        session_id="session-1",
        user_id="user-1",
        role="user",
        content="hello",
    )

    assert updated["messageCount"] == 4
