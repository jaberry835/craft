"""
PixelPress AI Backend — FastAPI application.

Provides an SSE-streaming chat endpoint that wraps the Microsoft Agent Framework
agent for the PixelPress print & digital media assistant.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import AsyncGenerator

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

load_dotenv(override=True)

from agent_config import create_agent, drain_tool_calls  # noqa: E402
from agent_framework import AgentThread  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pixelpress")

# ── App ──────────────────────────────────────────────────────
app = FastAPI(title="PixelPress AI Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory thread store (one thread per session) ──────────
_threads: dict[str, AgentThread] = {}


# ── SSE helpers ──────────────────────────────────────────────
def _sse(event: str, data: dict | str) -> str:
    payload = data if isinstance(data, str) else json.dumps(data)
    return f"event: {event}\ndata: {payload}\n\n"


# ── Chat endpoint (SSE streaming) ───────────────────────────
@app.post("/api/chat")
async def chat(request: Request):
    """
    Accepts JSON body:
      {
        "message": "user message text",
        "session_id": "optional-uuid",
        "form_data": { ... current form state ... }
      }

    Returns an SSE stream with these event types:
      event: token       — { "text": "..." }
      event: tool_call   — { "action": "update_field", "field": "...", "value": "..." }
      event: done        — {}
      event: error       — { "message": "..." }
    """
    body = await request.json()
    user_message: str = body.get("message", "").strip()
    session_id: str = body.get("session_id") or str(uuid.uuid4())
    form_data: dict = body.get("form_data", {})

    if not user_message:
        return StreamingResponse(
            iter([_sse("error", {"message": "Empty message"})]),
            media_type="text/event-stream",
        )

    async def generate() -> AsyncGenerator[str, None]:
        try:
            agent = create_agent()

            # Get or create a thread for multi-turn memory
            thread = _threads.get(session_id)
            if thread is None:
                thread = agent.get_new_thread()
                _threads[session_id] = thread

            # Build contextual message with current form state
            context_prefix = ""
            if form_data and any(v for v in form_data.values() if v):
                context_prefix = (
                    f"[Current form state: {json.dumps(form_data, default=str)}]\n\n"
                )

            full_message = context_prefix + user_message

            # Stream the agent response
            drain_tool_calls()  # clear any leftover from previous call

            async for update in agent.run_stream(full_message, thread=thread):
                text = update.text
                if text:
                    yield _sse("token", {"text": text})

            # After stream completes, send any tool calls that were captured
            tool_calls = drain_tool_calls()
            for tc in tool_calls:
                yield _sse("tool_call", tc)

            yield _sse("done", {"session_id": session_id})

        except Exception as e:
            logger.exception("Chat error")
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Health check ─────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "pixelpress-ai"}


# ── Run ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, reload=True)
