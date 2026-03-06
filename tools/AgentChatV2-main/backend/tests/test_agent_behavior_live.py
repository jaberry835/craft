import json
import os
from typing import Any

import httpx
import pytest


pytestmark = pytest.mark.live


LIVE_TIMEOUT_SECONDS = 120.0


def _base_url() -> str:
    return os.getenv("LIVE_BACKEND_URL", "http://127.0.0.1:5000").rstrip("/")


def _headers() -> dict[str, str]:
    token = os.getenv("LIVE_BEARER_TOKEN", "").strip()
    return {"Authorization": f"Bearer {token}"} if token else {}


def _enabled() -> bool:
    return os.getenv("LIVE_SMOKE_ENABLED", "0").strip() == "1"


def _create_session(client: httpx.Client, selected_agents: list[str]) -> str:
    url = f"{_base_url()}/api/chat/sessions"
    response = client.post(
        url,
        json={
            "title": "live-smoke-session",
            "orchestration_type": "sequential",
            "selected_agents": selected_agents,
        },
        headers=_headers(),
        timeout=LIVE_TIMEOUT_SECONDS,
    )
    assert response.status_code == 200, (
        f"Failed to create smoke session: POST {url} returned {response.status_code}. "
        f"Response body: {response.text}"
    )
    payload = response.json()
    assert "id" in payload, f"Session create response missing 'id'. Payload: {payload}"
    return payload["id"]


def _delete_session(client: httpx.Client, session_id: str) -> None:
    try:
        client.delete(
            f"{_base_url()}/api/chat/sessions/{session_id}",
            headers=_headers(),
            timeout=LIVE_TIMEOUT_SECONDS,
        )
    except Exception:
        # Best-effort cleanup only.
        pass


