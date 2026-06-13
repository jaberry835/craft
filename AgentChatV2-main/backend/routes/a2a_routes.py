"""
A2A Server Routes
Exposes local agents via the A2A (Agent-to-Agent) protocol using the A2A SDK.

Uses A2AFastAPIApplication from the SDK for proper JSON-RPC handling, task
management, and SSE streaming. Each local agent gets its own A2A endpoint.

A2A Protocol Endpoints (per agent, managed by SDK):
- GET  /a2a/{id}/.well-known/agent-card.json  - Agent card (discovery)
- POST /a2a/{id}                               - JSON-RPC (message/send, etc.)

Global:
- GET  /.well-known/agent.json                 - List all agent cards
"""
import uuid
from typing import Optional

from fastapi import FastAPI, APIRouter, Request
from starlette.requests import Request as StarletteRequest

from a2a.server.apps import A2AFastAPIApplication, CallContextBuilder
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue, InMemoryQueueManager
from a2a.server.tasks import InMemoryTaskStore
from a2a.server.context import ServerCallContext
from a2a.types import (
    AgentCard, AgentSkill, AgentCapabilities,
    Message, Part, TextPart, Role,
    TaskStatusUpdateEvent, TaskStatus, TaskState,
)

from config import get_settings
from observability import get_logger, should_log_a2a
from services.cosmos_service import cosmos_service

settings = get_settings()
logger = get_logger(__name__)

router = APIRouter(tags=["a2a"])


# Maps internal ChatterEventType values to the A2A status-update metadata.type
# contract that external callers parse. A2A has no first-class reasoning field,
# so Message.metadata.type is the spec-compliant extension point.
#   "reasoning" -> model reasoning summaries
#   "tool_call" -> tool invocation / result narration
#   "progress"  -> all other progress narration (thinking, delegation, content)
# Values are plain strings (not the ChatterEventType enum) to avoid importing
# the enum at module load time and to keep the mapping explicit.
_A2A_EVENT_TYPE_MAP = {
    "reasoning": "reasoning",
    "tool_call": "tool_call",
    "tool_result": "tool_call",
    "thinking": "progress",
    "delegation": "progress",
    "content": "progress",
    "html_preview": "progress",
}


# =============================================================================
# Browser-Friendly GET for Agent Base URLs
# =============================================================================

@router.get("/a2a/{agent_id}")
async def get_agent_card_redirect(agent_id: str, request: Request):
    """Return agent card when browsing the A2A base URL.

    The SDK registers POST /a2a/{id} for JSON-RPC, but browsers send GET.
    This handler returns the agent card so the URL is browsable.
    """
    return await _get_dynamic_agent_card(agent_id, request)


@router.get("/a2a/{agent_id}/.well-known/agent.json")
async def get_agent_card_wellknown(agent_id: str, request: Request):
    """Serve agent card at the standard A2A well-known path.

    The A2A SDK client (A2ACardResolver) fetches /.well-known/agent.json
    for discovery, but the SDK server only registers agent-card.json.
    This dynamic handler ensures discovery works for all agents
    (including those added after startup).
    """
    return await _get_dynamic_agent_card(agent_id, request)


async def _get_dynamic_agent_card(agent_id: str, request: Request):
    """Build and return an agent card from Cosmos DB for any agent."""
    base_url = _get_base_url(request)
    agents = await cosmos_service.list_agents()
    agent_config = next((a for a in agents if a.get("id") == agent_id), None)
    if not agent_config:
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "Agent not found"}, status_code=404)
    card = build_agent_card(agent_config, base_url)
    return card.model_dump(by_alias=True)


# =============================================================================
# A2A SDK Integration
# =============================================================================

class AuthContextBuilder(CallContextBuilder):
    """Extracts user auth token from the HTTP request into ServerCallContext.

    This allows the AgentExecutor to access the user's bearer token for
    MCP tool authentication passthrough.
    """

    def build(self, request: StarletteRequest) -> ServerCallContext:
        context = ServerCallContext()
        context.state["user_token"] = getattr(request.state, "token", None)
        return context


