"""
A2A Server Routes
Exposes local agents via the A2A (Agent-to-Agent) protocol.
Allows external systems to discover and communicate with agents hosted here.

A2A Protocol Endpoints:
- GET  /.well-known/agent.json     - List all agent cards (discovery)
- GET  /a2a/{agent_id}/v1/card     - Get specific agent card
- POST /a2a/{agent_id}/v1/message  - Send message to agent
- POST /a2a/{agent_id}/v1/message:stream - Send message with streaming response
"""
from typing import Optional, Any
from datetime import datetime
import json
import uuid
import time

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

from config import get_settings
from observability import get_logger, should_log_a2a
from services.cosmos_service import cosmos_service
from services.agent_manager import agent_manager, ChatterEvent

settings = get_settings()
logger = get_logger(__name__)

router = APIRouter(tags=["a2a"])


# =============================================================================
# A2A Protocol Models
# =============================================================================

class A2ASkill(BaseModel):
    """A2A Agent Skill."""
    id: str
    name: str
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)


class A2ACapabilities(BaseModel):
    """A2A Agent Capabilities."""
    streaming: bool = True
    push_notifications: bool = False
    state_transition_history: bool = False


class A2AAgentCard(BaseModel):
    """A2A Agent Card - metadata for agent discovery."""
    name: str
    description: Optional[str] = None
    url: str
    version: str = "1.0"
    protocol_version: str = "0.3.0"
    capabilities: A2ACapabilities = Field(default_factory=A2ACapabilities)
    skills: list[A2ASkill] = Field(default_factory=list)
    default_input_modes: list[str] = Field(default_factory=lambda: ["text"])
    default_output_modes: list[str] = Field(default_factory=lambda: ["text"])


class A2ATextPart(BaseModel):
    """A2A Text Part in a message."""
    kind: str = "text"
    text: str
    metadata: Optional[dict[str, Any]] = None


class A2APart(BaseModel):
    """A2A Message Part (wrapper)."""
    kind: str = "text"
    text: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class A2AMessage(BaseModel):
    """A2A Protocol Message."""
    kind: str = "message"
    role: str = "user"  # "user" or "agent"
    parts: list[A2APart]
    message_id: Optional[str] = Field(default=None, alias="messageId")
    context_id: Optional[str] = Field(default=None, alias="contextId")
    metadata: Optional[dict[str, Any]] = None
    
    model_config = {"populate_by_name": True}


class A2AMessageRequest(BaseModel):
    """A2A Message Request."""
    message: A2AMessage


class A2AMessageResponse(BaseModel):
    """A2A Message Response."""
    kind: str = "message"
    role: str = "agent"
    parts: list[A2APart]
    message_id: Optional[str] = Field(default=None, alias="messageId")
    context_id: Optional[str] = Field(default=None, alias="contextId")
    
    model_config = {"populate_by_name": True, "by_alias": True}


# =============================================================================
# Helper Functions
# =============================================================================

def _get_base_url(request: Request) -> str:
    """Get base URL from request for agent card URLs."""
    # Use configured base URL if available, otherwise derive from request
    if hasattr(settings, 'base_url') and settings.base_url:
        return settings.base_url.rstrip('/')
    
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.url.netloc)
    return f"{scheme}://{host}"


def _agent_to_card(agent: dict, base_url: str) -> A2AAgentCard:
    """Convert internal agent config to A2A Agent Card."""
    agent_id = agent.get("id", "unknown")
    
    # Create skill from agent description
    skills = [A2ASkill(
        id=agent_id,
        name=agent.get("name", "Agent"),
        description=agent.get("description", ""),
        tags=[],
        examples=[]
    )]
    
    return A2AAgentCard(
        name=agent.get("name", "Agent"),
        description=agent.get("description", ""),
        url=f"{base_url}/a2a/{agent_id}/v1/card",
        version="1.0",
        protocol_version="0.3.0",
        capabilities=A2ACapabilities(streaming=True),
        skills=skills
    )


# =============================================================================
# A2A Discovery Endpoints
# =============================================================================

@router.get("/.well-known/agent.json")
async def get_all_agent_cards(request: Request):
    """
    Well-known endpoint for A2A agent discovery.
    Returns agent cards for all local agents that have a2a_enabled=True.
    """
    base_url = _get_base_url(request)
    agents = await cosmos_service.list_agents()
    
    # Filter to only local agents with A2A enabled
    local_agents = [
        a for a in agents 
        if a.get("agent_type", "local") == "local" and a.get("a2a_enabled", True)
    ]
    
    # Return list of agent cards
    cards = [_agent_to_card(a, base_url).model_dump(by_alias=True) for a in local_agents]
    
    if should_log_a2a():
        logger.info(f"A2A discovery: returning {len(cards)} agent cards")
    return {"agents": cards, "count": len(cards)}


