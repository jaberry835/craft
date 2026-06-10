"""
Agent Manager
Creates and orchestrates agents using Microsoft Agent Framework.
Supports dynamic agent configuration and multiple orchestration patterns.

This is the core module; heavy logic is delegated to:
  - services.chatter          (ChatterEvent, ChatterEventType, extract_chatter_from_update)
  - services.orchestration     (AgentResponse, run_orchestrator_for_*)
  - services.workflow_runner   (execute_specialists_with_pattern)
"""
from typing import Optional, AsyncIterator, Union
from enum import Enum
import asyncio
import re
import time
from functools import partial

from agent_framework import Agent, AgentSession, Message, Content

from agent_framework.openai import OpenAIChatCompletionClient, OpenAIChatClient

from config import get_settings, get_azure_credential
from observability import (
    get_logger, track_performance, should_log_agent, should_log_a2a, MetricType
)
from services.cosmos_service import cosmos_service
from services.mcp_client import mcp_client
from services.a2a_client import a2a_client, A2A_AVAILABLE
from services.grounding_service import grounding_service
from services.context_providers import CosmosHistoryProvider, DocumentRAGProvider
from services.embedding_service import embedding_service
from services.search_service import search_service

# ---------------------------------------------------------------------------
# Re-export public types from extracted sub-modules so existing import sites
# (routes/chat_routes.py, routes/a2a_routes.py, etc.) keep working unchanged.
# ---------------------------------------------------------------------------
from services.chatter import (                       # noqa: F401
    ChatterEvent,
    ChatterEventType,
    ProgressDirectiveBuffer,
    extract_progress_updates,
    extract_chatter_from_update,
)
from services.orchestration import (                 # noqa: F401
    AgentResponse,
    run_orchestrator_for_analysis,
    run_orchestrator_for_evaluation,
    run_orchestrator_for_synthesis,
)
from services.workflow_runner import (               # noqa: F401
    execute_specialists_with_pattern,
)

settings = get_settings()
logger = get_logger(__name__)


class OrchestrationPattern(str, Enum):
    """Supported orchestration patterns."""
    SINGLE = "single"           # Single agent
    SEQUENTIAL = "sequential"   # Agents run in sequence
    CONCURRENT = "concurrent"   # Agents run in parallel
    MAGENTIC = "magentic"       # Magentic-One pattern
    GROUP_CHAT = "group_chat"   # Round-robin group chat


# Regex for ```html_preview ... ``` blocks emitted by agents.
_HTML_PREVIEW_RE = re.compile(r"```html_preview\s*\n(.*?)```", re.DOTALL)


def _get_ui_capabilities(agent_config: Optional[dict]) -> dict[str, bool]:
    """Return normalized UI capability flags for an agent config."""
    config = agent_config or {}
    caps = config.get("ui_capabilities") or {}
    return {
        "html_preview": bool(caps.get("html_preview", False)),
        "structured_input_form": bool(caps.get("structured_input_form", False)),
    }


def _build_ui_capability_instructions(agent_config: Optional[dict]) -> str:
    """Build optional prompt guidance for enabled UI capabilities."""
    caps = _get_ui_capabilities(agent_config)
    sections: list[str] = []

    if caps["html_preview"]:
        sections.append("""
=== UI CAPABILITY: HTML PREVIEW ===
You may open the HTML preview side panel when the user should review a complete HTML page.
- To open the preview, return the FULL HTML document in a fenced code block with the language html_preview
- Example:
```html_preview
<!DOCTYPE html>
<html>
...complete page...
</html>
```
- Use html_preview only for real HTML page previews, not for snippets or non-HTML content
- When the user requests revisions, update the existing draft and return a full replacement page in a fresh html_preview block
===================================""")

    if caps["structured_input_form"]:
        sections.append("""
=== UI CAPABILITY: STRUCTURED INPUT FORM ===
You may ask the chat UI to render a structured input form when you need the user to fill in several fields.
- To trigger the form, return a fenced code block with the language structured_input_form containing JSON.
- Example:
```structured_input_form
{
    "fields": [
        { "label": "Project Display Name", "hint": "example: Genesis" },
        { "label": "Description", "hint": "brief summary", "type": "textarea" },
        { "label": "Owner", "hint": "name or email" }
    ]
}
```
- Use the form only when structured input is actually needed to continue the task
- Keep labels concise and concrete
- Supported field types: text, textarea, date, email, url, number
- When the user submits the form, their answers will come back as markdown lines like:
  **Field Name**: value
===========================================""")

    return "\n\n".join(section.strip("\n") for section in sections if section)


def _extract_html_previews(text: str) -> tuple[str, list[str]]:
    """Extract html_preview code blocks from text.

    Returns:
        (cleaned_text, list_of_html_strings)
        cleaned_text has the fenced blocks replaced with a placeholder.
    """
    previews: list[str] = []
    def _replace(m: re.Match) -> str:
        previews.append(m.group(1).strip())
        return "_\u2705 HTML preview opened in side panel_"
    cleaned = _HTML_PREVIEW_RE.sub(_replace, text)
    return cleaned, previews


def _convert_to_chat_messages(messages: list[dict]) -> list[Message]:
    """Convert dict messages to Message objects for the agent framework."""
    chat_messages = []
    for msg in messages:
        role_str = msg.get("role", "user").lower()
        # Map role string directly (rc1 uses plain strings for roles)
        if role_str in ("user", "assistant", "system"):
            role = role_str
        else:
            role = "user"

        content = msg.get("content", "")
        chat_messages.append(Message(role, [content] if content else []))
    return chat_messages