class ChatAgentExecutor(AgentExecutor):
    """Bridges agent_manager.execute_single() to the A2A SDK's EventQueue.

    Each instance handles a single agent. The execute() method:
    1. Extracts text from the incoming A2A message
    2. Calls agent_manager.execute_single() to run the agent
    3. Enqueues the response as an A2A Message to the EventQueue

    The SDK's DefaultRequestHandler then handles task lifecycle,
    JSON-RPC formatting, and SSE streaming automatically.
    """

    def __init__(self, agent_id: str):
        self.agent_id = agent_id

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        from services.agent_manager import agent_manager, ChatterEvent, ChatterEventType

        # Extract text from incoming A2A message parts
        input_text = context.get_user_input()
        if not input_text:
            error_msg = Message(
                role=Role.agent,
                parts=[Part(root=TextPart(text="Error: Message must contain text"))],
                message_id=str(uuid.uuid4()),
            )
            await event_queue.enqueue_event(error_msg)
            return

        # Get user token from call context for MCP tool passthrough
        user_token = None
        if context.call_context:
            user_token = context.call_context.state.get("user_token")

        if should_log_a2a():
            logger.info(
                f"A2A executing agent {self.agent_id}, "
                f"token present: {user_token is not None}, "
                f"message: {input_text[:100]}..."
            )

        # Resolve task/context IDs for status updates
        task_id = context.task_id or str(uuid.uuid4())
        context_id = context.context_id or str(uuid.uuid4())

        # Execute the agent via agent_manager with chatter enabled
        messages = [{"role": "user", "content": input_text}]
        chunks = []
        try:
            async for item in agent_manager.execute_single(
                self.agent_id, messages, user_token, include_chatter=True
            ):
                if isinstance(item, str):
                    chunks.append(item)
                elif isinstance(item, ChatterEvent):
                    # Emit intermediate A2A status update so streaming clients
                    # (message/stream) see real-time progress: reasoning
                    # summaries, tool calls, and progress narration.
                    #
                    # For reasoning events the actual summary text lives in
                    # item.content — friendly_message is only the generic label
                    # "Reasoning..." — so prefer content there. For other event
                    # kinds the friendly_message is the human-readable narration.
                    if item.type == ChatterEventType.REASONING:
                        narration_text = item.content or item.friendly_message or ""
                    else:
                        narration_text = item.friendly_message or item.content or ""

                    if not narration_text.strip():
                        continue

                    # Tag intent via Message.metadata.type so external callers
                    # can distinguish reasoning vs. narration and render them
                    # distinctly. A2A has no first-class reasoning field, so
                    # metadata is the spec-compliant extension point. Values are
                    # collapsed to the contract the caller parses:
                    #   "reasoning"  -> model reasoning summaries
                    #   "tool_call"  -> tool invocation / result narration
                    #   "progress"   -> all other progress narration
                    event_type = _A2A_EVENT_TYPE_MAP.get(item.type.value, "progress")
                    status_metadata: dict = {"type": event_type}
                    if item.tool_name:
                        status_metadata["tool_name"] = item.tool_name
                    if item.call_id:
                        status_metadata["call_id"] = item.call_id

                    status_message = Message(
                        role=Role.agent,
                        parts=[Part(root=TextPart(text=narration_text))],
                        message_id=str(uuid.uuid4()),
                        metadata=status_metadata,
                    )
                    try:
                        await event_queue.enqueue_event(
                            TaskStatusUpdateEvent(
                                task_id=task_id,
                                context_id=context_id,
                                final=False,
                                status=TaskStatus(
                                    state=TaskState.working,
                                    message=status_message,
                                ),
                            )
                        )
                    except Exception as status_err:
                        # Don't break execution if status update fails
                        if should_log_a2a():
                            logger.debug(f"A2A status update skipped: {status_err}")
        except Exception as e:
            logger.error(f"A2A agent {self.agent_id} execution error: {e}", exc_info=True)
            error_msg = Message(
                role=Role.agent,
                parts=[Part(root=TextPart(text=f"Error: {str(e)}"))],
                message_id=str(uuid.uuid4()),
            )
            await event_queue.enqueue_event(error_msg)
            return

        response_text = "".join(chunks)

        if should_log_a2a():
            logger.info(f"A2A agent {self.agent_id} completed: {len(response_text)} chars")

        # Enqueue response as A2A Message — the SDK handles task lifecycle
        response_message = Message(
            role=Role.agent,
            parts=[Part(root=TextPart(text=response_text))],
            message_id=str(uuid.uuid4()),
        )
        await event_queue.enqueue_event(response_message)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Cancel is not currently supported."""
        logger.warning(f"Cancel requested for agent {self.agent_id} — not supported")

    @staticmethod
    def _extract_text(context: RequestContext) -> str:
        """Extract text content from A2A message parts."""
        return context.get_user_input()


# =============================================================================
# Agent Card Builder
# =============================================================================

def _get_base_url(request: Request = None) -> str:
    """Get base URL for agent card URLs.

    Resolution order:
      1. An explicitly-configured ``BACKEND_URL`` (settings.backend_url) that is
         NOT the localhost development default.
      2. The host the request actually arrived on, derived from the
         X-Forwarded-Proto / X-Forwarded-Host headers set by the Azure App
         Service ingress (falling back to the raw request URL).
      3. The localhost development default for startup-time card generation
         when no request context is available.

    The localhost default is treated as "not configured" so that a deployed
    backend whose BACKEND_URL env var was not set still advertises its real
    public hostname instead of emitting ``http://localhost:5000`` in the card.
    """
    configured = getattr(settings, "backend_url", "") or ""
    configured = configured.rstrip("/")
    if configured and configured != "http://localhost:5000":
        return configured

    if request:
        scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
        host = request.headers.get("x-forwarded-host", request.url.netloc)
        return f"{scheme}://{host}"

    # Fallback for startup-time generation (no request, no explicit config)
    return configured or "http://localhost:5000"


def build_agent_card(agent_config: dict, base_url: str) -> AgentCard:
    """Build an SDK AgentCard from a database agent configuration."""
    agent_id = agent_config.get("id", "unknown")

    return AgentCard(
        name=agent_config.get("name", "Agent"),
        description=agent_config.get("description", ""),
        url=f"{base_url}/a2a/{agent_id}",
        version="1.0",
        capabilities=AgentCapabilities(streaming=True),
        skills=[AgentSkill(
            id=agent_id,
            name=agent_config.get("name", "Agent"),
            description=agent_config.get("description", ""),
            tags=[],
        )],
        default_input_modes=["text"],
        default_output_modes=["text"],
    )


# =============================================================================
# A2A Server Manager
# =============================================================================

class A2AServerManager:
    """Manages per-agent A2A endpoints using the SDK.

    For each local agent, creates:
    - A ChatAgentExecutor (bridges to agent_manager)
    - A DefaultRequestHandler (handles A2A protocol: tasks, JSON-RPC)
    - Routes added to the main FastAPI app via A2AFastAPIApplication

    This replaces ~400 lines of custom JSON-RPC/model code with SDK calls.
    """

    def __init__(self):
        self._apps: dict[str, A2AFastAPIApplication] = {}
        self._context_builder = AuthContextBuilder()

    async def mount_agents(self, app: FastAPI) -> None:
        """Register A2A routes for all local agents on the FastAPI app."""
        base_url = _get_base_url()
        agents = await cosmos_service.list_agents()
        local_agents = [
            a for a in agents
            if a.get("agent_type", "local") == "local" and a.get("a2a_enabled", True)
        ]

        count = 0
        for agent_config in local_agents:
            try:
                self._register_agent(app, agent_config, base_url)
                count += 1
            except Exception as e:
                logger.error(
                    f"Failed to register A2A routes for agent {agent_config.get('id')}: {e}",
                    exc_info=True,
                )

        logger.info(f"A2A server: registered {count} agent endpoint(s)")

    def _register_agent(self, app: FastAPI, agent_config: dict, base_url: str) -> None:
        """Register A2A SDK routes for a single agent."""
        agent_id = agent_config["id"]
        agent_name = agent_config.get("name", "Agent")

        # Build SDK components
        card = build_agent_card(agent_config, base_url)
        executor = ChatAgentExecutor(agent_id)
        task_store = InMemoryTaskStore()
        queue_manager = InMemoryQueueManager()

        handler = DefaultRequestHandler(
            agent_executor=executor,
            task_store=task_store,
            queue_manager=queue_manager,
        )

        a2a_app = A2AFastAPIApplication(
            agent_card=card,
            http_handler=handler,
            context_builder=self._context_builder,
        )

        # Add routes directly to the main app with per-agent URL paths
        a2a_app.add_routes_to_app(
            app,
            agent_card_url=f"/a2a/{agent_id}/.well-known/agent-card.json",
            rpc_url=f"/a2a/{agent_id}",
        )

        self._apps[agent_id] = a2a_app

        if should_log_a2a():
            logger.info(
                f"  A2A: {agent_name} -> POST /a2a/{agent_id} "
                f"| GET /a2a/{agent_id}/.well-known/agent-card.json"
            )


# Singleton
a2a_server = A2AServerManager()


# =============================================================================
# Global Discovery Endpoint
# =============================================================================

@router.get("/.well-known/agent.json")
async def get_all_agent_cards(request: Request):
    """
    Well-known endpoint for A2A agent discovery.
    Returns agent cards for all local agents that have a2a_enabled=True.
    """
    base_url = _get_base_url(request)
    agents = await cosmos_service.list_agents()

    local_agents = [
        a for a in agents
        if a.get("agent_type", "local") == "local" and a.get("a2a_enabled", True)
    ]

    cards = [build_agent_card(a, base_url).model_dump(by_alias=True) for a in local_agents]

    if should_log_a2a():
        logger.info(f"A2A discovery: returning {len(cards)} agent cards")

    return {"agents": cards, "count": len(cards)}