def _read_sse_events(client: httpx.Client, session_id: str, message: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    buffer = ""
    url = f"{_base_url()}/api/chat/send"

    with client.stream(
        "POST",
        url,
        json={"message": message, "session_id": session_id},
        headers=_headers(),
        timeout=LIVE_TIMEOUT_SECONDS,
    ) as response:
        assert response.status_code == 200, (
            f"Streaming send failed: POST {url} returned {response.status_code}. "
            f"Response body: {response.text}"
        )

        finished = False
        for chunk in response.iter_text():
            buffer += chunk

            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.splitlines():
                    if not line.startswith("data: "):
                        continue
                    payload_text = line[6:].strip()
                    if not payload_text:
                        continue
                    event = json.loads(payload_text)
                    events.append(event)

                    if event.get("type") in {"RUN_FINISHED", "RUN_ERROR"}:
                        finished = True
                if finished:
                    break
            if finished:
                break

    return events


@pytest.mark.skipif(not _enabled(), reason="Set LIVE_SMOKE_ENABLED=1 to run live smoke tests")
def test_live_streaming_emits_chatter_and_lifecycle_contracts():
    with httpx.Client() as client:
        agents_resp = client.get(
            f"{_base_url()}/api/chat/agents",
            headers=_headers(),
            timeout=LIVE_TIMEOUT_SECONDS,
        )
        assert agents_resp.status_code == 200, (
            f"Failed to list agents before streaming test: status={agents_resp.status_code}, "
            f"body={agents_resp.text}"
        )

        agents = agents_resp.json().get("agents", [])
        if not agents:
            pytest.skip("No agents configured on live backend")

        orchestrators = [a for a in agents if a.get("is_orchestrator")]
        if not orchestrators:
            pytest.skip("No orchestrator configured; cannot validate orchestration chatter")

        # Use one orchestrator plus up to two specialists for deterministic behavior.
        selected = [orchestrators[0]["id"]]
        selected.extend([a["id"] for a in agents if not a.get("is_orchestrator")][:2])

        session_id = _create_session(client, selected)
        try:
            events = _read_sse_events(
                client,
                session_id=session_id,
                message="Give me a concise response and show your normal orchestration activity.",
            )
        finally:
            _delete_session(client, session_id)

    assert events, (
        "No SSE events were received from /api/chat/send. "
        "Possible causes: stream closed early, auth failure, or orchestration runtime error."
    )

    event_types = [e.get("type") for e in events]
    assert "RUN_STARTED" in event_types, (
        f"Missing RUN_STARTED in SSE stream. Seen event types: {event_types}"
    )
    assert "RUN_FINISHED" in event_types, (
        f"Missing RUN_FINISHED in SSE stream. Seen event types: {event_types}"
    )
    assert "RUN_ERROR" not in event_types, (
        f"RUN_ERROR was emitted in stream. Seen event types: {event_types}"
    )

    assert event_types.index("RUN_STARTED") < event_types.index("RUN_FINISHED"), (
        f"Invalid lifecycle order: RUN_FINISHED appeared before RUN_STARTED. Event types: {event_types}"
    )

    # Expect final assistant output content.
    assert "TEXT_MESSAGE_CONTENT" in event_types or "TEXT_MESSAGE_END" in event_types, (
        "No final assistant text events found. Expected TEXT_MESSAGE_CONTENT or TEXT_MESSAGE_END. "
        f"Seen event types: {event_types}"
    )

    # Chatter contract: at least one CUSTOM chatter payload should be present.
    chatter_events = [e for e in events if e.get("type") == "CUSTOM" and e.get("name") == "chatter"]
    assert chatter_events, (
        "No chatter custom events were emitted (CUSTOM with name='chatter'). "
        "This may indicate chatter mapping/regression in streaming pipeline."
    )

    # Tool-call ordering contract (only assert if tool events are present).
    starts: dict[str, int] = {}
    for idx, e in enumerate(events):
        et = e.get("type")
        tc_id = e.get("tool_call_id")
        if et == "TOOL_CALL_START" and tc_id:
            starts[tc_id] = idx
        elif et in {"TOOL_CALL_END", "TOOL_CALL_RESULT"} and tc_id:
            assert tc_id in starts, (
                f"Tool event ordering error: {et} was seen for tool_call_id='{tc_id}' "
                "without a prior TOOL_CALL_START."
            )
            assert idx > starts[tc_id], (
                f"Tool event ordering error: {et} for tool_call_id='{tc_id}' "
                "appeared before TOOL_CALL_START."
            )


@pytest.mark.skipif(not _enabled(), reason="Set LIVE_SMOKE_ENABLED=1 to run live smoke tests")
def test_live_send_sync_returns_non_empty_content():
    with httpx.Client() as client:
        agents_resp = client.get(
            f"{_base_url()}/api/chat/agents",
            headers=_headers(),
            timeout=LIVE_TIMEOUT_SECONDS,
        )
        assert agents_resp.status_code == 200, (
            f"Failed to list agents before send-sync test: status={agents_resp.status_code}, "
            f"body={agents_resp.text}"
        )

        agents = agents_resp.json().get("agents", [])
        if not agents:
            pytest.skip("No agents configured on live backend")

        orchestrators = [a for a in agents if a.get("is_orchestrator")]
        if not orchestrators:
            pytest.skip("No orchestrator configured; cannot validate send-sync")

        selected = [orchestrators[0]["id"]]
        selected.extend([a["id"] for a in agents if not a.get("is_orchestrator")][:2])

        session_id = _create_session(client, selected)
        try:
            url = f"{_base_url()}/api/chat/send-sync"
            response = client.post(
                url,
                json={"message": "Reply in one short sentence.", "session_id": session_id},
                headers=_headers(),
                timeout=LIVE_TIMEOUT_SECONDS,
            )
            assert response.status_code == 200, (
                f"send-sync request failed: POST {url} returned {response.status_code}. "
                f"Response body: {response.text}"
            )
            payload = response.json()
        finally:
            _delete_session(client, session_id)

    assert isinstance(payload.get("content"), str), (
        f"send-sync response 'content' should be string, got {type(payload.get('content')).__name__}."
    )
    assert payload["content"].strip() != "", (
        "send-sync response content is empty. "
        f"Payload: {payload}"
    )
    assert isinstance(payload.get("agent_responses"), list), (
        f"send-sync response 'agent_responses' should be list, got {type(payload.get('agent_responses')).__name__}."
    )