class AgentManager:
    """Manages agent creation and orchestration."""

    def __init__(self):
        self._credential = None
        self._agents_cache: dict[str, Agent] = {}
        self._configs_cache: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize the agent manager."""
        # Use centralized credential helper (AzureCliCredential for dev, ManagedIdentityCredential for prod)
        self._credential = get_azure_credential()
        env_mode = "dev" if settings.environment == "development" else "prod"
        if should_log_agent():
            logger.info(f"Using {type(self._credential).__name__} for Azure OpenAI ({env_mode} mode)")

        # Initialize grounding service for document file search
        await grounding_service.initialize()
        if grounding_service.is_available:
            logger.info("Grounding service available for document search")

        await self.refresh_agents()
        if should_log_agent():
            logger.info("Agent Manager initialized")

    async def refresh_agents(self) -> None:
        """Reload agent configurations from CosmosDB."""
        async with self._lock:
            configs = await cosmos_service.list_agents()

            # Load AOAI endpoints to attach to agents
            aoai_endpoints = await cosmos_service.list_aoai_endpoints()
            aoai_endpoints_map = {e["id"]: e for e in aoai_endpoints}

            # Enhance agent configs with their AOAI endpoint config
            for config in configs:
                aoai_endpoint_id = config.get("aoai_endpoint_id")
                if aoai_endpoint_id and aoai_endpoint_id in aoai_endpoints_map:
                    config["_aoai_endpoint_config"] = aoai_endpoints_map[aoai_endpoint_id]

            self._configs_cache = {c["id"]: c for c in configs}
            self._agents_cache.clear()  # Force recreation
            if should_log_agent():
                logger.info(f"Loaded {len(configs)} agent configurations with {len(aoai_endpoints)} AOAI endpoints")

    # =====================================================================
    # Token / Chat Client helpers
    # =====================================================================

    def _get_token_provider(self):
        """Get a token provider function for Azure OpenAI.

        Uses the configured cognitive services scope from settings.
        Azure Commercial: https://cognitiveservices.azure.com/.default
        Azure Government: https://cognitiveservices.azure.us/.default
        """
        scope = settings.azure_cognitive_services_scope

        def get_token() -> str:
            token = self._credential.get_token(scope)
            return token.token

        return get_token

    def _create_chat_client(self, agent_config: dict):
        """Create Azure OpenAI chat client for an agent.

        Uses the agent's configured AOAI endpoint if specified, otherwise falls back
        to the global settings from environment variables.

        The endpoint's ``endpoint_type`` selects the client class:
          - ``azure_openai`` / ``apim`` -> ``OpenAIChatCompletionClient`` (chat/completions)
          - ``azure_openai_responses`` / ``apim_responses`` -> ``OpenAIChatClient`` (Responses API)

        Returns:
            ``OpenAIChatCompletionClient`` or ``OpenAIChatClient`` instance.

        Raises:
            ValueError: If the agent does not have a model/deployment configured.
        """
        # Model/deployment is required for each agent - no global default
        deployment_name = agent_config.get("model")
        agent_name = agent_config.get("name", "Unknown")

        if not deployment_name:
            raise ValueError(
                f"Agent '{agent_name}' does not have a model/deployment configured. "
                f"Please configure the Azure OpenAI deployment name in the Admin UI."
            )

        # Check if agent has a specific AOAI endpoint configured
        aoai_endpoint_id = agent_config.get("aoai_endpoint_id")
        endpoint_url = settings.azure_openai_endpoint
        api_key = settings.azure_openai_key
        api_version = settings.azure_openai_api_version
        endpoint_type = "azure_openai"  # default when falling back to global env settings

        if aoai_endpoint_id:
            cached_endpoint = agent_config.get("_aoai_endpoint_config")
            if cached_endpoint:
                endpoint_url = cached_endpoint.get("endpoint", endpoint_url)
                cached_key = cached_endpoint.get("api_key")
                if cached_key:
                    api_key = cached_key
                    logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': using API key from AOAI endpoint config "
                                f"(endpoint_id={aoai_endpoint_id})")
                else:
                    logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': AOAI endpoint config has NO api_key "
                                f"(endpoint_id={aoai_endpoint_id}), will use token auth")
                if cached_endpoint.get("api_version"):
                    api_version = cached_endpoint.get("api_version")
                cloud = cached_endpoint.get("cloud", "unknown")
                endpoint_type = cached_endpoint.get("endpoint_type", "azure_openai")
                logger.info(f"[AOAI-CONFIG] Using custom AOAI endpoint for agent '{agent_name}': "
                            f"type={endpoint_type}, endpoint={endpoint_url}, cloud={cloud}, api_version={api_version}")
            else:
                logger.warning(f"[AOAI-CONFIG] Agent '{agent_name}' has aoai_endpoint_id={aoai_endpoint_id} "
                               f"but NO cached endpoint config found! Using global defaults. "
                               f"Try refreshing agents from Admin UI.")
        else:
            logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': no aoai_endpoint_id, using global defaults")

        # Determine auth method and log the decision
        auth_method = "api_key" if api_key else "token_provider"
        scope = settings.azure_cognitive_services_scope if not api_key else "N/A"
        logger.info(f"[AOAI-CONFIG] Creating chat client for agent '{agent_name}': "
                    f"endpoint={endpoint_url}, deployment={deployment_name}, "
                    f"api_version={api_version}, auth={auth_method}, "
                    f"endpoint_type={endpoint_type}, "
                    f"has_api_key={bool(api_key)}, token_scope={scope}")

        # Choose client class based on endpoint type:
        #   *_responses -> OpenAIChatClient (Responses API surface)
        #   otherwise   -> OpenAIChatCompletionClient (chat/completions surface)
        use_responses = endpoint_type in ("azure_openai_responses", "apim_responses")
        client_cls = OpenAIChatClient if use_responses else OpenAIChatCompletionClient

        # The SDK auto-appends '/openai/v1' to azure_endpoint for Responses
        # clients (and '/openai/deployments/...' for chat-completions clients).
        # When the configured URL already contains '/openai/v1' (typical for
        # APIM-fronted Responses endpoints) we must pass it via base_url
        # instead, otherwise we get '/openai/v1/openai/v1/responses' -> 404.
        normalized_url = (endpoint_url or "").rstrip("/")
        url_has_openai_v1 = "/openai/v1" in normalized_url.lower()
        endpoint_kwargs: dict = {}
        extra_headers: dict[str, str] = {}
        if use_responses and url_has_openai_v1:
            # Use base_url; SDK won't append anything further.
            endpoint_kwargs["base_url"] = normalized_url + "/"
            # When base_url is used the SDK constructs a plain AsyncOpenAI
            # client which sends the key as 'Authorization: Bearer ...'. APIM
            # (and Azure OpenAI key auth) expects the 'api-key' header, so
            # add it explicitly when an api_key is configured.
            if api_key:
                extra_headers["api-key"] = api_key
        else:
            endpoint_kwargs["azure_endpoint"] = endpoint_url

        # Use API key if available, otherwise use token provider
        if api_key:
            logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': authenticating with API key "
                        f"(client={client_cls.__name__}, "
                        f"url_kwarg={'base_url' if 'base_url' in endpoint_kwargs else 'azure_endpoint'}, "
                        f"extra_api_key_header={bool(extra_headers)})")
            return client_cls(
                model=deployment_name,
                api_key=api_key,
                api_version=api_version,
                default_headers=extra_headers or None,
                **endpoint_kwargs,
            )
        else:
            logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': authenticating with credential "
                        f"(scope={settings.azure_cognitive_services_scope}, client={client_cls.__name__}, "
                        f"url_kwarg={'base_url' if 'base_url' in endpoint_kwargs else 'azure_endpoint'})")
            return client_cls(
                model=deployment_name,
                credential=self._get_token_provider(),
                api_version=api_version,
                **endpoint_kwargs,
            )

    @staticmethod
    def _is_reasoning_model(deployment_name: str) -> bool:
        """Return True for deployment names that map to reasoning-capable
        OpenAI models (gpt-5*, o-series like o1/o3/o4).

        Deployment names are operator-chosen and often carry a project prefix
        (e.g. ``project-name-gpt-5.4`` or ``team_o3-mini``), so we match the
        model token anywhere in the name rather than requiring it at the start.
        """
        if not deployment_name:
            return False
        name = deployment_name.lower()
        # gpt-5 family anywhere in the name (handles prefixed deployments).
        if re.search(r"gpt-5", name):
            return True
        # o-series (o1, o1-mini, o3, o3-mini, o4-mini, ...) at a word boundary
        # so we don't match 'omni'-style names or letters mid-word.
        return bool(re.search(r"(?:^|[-_/])o\d+(?:-|$)", name))

    @staticmethod
    def default_options_for_agent(agent_config: dict) -> Optional[dict]:
        """Build per-agent default chat options.

        Currently used to opt-in to streaming reasoning summaries on the
        Responses API for reasoning-capable models (gpt-5*, o-series). The
        returned dict is suitable for passing to ``Agent(default_options=...)``
        and is forwarded verbatim to ``client.responses.create(...)``.
        Returns None when no special options apply.
        """
        # Schema matches what _create_chat_client reads:
        #   - deployment is at agent_config["model"]
        #   - endpoint_type is at agent_config["_aoai_endpoint_config"]["endpoint_type"]
        endpoint_cfg = agent_config.get("_aoai_endpoint_config") or {}
        endpoint_type = (endpoint_cfg.get("endpoint_type") or "").lower()
        deployment = agent_config.get("model") or ""
        use_responses = endpoint_type in ("azure_openai_responses", "apim_responses")
        if not use_responses:
            return None

        # Reasoning effort is configurable per-agent in Cosmos:
        #   "reasoning_effort": "" (auto) | "low" | "medium" | "high" | "none"
        raw_effort = (agent_config.get("reasoning_effort") or "").lower().strip()

        # Explicit opt-out: admin selected "None" to disable reasoning even on a
        # reasoning-capable model.
        if raw_effort in ("none", "off", "disabled"):
            return None

        # Decide whether to request reasoning. An explicit effort selection by
        # the admin (low/medium/high) is treated as intent to use reasoning,
        # even when the deployment name doesn't look like a known reasoning
        # model (e.g. a custom name like "project-name-gpt-5.4"). Otherwise we
        # fall back to name-based detection.
        explicit = raw_effort in ("low", "medium", "high")
        if not explicit and not AgentManager._is_reasoning_model(deployment):
            return None

        effort = raw_effort if explicit else "medium"
        return {
            "reasoning": {"effort": effort, "summary": "auto"},
        }

    # =====================================================================
    # Agent creation
    # =====================================================================

    async def _create_specialist_agent(
        self,
        agent_config: dict,
        user_token: Optional[str] = None,
        context_providers: Optional[list] = None,
    ) -> Agent:
        """Create a specialist Agent with MCP tools and optional grounding.

        Args:
            agent_config: Agent configuration from Cosmos DB.
            user_token: Optional user auth token for MCP/A2A pass-through.
            context_providers: Optional list of BaseContextProvider instances
                (e.g. CosmosHistoryProvider, DocumentRAGProvider) so the
                framework automatically loads conversation history and RAG
                context into the agent's run.
        """
        # Specialist agents get MCP tools
        tools = await mcp_client.get_tools_for_agent(agent_config, user_token)
        if tools is None:
            tools = []

        # Add knowledge base search tool if grounding sources are configured
        grounding_sources = agent_config.get("grounding_sources", [])
        grounding_index = agent_config.get("grounding_index_name")
        if grounding_sources and grounding_index and grounding_service.is_available:
            # Check if this is an external (BYOI) index
            has_external = any(s.get("type") == "external" for s in grounding_sources)
            index_override = grounding_index if has_external else None

            # Create a search tool that queries the agent's grounded documents
            # Pass user_token so the tool can apply SS token security filtering
            search_tool = grounding_service.create_search_tool(
                agent_id=agent_config.get("id", ""),
                agent_name=agent_config.get("name", "Agent"),
                user_token=user_token,
                index_name_override=index_override
            )
            tools.append(search_tool)
            if should_log_agent():
                source_names = [s.get("name") or s.get("container_url") for s in grounding_sources]
                logger.info(f"Added knowledge base search tool for agent '{agent_config.get('name')}' with sources: {source_names}")

        # Create chat client
        chat_client = self._create_chat_client(agent_config)

        # Sanitize agent name for OpenAI API compatibility
        # OpenAI requires name to match pattern: ^[^\s<|\\/>]+$ (no whitespace or special chars)
        raw_name = agent_config.get("name", "Agent")
        sanitized_name = raw_name.replace(" ", "_").replace("<", "").replace(">", "").replace("|", "").replace("/", "").replace("\\", "")

        # Get base instructions and add action-oriented suffix
        base_instructions = agent_config.get("system_prompt", "You are a helpful assistant.")
        capability_instructions = _build_ui_capability_instructions(agent_config)

        # Add directive to be proactive and not ask for clarification
        action_suffix = """

