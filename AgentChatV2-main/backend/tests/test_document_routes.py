from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import routes.document_routes as document_routes


@pytest.mark.asyncio
async def test_get_document_content_scopes_lookup_to_current_user(monkeypatch):
    captured = {}

    async def fake_get_document_chunks(document_id, user_id=None):
        captured["document_id"] = document_id
        captured["user_id"] = user_id
        return []

    async def fake_find_image_message(document_id, user_id):
        captured["image_lookup"] = (document_id, user_id)
        return None

    monkeypatch.setattr(document_routes.search_service, "get_document_chunks", fake_get_document_chunks)
    monkeypatch.setattr(document_routes, "_find_image_message_for_document", fake_find_image_message)

    request = SimpleNamespace(
        state=SimpleNamespace(user=SimpleNamespace(user_id="user-42"))
    )

    with pytest.raises(HTTPException) as exc:
        await document_routes.get_document_content(request, "doc-123")

    assert exc.value.status_code == 404
    assert captured["document_id"] == "doc-123"
    assert captured["user_id"] == "user-42"
    assert captured["image_lookup"] == ("doc-123", "user-42")