@router.get("/a2a/{agent_id}/v1/card")
async def get_agent_card(request: Request, agent_id: str):
    """
    Get A2A Agent Card for a specific agent.
    """
    agent = await cosmos_service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    # Only expose local agents via A2A
    if agent.get("agent_type", "local") != "local":
        raise HTTPException(status_code=404, detail="Agent not available via A2A")
    
    if not agent.get("a2a_enabled", True):
        raise HTTPException(status_code=403, detail="Agent does not have A2A enabled")
    
    base_url = _get_base_url(request)
    card = _agent_to_card(agent, base_url)
    
    return card.model_dump(by_alias=True)


@router.get("/a2a/{agent_id}/.well-known/agent.json")
async def get_agent_card_wellknown(request: Request, agent_id: str):
    """
    Well-known endpoint for individual agent discovery.
    This is the path the A2A SDK expects when discovering an agent.
    Redirects to the standard /v1/card endpoint logic.
    """
    return await get_agent_card(request, agent_id)


@router.get("/a2a/{agent_id}")
async def get_agent_card_base(request: Request, agent_id: str):
    """
    Base A2A endpoint - returns agent card for browser convenience.
    This allows users to paste the A2A URL directly in a browser and see the card.
    A2A clients will use /.well-known/agent.json, but this works for both.
    """
    return await get_agent_card(request, agent_id)


# =============================================================================
# A2A Message Endpoints
# =============================================================================

async def _handle_a2a_message(request: Request, agent_id: str, body: dict) -> dict:
    """
    Common handler for A2A message requests.
    Supports both JSON-RPC format (from A2A SDK) and simple message format.
    """
    agent = await cosmos_service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    if agent.get("agent_type", "local") != "local":
        raise HTTPException(status_code=404, detail="Agent not available via A2A")
    
    # Handle JSON-RPC format (what the A2A SDK sends)
    # Format: {"jsonrpc": "2.0", "method": "message/send", "params": {...}, "id": "..."}
    if "jsonrpc" in body:
        method = body.get("method", "")
        params = body.get("params", {})
        request_id = body.get("id", "1")
        
        # Extract message from params
        message_data = params.get("message", {})
        parts = message_data.get("parts", [])
        
        input_text = ""
        for part in parts:
            if part.get("kind") == "text" or "text" in part:
                input_text += part.get("text", "") + " "
        input_text = input_text.strip()
        
        if not input_text:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": "Message must contain text"}
            }
        
        # Execute agent
        try:
            messages = [{"role": "user", "content": input_text}]
            user_token = getattr(request.state, 'token', None)
            
            if should_log_a2a():
                logger.info(f"A2A executing agent {agent_id} with token present: {user_token is not None}, message: {input_text[:100]}...")
            
            # Collect all chunks and chatter events from the async generator
            chunks = []
            chatter_events = []
            start_time = time.time()
            
            try:
                async for item in agent_manager.execute_single(agent_id, messages, user_token, include_chatter=True):
                    if isinstance(item, ChatterEvent):
                        # Convert ChatterEvent to serializable dict including token info
                        event_dict = {
                            "type": item.type.value,
                            "agent_name": item.agent_name,
                            "content": item.content,
                            "tool_name": item.tool_name,
                            "tool_args": item.tool_args,
                            "duration_ms": item.duration_ms
                        }
                        # Include token counts if present
                        if item.tokens_input is not None:
                            event_dict["tokens_input"] = item.tokens_input
                        if item.tokens_output is not None:
                            event_dict["tokens_output"] = item.tokens_output
                        # Include friendly message if present
                        if item.friendly_message:
                            event_dict["friendly_message"] = item.friendly_message
                        chatter_events.append(event_dict)
                    elif isinstance(item, str):
                        chunks.append(item)
            except Exception as gen_error:
                logger.error(f"A2A generator error for {agent_id}: {gen_error}", exc_info=True)
                raise
            
            response_text = "".join(chunks)
            total_duration_ms = (time.time() - start_time) * 1000
            if should_log_a2a():
                logger.info(f"A2A agent {agent_id} completed with {len(response_text)} chars, {len(chatter_events)} tool events")
            
            # Return JSON-RPC response with A2A message format
            # Include chatter events as metadata for transparency
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "kind": "message",
                    "role": "agent",
                    "messageId": str(uuid.uuid4()),
                    "parts": [{"kind": "text", "text": response_text}],
                    "metadata": {
                        "chatter_events": chatter_events,
                        "duration_ms": total_duration_ms
                    }
                }
            }
        except Exception as e:
            import traceback
            logger.error(f"A2A JSON-RPC error for agent {agent_id}: {e}\n{traceback.format_exc()}")
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": str(e)}
            }
    
    # Handle simple message format (legacy)
    message_data = body.get("message", body)
    parts = message_data.get("parts", [])
    
    input_text = ""
    for part in parts:
        if part.get("kind") == "text" or "text" in part:
            input_text += part.get("text", "") + " "
    input_text = input_text.strip()
    
    if not input_text:
        raise HTTPException(status_code=400, detail="Message must contain text")
    
    context_id = message_data.get("contextId") or str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    
    try:
        messages = [{"role": "user", "content": input_text}]
        user_token = getattr(request.state, 'token', None)
        
        response_text = ""
        async for chunk in agent_manager.execute_single(agent_id, messages, user_token):
            response_text += chunk
        
        return {
            "kind": "message",
            "role": "agent",
            "parts": [{"kind": "text", "text": response_text}],
            "messageId": message_id,
            "contextId": context_id
        }
    except Exception as e:
        logger.error(f"A2A message error for agent {agent_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/a2a/{agent_id}")