=== EXECUTION DIRECTIVE ===
You are being called as a specialist by an orchestrator agent. The user's request has already been validated.
- DO NOT ask for clarification - take action immediately using your tools
- DO NOT ask "would you like me to..." - just do it
- If information is missing, use your tools to discover it (list databases, list tables, etc.)
- If you're unsure which resource to use, try the most likely ones
- Provide results, not questions

=== PROGRESS NARRATION STYLE ===
While you work, keep your visible narration concise, useful, and action-oriented like an expert coding assistant.
- If you want to send a progress update to the UI while you work, emit it in a fenced block using the language progress
- Example:
```progress
Checking the available options before I make a recommendation.
```
- Prefer emitting one brief progress update near the start of the task that states what you are about to do
- If something meaningful changes, you may emit one additional short update describing what you learned or what you are doing next
- Keep each progress update short, concrete, and specific to what you are doing right now
- Use progress updates only when they add real signal
- Do NOT reveal private chain-of-thought or long hidden reasoning
- Do NOT flood the user with repetitive commentary
==========================="""

        enhanced_instructions = base_instructions
        if capability_instructions:
            enhanced_instructions += "\n\n" + capability_instructions
        enhanced_instructions += action_suffix

        # Build the agent
        default_options = self.default_options_for_agent(agent_config)
        if default_options:
            logger.info(f"[AOAI-CONFIG] Agent '{sanitized_name}': enabling reasoning "
                        f"summary stream (default_options={default_options})")
        agent = Agent(
            name=sanitized_name,
            description=agent_config.get("description", ""),
            instructions=enhanced_instructions,
            client=chat_client,
            tools=tools if tools else None,
            context_providers=context_providers,
            default_options=default_options,
        )

        return agent

    async def _create_agent(
        self,
        agent_config: dict,
        user_token: Optional[str] = None
    ) -> Agent:
        """
        Create an agent from configuration.

        Handles both local Agent and external A2AAgent based on agent_type.
        Both implement the same AgentProtocol, so they're interchangeable.
        """
        agent_type = agent_config.get("agent_type", "local")

        if agent_type == "a2a":
            # External A2A agent - use SDK with auth support
            if not A2A_AVAILABLE:
                raise RuntimeError(
                    f"Cannot create A2A agent '{agent_config.get('name')}': "
                    "A2A packages not installed. Run: pip install agent-framework-a2a a2a-sdk"
                )
            return a2a_client.create_a2a_agent(agent_config, user_token)
        else:
            # Local Agent (default)
            return await self._create_specialist_agent(agent_config, user_token)

    async def get_agent(
        self,
        agent_id: str,
        user_token: Optional[str] = None
    ) -> Optional[Agent]:
        """Get or create an agent by ID."""
        config = self._configs_cache.get(agent_id)
        if not config:
            config = await cosmos_service.get_agent(agent_id)
            if config:
                self._configs_cache[agent_id] = config
            else:
                return None

        # Create agent (not cached due to user-specific tokens)
        return await self._create_agent(config, user_token)

    async def get_agent_config(self, agent_id: str) -> Optional[dict]:
        """Get agent configuration."""
        if agent_id in self._configs_cache:
            return self._configs_cache[agent_id]
        return await cosmos_service.get_agent(agent_id)

    # =====================================================================
    # Single-agent execution
    # =====================================================================

    @track_performance("agent_execute_single", MetricType.AGENT_EXECUTION)
    async def execute_single(
        self,
        agent_id: str,
        messages: list[dict],
        user_token: Optional[str] = None,
        include_chatter: bool = False
    ) -> AsyncIterator[Union[str, ChatterEvent]]:
        """
        Execute a single agent with streaming.

        Args:
            agent_id: The agent to execute
            messages: Chat messages
            user_token: Optional user token for auth passthrough
            include_chatter: If True, also yields ChatterEvent objects for tool calls/results

        Yields:
            str: Text content chunks
            ChatterEvent: Tool call/result events (only if include_chatter=True)
        """
        if should_log_agent():
            logger.debug(f"execute_single called for {agent_id} with token present: {user_token is not None}")
        try:
            agent = await self.get_agent(agent_id, user_token)
            if not agent:
                raise ValueError(f"Agent {agent_id} not found")

            if should_log_agent():
                logger.debug(f"Agent created: {agent.name}")

            chat_messages = _convert_to_chat_messages(messages)
            if should_log_agent():
                logger.debug(f"Starting run (stream=True) with {len(chat_messages)} messages")

            # Track tool calls for timing (shared helper state)
            seen_tool_calls: set[str] = set()
            seen_tool_results: set[str] = set()
            pending_tool_calls: dict[str, tuple[float, str, Optional[dict]]] = {}
            token_accumulator: dict[str, int] = {"input": 0, "output": 0}

            # Emit a "working" thinking event at the start
            progress_buffer = ProgressDirectiveBuffer()

            async for update in agent.run(chat_messages, stream=True):
                if update.text:
                    visible_text, progress_updates = progress_buffer.push(update.text)
                    for progress_update in progress_updates:
                        if include_chatter:
                            yield ChatterEvent(
                                type=ChatterEventType.THINKING,
                                agent_name=agent.name,
                                content=progress_update,
                                friendly_message=progress_update,
                            )
                    if visible_text:
                        yield visible_text

                # Capture tool call/result events if requested
                if include_chatter:
                    for ce in extract_chatter_from_update(
                        update, agent.name,
                        seen_tool_calls, seen_tool_results,
                        pending_tool_calls, token_accumulator,
                    ):
                        yield ce

            trailing_text = progress_buffer.finalize()
            if trailing_text:
                yield trailing_text

            # Yield a final summary event with total token usage if we have any
            if include_chatter and (token_accumulator["input"] > 0 or token_accumulator["output"] > 0):
                summary_event = ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent.name,
                    content=f"Total tokens: {token_accumulator['input']} input, {token_accumulator['output']} output",
                    tokens_input=token_accumulator["input"],
                    tokens_output=token_accumulator["output"],
                )
                yield summary_event

            if should_log_agent():
                logger.debug(f"run completed for {agent_id}")
        except Exception as e:
            logger.error(f"execute_single error for agent {agent_id}: {e}", exc_info=True)
            raise

    # =====================================================================
    # Specialist calls (local and remote)
    # =====================================================================

    async def _call_specialist_a2a(
        self,
        agent_id: str,
        message: str,
        user_token: Optional[str] = None,
        chatter_queue: Optional[asyncio.Queue] = None,
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> dict:
        """
        Call a specialist agent. For local agents, executes directly to capture
        rich chatter (tool calls, token usage, etc.). For external A2A agents,
        uses the A2A HTTP protocol.

        Returns:
            dict with keys: agent_id, agent_name, response, error (if any)
        """
        config = self._configs_cache.get(agent_id)
        if not config:
            config = await cosmos_service.get_agent(agent_id)

        if not config:
            return {"agent_id": agent_id, "agent_name": "Unknown", "response": "", "error": "Agent not found"}

        agent_name = config.get("name", "Agent")
        agent_type = config.get("agent_type", "local")

        # --- Local agents: execute directly for rich chatter ---
        if agent_type != "a2a":
            return await self._call_specialist_local(
                agent_id, agent_name, message, user_token, chatter_queue,
                session_id=session_id, user_id=user_id,
            )

        # --- External A2A agents: use HTTP protocol ---
        return await self._call_specialist_remote(
            agent_id, agent_name, config, message, user_token, chatter_queue,
            session_id=session_id, user_id=user_id,
        )

    async def _call_specialist_local(
        self,
        agent_id: str,
        agent_name: str,
        message: str,
        user_token: Optional[str],
        chatter_queue: Optional[asyncio.Queue],
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> dict:
        """
        Execute a local specialist directly with chatter streaming for
        rich tool call / token usage events.

        When ``session_id`` and ``user_id`` are provided the agent is created
        with the framework's ``CosmosHistoryProvider`` and
        ``DocumentRAGProvider`` so conversation history and RAG document
        context are loaded automatically.
        """
        if should_log_agent():
            logger.info(f"LOCAL specialist call: {agent_name} <- {message[:100]}...")

        start_time = time.time()
        try:
            config = self._configs_cache.get(agent_id)
            if not config:
                config = await cosmos_service.get_agent(agent_id)
                if config:
                    self._configs_cache[agent_id] = config
            if not config:
                raise ValueError(f"Agent {agent_id} not found")

            # ── Build context providers when session context is available ──
            has_session = bool(session_id and user_id)

            # ── Check for image attachments → build multimodal input ──
            run_input: str | Message = message
            if has_session:
                image_messages = await cosmos_service.get_session_image_messages(
                    session_id, user_id
                )
                if image_messages:
                    if should_log_agent():
                        logger.info(
                            f"Session {session_id} has {len(image_messages)} image(s), "
                            f"building multimodal input for {agent_name}"
                        )
                    # Build a Message with text + all session images
                    contents: list[Content | str] = [message]
                    for img_msg in image_messages:
                        img = img_msg.get("metadata", {}).get("image_attachment", {})
                        if img.get("base64") and img.get("content_type"):
                            data_uri = f"data:{img['content_type']};base64,{img['base64']}"
                            contents.append(
                                Content.from_uri(data_uri, media_type=img["content_type"])
                            )
                    if len(contents) > 1:
                        run_input = Message("user", contents)

            providers = None
            if has_session:
                providers = [
                    CosmosHistoryProvider(cosmos_service),
                    DocumentRAGProvider(embedding_service, search_service),
                ]

            # Create the specialist agent with framework context providers
            agent = await self._create_specialist_agent(
                config, user_token, context_providers=providers
            )

            # ── Prepare session state for the providers ──
            session = None
            if has_session:
                session = agent.create_session()
                session.state.setdefault("cosmos-history", {}).update({
                    "session_id": session_id,
                    "user_id": user_id,
                    "current_query": message,
                })
                session.state.setdefault("document-rag", {}).update({
                    "session_id": session_id,
                    "user_id": user_id,
                    "user_query": message,
                })

            # ── Stream the response ──
            response_parts = []
            progress_buffer = ProgressDirectiveBuffer()

            # Track tool calls for timing (shared helper state)
            seen_tool_calls: set[str] = set()
            seen_tool_results: set[str] = set()
            pending_tool_calls: dict[str, tuple[float, str, Optional[dict]]] = {}
            token_accumulator: dict[str, int] = {"input": 0, "output": 0}

            async for update in agent.run(run_input, session=session, stream=True):
                if update.text:
                    visible_text, progress_updates = progress_buffer.push(update.text)
                    if visible_text:
                        response_parts.append(visible_text)
                    if chatter_queue:
                        for progress_update in progress_updates:
                            await chatter_queue.put(ChatterEvent(
                                type=ChatterEventType.THINKING,
                                agent_name=agent_name,
                                content=progress_update,
                                friendly_message=progress_update,
                            ))

                # Capture chatter events (tool calls, results, token usage)
                if chatter_queue:
                    chatter_events = extract_chatter_from_update(
                        update, agent_name,
                        seen_tool_calls, seen_tool_results,
                        pending_tool_calls, token_accumulator,
                    )
                    for ce in chatter_events:
                        await chatter_queue.put(ce)

            trailing_text = progress_buffer.finalize()
            if trailing_text:
                response_parts.append(trailing_text)

            response_text = "".join(response_parts)
            duration_ms = (time.time() - start_time) * 1000

            if should_log_agent():
                logger.info(f"LOCAL specialist {agent_name}: {len(response_text)} chars in {duration_ms:.0f}ms")

            # Emit completion event with duration
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content="Finished preparing the specialist response.",
                    duration_ms=duration_ms,
                    friendly_message=f"{agent_name} finished in {duration_ms/1000:.1f}s"
                ))

            return {
                "agent_id": agent_id,
                "agent_name": agent_name,
                "response": response_text,
            }

        except Exception as e:
            logger.error(f"Local specialist call to {agent_name} failed: {e}", exc_info=True)
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Error: {str(e)[:200]}",
                    friendly_message=f"{agent_name} encountered an error"
                ))
            return {"agent_id": agent_id, "agent_name": agent_name, "response": "", "error": str(e)}

    async def _build_context_enriched_message(
        self,
        message: str,
        session_id: Optional[str],
        user_id: Optional[str],
        agent_name: str,
    ) -> str:
        """
        Build a context-enriched message for external A2A agents by prepending
        recent conversation history.

        Since external agents communicate via the A2A protocol (single message
        per task), they have no access to the session's chat history.  This
        method loads the last few turns from Cosmos DB and formats them as
        context so the remote agent can resolve references like "tell me more"
        or pronouns that depend on prior messages.
        """
        if not session_id or not user_id:
            return message

        try:
            raw_messages, _, _ = await cosmos_service.get_session_messages(
                session_id=session_id,
                user_id=user_id,
                page_size=10,       # last 10 messages (5 turns) is enough context
                oldest_first=True,
            )

            if not raw_messages:
                return message

            # Filter out the current message (already saved to Cosmos before
            # orchestration) to avoid duplication.
            history = [
                m for m in raw_messages
                if not (m.get("role") == "user" and m.get("content", "").strip() == message.strip())
            ]

            if not history:
                return message

            # Format as a compact conversation context block
            lines = []
            for m in history:
                role = m.get("role", "user").capitalize()
                content = m.get("content", "").strip()
                if content:
                    # Truncate very long assistant replies to keep the payload reasonable
                    if len(content) > 500:
                        content = content[:500] + "..."
                    lines.append(f"{role}: {content}")

            if not lines:
                return message

            context_block = "\n".join(lines)
            enriched = (
                f"[Conversation context — previous messages in this session]\n"
                f"{context_block}\n\n"
                f"[Current request]\n"
                f"{message}"
            )

            if should_log_a2a():
                logger.info(
                    f"A2A context enrichment for {agent_name}: "
                    f"{len(history)} history messages prepended "
                    f"({len(enriched)} chars total)"
                )
            return enriched

        except Exception as e:
            logger.warning(f"Failed to load history for A2A context enrichment: {e}")
            return message

    async def _call_specialist_remote(
        self,
        agent_id: str,
        agent_name: str,
        config: dict,
        message: str,
        user_token: Optional[str],
        chatter_queue: Optional[asyncio.Queue],
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> dict:
        """
        Call an external A2A agent via HTTP protocol with streaming.

        Uses the SDK's streaming mode so we receive incremental updates
        instead of waiting for the full response.

        When session_id/user_id are available, conversation history is loaded
        from Cosmos DB and prepended to the message so the remote agent has
        context for follow-up questions and pronoun resolution.
        """
        # Enrich the message with conversation history for context
        enriched_message = await self._build_context_enriched_message(
            message, session_id, user_id, agent_name
        )

        if should_log_a2a():
            logger.info(f"A2A CALL (remote): {agent_name} <- {enriched_message[:200]}...")

        start_time = time.time()
        try:
            agent = a2a_client.create_a2a_agent(config, user_token)

            response_parts: list[str] = []
            chunk_count = 0

            progress_buffer = ProgressDirectiveBuffer()

            async with agent:
                stream = agent.run(enriched_message, stream=True)
                async for update in stream:
                    for content_item in update.contents:
                        if hasattr(content_item, 'text') and content_item.text:
                            visible_text, progress_updates = progress_buffer.push(content_item.text)
                            if visible_text:
                                response_parts.append(visible_text)
                            chunk_count += 1
                            if chatter_queue:
                                for progress_update in progress_updates:
                                    await chatter_queue.put(ChatterEvent(
                                        type=ChatterEventType.THINKING,
                                        agent_name=agent_name,
                                        content=progress_update,
                                        friendly_message=progress_update,
                                    ))

            trailing_text = progress_buffer.finalize()
            if trailing_text:
                response_parts.append(trailing_text)

            response_text = "".join(response_parts)
            duration_ms = (time.time() - start_time) * 1000

            if should_log_a2a():
                logger.info(
                    f"A2A RESPONSE from {agent_name}: "
                    f"{response_text[:500]}{'...' if len(response_text) > 500 else ''} "
                    f"({chunk_count} chunks)"
                )

            # Emit completion event
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content="Finished preparing the specialist response.",
                    duration_ms=duration_ms,
                    friendly_message=f"{agent_name} responded in {duration_ms/1000:.1f}s"
                ))

            return {
                "agent_id": agent_id,
                "agent_name": agent_name,
                "response": response_text,
            }

        except Exception as e:
            logger.error(f"A2A call to {agent_name} failed: {e}")
            duration_ms = (time.time() - start_time) * 1000
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Error: {str(e)[:200]}",
                    duration_ms=duration_ms,
                    friendly_message=f"{agent_name} encountered an error",
                ))
            return {"agent_id": agent_id, "agent_name": agent_name, "response": "", "error": str(e)}

    # =====================================================================
    # Two-Phase Orchestration (Analysis → Pattern Execution → Synthesis)
    # Delegates heavy lifting to services.orchestration and
    # services.workflow_runner while keeping the streaming event loop here.
    # =====================================================================

    @track_performance("agent_execute_orchestration", MetricType.AGENT_EXECUTION)
    async def execute_orchestration(
        self,
        pattern: OrchestrationPattern,
        agent_ids: list[str],
        user_message: str,
        session_id: str,
        user_id: str,
        user_token: Optional[str] = None,
        preview_context: Optional[dict] = None,
        max_rounds: int = 10,
    ) -> AsyncIterator[AgentResponse]:
        """
        Execute agents using Two-Phase Orchestration with pattern-controlled execution.

        Conversation history and RAG document context are loaded automatically
        by the Agent Framework's context-provider system (CosmosHistoryProvider
        and DocumentRAGProvider).

        Phase 1 (Analysis): Orchestrator analyzes request and decides action.
        Phase 2 (Execution): Execute specialists using the session's pattern.
        Phase 3 (Synthesis): Orchestrator synthesizes specialist results.
        """
        if not agent_ids:
            raise ValueError("No agents specified for orchestration")

        # Find orchestrator and specialist agents
        orchestrator_config = None
        specialist_configs = []

        for agent_id in agent_ids:
            config = self._configs_cache.get(agent_id)
            if not config:
                config = await cosmos_service.get_agent(agent_id)
                if config:
                    self._configs_cache[agent_id] = config

            if config:
                if config.get("is_orchestrator", False):
                    orchestrator_config = config
                else:
                    specialist_configs.append(config)

        # Require orchestrator for two-phase pattern
        if not orchestrator_config:
            raise ValueError("An orchestrator agent is required. Please select an orchestrator in your session.")

        # Create chatter queue for real-time events
        chatter_queue: asyncio.Queue[ChatterEvent] = asyncio.Queue()

        # Single selected orchestrator mode: let the orchestrator execute directly
        # with its own tools, grounding, history, and preview flow.
        if len(agent_ids) == 1 and not specialist_configs:
            if should_log_agent():
                logger.info(
                    f"Single orchestrator mode: executing {orchestrator_config.get('name', 'Orchestrator')} directly"
                )

            agent_name = orchestrator_config.get("name", "Orchestrator")
            agent_id = orchestrator_config.get("id", "orchestrator")
            agent_type = orchestrator_config.get("agent_type", "local")

            yield ChatterEvent(
                type=ChatterEventType.THINKING,
                agent_name=agent_name,
                agent_id=agent_id,
                content="Running in single-agent orchestrator mode...",
                friendly_message=f"{agent_name} is handling this request directly"
            )

            if agent_type != "a2a":
                single_task = asyncio.create_task(
                    self._call_specialist_local(
                        agent_id,
                        agent_name,
                        user_message,
                        user_token,
                        chatter_queue,
                        session_id=session_id,
                        user_id=user_id,
                    )
                )
            else:
                single_task = asyncio.create_task(
                    self._call_specialist_remote(
                        agent_id,
                        agent_name,
                        orchestrator_config,
                        user_message,
                        user_token,
                        chatter_queue,
                        session_id=session_id,
                        user_id=user_id,
                    )
                )

            while not single_task.done():
                try:
                    event = await asyncio.wait_for(chatter_queue.get(), timeout=0.1)
                    yield event
                except asyncio.TimeoutError:
                    continue
                except asyncio.QueueEmpty:
                    await asyncio.sleep(0.05)

            single_result = await single_task

            while not chatter_queue.empty():
                try:
                    event = chatter_queue.get_nowait()
                    yield event
                except asyncio.QueueEmpty:
                    break

            response_text = single_result.get("response", "")
            if single_result.get("error") and not response_text:
                response_text = f"Error: {single_result['error']}"

            cleaned, html_previews = _extract_html_previews(response_text)
            for html in html_previews:
                yield ChatterEvent(
                    type=ChatterEventType.HTML_PREVIEW,
                    agent_name=agent_name,
                    agent_id=agent_id,
                    content=html,
                    friendly_message="Showing HTML preview",
                )

            yield AgentResponse(
                agent_id=agent_id,
                agent_name=agent_name,
                content=cleaned if html_previews else response_text,
                tokens_used=0,
                metadata={
                    "pattern": pattern.value,
                    "action": "single_orchestrator",
                },
                chatter_events=[]
            )
            return

        if should_log_agent():
            logger.info(f"Two-Phase Orchestration: pattern={pattern.value}, specialists={len(specialist_configs)}")

        # =================================================================
        # Phase 1: Analysis
        # =================================================================
        if should_log_agent():
            logger.info("Phase 1: Orchestrator analyzing request...")

        yield ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content="Analyzing request...",
            friendly_message="Determining how to handle your request"
        )

        decision_chatter_queue: asyncio.Queue = asyncio.Queue()
        decision_task = asyncio.create_task(run_orchestrator_for_analysis(
            orchestrator_config,
            specialist_configs,
            user_message,
            session_id,
            user_id,
            preview_context,
            create_chat_client_fn=self._create_chat_client,
            cosmos_service=cosmos_service,
            embedding_service=embedding_service,
            search_service=search_service,
            chatter_emitter=lambda ev: decision_chatter_queue.put_nowait(ev),
        ))
        # Drain queued chatter events while the analyzer streams. Use a short
        # poll so we don't block the task; loop exits once task is done AND
        # queue is empty.
        while not decision_task.done() or not decision_chatter_queue.empty():
            try:
                ev = await asyncio.wait_for(decision_chatter_queue.get(), timeout=0.05)
                yield ev
            except asyncio.TimeoutError:
                continue
        decision = await decision_task

        if should_log_agent():
            ctx_query = decision.get('contextualized_query', '')
            logger.info(
                f"Phase 1 decision: action={decision.get('action')}, "
                f"specialists={decision.get('specialists', [])}"
                + (f", contextualized_query={ctx_query[:120]}" if ctx_query else "")
            )

        # Emit decision result event
        reasoning = decision.get("reasoning", "")
        action = decision.get("action", "unknown")
        if action == "delegate":
            specialist_names = []
            for sid in decision.get("specialists", []):
                sc = self._configs_cache.get(sid, {})
                specialist_names.append(sc.get("name", sid))
            decision_msg = f"Decision: delegate to {', '.join(specialist_names)}" if specialist_names else f"Decision: {action}"
            if reasoning:
                decision_msg += f" — {reasoning}"
        else:
            decision_msg = f"Decision: answer directly"
            if reasoning:
                decision_msg += f" — {reasoning}"

        yield ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=decision_msg,
            friendly_message=decision_msg,
            tokens_input=decision.get("tokens_input"),
            tokens_output=decision.get("tokens_output"),
        )

        # =================================================================
        # Handle Direct Response (no specialists needed)
        # =================================================================
        if decision.get("action") == "direct":
            direct_response, _ = extract_progress_updates(decision.get("direct_response", ""))

            # Extract html_preview blocks from direct responses
            cleaned, html_previews = _extract_html_previews(direct_response)
            for html in html_previews:
                yield ChatterEvent(
                    type=ChatterEventType.HTML_PREVIEW,
                    agent_name=orchestrator_config.get("name", "Orchestrator"),
                    agent_id=orchestrator_config.get("id"),
                    content=html,
                    friendly_message="Showing HTML preview",
                )

            yield AgentResponse(
                agent_id=orchestrator_config.get("id", "orchestrator"),
                agent_name=orchestrator_config.get("name", "Orchestrator"),
                content=cleaned if html_previews else direct_response,
                tokens_used=(decision.get("tokens_input", 0) or 0) + (decision.get("tokens_output", 0) or 0),
                metadata={
                    "pattern": pattern.value,
                    "action": "direct",
                    "reasoning": decision.get("reasoning", "")
                },
                chatter_events=[]
            )
            return

        # =================================================================
        # Phase 2: Pattern Execution
        # =================================================================
        if pattern == OrchestrationPattern.MAGENTIC:
            specialist_ids = [c.get("id") for c in specialist_configs if c.get("id")]
            if should_log_agent():
                logger.info(f"Magentic pattern: including ALL {len(specialist_ids)} selected specialists")
        else:
            specialist_ids = decision.get("specialists", [])

        if not specialist_ids:
            direct_response = decision.get("direct_response", "I'm not sure which specialist can help with this request.")
            yield AgentResponse(
                agent_id=orchestrator_config.get("id", "orchestrator"),
                agent_name=orchestrator_config.get("name", "Orchestrator"),
                content=direct_response,
                tokens_used=(decision.get("tokens_input", 0) or 0) + (decision.get("tokens_output", 0) or 0),
                metadata={"pattern": pattern.value, "action": "direct_fallback"},
                chatter_events=[]
            )
            return

        if should_log_agent():
            logger.info(f"Phase 2: Executing {len(specialist_ids)} specialists with pattern={pattern.value}")

        # Use the orchestrator's contextualized query (if available) so that
        # specialists — especially external A2A agents with no access to chat
        # history — receive a fully self-contained, disambiguated message.
        specialist_message = decision.get("contextualized_query") or user_message
        specialist_queries = decision.get("specialist_queries") or {}
        if specialist_message != user_message and should_log_agent():
            logger.info(f"Using contextualized query for specialists: {specialist_message[:200]}")
        if specialist_queries and should_log_agent():
            for sid, sq in specialist_queries.items():
                logger.info(f"Per-specialist query [{sid[:20]}]: {sq[:120]}")

        specialist_names: list[str] = []
        for sid in specialist_ids:
            sc = self._configs_cache.get(sid, {})
            specialist_names.append(sc.get("name", sid))

        if specialist_names:
            if len(specialist_names) == 1:
                coordination_detail = (
                    f"I'm going to ask {specialist_names[0]} to handle the specialist part of this request, "
                    f"review the result, and then combine it into the final answer."
                )
            else:
                coordination_detail = (
                    f"I'm going to coordinate {', '.join(specialist_names)} using the {pattern.value} pattern, "
                    f"review what each specialist returns, and then synthesize a final answer."
                )
        else:
            coordination_detail = (
                f"I'm going to coordinate the selected specialists using the {pattern.value} pattern, "
                f"review their results, and then synthesize a final answer."
            )

        yield ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=coordination_detail,
            friendly_message=f"Coordinating {len(specialist_ids)} specialist(s)"
        )

        orchestrator_name = orchestrator_config.get("name", "Orchestrator")
        for specialist_name in specialist_names:
            delegation_detail = (
                f"Delegated a focused task to {specialist_name}: "
                f"{specialist_message[:220]}{'...' if len(specialist_message) > 220 else ''}"
            )
            yield ChatterEvent(
                type=ChatterEventType.DELEGATION,
                agent_name=orchestrator_name,
                content=delegation_detail,
                friendly_message=f"Asking {specialist_name}",
            )

        # Wrap evaluation function so workflow_runner can call it with 4 args
        run_eval = partial(
            run_orchestrator_for_evaluation,
            create_chat_client_fn=self._create_chat_client,
        )

        # Execute specialists in a background task and stream chatter events
        specialist_task = asyncio.create_task(
            execute_specialists_with_pattern(
                pattern=pattern.value,
                specialist_ids=specialist_ids,
                user_message=specialist_message,
                configs_cache=self._configs_cache,
                create_specialist_agent_fn=self._create_specialist_agent,
                call_specialist_a2a_fn=self._call_specialist_a2a,
                user_token=user_token,
                chatter_queue=chatter_queue,
                max_rounds=max_rounds,
                orchestrator_config=orchestrator_config,
                session_id=session_id,
                user_id=user_id,
                cosmos_service=cosmos_service,
                embedding_service=embedding_service,
                search_service=search_service,
                run_evaluation_fn=run_eval,
                specialist_queries=specialist_queries,
            )
        )

        # Stream chatter events as they arrive from specialists
        while not specialist_task.done():
            try:
                event = await asyncio.wait_for(chatter_queue.get(), timeout=0.1)
                yield event
            except asyncio.TimeoutError:
                continue
            except asyncio.QueueEmpty:
                await asyncio.sleep(0.05)

        # Get the result (raises if the task errored)
        specialist_results = await specialist_task

        # Drain any remaining events
        while not chatter_queue.empty():
            try:
                event = chatter_queue.get_nowait()
                yield event
            except asyncio.QueueEmpty:
                break

        if should_log_agent():
            logger.info(f"Phase 2 complete: received {len(specialist_results)} specialist responses")

        # =================================================================
        # Extract html_preview blocks from specialist responses BEFORE
        # synthesis so the LLM doesn't rewrite/strip them.
        # =================================================================
        for result in specialist_results:
            raw_response = result.get("response", "")
            source_config = self._configs_cache.get(result.get("agent_id"), {})
            cleaned, html_previews = _extract_html_previews(raw_response)
            if html_previews:
                # Replace the specialist response with cleaned text for synthesis
                result["response"] = cleaned
                # Emit each preview as a ChatterEvent so chat_routes can forward it
                for html in html_previews:
                    yield ChatterEvent(
                        type=ChatterEventType.HTML_PREVIEW,
                        agent_name=result.get("agent_name", "Agent"),
                        agent_id=result.get("agent_id"),
                        content=html,
                        friendly_message="Showing HTML preview",
                    )

        # =================================================================
        # Phase 3: Synthesis
        # =================================================================
        if should_log_agent():
            logger.info("Phase 3: Orchestrator synthesizing results...")

        yield ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=(
                f"Reviewing {' and '.join(specialist_names)} and drafting the final answer..."
                if specialist_names and len(specialist_names) <= 2
                else "Reviewing specialist results and drafting the final answer..."
            ),
            friendly_message="Combining results into final answer"
        )

        synth_chatter_queue: asyncio.Queue = asyncio.Queue()
        synth_task = asyncio.create_task(run_orchestrator_for_synthesis(
            orchestrator_config,
            specialist_results,
            user_message,
            create_chat_client_fn=self._create_chat_client,
            chatter_emitter=lambda ev: synth_chatter_queue.put_nowait(ev),
        ))
        while not synth_task.done() or not synth_chatter_queue.empty():
            try:
                ev = await asyncio.wait_for(synth_chatter_queue.get(), timeout=0.05)
                yield ev
            except asyncio.TimeoutError:
                continue
        synthesis_result = await synth_task

        yield ChatterEvent(
            type=ChatterEventType.CONTENT,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=(
                f"Reviewed {', '.join(specialist_names)} and prepared the final answer."
                if specialist_names
                else "Prepared the final answer."
            ),
            friendly_message="Prepared final answer",
            tokens_input=synthesis_result.get("tokens_input"),
            tokens_output=synthesis_result.get("tokens_output"),
        )

        # Build final response — also extract any html_preview the synthesizer kept
        synthesis_content, _ = extract_progress_updates(synthesis_result.get("content", ""))
        synth_cleaned, synth_previews = _extract_html_previews(synthesis_content)
        for html in synth_previews:
            yield ChatterEvent(
                type=ChatterEventType.HTML_PREVIEW,
                agent_name=orchestrator_config.get("name", "Orchestrator"),
                agent_id=orchestrator_config.get("id"),
                content=html,
                friendly_message="Showing HTML preview",
            )

        total_tokens = sum(r.get("tokens_input", 0) + r.get("tokens_output", 0) for r in specialist_results)
        total_tokens += (decision.get("tokens_input", 0) or 0) + (decision.get("tokens_output", 0) or 0)
        total_tokens += (synthesis_result.get("tokens_input", 0) or 0) + (synthesis_result.get("tokens_output", 0) or 0)

        yield AgentResponse(
            agent_id=orchestrator_config.get("id", "orchestrator"),
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=synth_cleaned if synth_previews else synthesis_content,
            tokens_used=total_tokens,
            metadata={
                "pattern": pattern.value,
                "action": "delegate_and_synthesize",
                "specialists_called": [r.get("agent_name") for r in specialist_results],
                "specialist_count": len(specialist_results)
            },
            chatter_events=[]
        )

    async def close(self) -> None:
        """Cleanup resources."""
        self._agents_cache.clear()
        self._configs_cache.clear()


# Global instance
agent_manager = AgentManager()
