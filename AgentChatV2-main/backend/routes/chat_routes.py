"""
Chat API Routes
Handles chat sessions, messages, and streaming responses.

Uses AG-UI protocol for SSE streaming events (standardized event format):
- RUN_STARTED / RUN_FINISHED / RUN_ERROR for lifecycle
- STEP_STARTED / STEP_FINISHED for orchestration phases
- TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END / TOOL_CALL_RESULT for tools
- TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END for final responses
- CUSTOM events for app-specific metadata (tokens, durations, session creation)
"""
from typing import Optional
import json
import uuid

from fastapi import APIRouter, Request, HTTPException, Query
from fastapi.responses import StreamingResponse

from ag_ui.core import (
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    StepStartedEvent, StepFinishedEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
    ReasoningStartEvent, ReasoningMessageStartEvent,
    ReasoningMessageContentEvent, ReasoningMessageEndEvent,
    ReasoningEndEvent,
    CustomEvent,
)

from models import (
    ChatRequest, ChatResponse,
    SessionCreate, SessionUpdate, Session, SessionListResponse,
    MessageListResponse, OrchestrationPattern
)
from services.cosmos_service import cosmos_service
from services.agent_manager import (
    agent_manager,
    OrchestrationPattern as AgentOrchPattern,
    ChatterEvent, ChatterEventType,
    AgentResponse as AgentManagerResponse,
)
from auth.middleware import get_user_token
from observability import get_logger, track_performance, should_log_performance, should_log_agent, log_performance_summary, MetricType
from rate_limit import limiter
from config import get_settings

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = get_logger(__name__)
_settings = get_settings()


def _agui_sse(event) -> str:
    """Serialize an AG-UI event as an SSE data frame."""
    return f"data: {event.model_dump_json()}\n\n"


# =============================================================================
# Agents (for regular users - read-only)
# =============================================================================

@router.get("/agents")
async def list_available_agents(request: Request):
    """
    List available agents for chat selection.
    This is a read-only endpoint for regular users (no admin required).
    Returns only active agents with minimal info needed for selection.
    """
    agents = await cosmos_service.list_agents()
    
    # Return only active agents with fields needed for selection
    # Include agent_type for visual differentiation (local vs a2a)
    available = [
        {
            "id": a["id"],
            "name": a["name"],
            "description": a.get("description", ""),
            "agent_type": a.get("agent_type", "local"),  # 'local' or 'a2a'
            "is_orchestrator": a.get("is_orchestrator", False),
            "model": a.get("model"),  # Show model for local agents
            "has_grounding": bool(a.get("grounding_sources")),  # For citation auto-linking
        }
        for a in agents
        if a.get("is_active", True)  # Only return active agents
    ]
    
    return {"agents": available, "count": len(available)}


# =============================================================================
# Sessions
# =============================================================================

@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions(
    request: Request,
    page_size: int = Query(20, ge=1, le=100),
    continuation_token: Optional[str] = None
):
    """List user's chat sessions with pagination."""
    user = request.state.user
    
    sessions, next_token, has_more = await cosmos_service.get_user_sessions(
        user_id=user.user_id,
        page_size=page_size,
        continuation_token=continuation_token
    )
    
    return SessionListResponse(
        sessions=sessions,
        continuation_token=next_token,
        has_more=has_more
    )


@router.post("/sessions", response_model=Session)
async def create_session(request: Request, session_data: SessionCreate):
    """Create a new chat session."""
    user = request.state.user
    
    session = await cosmos_service.create_session(
        user_id=user.user_id,
        title=session_data.title,
        orchestration_type=session_data.orchestration_type.value,
        selected_agents=session_data.selected_agents
    )
    
    return session