async def send_message_direct(request: Request, agent_id: str):
    """
    Direct A2A endpoint - handles JSON-RPC messages from A2A SDK.
    This is the URL pattern the agent-framework-a2a SDK uses.
    """
    try:
        body = await request.json()
        if should_log_a2a():
            logger.info(f"A2A direct message to agent {agent_id}: method={body.get('method', 'unknown')}")
        result = await _handle_a2a_message(request, agent_id, body)
        return JSONResponse(content=result)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"A2A route error for {agent_id}: {e}\n{traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={
                "jsonrpc": "2.0",
                "id": "1",
                "error": {"code": -32603, "message": str(e)}
            }
        )


@router.post("/a2a/{agent_id}/v1/message")
async def send_message(request: Request, agent_id: str, message_request: A2AMessageRequest):
    """
    Send a message to an agent and get a complete response.
    Non-streaming version of the A2A message endpoint (v1 path).
    """
    agent = await cosmos_service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    if agent.get("agent_type", "local") != "local":
        raise HTTPException(status_code=404, detail="Agent not available via A2A")
    
    # Extract text from message parts
    input_text = ""
    for part in message_request.message.parts:
        if part.kind == "text" and part.text:
            input_text += part.text + " "
    input_text = input_text.strip()
    
    if not input_text:
        raise HTTPException(status_code=400, detail="Message must contain text")
    
    # Get context ID (conversation ID) - generate if not provided
    context_id = message_request.message.context_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    
    try:
        # Execute agent
        messages = [{"role": "user", "content": input_text}]
        
        # Get user token if available for MCP pass-through
        user_token = getattr(request.state, 'token', None)
        
        response_text = ""
        async for item in agent_manager.execute_single(agent_id, messages, user_token, include_chatter=False):
            if isinstance(item, str):
                response_text += item
        
        # Build A2A response
        response = A2AMessageResponse(
            kind="message",
            role="agent",
            parts=[A2APart(kind="text", text=response_text)],
            message_id=message_id,
            context_id=context_id
        )
        
        return response.model_dump(by_alias=True)
        
    except Exception as e:
        logger.error(f"A2A message error for agent {agent_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/a2a/{agent_id}/v1/message:stream")
async def send_message_stream(request: Request, agent_id: str, message_request: A2AMessageRequest):
    """
    Send a message to an agent with streaming response.
    Returns Server-Sent Events (SSE) stream following A2A protocol.
    """
    agent = await cosmos_service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    if agent.get("agent_type", "local") != "local":
        raise HTTPException(status_code=404, detail="Agent not available via A2A")
    
    # Extract text from message parts
    input_text = ""
    for part in message_request.message.parts:
        if part.kind == "text" and part.text:
            input_text += part.text + " "
    input_text = input_text.strip()
    
    if not input_text:
        raise HTTPException(status_code=400, detail="Message must contain text")
    
    # Get context ID (conversation ID) - generate if not provided
    context_id = message_request.message.context_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    
    async def generate_stream():
        """Generate A2A streaming response."""
        try:
            messages = [{"role": "user", "content": input_text}]
            user_token = getattr(request.state, 'token', None)
            
            full_response = ""
            async for item in agent_manager.execute_single(agent_id, messages, user_token, include_chatter=False):
                if isinstance(item, str):
                    full_response += item
                # For simplicity, collect full response then send
                # In production, could stream incremental updates
            
            # Send final message response
            response = {
                "kind": "message",
                "role": "agent",
                "parts": [{"kind": "text", "text": full_response}],
                "messageId": message_id,
                "contextId": context_id
            }
            
            yield json.dumps(response)
            
        except Exception as e:
            logger.error(f"A2A stream error for agent {agent_id}: {e}")
            error_response = {
                "kind": "error",
                "error": str(e),
                "contextId": context_id
            }
            yield json.dumps(error_response)
    
    return StreamingResponse(
        generate_stream(),
        media_type="application/json"
    )


# =============================================================================
# A2A Task Endpoints (Optional - for long-running operations)
# =============================================================================

@router.post("/a2a/{agent_id}/v1/task")
async def create_task(request: Request, agent_id: str, message_request: A2AMessageRequest):
    """
    Create a long-running task for an agent.
    Returns task ID for polling status.
    
    Note: This is a placeholder for future implementation.
    Current implementation forwards to synchronous message endpoint.
    """
    # For now, forward to synchronous message endpoint
    return await send_message(request, agent_id, message_request)


@router.get("/a2a/{agent_id}/v1/task/{task_id}")
async def get_task_status(agent_id: str, task_id: str):
    """
    Get status of a long-running task.
    
    Note: This is a placeholder for future implementation.
    """
    raise HTTPException(
        status_code=501, 
        detail="Task-based A2A operations not yet implemented"
    )
