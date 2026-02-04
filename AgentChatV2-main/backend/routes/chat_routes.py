"""
Chat API Routes
Handles chat sessions, messages, and streaming responses.
"""
from typing import Optional
import json

from fastapi import APIRouter, Request, HTTPException, Query
from fastapi.responses import StreamingResponse

from models import (
    ChatRequest, ChatStreamChunk, ChatResponse,
    SessionCreate, SessionUpdate, Session, SessionListResponse,
    MessageListResponse, OrchestrationPattern
)
from services.cosmos_service import cosmos_service
from services.agent_manager import agent_manager, OrchestrationPattern as AgentOrchPattern, ChatterEvent, AgentResponse as AgentManagerResponse
from services.search_service import search_service
from services.embedding_service import embedding_service
from auth.middleware import get_user_token
from observability import get_logger, track_performance, should_log_performance, should_log_agent, log_performance_summary, MetricType

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = get_logger(__name__)


# =============================================================================
# RAG Helper
# =============================================================================

async def get_document_context(
    query: str,
    session_id: str,
    user_id: str,
    top_k: int = 3
) -> Optional[str]:
    """
    Retrieve relevant document context for RAG.
    Returns formatted context string or None if no documents found.
    """
    try:
        # Generate embedding for the query
        query_embedding = await embedding_service.generate_embedding(query)
        if not query_embedding:
            return None
        
        # Search for relevant documents in this session
        documents = await search_service.search_documents(
            query_embedding=query_embedding,
            session_id=session_id,
            user_id=user_id,
            top_k=top_k
        )
        
        if not documents:
            return None
        
        # Format context for injection
        context_parts = ["Here are relevant excerpts from uploaded documents:\n"]
        for doc in documents:
            context_parts.append(f"--- From: {doc['title']} ---")
            context_parts.append(doc['content'])
            context_parts.append("")
        
        context = "\n".join(context_parts)
        if should_log_agent():
            logger.info(f"Retrieved {len(documents)} document chunks for RAG context")
        return context
        
    except Exception as e:
        logger.warning(f"Failed to retrieve document context: {e}")
        return None


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
        """Generator for SSE streaming."""
        try:
            # Determine orchestration pattern from SESSION (not per-message)
            # Pattern is set when session is created and applies to all messages
            pattern = AgentOrchPattern(
                session.get("orchestration_type", "sequential")
            )
            
            # Get agent IDs from session
            agent_ids = session.get("selected_agents", [])
            if not agent_ids:
                # Fallback: use all agents if none selected
                agents = await cosmos_service.list_agents()
                agent_ids = [a["id"] for a in agents]
            
            # Build message history
            messages, _, _ = await cosmos_service.get_session_messages(
                session_id=session_id,
                user_id=user.user_id,
                page_size=20,
                oldest_first=True
            )
            
            chat_messages = [
                {"role": m["role"], "content": m["content"]}
                for m in messages
            ]
            
            # Ensure the current user message is included
            # (in case it wasn't retrieved due to timing)
            current_msg = {"role": "user", "content": chat_request.message}
            if not chat_messages or chat_messages[-1] != current_msg:
                # Check if last message is different from current
                if not chat_messages or chat_messages[-1].get("content") != chat_request.message:
                    chat_messages.append(current_msg)
            
            # RAG: Retrieve relevant document context
            doc_context = await get_document_context(
                query=chat_request.message,
                session_id=session_id,
                user_id=user.user_id
            )
            
            # Inject document context as a system message if found
            if doc_context:
                # Insert context at the beginning of messages
                context_message = {
                    "role": "system",
                    "content": f"Use the following document context to help answer the user's question:\n\n{doc_context}"
                }
                chat_messages.insert(0, context_message)
                if should_log_agent():
                    logger.info("Injected RAG document context into conversation")
            
            if should_log_agent():
                logger.info(f"Sending {len(chat_messages)} messages to orchestration")
                if chat_messages:
                    logger.info(f"Last message: role={chat_messages[-1].get('role')}, content={chat_messages[-1].get('content')[:100]}...")
            
            full_response = []
            
            # Stream from orchestrated agents
            async for event in agent_manager.execute_orchestration(
                pattern=pattern,
                agent_ids=agent_ids,
                messages=chat_messages,
                user_token=user_token
            ):
                # Check if this is a ChatterEvent (intermediate) or AgentResponse (final)
                if isinstance(event, ChatterEvent):
                    # Stream chatter event to UI
                    chatter_data = {
                        'type': 'chatter',
                        'chatter_type': event.type.value,
                        'agent_name': event.agent_name,
                        'content': event.content
                    }
                    if event.tool_name:
                        chatter_data['tool_name'] = event.tool_name
                    if event.tool_args:
                        chatter_data['tool_args'] = event.tool_args
                    if event.duration_ms is not None:
                        chatter_data['duration_ms'] = round(event.duration_ms, 1)
                    if event.tokens_input is not None:
                        chatter_data['tokens_input'] = event.tokens_input
                    if event.tokens_output is not None:
                        chatter_data['tokens_output'] = event.tokens_output
                    if event.friendly_message:
                        chatter_data['friendly_message'] = event.friendly_message
                    
                    # logger.info(f"SSE SENDING chatter: {event.type.value} - {event.tool_name}")  # Commented: verbose chatter logging
                    yield f"data: {json.dumps(chatter_data)}\n\n"
                    
                elif isinstance(event, AgentManagerResponse):
                    # This is the final agent response
                    agent_response = event
                    
                    # Send agent start event
                    yield f"data: {json.dumps({'type': 'agent_start', 'agent_id': agent_response.agent_id, 'agent_name': agent_response.agent_name})}\n\n"
                    
                    # Send content
                    yield f"data: {json.dumps({'type': 'content', 'agent_id': agent_response.agent_id, 'content': agent_response.content})}\n\n"
                    
                    full_response.append(f"[{agent_response.agent_name}]: {agent_response.content}")
                    
                    # Send agent end event
                    yield f"data: {json.dumps({'type': 'agent_end', 'agent_id': agent_response.agent_id})}\n\n"
            
            # Save assistant response
            combined_response = "\n\n".join(full_response)
            await cosmos_service.save_message(
                session_id=session_id,
                user_id=user.user_id,
                role="assistant",
                content=combined_response,
                metadata={"pattern": pattern.value, "agents": agent_ids}
            )
            
            # Send done event
            yield f"data: {json.dumps({'type': 'done', 'session_id': session_id})}\n\n"
            
        except Exception as e:
            logger.error(f"Chat streaming error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
    
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
    
    messages, _, _ = await cosmos_service.get_session_messages(
        session_id=session_id,
        user_id=user.user_id,
        page_size=20,
        oldest_first=True
    )
    
    chat_messages = [{"role": m["role"], "content": m["content"]} for m in messages]
    
    # RAG: Retrieve relevant document context
    doc_context = await get_document_context(
        query=chat_request.message,
        session_id=session_id,
        user_id=user.user_id
    )
    
    # Inject document context as a system message if found
    if doc_context:
        context_message = {
            "role": "system",
            "content": f"Use the following document context to help answer the user's question:\n\n{doc_context}"
        }
        chat_messages.insert(0, context_message)
        if should_log_agent():
            logger.info("Injected RAG document context into sync conversation")
    
    agent_responses = []
    async for response in agent_manager.execute_orchestration(
        pattern=pattern,
        agent_ids=agent_ids,
        messages=chat_messages,
        user_token=user_token
    ):
        agent_responses.append({
            "agent_id": response.agent_id,
            "agent_name": response.agent_name,
            "content": response.content
        })
    
    # Save and return response
    combined = "\n\n".join([f"[{r['agent_name']}]: {r['content']}" for r in agent_responses])
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