@router.get("/sessions/{session_id}", response_model=Session)
async def get_session(request: Request, session_id: str):
    """Get a specific session."""
    user = request.state.user
    
    session = await cosmos_service.get_session(session_id, user.user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    return session


@router.patch("/sessions/{session_id}", response_model=Session)
async def update_session(
    request: Request,
    session_id: str,
    updates: SessionUpdate
):
    """Update a session."""
    user = request.state.user
    
    update_dict = updates.model_dump(exclude_unset=True)
    if "orchestration_type" in update_dict and update_dict["orchestration_type"]:
        update_dict["orchestrationType"] = update_dict.pop("orchestration_type").value
    if "selected_agents" in update_dict:
        update_dict["selectedAgents"] = update_dict.pop("selected_agents")
    
    session = await cosmos_service.update_session(session_id, user.user_id, update_dict)
    return session


@router.delete("/sessions/{session_id}")
async def delete_session(request: Request, session_id: str):
    """Delete a session and all its messages."""
    user = request.state.user
    
    success = await cosmos_service.delete_session(session_id, user.user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found")
    
    return {"message": "Session deleted"}


# =============================================================================
# Messages
# =============================================================================

@router.get("/sessions/{session_id}/messages", response_model=MessageListResponse)
async def list_messages(
    request: Request,
    session_id: str,
    page_size: int = Query(50, ge=1, le=200),
    continuation_token: Optional[str] = None,
    oldest_first: bool = False
):
    """List messages in a session with pagination."""
    user = request.state.user
    
    messages, next_token, has_more = await cosmos_service.get_session_messages(
        session_id=session_id,
        user_id=user.user_id,
        page_size=page_size,
        continuation_token=continuation_token,
        oldest_first=oldest_first
    )
    
    return MessageListResponse(
        messages=messages,
        continuation_token=next_token,
        has_more=has_more
    )


# =============================================================================
# Chat Streaming
# =============================================================================

@router.post("/send")
@limiter.limit(lambda: _settings.rate_limit_chat)
@track_performance("chat_send", MetricType.HTTP_REQUEST)
async def send_message(request: Request, chat_request: ChatRequest):
    """
    Send a message and get a streaming response.
    Returns Server-Sent Events (SSE).
    """
    user = request.state.user
    user_token = get_user_token(request)
    
    # Get or create session
    session_id = chat_request.session_id
    if not session_id:
        session = await cosmos_service.create_session(
            user_id=user.user_id,
            title=chat_request.message[:50] + "..." if len(chat_request.message) > 50 else chat_request.message,
            orchestration_type=(chat_request.orchestration_type or OrchestrationPattern.SEQUENTIAL).value,
            selected_agents=chat_request.agent_ids or []
        )
        session_id = session["id"]
    
    # Save user message
    await cosmos_service.save_message(
        session_id=session_id,
        user_id=user.user_id,
        role="user",
        content=chat_request.message
    )
    
    # Get session for orchestration config
    session = await cosmos_service.get_session(session_id, user.user_id)
    
    # Update session title if it was auto-generated from document upload
    if session and session.get("title", "").startswith("Document:"):
        new_title = chat_request.message[:50] + "..." if len(chat_request.message) > 50 else chat_request.message
        try:
            await cosmos_service.update_session(session_id, user.user_id, {"title": new_title})
            logger.info(f"Updated session title from document name to: {new_title}")
        except Exception as e:
            logger.warning(f"Failed to update session title: {e}")
    
    async def stream_response():
        """Generator for SSE streaming using AG-UI protocol events."""
        run_id = str(uuid.uuid4())
        message_id = str(uuid.uuid4())
        tool_call_counter = 0
        tool_call_id_map: dict[str, str] = {}  # framework call_id -> AG-UI tc_id

        try:
            # --- AG-UI: RUN_STARTED ---
            yield _agui_sse(RunStartedEvent(thread_id=session_id, run_id=run_id))

            # Determine orchestration pattern from SESSION (not per-message)
            pattern = AgentOrchPattern(
                session.get("orchestration_type", "sequential")
            )
            
            # Get agent IDs from session
            agent_ids = session.get("selected_agents", [])
            if not agent_ids:
                agents = await cosmos_service.list_agents()
                agent_ids = [a["id"] for a in agents]
            
            full_response = []
            chatter_log = []  # Collect chatter events for persistence
            
            # Stream from orchestrated agents.
            # Conversation history and RAG document context are loaded
            # automatically by Agent Framework context providers
            # (CosmosHistoryProvider and DocumentRAGProvider).
            async for event in agent_manager.execute_orchestration(
                pattern=pattern,
                agent_ids=agent_ids,
                user_message=chat_request.message,
                session_id=session_id,
                user_id=user.user_id,
                user_token=user_token
            ):
                if isinstance(event, ChatterEvent):
                    # Collect for persistence (strip large tool result content to save space)
                    evt_dict = event.to_dict()
                    if event.type == ChatterEventType.TOOL_RESULT and len(evt_dict.get("content", "")) > 500:
                        evt_dict["content"] = evt_dict["content"][:500] + "..."
                    chatter_log.append(evt_dict)

                    # --- Map ChatterEvent → AG-UI events ---
                    if event.type == ChatterEventType.THINKING:
                        step_name = f"thinking:{event.agent_name}"
                        yield _agui_sse(StepStartedEvent(step_name=step_name))
                        # Attach rich metadata via CUSTOM event
                        thinking_metadata: dict = {
                            "chatter_type": event.type.value,
                            "agent_name": event.agent_name,
                            "content": event.content,
                        }
                        if event.friendly_message:
                            thinking_metadata["friendly_message"] = event.friendly_message
                        if event.tokens_input is not None:
                            thinking_metadata["tokens_input"] = event.tokens_input
                        if event.tokens_output is not None:
                            thinking_metadata["tokens_output"] = event.tokens_output
                        yield _agui_sse(CustomEvent(name="chatter", value=thinking_metadata))

                    elif event.type == ChatterEventType.DELEGATION:
                        step_name = f"delegate:{event.agent_name}"
                        yield _agui_sse(StepStartedEvent(step_name=step_name))
                        delegation_metadata: dict = {
                            "chatter_type": event.type.value,
                            "agent_name": event.agent_name,
                            "content": event.content,
                        }
                        if event.friendly_message:
                            delegation_metadata["friendly_message"] = event.friendly_message
                        yield _agui_sse(CustomEvent(name="chatter", value=delegation_metadata))

                    elif event.type == ChatterEventType.TOOL_CALL:
                        tool_call_counter += 1
                        tc_id = f"tc-{tool_call_counter}"
                        if event.call_id:
                            tool_call_id_map[event.call_id] = tc_id
                        yield _agui_sse(ToolCallStartEvent(
                            tool_call_id=tc_id,
                            tool_call_name=event.tool_name or "unknown",
                        ))
                        if event.tool_args:
                            yield _agui_sse(ToolCallArgsEvent(
                                tool_call_id=tc_id,
                                delta=json.dumps(event.tool_args),
                            ))
                        if event.friendly_message:
                            yield _agui_sse(CustomEvent(name="chatter", value={
                                "chatter_type": event.type.value,
                                "agent_name": event.agent_name,
                                "tool_call_id": tc_id,
                                "tool_name": event.tool_name,
                                "friendly_message": event.friendly_message,
                            }))

                    elif event.type == ChatterEventType.TOOL_RESULT:
                        tc_id = tool_call_id_map.get(event.call_id, f"tc-{tool_call_counter}") if event.call_id else f"tc-{tool_call_counter}"
                        yield _agui_sse(ToolCallEndEvent(tool_call_id=tc_id))
                        yield _agui_sse(ToolCallResultEvent(
                            message_id=str(uuid.uuid4()),
                            tool_call_id=tc_id,
                            content=event.content or "",
                        ))
                        # Emit metadata (duration, tokens) as CUSTOM
                        metadata: dict = {"chatter_type": event.type.value, "agent_name": event.agent_name, "tool_call_id": tc_id}
                        if event.duration_ms is not None:
                            metadata["duration_ms"] = round(event.duration_ms, 1)
                        if event.tokens_input is not None:
                            metadata["tokens_input"] = event.tokens_input
                        if event.tokens_output is not None:
                            metadata["tokens_output"] = event.tokens_output
                        if event.friendly_message:
                            metadata["friendly_message"] = event.friendly_message
                        yield _agui_sse(CustomEvent(name="chatter", value=metadata))

                    elif event.type == ChatterEventType.REASONING:
                        # AG-UI REASONING events for model chain-of-thought tokens
                        reasoning_msg_id = str(uuid.uuid4())
                        yield _agui_sse(ReasoningStartEvent(messageId=reasoning_msg_id))
                        yield _agui_sse(ReasoningMessageStartEvent(messageId=reasoning_msg_id, role="assistant"))
                        yield _agui_sse(ReasoningMessageContentEvent(messageId=reasoning_msg_id, delta=event.content))
                        yield _agui_sse(ReasoningMessageEndEvent(messageId=reasoning_msg_id))
                        yield _agui_sse(ReasoningEndEvent(messageId=reasoning_msg_id))
                        # Also emit CUSTOM so the activity feed gets enriched
                        yield _agui_sse(CustomEvent(name="chatter", value={
                            "chatter_type": event.type.value,
                            "agent_name": event.agent_name,
                            "content": event.content,
                            "friendly_message": event.friendly_message or "Reasoning...",
                        }))

                    elif event.type == ChatterEventType.CONTENT:
                        step_name = f"delegate:{event.agent_name}"
                        yield _agui_sse(StepFinishedEvent(step_name=step_name))
                        metadata = {"chatter_type": event.type.value, "agent_name": event.agent_name, "content": event.content}
                        if event.duration_ms is not None:
                            metadata["duration_ms"] = round(event.duration_ms, 1)
                        if event.tokens_input is not None:
                            metadata["tokens_input"] = event.tokens_input
                        if event.tokens_output is not None:
                            metadata["tokens_output"] = event.tokens_output
                        yield _agui_sse(CustomEvent(name="chatter", value=metadata))
                    
                elif isinstance(event, AgentManagerResponse):
                    # --- AG-UI: TEXT_MESSAGE_START / CONTENT / END ---
                    yield _agui_sse(TextMessageStartEvent(message_id=message_id, role="assistant"))
                    yield _agui_sse(TextMessageContentEvent(message_id=message_id, delta=event.content))
                    yield _agui_sse(TextMessageEndEvent(message_id=message_id))

                    # Persist clean assistant text; agent provenance is captured in chatter metadata.
                    full_response.append(event.content)
            
            # Save assistant response with chatter history
            combined_response = "\n\n".join(full_response)
            await cosmos_service.save_message(
                session_id=session_id,
                user_id=user.user_id,
                role="assistant",
                content=combined_response,
                metadata={
                    "pattern": pattern.value,
                    "agents": agent_ids,
                    "chatter_events": chatter_log
                }
            )
            
            # --- AG-UI: session_created CUSTOM + RUN_FINISHED ---
            yield _agui_sse(CustomEvent(name="session_created", value={"session_id": session_id}))
            yield _agui_sse(RunFinishedEvent(thread_id=session_id, run_id=run_id))
            
        except Exception as e:
            logger.error(f"Chat streaming error: {e}")
            yield _agui_sse(RunErrorEvent(message=str(e)))
    
    return StreamingResponse(
        stream_response(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.post("/send-sync", response_model=ChatResponse)
@limiter.limit(lambda: _settings.rate_limit_chat)
@track_performance("chat_send_sync", MetricType.HTTP_REQUEST)
async def send_message_sync(request: Request, chat_request: ChatRequest):
    """
    Send a message and get a non-streaming response.
    Useful for programmatic access.
    """
    user = request.state.user
    user_token = get_user_token(request)
    
    # Get or create session
    session_id = chat_request.session_id
    if not session_id:
        session = await cosmos_service.create_session(
            user_id=user.user_id,
            title=chat_request.message[:50],
            orchestration_type=(chat_request.orchestration_type or OrchestrationPattern.SEQUENTIAL).value,
            selected_agents=chat_request.agent_ids or []
        )
        session_id = session["id"]
    
    # Save user message
    await cosmos_service.save_message(
        session_id=session_id,
        user_id=user.user_id,
        role="user",
        content=chat_request.message
    )
    
    session = await cosmos_service.get_session(session_id, user.user_id)
    
    # Update session title if it was auto-generated from document upload
    if session and session.get("title", "").startswith("Document:"):
        new_title = chat_request.message[:50] + "..." if len(chat_request.message) > 50 else chat_request.message
        try:
            await cosmos_service.update_session(session_id, user.user_id, {"title": new_title})
            logger.info(f"Updated session title from document name to: {new_title}")
        except Exception as e:
            logger.warning(f"Failed to update session title: {e}")
    
    # Execute orchestration
    pattern = AgentOrchPattern(
        chat_request.orchestration_type.value if chat_request.orchestration_type
        else session.get("orchestration_type", "sequential")
    )
    
    agent_ids = chat_request.agent_ids or session.get("selected_agents", [])
    
    # Agent Framework providers handle history loading and RAG injection.
    # execute_orchestration yields both ChatterEvent and AgentResponse items;
    # sync endpoint should only include final AgentResponse content.
    agent_responses = []
    async for event in agent_manager.execute_orchestration(
        pattern=pattern,
        agent_ids=agent_ids,
        user_message=chat_request.message,
        session_id=session_id,
        user_id=user.user_id,
        user_token=user_token
    ):
        if isinstance(event, ChatterEvent):
            continue
        if isinstance(event, AgentManagerResponse):
            agent_responses.append({
                "agent_id": event.agent_id,
                "agent_name": event.agent_name,
                "content": event.content
            })
            continue
        logger.warning(f"Unexpected orchestration event type in send-sync: {type(event).__name__}")
    
    # Save and return response
    # Return/store clean assistant text; callers can still inspect `agent_responses` for provenance.
    combined = "\n\n".join([r["content"] for r in agent_responses])
    saved_msg = await cosmos_service.save_message(
        session_id=session_id,
        user_id=user.user_id,
        role="assistant",
        content=combined
    )
    
    return ChatResponse(
        session_id=session_id,
        message_id=saved_msg["id"],
        content=combined,
        agent_responses=agent_responses
    )
