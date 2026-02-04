"""
Agent Manager
Creates and orchestrates agents using Microsoft Agent Framework.
Supports dynamic agent configuration and multiple orchestration patterns.
"""
from typing import Optional, AsyncIterator, Union, Annotated, Callable, Any
from dataclasses import dataclass, field
from enum import Enum
import asyncio
import time

from agent_framework import ChatAgent, ChatMessage, Role, FunctionCallContent, FunctionResultContent, TextContent, UsageContent, ai_function, AIFunction
from agent_framework.azure import AzureOpenAIChatClient

# Note: Workflow orchestration is handled manually below
# The agent_framework may have different workflow APIs

from config import get_settings, get_azure_credential
from observability import (
    get_logger, track_performance, should_log_performance, should_log_agent, should_log_a2a,
    AOAIPerformanceTracker, MetricType, log_performance_summary
)
from services.cosmos_service import cosmos_service
from services.mcp_client import mcp_client
from services.a2a_client import a2a_client, A2A_AVAILABLE

settings = get_settings()
logger = get_logger(__name__)


class OrchestrationPattern(str, Enum):
    """Supported orchestration patterns."""
    SINGLE = "single"           # Single agent
    SEQUENTIAL = "sequential"   # Agents run in sequence
    CONCURRENT = "concurrent"   # Agents run in parallel
    MAGENTIC = "magentic"       # Magentic-One pattern
    GROUP_CHAT = "group_chat"   # Round-robin group chat


class ChatterEventType(str, Enum):
    """Types of agent chatter events streamed to the UI."""
    THINKING = "thinking"           # Agent is processing
    TOOL_CALL = "tool_call"         # Agent is calling a tool/function
    TOOL_RESULT = "tool_result"     # Tool returned a result
    DELEGATION = "delegation"       # Orchestrator delegating to specialist
    CONTENT = "content"             # Actual content/text output


def _get_friendly_tool_description(tool_name: str, tool_args: Optional[dict] = None) -> str:
    """
    Generate a user-friendly description of what a tool is doing.
    Converts technical tool names into human-readable activity descriptions.
    """
    # Common tool name patterns -> friendly descriptions
    tool_patterns = {
        # Database/Query operations
        'query': 'Querying data',
        'search': 'Searching for information',
        'lookup': 'Looking up information',
        'get': 'Retrieving data',
        'fetch': 'Fetching information',
        'list': 'Listing available items',
        'read': 'Reading data',
        
        # Write operations
        'create': 'Creating a new record',
        'insert': 'Adding new data',
        'update': 'Updating information',
        'delete': 'Removing data',
        'write': 'Writing data',
        
        # Analysis operations
        'analyze': 'Analyzing data',
        'calculate': 'Running calculations',
        'aggregate': 'Aggregating results',
        'summarize': 'Summarizing information',
        'compare': 'Comparing data',
        
        # Data retrieval
        'database': 'Querying the database',
        'table': 'Accessing table data',
        'execute': 'Executing operation',
        'run': 'Running operation',
        
        # API operations
        'api': 'Calling external service',
        'request': 'Making a request',
        'call': 'Making a call',
        
        # Document operations
        'document': 'Processing documents',
        'file': 'Accessing files',
        'content': 'Retrieving content',
    }
    
    tool_lower = tool_name.lower()
    
    # Try to match patterns
    for pattern, description in tool_patterns.items():
        if pattern in tool_lower:
            # Add context from args if available
            if tool_args:
                if 'query' in tool_args:
                    query_preview = str(tool_args['query'])[:50]
                    if len(str(tool_args['query'])) > 50:
                        query_preview += '...'
                    return f"{description}: \"{query_preview}\""
                elif 'table' in tool_args or 'table_name' in tool_args:
                    table = tool_args.get('table') or tool_args.get('table_name')
                    return f"{description} from {table}"
                elif 'database' in tool_args or 'db' in tool_args:
                    db = tool_args.get('database') or tool_args.get('db')
                    return f"{description} in {db}"
            return description
    
    # Fallback: humanize the tool name
    # Convert snake_case or camelCase to readable text
    readable_name = tool_name.replace('_', ' ').replace('-', ' ')
    # Add spaces before capitals in camelCase
    import re
    readable_name = re.sub(r'([a-z])([A-Z])', r'\1 \2', readable_name)
    return f"Running {readable_name.lower()}"


def _get_friendly_result_summary(tool_name: str, result_text: str) -> str:
    """
    Generate a user-friendly summary of a tool result.
    """
    # Count approximate items if result looks like a list or table
    if not result_text:
        return "Completed successfully"
    
    # Check if result has multiple lines (could be rows of data)
    lines = result_text.strip().split('\n')
    if len(lines) > 2:
        return f"Retrieved {len(lines)} results"
    
    # Check for JSON array-like patterns
    if result_text.count('[') > 0 and result_text.count(']') > 0:
        # Try to estimate count
        comma_count = result_text.count(',')
        if comma_count > 0:
            return f"Retrieved approximately {comma_count + 1} items"
    
    # Short result - just say completed
    if len(result_text) < 100:
        return "Completed"
    
    return f"Retrieved {len(result_text)} characters of data"


@dataclass
class ChatterEvent:
    """Intermediate event during agent execution for streaming to UI."""
    type: ChatterEventType
    agent_name: str
    content: str = ""
    tool_name: Optional[str] = None
    tool_args: Optional[dict] = None
    timestamp: float = field(default_factory=time.time)
    duration_ms: Optional[float] = None  # Duration of tool execution
    tokens_input: Optional[int] = None   # Input tokens used (for LLM calls)
    tokens_output: Optional[int] = None  # Output tokens used (for LLM calls)
    friendly_message: Optional[str] = None  # User-friendly description of the action
    
    @staticmethod
    def extract_result_text(result: Any) -> str:
        """
        Extract text from various result types.
        Handles TextContent objects, lists, dicts, and primitives.
        """
        if result is None:
            return ""
        
        # Handle TextContent objects
        if hasattr(result, 'text'):
            return str(result.text)
        
        # Handle lists (of TextContent or other items)
        if isinstance(result, list):
            parts = []
            for item in result:
                if hasattr(item, 'text'):
                    parts.append(str(item.text))
                elif isinstance(item, str):
                    parts.append(item)
                else:
                    parts.append(str(item))
            return " ".join(parts)
        
        # Handle dicts
        if isinstance(result, dict):
            if 'text' in result:
                return str(result['text'])
            return str(result)
        
        # Default to string conversion
        return str(result)
    
    def to_dict(self) -> dict:
        """Convert to dict for JSON serialization."""
        result = {
            "type": self.type.value,
            "agent_name": self.agent_name,
            "content": self.content,
            "timestamp": self.timestamp
        }
        if self.tool_name:
            result["tool_name"] = self.tool_name
        if self.tool_args:
            result["tool_args"] = self.tool_args
        if self.duration_ms is not None:
            result["duration_ms"] = round(self.duration_ms, 1)
        if self.tokens_input is not None:
            result["tokens_input"] = self.tokens_input
        if self.tokens_output is not None:
            result["tokens_output"] = self.tokens_output
        if self.friendly_message:
            result["friendly_message"] = self.friendly_message
        return result


@dataclass
class AgentResponse:
    """Response from agent execution."""
    agent_id: str
    agent_name: str
    content: str
    tokens_used: int
    metadata: dict
    chatter_events: list[ChatterEvent] = field(default_factory=list)


def _convert_to_chat_messages(messages: list[dict]) -> list[ChatMessage]:
    """Convert dict messages to ChatMessage objects for the agent framework."""
    chat_messages = []
    for msg in messages:
        role_str = msg.get("role", "user").lower()
        # Map role string to Role enum
        if role_str == "user":
            role = Role.USER
        elif role_str == "assistant":
            role = Role.ASSISTANT
        elif role_str == "system":
            role = Role.SYSTEM
        else:
            role = Role.USER
        
        chat_messages.append(ChatMessage(role=role, text=msg.get("content", "")))
    return chat_messages


class AgentManager:
    """Manages agent creation and orchestration."""
    
    # Limit concurrent specialist agent executions to avoid overwhelming Azure OpenAI
    # When the orchestrator calls multiple specialists in parallel, this serializes them
    MAX_CONCURRENT_SPECIALISTS = 2
    
    def __init__(self):
        self._credential = None
        self._agents_cache: dict[str, ChatAgent] = {}
        self._configs_cache: dict[str, dict] = {}
        self._lock = asyncio.Lock()
        self._specialist_semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_SPECIALISTS)
    
    async def initialize(self) -> None:
        """Initialize the agent manager."""
        # Use centralized credential helper (AzureCliCredential for dev, ManagedIdentityCredential for prod)
        self._credential = get_azure_credential()
        env_mode = "dev" if settings.environment == "development" else "prod"
        if should_log_agent():
            logger.info(f"Using {type(self._credential).__name__} for Azure OpenAI ({env_mode} mode)")
        
        await self.refresh_agents()
        if should_log_agent():
            logger.info("Agent Manager initialized")
    
    async def refresh_agents(self) -> None:
        """Reload agent configurations from CosmosDB."""
        async with self._lock:
            configs = await cosmos_service.list_agents()
            self._configs_cache = {c["id"]: c for c in configs}
            self._agents_cache.clear()  # Force recreation
            if should_log_agent():
                logger.info(f"Loaded {len(configs)} agent configurations")
    
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
    
    def _create_chat_client(self, agent_config: dict) -> AzureOpenAIChatClient:
        """Create Azure OpenAI chat client for an agent.
        
        Raises:
            ValueError: If the agent does not have a model/deployment configured.
        """
        # Model/deployment is required for each agent - no global default
        deployment_name = agent_config.get("model")
        if not deployment_name:
            agent_name = agent_config.get("name", "Unknown")
            raise ValueError(
                f"Agent '{agent_name}' does not have a model/deployment configured. "
                f"Please configure the Azure OpenAI deployment name in the Admin UI."
            )
        
        # Use API key if available, otherwise use token provider
        if settings.azure_openai_key:
            return AzureOpenAIChatClient(
                endpoint=settings.azure_openai_endpoint,
                deployment_name=deployment_name,
                api_key=settings.azure_openai_key
            )
        else:
            # Use token provider with Azure Government scope
            return AzureOpenAIChatClient(
                endpoint=settings.azure_openai_endpoint,
                deployment_name=deployment_name,
                ad_token_provider=self._get_token_provider()
            )
    
    async def _create_specialist_agent(
        self,
        agent_config: dict,
        user_token: Optional[str] = None
    ) -> ChatAgent:
        """Create a specialist ChatAgent with MCP tools."""
        # Specialist agents get MCP tools
        tools = await mcp_client.get_tools_for_agent(agent_config, user_token)
        
        # Create chat client
        chat_client = self._create_chat_client(agent_config)
        
        # Sanitize agent name for OpenAI API compatibility
        # OpenAI requires name to match pattern: ^[^\s<|\\/>]+$ (no whitespace or special chars)
        raw_name = agent_config.get("name", "Agent")
        sanitized_name = raw_name.replace(" ", "_").replace("<", "").replace(">", "").replace("|", "").replace("/", "").replace("\\", "")
        
        # Get base instructions and add action-oriented suffix
        base_instructions = agent_config.get("system_prompt", "You are a helpful assistant.")
        
        # Add directive to be proactive and not ask for clarification
        action_suffix = """

=== EXECUTION DIRECTIVE ===
You are being called as a specialist by an orchestrator agent. The user's request has already been validated.
- DO NOT ask for clarification - take action immediately using your tools
- DO NOT ask "would you like me to..." - just do it
- If information is missing, use your tools to discover it (list databases, list tables, etc.)
- If you're unsure which resource to use, try the most likely ones
- Provide results, not questions
==========================="""
        
        enhanced_instructions = base_instructions + action_suffix
        
        # Build the agent
        agent = ChatAgent(
            name=sanitized_name,
            description=agent_config.get("description", ""),
            instructions=enhanced_instructions,
            chat_client=chat_client,
            tools=tools if tools else None
        )
        
        return agent
    
    async def _create_orchestrator_agent(
        self,
        orchestrator_config: dict,
        specialist_agent_ids: list[str],
        user_token: Optional[str] = None,
        chatter_queue: Optional[asyncio.Queue] = None
    ) -> ChatAgent:
        """
        Create an orchestrator agent with A2A tools to call specialist agents.
        
        All specialist agents (local and external) are called via A2A protocol.
        Local agents are exposed at /a2a/{agent_id} endpoints, allowing:
        - Consistent A2A protocol for all agent communication
        - Local agents discoverable and callable by external systems
        - Same code path for local and external agent orchestration
        
        When chatter_queue is provided, uses custom tool wrappers that capture
        streaming events from specialist agents.
        """
        # Determine the base URL for local A2A endpoints
        # Uses BACKEND_URL from environment (defaults to localhost:5000 for dev)
        local_base_url = settings.backend_url
        
        if should_log_agent():
            logger.debug(f"Creating orchestrator with user_token present: {user_token is not None}, A2A base URL: {local_base_url}")
        
        # Create specialist agents as tools
        agent_tools = []
        agent_descriptions = []
        
        for agent_id in specialist_agent_ids:
            config = self._configs_cache.get(agent_id)
            if not config:
                config = await cosmos_service.get_agent(agent_id)
            
            if config and config.get("id") != orchestrator_config.get("id"):
                agent_type = config.get("agent_type", "local")
                
                # Use custom chatter-capturing wrapper that makes direct A2A HTTP calls
                if chatter_queue:
                    agent_tool = self._create_a2a_tool_with_chatter(
                        config, chatter_queue, user_token
                    )
                else:
                    # Fallback: create A2AAgent and use as_tool() (no chatter capture)
                    if agent_type == "a2a":
                        if A2A_AVAILABLE:
                            specialist = a2a_client.create_a2a_agent(config)
                        else:
                            if should_log_a2a():
                                logger.warning(f"Skipping external A2A agent {config.get('name')} - A2A not available")
                            continue
                    else:
                        if A2A_AVAILABLE:
                            specialist = a2a_client.create_local_a2a_agent(config, local_base_url, user_token)
                        else:
                            specialist = await self._create_specialist_agent(config, user_token)
                    
                    agent_tool = specialist.as_tool(
                        name=config.get("name", "agent").replace(" ", "_").lower(),
                        description=config.get("description", f"Specialist agent: {config.get('name')}")
                    )
                
                agent_tools.append(agent_tool)
                agent_descriptions.append(f"- {config.get('name')}: {config.get('description', 'No description')}")
        
        # Build context about available agents for the orchestrator's prompt
        if agent_descriptions:
            # When specialists exist, provide the list
            agent_context = "=== AVAILABLE SPECIALIST AGENTS ===\n" + "\n".join(agent_descriptions)
            agent_context += "\n\nYou can delegate tasks to these agents by calling them as tools."
            agent_context += "\n=================================\n\n"
        else:
            # When no specialists exist, tell orchestrator to answer directly
            agent_context = """=== AGENT AVAILABILITY STATUS ===
NO SPECIALIST AGENTS ARE CURRENTLY REGISTERED.

Since no specialist agents are available, you MUST answer all questions directly yourself.
Do not say you will delegate - there is no one to delegate to.
Answer the user's question to the best of your ability.
=================================

"""
        
        # Put agent context BEFORE the base instructions so the orchestrator knows the situation first
        base_instructions = orchestrator_config.get("system_prompt", "You are a helpful assistant.")
        enhanced_instructions = agent_context + base_instructions
        
        # Debug: log the full instructions
        if should_log_agent():
            logger.debug(f"Orchestrator enhanced instructions:\n{enhanced_instructions}")
        
        # Create chat client
        chat_client = self._create_chat_client(orchestrator_config)
        
        # Sanitize orchestrator name for OpenAI API compatibility
        raw_name = orchestrator_config.get("name", "Orchestrator")
        sanitized_name = raw_name.replace(" ", "_").replace("<", "").replace(">", "").replace("|", "").replace("/", "").replace("\\", "")
        
        # Build orchestrator with specialist agents as tools
        orchestrator = ChatAgent(
            name=sanitized_name,
            description=orchestrator_config.get("description", ""),
            instructions=enhanced_instructions,
            chat_client=chat_client,
            tools=agent_tools if agent_tools else None
        )
        
        if should_log_agent():
            logger.info(f"Created orchestrator with {len(agent_tools)} specialist agent tools (A2A mode: {A2A_AVAILABLE})")
        return orchestrator
    
    def _create_a2a_tool_with_chatter(
        self,
        config: dict,
        chatter_queue: asyncio.Queue,
        user_token: Optional[str] = None
    ) -> AIFunction:
        """
        Create a custom tool wrapper for an A2A agent that captures chatter events.
        
        Uses direct HTTP calls to the A2A endpoint to get the full response 
        including metadata with tool call/result events from the remote agent.
        This provides visibility into what the specialist agent is doing.
        """
        agent_name = config.get("name", "Agent")
        agent_id = config.get("id", "")
        tool_name = agent_name.replace(" ", "_").lower()
        base_description = config.get("description", f"Specialist agent: {agent_name}")
        tool_description = f"{base_description}. Pass the user's request directly without adding commentary or assumptions - this agent has its own tools to discover needed information."
        
        # Build A2A URL for direct calls
        agent_type = config.get("agent_type", "local")
        if agent_type == "a2a":
            a2a_url = config.get("a2a_url", "")
        else:
            # Local agent - build A2A URL from backend_url setting
            a2a_url = f"{settings.backend_url.rstrip('/')}/a2a/{agent_id}"
        
        async def call_a2a_specialist(request: Annotated[str, "The user's exact request or question. Pass it directly without modification or commentary."]) -> str:
            """Execute the A2A agent via direct HTTP call to capture all events."""
            if should_log_a2a():
                logger.info(f"A2A CALL: {agent_name} <- {request[:100]}...")
            
            start_time = time.time()
            
            # Emit delegation event showing what request is being sent
            delegation_event = ChatterEvent(
                type=ChatterEventType.DELEGATION,
                agent_name=agent_name,
                content=request[:200] + ("..." if len(request) > 200 else "")
            )
            await chatter_queue.put(delegation_event)
            
            # Emit thinking event
            thinking_event = ChatterEvent(
                type=ChatterEventType.THINKING,
                agent_name=agent_name,
                content=f"Working on request..."
            )
            await chatter_queue.put(thinking_event)
            
            try:
                # Use direct HTTP call to get full response with metadata
                result = await a2a_client.call_agent_direct(
                    agent_url=a2a_url,
                    message=request,
                    user_token=user_token
                )
                
                if result.get("error"):
                    logger.error(f"A2A CALL ERROR: {agent_name}: {result['error']}")
                    return f"Error calling {agent_name}: {result['error']}"
                
                # Emit chatter events from the remote agent
                for event_data in result.get("chatter_events", []):
                    try:
                        event_type_str = event_data.get("type", "thinking")
                        event_type = ChatterEventType(event_type_str)
                        
                        event = ChatterEvent(
                            type=event_type,
                            agent_name=agent_name,  # Prefix with source agent name
                            content=event_data.get("content", ""),
                            tool_name=event_data.get("tool_name"),
                            tool_args=event_data.get("tool_args"),
                            duration_ms=event_data.get("duration_ms"),
                            tokens_input=event_data.get("tokens_input"),
                            tokens_output=event_data.get("tokens_output")
                        )
                        await chatter_queue.put(event)
                    except Exception as e:
                        logger.warning(f"Failed to emit chatter event: {e}")
                
                final_response = result.get("text", "")
                total_duration_ms = result.get("duration_ms") or ((time.time() - start_time) * 1000)
                
                # Emit completion event with total duration
                complete_event = ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Completed ({len(final_response)} chars)",
                    duration_ms=total_duration_ms
                )
                await chatter_queue.put(complete_event)
                
                if should_log_a2a():
                    logger.info(f"A2A CALL: {agent_name} -> response length={len(final_response)}, events={len(result.get('chatter_events', []))}")
                return final_response
                
            except Exception as e:
                logger.error(f"A2A CALL ERROR: {agent_name}: {type(e).__name__}: {e}")
                return f"Error calling {agent_name}: {str(e)}"
        
        return AIFunction(
            name=tool_name,
            description=tool_description,
            func=call_a2a_specialist,
            additional_properties={}
        )

    async def _create_agent(
        self,
        agent_config: dict,
        user_token: Optional[str] = None
    ) -> ChatAgent:
        """
        Create an agent from configuration.
        
        Handles both local ChatAgent and external A2AAgent based on agent_type.
        Both implement the same AgentProtocol, so they're interchangeable.
        """
        agent_type = agent_config.get("agent_type", "local")
        
        if agent_type == "a2a":
            # External A2A agent
            if not A2A_AVAILABLE:
                raise RuntimeError(
                    f"Cannot create A2A agent '{agent_config.get('name')}': "
                    "A2A packages not installed. Run: pip install agent-framework-a2a a2a"
                )
            return a2a_client.create_a2a_agent(agent_config)
        else:
            # Local ChatAgent (default)
            return await self._create_specialist_agent(agent_config, user_token)
    
    async def get_agent(
        self,
        agent_id: str,
        user_token: Optional[str] = None
    ) -> Optional[ChatAgent]:
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
                logger.debug(f"Starting run_stream with {len(chat_messages)} messages")
            
            # Track tool calls for timing
            seen_tool_calls: set[str] = set()
            seen_tool_results: set[str] = set()
            pending_tool_calls: dict[str, tuple[float, str, Optional[dict]]] = {}  # call_id -> (start_time, tool_name, tool_args)
            total_tokens_input = 0
            total_tokens_output = 0
            
            async for update in agent.run_stream(chat_messages):
                if update.text:
                    yield update.text
                
                # Capture tool call/result events if requested
                if include_chatter and hasattr(update, 'contents') and update.contents:
                    for content_item in update.contents:
                        if isinstance(content_item, FunctionCallContent):
                            call_id = getattr(content_item, 'call_id', None)
                            tool_name = getattr(content_item, 'name', None)
                            tool_args = getattr(content_item, 'arguments', None)
                            
                            if call_id and tool_name and call_id not in seen_tool_calls:
                                seen_tool_calls.add(call_id)
                                args_dict = tool_args if isinstance(tool_args, dict) else None
                                pending_tool_calls[call_id] = (time.time(), tool_name, args_dict)
                                
                                # Generate user-friendly description
                                friendly_msg = _get_friendly_tool_description(tool_name, args_dict)
                                
                                event = ChatterEvent(
                                    type=ChatterEventType.TOOL_CALL,
                                    agent_name=agent.name,
                                    content=f"Calling {tool_name}",
                                    tool_name=tool_name,
                                    tool_args=args_dict,
                                    friendly_message=friendly_msg
                                )
                                yield event
                        
                        elif isinstance(content_item, FunctionResultContent):
                            call_id = getattr(content_item, 'call_id', None)
                            result = getattr(content_item, 'result', None)
                            
                            if call_id and call_id not in seen_tool_results:
                                seen_tool_results.add(call_id)
                                
                                # Calculate duration
                                duration_ms = None
                                tool_name_result = None
                                if call_id in pending_tool_calls:
                                    start_time, tool_name_result, _ = pending_tool_calls[call_id]
                                    duration_ms = (time.time() - start_time) * 1000
                                
                                # Format result for display - extract text from TextContent objects
                                result_display = ChatterEvent.extract_result_text(result)
                                if len(result_display) > 300:
                                    result_display = result_display[:300] + "..."
                                
                                # Generate user-friendly result summary
                                friendly_msg = _get_friendly_result_summary(tool_name_result or "", result_display)
                                
                                event = ChatterEvent(
                                    type=ChatterEventType.TOOL_RESULT,
                                    agent_name=agent.name,
                                    content=result_display or "Result received",
                                    tool_name=tool_name_result,
                                    duration_ms=duration_ms,
                                    friendly_message=friendly_msg
                                )
                                yield event
                        
                        # Handle UsageContent to capture token counts
                        elif isinstance(content_item, UsageContent):
                            details = getattr(content_item, 'details', None)
                            if details:
                                uc_input = getattr(details, 'input_token_count', None)
                                uc_output = getattr(details, 'output_token_count', None)
                                if uc_input:
                                    total_tokens_input += uc_input
                                if uc_output:
                                    total_tokens_output += uc_output
                                
                                # Emit token usage as a thinking event (with friendly message)
                                if uc_input or uc_output:
                                    event = ChatterEvent(
                                        type=ChatterEventType.THINKING,
                                        agent_name=agent.name,
                                        content=f"LLM call: {uc_input or 0} input, {uc_output or 0} output tokens",
                                        tokens_input=uc_input,
                                        tokens_output=uc_output,
                                        friendly_message="Analyzing information..."
                                    )
                                    yield event
            
            # Yield a final summary event with total token usage if we have any
            if include_chatter and (total_tokens_input > 0 or total_tokens_output > 0):
                summary_event = ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent.name,
                    content=f"Total tokens: {total_tokens_input} input, {total_tokens_output} output",
                    tokens_input=total_tokens_input,
                    tokens_output=total_tokens_output
                )
                yield summary_event
                    
            if should_log_agent():
                logger.debug(f"run_stream completed for {agent_id}")
        except Exception as e:
            logger.error(f"execute_single error for agent {agent_id}: {e}", exc_info=True)
            raise
    
    # =========================================================================
    # Two-Phase Orchestration (Analysis → Pattern Execution → Synthesis)
    # =========================================================================
    
    # Default prompts used when admin doesn't provide custom prompts
    DEFAULT_ANALYSIS_PROMPT = """You are an intelligent orchestration agent that routes requests to specialist agents.

YOUR ROLE:
- Analyze each user request to determine how to handle it
- Either answer directly yourself OR delegate to specialist agents
- Output your decision in a structured format

=== AVAILABLE SPECIALIST AGENTS ===
{agent_list}
===================================

DECISION PROCESS:
1. Read the user's request carefully
2. Check if any specialist agent can handle this request
3. If YES: Identify which specialist(s) are needed
4. If NO: You will answer directly

OUTPUT FORMAT:
You MUST respond with a JSON decision block, followed by any direct response if answering yourself.

For delegation to specialists:
```json
{
  "action": "delegate",
  "specialists": ["agent_id_1", "agent_id_2"],
  "reasoning": "Brief explanation of why these specialists are needed"
}
```

For direct answer (no specialists needed):
```json
{
  "action": "direct",
  "reasoning": "Brief explanation of why you're answering directly"
}
```
[Then provide your direct answer after the JSON block]

DELEGATION RULES:
1. Delegate when the request matches a specialist's domain
2. You can delegate to MULTIPLE specialists if the request spans domains
3. When in doubt about whether a specialist can help, delegate to them
4. Generic questions (greetings, weather, time, general knowledge) = answer directly
5. Domain-specific questions (databases, APIs, documents) = delegate
"""

    DEFAULT_SYNTHESIS_PROMPT = """You are an intelligent orchestration agent synthesizing results from specialist agents.

YOUR ROLE:
- Combine responses from multiple specialist agents into a coherent answer
- Present findings clearly and concisely to the user
- Highlight key information and resolve any conflicts

SPECIALIST RESPONSES:
{specialist_responses}

SYNTHESIS RULES:
1. Combine information logically - don't just concatenate
2. If specialists provided overlapping information, merge it
3. If specialists provided conflicting information, note the discrepancy
4. If a specialist encountered an error, explain what happened
5. Present the final answer as if you gathered the information yourself
6. Use clear formatting (bullet points, sections) for complex responses
7. Do NOT mention "the specialist said" or "the agent reported" - present findings directly

FORMATTING:
- Use markdown for readability when appropriate
- For data/tables, format them clearly
- For errors, explain what went wrong and suggest next steps if possible

Provide your synthesized response to the user now:
"""

    DEFAULT_EVALUATION_PROMPT = """You are evaluating whether the specialist agents have gathered enough information to answer the user's question.

ORIGINAL USER QUESTION:
{user_question}

INFORMATION GATHERED SO FAR:
{gathered_info}

AVAILABLE SPECIALISTS:
{agent_list}

YOUR TASK:
Review what has been learned and decide if we need to investigate further.

EVALUATION CRITERIA:
1. Did we find specific information mentioned (names, companies, data)?
2. Can any of that NEW information be used to query OTHER agents?
3. Are there obvious follow-up queries that would add value?

Examples of when to continue:
- Investigator found "Dr. Smith works at Acme Corp" → ADX Agent should query for Acme Corp employees
- ADX found a list of transactions → Investigator could research the parties involved
- One agent mentioned a related entity that another agent could look up

Examples of when to STOP:
- Agents already queried with the new information
- No new entities/names/companies were discovered
- We've done 3+ rounds already
- The information gathered seems complete

RESPOND WITH JSON:
```json
{
  "continue": true/false,
  "reasoning": "Brief explanation",
  "follow_up_query": "The specific question to ask next (if continuing)",
  "target_agents": ["agent_id_1"] // Which agents should handle the follow-up
}
```
"""

    async def _run_orchestrator_for_evaluation(
        self,
        orchestrator_config: dict,
        results_so_far: list[dict],
        original_question: str,
        specialist_configs: list[dict]
    ) -> dict:
        """
        Magentic evaluation phase: Decide if more investigation rounds are needed.
        
        Returns:
            dict with keys:
                - continue: bool - whether to do another round
                - follow_up_query: str - what to ask in the next round
                - target_agents: list[str] - which agents to query
                - reasoning: str - explanation
        """
        import json as json_module
        import re
        
        # Format gathered information
        gathered_parts = []
        for result in results_so_far:
            agent_name = result.get("agent_name", "Agent")
            response = result.get("response", "")
            if response:
                gathered_parts.append(f"[{agent_name}]: {response}")
        gathered_info = "\n\n".join(gathered_parts) if gathered_parts else "No information gathered yet."
        
        # Build agent list
        agent_list = []
        agent_id_map = {}
        for config in specialist_configs:
            name = config.get("name", "Agent")
            agent_id = config.get("id", "")
            description = config.get("description", "No description")
            agent_list.append(f"- {name} (id: {agent_id}): {description}")
            agent_id_map[name.lower()] = agent_id
            agent_id_map[agent_id] = agent_id
        
        # Build evaluation prompt
        eval_prompt = self.DEFAULT_EVALUATION_PROMPT
        eval_prompt = eval_prompt.replace("{user_question}", original_question)
        eval_prompt = eval_prompt.replace("{gathered_info}", gathered_info)
        eval_prompt = eval_prompt.replace("{agent_list}", "\n".join(agent_list) if agent_list else "No specialists")
        
        # Create chat client and agent
        chat_client = self._create_chat_client(orchestrator_config)
        eval_agent = ChatAgent(
            name="Evaluator",
            description="Evaluates if more investigation is needed",
            instructions=eval_prompt,
            chat_client=chat_client
        )
        
        # Get evaluation
        eval_messages = [
            ChatMessage(role=Role.SYSTEM, text=eval_prompt),
            ChatMessage(role=Role.USER, text="Should we continue investigating or do we have enough information?")
        ]
        
        response_parts = []
        async for update in eval_agent.run_stream(eval_messages):
            if update.text:
                response_parts.append(update.text)
        
        full_response = "".join(response_parts)
        
        if should_log_agent():
            logger.info(f"Magentic evaluation response:\n{full_response[:300]}...")
        
        # Parse JSON response
        try:
            json_match = re.search(r'```json\s*\n?(.*?)\n?```', full_response, re.DOTALL)
            if json_match:
                evaluation = json_module.loads(json_match.group(1))
            else:
                json_match = re.search(r'\{[^{}]*"continue"[^{}]*\}', full_response, re.DOTALL)
                if json_match:
                    evaluation = json_module.loads(json_match.group())
                else:
                    evaluation = {"continue": False, "reasoning": "Could not parse evaluation"}
            
            # Normalize agent IDs in target_agents
            if "target_agents" in evaluation:
                normalized = []
                for spec in evaluation["target_agents"]:
                    spec_lower = spec.lower()
                    if spec_lower in agent_id_map:
                        normalized.append(agent_id_map[spec_lower])
                    elif spec in agent_id_map:
                        normalized.append(agent_id_map[spec])
                evaluation["target_agents"] = normalized
            
            return evaluation
            
        except json_module.JSONDecodeError as e:
            logger.warning(f"Failed to parse evaluation JSON: {e}")
            return {"continue": False, "reasoning": "Failed to parse evaluation"}

    async def _run_orchestrator_for_analysis(
        self,
        orchestrator_config: dict,
        specialist_configs: list[dict],
        messages: list[dict]
    ) -> dict:
        """
        Phase 1: Run orchestrator to analyze the request and decide action.
        
        Returns:
            dict with keys:
                - action: "direct" or "delegate"
                - specialists: list of agent IDs to call (if delegate)
                - reasoning: explanation of decision
                - direct_response: response text (if direct action)
        """
        import json as json_module
        import re
        
        # Build agent list for prompt
        agent_list = []
        agent_id_map = {}  # Map names to IDs for later
        for config in specialist_configs:
            name = config.get("name", "Agent")
            agent_id = config.get("id", "")
            description = config.get("description", "No description")
            agent_list.append(f"- {name} (id: {agent_id}): {description}")
            agent_id_map[name.lower()] = agent_id
            agent_id_map[agent_id] = agent_id  # Also map ID to itself
        
        # Use admin-configured analysis prompt, or default if not set
        analysis_prompt = orchestrator_config.get("analysis_prompt") or self.DEFAULT_ANALYSIS_PROMPT
        
        # Format the prompt with agent list
        analysis_prompt = analysis_prompt.replace("{agent_list}", "\n".join(agent_list) if agent_list else "No specialists available")
        
        # Create a temporary chat client for analysis
        chat_client = self._create_chat_client(orchestrator_config)
        
        # Build chat messages with analysis prompt as system
        analysis_messages = [
            ChatMessage(role=Role.SYSTEM, text=analysis_prompt)
        ]
        for msg in messages:
            role_str = msg.get("role", "user").lower()
            if role_str == "user":
                role = Role.USER
            elif role_str == "assistant":
                role = Role.ASSISTANT
            else:
                role = Role.USER
            analysis_messages.append(ChatMessage(role=role, text=msg.get("content", "")))
        
        # Create simple agent for analysis (no tools)
        analysis_agent = ChatAgent(
            name="Analyzer",
            description="Analyzes requests",
            instructions=analysis_prompt,
            chat_client=chat_client
        )
        
        # Get analysis response
        response_parts = []
        async for update in analysis_agent.run_stream(analysis_messages):
            if update.text:
                response_parts.append(update.text)
        
        full_response = "".join(response_parts)
        
        if should_log_agent():
            logger.info(f"Orchestrator analysis response:\n{full_response[:500]}...")
        
        # Parse the JSON decision from response
        try:
            # Find JSON block in response
            json_match = re.search(r'```json\s*\n?(.*?)\n?```', full_response, re.DOTALL)
            if json_match:
                decision = json_module.loads(json_match.group(1))
            else:
                # Try to find raw JSON
                json_match = re.search(r'\{[^{}]*"action"[^{}]*\}', full_response, re.DOTALL)
                if json_match:
                    decision = json_module.loads(json_match.group())
                else:
                    # No JSON found - assume direct answer
                    decision = {"action": "direct", "reasoning": "Could not parse decision"}
            
            # Extract any text after the JSON as the direct response
            if decision.get("action") == "direct":
                # Get text after the JSON block
                if json_match:
                    post_json = full_response[json_match.end():].strip()
                    if post_json:
                        decision["direct_response"] = post_json
                    else:
                        decision["direct_response"] = full_response
                else:
                    decision["direct_response"] = full_response
            
            # Normalize specialist IDs
            if decision.get("action") == "delegate":
                specialists = decision.get("specialists", [])
                normalized = []
                for spec in specialists:
                    spec_lower = spec.lower()
                    if spec_lower in agent_id_map:
                        normalized.append(agent_id_map[spec_lower])
                    elif spec in agent_id_map:
                        normalized.append(agent_id_map[spec])
                    else:
                        # Try partial match
                        for name, aid in agent_id_map.items():
                            if spec_lower in name or name in spec_lower:
                                normalized.append(aid)
                                break
                decision["specialists"] = normalized
                
                if not normalized and specialists:
                    # Couldn't match any specialists - fall back to direct
                    logger.warning(f"Could not match specialists {specialists}, falling back to direct")
                    decision["action"] = "direct"
                    decision["direct_response"] = full_response
            
            return decision
            
        except json_module.JSONDecodeError as e:
            logger.warning(f"Failed to parse orchestrator analysis JSON: {e}")
            # Fallback to direct answer
            return {
                "action": "direct",
                "reasoning": "Failed to parse decision",
                "direct_response": full_response
            }
    
    async def _call_specialist_a2a(
        self,
        agent_id: str,
        message: str,
        user_token: Optional[str] = None,
        chatter_queue: Optional[asyncio.Queue] = None
    ) -> dict:
        """
        Call a specialist agent via A2A protocol.
        
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
        
        # Build A2A URL
        if agent_type == "a2a":
            a2a_url = config.get("a2a_url", "")
        else:
            a2a_url = f"{settings.backend_url.rstrip('/')}/a2a/{agent_id}"
        
        if should_log_a2a():
            logger.info(f"A2A CALL (pattern): {agent_name} <- {message[:100]}...")
        
        # Emit delegation event
        if chatter_queue:
            delegation_event = ChatterEvent(
                type=ChatterEventType.DELEGATION,
                agent_name=agent_name,
                content=message[:200] + ("..." if len(message) > 200 else "")
            )
            await chatter_queue.put(delegation_event)
        
        try:
            result = await a2a_client.call_agent_direct(
                agent_url=a2a_url,
                message=message,
                user_token=user_token
            )
            
            if result.get("error"):
                return {"agent_id": agent_id, "agent_name": agent_name, "response": "", "error": result["error"]}
            
            # Forward chatter events
            if chatter_queue:
                for event_data in result.get("chatter_events", []):
                    try:
                        event = ChatterEvent(
                            type=ChatterEventType(event_data.get("type", "thinking")),
                            agent_name=agent_name,
                            content=event_data.get("content", ""),
                            tool_name=event_data.get("tool_name"),
                            tool_args=event_data.get("tool_args"),
                            duration_ms=event_data.get("duration_ms"),
                            tokens_input=event_data.get("tokens_input"),
                            tokens_output=event_data.get("tokens_output")
                        )
                        await chatter_queue.put(event)
                    except Exception as e:
                        logger.warning(f"Failed to emit chatter event: {e}")
            
            # Debug: Log the specialist response content
            response_text = result.get("text", "")
            if should_log_a2a():
                logger.info(f"A2A RESPONSE from {agent_name}: {response_text[:500]}{'...' if len(response_text) > 500 else ''}")
            
            return {
                "agent_id": agent_id,
                "agent_name": agent_name,
                "response": response_text,
                "tokens_input": result.get("tokens_input", 0),
                "tokens_output": result.get("tokens_output", 0)
            }
            
        except Exception as e:
            logger.error(f"A2A call to {agent_name} failed: {e}")
            return {"agent_id": agent_id, "agent_name": agent_name, "response": "", "error": str(e)}
    
    async def _execute_specialists_with_pattern(
        self,
        pattern: OrchestrationPattern,
        specialist_ids: list[str],
        user_message: str,
        user_token: Optional[str] = None,
        chatter_queue: Optional[asyncio.Queue] = None,
        max_rounds: int = 10,
        orchestrator_config: Optional[dict] = None
    ) -> list[dict]:
        """
        Phase 2: Execute specialists according to the orchestration pattern.
        
        Returns:
            list of dicts with agent_id, agent_name, response
        """
        results = []
        
        if not specialist_ids:
            return results
        
        if pattern == OrchestrationPattern.SINGLE or len(specialist_ids) == 1:
            # Single: Call just the first specialist
            result = await self._call_specialist_a2a(
                specialist_ids[0], user_message, user_token, chatter_queue
            )
            results.append(result)
        
        elif pattern == OrchestrationPattern.SEQUENTIAL:
            # Sequential: Call each in order, passing accumulated context
            accumulated_context = user_message
            for agent_id in specialist_ids:
                result = await self._call_specialist_a2a(
                    agent_id, accumulated_context, user_token, chatter_queue
                )
                results.append(result)
                # Add this response to context for next agent
                if result.get("response"):
                    accumulated_context += f"\n\n[{result['agent_name']} said]: {result['response']}"
        
        elif pattern == OrchestrationPattern.CONCURRENT:
            # Concurrent: Call all in parallel
            tasks = [
                self._call_specialist_a2a(agent_id, user_message, user_token, chatter_queue)
                for agent_id in specialist_ids
            ]
            results = await asyncio.gather(*tasks)
        
        elif pattern == OrchestrationPattern.MAGENTIC:
            # Magentic-One style: All agents participate with context accumulation
            # Key insight: Order matters! Research/investigation agents should run first
            # to gather info that data agents (ADX, SQL) can then use.
            # 
            # Strategy: Sort agents so "investigation/research" types run before "data" types
            # This allows: Investigator finds "works at Zyphronix" → ADX queries Zyphronix employees
            
            # Reorder: put agents with research-like descriptions first
            def agent_priority(agent_id: str) -> int:
                """Lower number = runs first. Research agents before data agents."""
                config = self._configs_cache.get(agent_id, {})
                name_lower = config.get("name", "").lower()
                desc_lower = config.get("description", "").lower()
                
                # Research/investigation agents run first (priority 0)
                research_keywords = ["investigat", "research", "search", "find", "discover", "rag", "document"]
                for kw in research_keywords:
                    if kw in name_lower or kw in desc_lower:
                        return 0
                
                # Data/query agents run second (priority 1) - they can use research results
                data_keywords = ["adx", "kusto", "database", "sql", "query", "data"]
                for kw in data_keywords:
                    if kw in name_lower or kw in desc_lower:
                        return 1
                
                # Other agents run last (priority 2)
                return 2
            
            sorted_specialists = sorted(specialist_ids, key=agent_priority)
            
            if should_log_agent():
                logger.info(f"Magentic execution order: {[self._configs_cache.get(sid, {}).get('name', sid) for sid in sorted_specialists]}")
            
            # Execute with accumulated context so later agents can use earlier findings
            accumulated_context = user_message
            for agent_id in sorted_specialists:
                result = await self._call_specialist_a2a(
                    agent_id, accumulated_context, user_token, chatter_queue
                )
                results.append(result)
                # Add this response to context for next agent
                if result.get("response"):
                    accumulated_context += f"\n\n[{result['agent_name']} said]: {result['response']}"
            
            # Magentic iterative loop: Orchestrator evaluates if more investigation is needed
            for round_num in range(1, max_rounds):  # Already did round 0 above
                # Ask orchestrator if we need more investigation
                evaluation = await self._run_orchestrator_for_evaluation(
                    orchestrator_config,
                    results,
                    user_message,
                    [self._configs_cache.get(sid, {}) for sid in sorted_specialists]
                )
                
                if should_log_agent():
                    logger.info(f"Magentic round {round_num} evaluation: continue={evaluation.get('continue')}, follow_up={evaluation.get('follow_up_query', '')[:100]}")
                
                if not evaluation.get("continue", False):
                    # Orchestrator says we have enough information
                    break
                
                # Get follow-up query and which agents to ask
                follow_up = evaluation.get("follow_up_query", "")
                target_agents = evaluation.get("target_agents", sorted_specialists)
                
                if not follow_up:
                    break
                
                # Emit thinking event for the follow-up round
                if chatter_queue:
                    followup_event = ChatterEvent(
                        type=ChatterEventType.THINKING,
                        agent_name="Orchestrator",
                        content=f"Round {round_num + 1}: Following up on new information...",
                        friendly_message=f"Investigating further based on new findings"
                    )
                    await chatter_queue.put(followup_event)
                
                # Run another round with the follow-up query + accumulated context
                round_context = f"{accumulated_context}\n\n[Orchestrator follow-up]: {follow_up}"
                
                for agent_id in target_agents:
                    if agent_id not in [r.get("agent_id") for r in results[-len(sorted_specialists):]]:
                        # Only call agents that might have new info
                        continue
                    
                    result = await self._call_specialist_a2a(
                        agent_id, round_context, user_token, chatter_queue
                    )
                    results.append(result)
                    
                    if result.get("response"):
                        accumulated_context += f"\n\n[{result['agent_name']} (round {round_num + 1})]: {result['response']}"
        
        elif pattern == OrchestrationPattern.GROUP_CHAT:
            # Group Chat: Round-robin with context accumulation
            current_context = user_message
            for round_num in range(max_rounds):
                round_had_output = False
                for agent_id in specialist_ids:
                    result = await self._call_specialist_a2a(
                        agent_id, current_context, user_token, chatter_queue
                    )
                    results.append(result)
                    
                    if result.get("response"):
                        round_had_output = True
                        current_context += f"\n\n[{result['agent_name']} said]: {result['response']}"
                        
                        # Check for termination signal
                        if "[DONE]" in result["response"] or "[END]" in result["response"]:
                            return results
                
                # If no agent produced output in a round, stop
                if not round_had_output:
                    break
        
        return list(results) if not isinstance(results, list) else results
    
    async def _run_orchestrator_for_synthesis(
        self,
        orchestrator_config: dict,
        specialist_results: list[dict],
        original_messages: list[dict]
    ) -> str:
        """
        Phase 3: Run orchestrator to synthesize specialist results.
        
        Returns:
            Synthesized response text
        """
        # Format specialist responses
        responses_text = []
        for result in specialist_results:
            agent_name = result.get("agent_name", "Agent")
            response = result.get("response", "")
            error = result.get("error")
            
            if error:
                responses_text.append(f"=== {agent_name} ===\n[ERROR: {error}]")
            else:
                responses_text.append(f"=== {agent_name} ===\n{response}")
        
        specialist_responses = "\n\n".join(responses_text)
        
        # Debug: Log what's being sent to synthesis
        if should_log_agent():
            logger.info(f"SYNTHESIS INPUT (specialist_responses):\n{specialist_responses[:1000]}{'...' if len(specialist_responses) > 1000 else ''}")
        
        # Use admin-configured synthesis prompt, or default if not set
        synthesis_prompt = orchestrator_config.get("synthesis_prompt") or self.DEFAULT_SYNTHESIS_PROMPT
        
        synthesis_prompt = synthesis_prompt.replace("{specialist_responses}", specialist_responses)
        
        # Create chat client
        chat_client = self._create_chat_client(orchestrator_config)
        
        # Build messages: original conversation + synthesis instruction
        synthesis_messages = [
            ChatMessage(role=Role.SYSTEM, text=synthesis_prompt)
        ]
        
        # Add original user message for context
        for msg in original_messages:
            if msg.get("role") == "user":
                synthesis_messages.append(ChatMessage(role=Role.USER, text=msg.get("content", "")))
        
        # Create synthesis agent
        synthesis_agent = ChatAgent(
            name="Synthesizer",
            description="Synthesizes results",
            instructions=synthesis_prompt,
            chat_client=chat_client
        )
        
        # Get synthesis response
        response_parts = []
        async for update in synthesis_agent.run_stream(synthesis_messages):
            if update.text:
                response_parts.append(update.text)
        
        return "".join(response_parts)

    @track_performance("agent_execute_orchestration", MetricType.AGENT_EXECUTION)
    async def execute_orchestration(
        self,
        pattern: OrchestrationPattern,
        agent_ids: list[str],
        messages: list[dict],
        user_token: Optional[str] = None,
        max_rounds: int = 10
    ) -> AsyncIterator[AgentResponse]:
        """
        Execute agents using Two-Phase Orchestration with pattern-controlled execution.
        
        Phase 1 (Analysis): Orchestrator analyzes request and decides:
                           - Answer directly (generic questions)
                           - Delegate to specialists (domain-specific)
        
        Phase 2 (Execution): Execute specialists via A2A using the session's pattern
                            (sequential, concurrent, magentic, group_chat)
        
        Phase 3 (Synthesis): Orchestrator synthesizes specialist results into
                            a coherent final response
        
        Args:
            pattern: The orchestration pattern to use for specialist execution
            agent_ids: List of agent IDs (should include orchestrator + specialists)
            messages: Chat messages/context
            user_token: User's auth token for MCP/A2A pass-through
            max_rounds: Maximum rounds for iterative patterns
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
        
        if should_log_agent():
            logger.info(f"Two-Phase Orchestration: pattern={pattern.value}, specialists={len(specialist_configs)}")
        
        # Extract the user's latest message
        user_message = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                user_message = msg.get("content", "")
                break
        
        # =====================================================================
        # Phase 1: Analysis - Orchestrator decides how to handle the request
        # =====================================================================
        if should_log_agent():
            logger.info("Phase 1: Orchestrator analyzing request...")
        
        # Emit analysis thinking event
        analysis_event = ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content="Analyzing request...",
            friendly_message="Determining how to handle your request"
        )
        yield analysis_event
        
        decision = await self._run_orchestrator_for_analysis(
            orchestrator_config,
            specialist_configs,
            messages
        )
        
        if should_log_agent():
            logger.info(f"Phase 1 decision: action={decision.get('action')}, specialists={decision.get('specialists', [])}")
        
        # =====================================================================
        # Handle Direct Response (no specialists needed)
        # =====================================================================
        if decision.get("action") == "direct":
            direct_response = decision.get("direct_response", "")
            
            yield AgentResponse(
                agent_id=orchestrator_config.get("id", "orchestrator"),
                agent_name=orchestrator_config.get("name", "Orchestrator"),
                content=direct_response,
                tokens_used=0,  # Could track this if needed
                metadata={
                    "pattern": pattern.value,
                    "action": "direct",
                    "reasoning": decision.get("reasoning", "")
                },
                chatter_events=[]
            )
            return
        
        # =====================================================================
        # Phase 2: Pattern Execution - Call specialists via A2A
        # =====================================================================
        
        # For Magentic pattern: include ALL specialists for comprehensive coverage
        # For other patterns: use only the specialists identified by analysis
        if pattern == OrchestrationPattern.MAGENTIC:
            specialist_ids = [c.get("id") for c in specialist_configs if c.get("id")]
            if should_log_agent():
                logger.info(f"Magentic pattern: including ALL {len(specialist_ids)} selected specialists")
        else:
            specialist_ids = decision.get("specialists", [])
        
        if not specialist_ids:
            # No specialists identified - fall back to direct answer
            direct_response = decision.get("direct_response", "I'm not sure which specialist can help with this request.")
            yield AgentResponse(
                agent_id=orchestrator_config.get("id", "orchestrator"),
                agent_name=orchestrator_config.get("name", "Orchestrator"),
                content=direct_response,
                tokens_used=0,
                metadata={"pattern": pattern.value, "action": "direct_fallback"},
                chatter_events=[]
            )
            return
        
        if should_log_agent():
            logger.info(f"Phase 2: Executing {len(specialist_ids)} specialists with pattern={pattern.value}")
        
        # Emit pattern execution event
        pattern_event = ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=f"Coordinating specialists using {pattern.value} pattern...",
            friendly_message=f"Coordinating {len(specialist_ids)} specialist(s)"
        )
        yield pattern_event
        
        # Execute specialists according to pattern
        specialist_results = await self._execute_specialists_with_pattern(
            pattern=pattern,
            specialist_ids=specialist_ids,
            user_message=user_message,
            user_token=user_token,
            chatter_queue=chatter_queue,
            max_rounds=max_rounds,
            orchestrator_config=orchestrator_config
        )
        
        # Yield any chatter events that accumulated
        while not chatter_queue.empty():
            try:
                event = chatter_queue.get_nowait()
                yield event
            except asyncio.QueueEmpty:
                break
        
        if should_log_agent():
            logger.info(f"Phase 2 complete: received {len(specialist_results)} specialist responses")
        
        # =====================================================================
        # Phase 3: Synthesis - Orchestrator combines results
        # =====================================================================
        if should_log_agent():
            logger.info("Phase 3: Orchestrator synthesizing results...")
        
        synthesis_event = ChatterEvent(
            type=ChatterEventType.THINKING,
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content="Synthesizing specialist responses...",
            friendly_message="Combining results into final answer"
        )
        yield synthesis_event
        
        synthesized_response = await self._run_orchestrator_for_synthesis(
            orchestrator_config,
            specialist_results,
            messages
        )
        
        # Build final response
        total_tokens = sum(r.get("tokens_input", 0) + r.get("tokens_output", 0) for r in specialist_results)
        
        yield AgentResponse(
            agent_id=orchestrator_config.get("id", "orchestrator"),
            agent_name=orchestrator_config.get("name", "Orchestrator"),
            content=synthesized_response,
            tokens_used=total_tokens,
            metadata={
                "pattern": pattern.value,
                "action": "delegate_and_synthesize",
                "specialists_called": [r.get("agent_name") for r in specialist_results],
                "specialist_count": len(specialist_results)
            },
            chatter_events=[]
        )
    
    async def _execute_single_pattern(
        self,
        agent: ChatAgent,
        messages: list[dict],
        chatter_queue: Optional[asyncio.Queue] = None
    ) -> AsyncIterator[Union[ChatterEvent, AgentResponse]]:
        """Execute single agent with performance tracking and chatter event streaming.
        
        Yields ChatterEvent objects during execution for real-time UI updates,
        then yields the final AgentResponse with all accumulated events.
        
        Uses a concurrent approach to poll the chatter queue even while the agent
        is blocked waiting for tool calls (like specialist agents) to complete.
        
        Args:
            agent: The agent to execute
            messages: Chat messages/context
            chatter_queue: Optional queue for receiving chatter from specialist agents
        
        Note: The Agent Framework streams FunctionCallContent updates incrementally
        as the LLM generates the function call token-by-token. We only emit events
        when we have complete data (valid call_id and non-empty tool name).
        """
        response_content = []
        tokens_input = 0
        tokens_output = 0
        last_update = None
        chatter_events: list[ChatterEvent] = []
        seen_tool_calls: set[str] = set()  # Track tool call IDs we've already emitted
        seen_tool_results: set[str] = set()  # Track tool result IDs we've already emitted
        pending_tool_calls: dict[str, float] = {}  # Track start time for each tool call
        
        # Debug: log what we're sending
        if should_log_agent():
            logger.info(f"Executing agent '{agent.name}' with {len(messages)} messages")
            if messages:
                logger.info(f"Last message: {messages[-1]}")
        
        start_time = time.perf_counter()
        chat_messages = _convert_to_chat_messages(messages)
        
        # Use an async iterator with concurrent queue polling
        # This allows us to yield chatter events even while waiting for agent updates
        agent_stream = agent.run_stream(chat_messages).__aiter__()
        stream_done = False
        
        while not stream_done:
            # Create tasks for both: getting next agent update AND getting queue events
            next_update_task = asyncio.create_task(self._get_next_update(agent_stream))
            
            # If we have a chatter queue, poll it with a short timeout while waiting for agent
            if chatter_queue:
                while not next_update_task.done():
                    # Wait for either: queue event or agent update (with short timeout)
                    try:
                        queue_event = await asyncio.wait_for(chatter_queue.get(), timeout=0.05)
                        chatter_events.append(queue_event)
                        yield queue_event
                    except asyncio.TimeoutError:
                        # No queue event, check if agent task is done
                        if next_update_task.done():
                            break
                        continue
            
            # Get the agent update (or StopAsyncIteration if done)
            try:
                update = await next_update_task
            except StopAsyncIteration:
                stream_done = True
                continue
            
            last_update = update
            
            # Process contents to extract chatter events from this agent
            if hasattr(update, 'contents') and update.contents:
                for content_item in update.contents:
                    # Handle function/tool calls
                    if isinstance(content_item, FunctionCallContent):
                        # Get the call_id - this is the unique identifier for this function call
                        call_id = getattr(content_item, 'call_id', None)
                        tool_name = getattr(content_item, 'name', None) or getattr(content_item, 'function_name', None)
                        
                        # Skip incomplete streaming updates:
                        # - Must have a valid call_id (not None/empty)
                        # - Must have a non-empty tool name
                        # The LLM streams partial updates as it builds the function call JSON
                        if not call_id or not tool_name:
                            logger.debug(f"Skipping incomplete FunctionCallContent: call_id={call_id}, name={tool_name}")
                            continue
                        
                        # Only emit if we haven't seen this call_id
                        if call_id not in seen_tool_calls:
                            seen_tool_calls.add(call_id)
                            pending_tool_calls[call_id] = time.perf_counter()  # Track start time
                            tool_args = getattr(content_item, 'arguments', {})
                            
                            # Check if this is a delegation to another agent
                            # (agent.as_tool() creates functions with agent names)
                            is_delegation = tool_name.replace('_', ' ').lower() in [
                                c.get('name', '').lower() for c in self._configs_cache.values()
                            ]
                            
                            event_type = ChatterEventType.DELEGATION if is_delegation else ChatterEventType.TOOL_CALL
                            
                            chatter_event = ChatterEvent(
                                type=event_type,
                                agent_name=agent.name,
                                content=f"Calling {tool_name}" if not is_delegation else f"Delegating to {tool_name}",
                                tool_name=tool_name,
                                tool_args=tool_args if isinstance(tool_args, dict) else {}
                            )
                            chatter_events.append(chatter_event)
                            # logger.info(f"CHATTER YIELDING: {agent.name} -> {event_type.value}: {tool_name}")  # Commented: verbose chatter logging
                            yield chatter_event
                    
                    # Handle function/tool results
                    elif isinstance(content_item, FunctionResultContent):
                        call_id = getattr(content_item, 'call_id', None)
                        
                        # Skip if no call_id
                        if not call_id:
                            logger.debug(f"Skipping FunctionResultContent with no call_id")
                            continue
                        
                        # Only emit if we haven't seen this call_id
                        if call_id not in seen_tool_results:
                            seen_tool_results.add(call_id)
                            
                            # Calculate duration if we tracked the start
                            duration_ms = None
                            if call_id in pending_tool_calls:
                                duration_ms = (time.perf_counter() - pending_tool_calls[call_id]) * 1000
                                del pending_tool_calls[call_id]
                            
                            result = getattr(content_item, 'result', '')
                            
                            # Extract text from result - it might be a string, object, or list
                            if isinstance(result, str):
                                result_str = result[:500]
                            elif isinstance(result, (list, tuple)):
                                # Could be a list of content items
                                parts = []
                                for item in result:
                                    if hasattr(item, 'text'):
                                        parts.append(item.text)
                                    else:
                                        parts.append(str(item))
                                result_str = " ".join(parts)[:500]
                            elif hasattr(result, 'text'):
                                result_str = result.text[:500] if result.text else ''
                            else:
                                result_str = str(result)[:500] if result else ''
                            
                            chatter_event = ChatterEvent(
                                type=ChatterEventType.TOOL_RESULT,
                                agent_name=agent.name,
                                content=result_str,
                                tool_name=call_id,  # Store call_id so frontend can match
                                duration_ms=duration_ms
                            )
                            chatter_events.append(chatter_event)
                            # logger.info(f"CHATTER YIELDING: {agent.name} -> tool_result for {call_id}" + (f" (duration={duration_ms:.1f}ms)" if duration_ms else ""))  # Commented: verbose chatter logging
                            yield chatter_event
                    
                    # Handle usage content - emit token usage info
                    elif isinstance(content_item, UsageContent):
                        # UsageContent has a 'details' property which is a UsageDetails object
                        # UsageDetails has: input_token_count, output_token_count, total_token_count
                        details = getattr(content_item, 'details', None)
                        uc_input_tokens = None
                        uc_output_tokens = None
                        
                        if details:
                            uc_input_tokens = getattr(details, 'input_token_count', None)
                            uc_output_tokens = getattr(details, 'output_token_count', None)
                        
                        if uc_input_tokens or uc_output_tokens:
                            chatter_event = ChatterEvent(
                                type=ChatterEventType.THINKING,
                                agent_name=agent.name,
                                content=f"LLM call: {uc_input_tokens or 0} input, {uc_output_tokens or 0} output tokens",
                                tokens_input=uc_input_tokens,
                                tokens_output=uc_output_tokens
                            )
                            chatter_events.append(chatter_event)
                            # logger.info(f"CHATTER YIELDING: {agent.name} -> usage: {uc_input_tokens} in, {uc_output_tokens} out")  # Commented: verbose chatter logging
                            yield chatter_event
                    
                    # Handle text content - this is the actual response
                    elif isinstance(content_item, TextContent):
                        text = getattr(content_item, 'text', '')
                        if text:
                            response_content.append(text)
            
            # Also check update.text for simple text streaming
            elif update.text:
                response_content.append(update.text)
            
            # Try multiple ways to capture token usage
            tokens_input, tokens_output = self._extract_token_usage(
                update, tokens_input, tokens_output
            )
        
        # Drain any remaining events from the chatter queue
        if chatter_queue:
            while True:
                try:
                    specialist_event = chatter_queue.get_nowait()
                    chatter_events.append(specialist_event)
                    yield specialist_event
                except asyncio.QueueEmpty:
                    break
        
        # Try to get usage from the final update (some frameworks only report at the end)
        if last_update and tokens_input == 0 and tokens_output == 0:
            tokens_input, tokens_output = self._extract_token_usage_final(last_update)
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        total_tokens = tokens_input + tokens_output
        
        # If no token info available, estimate based on text length
        response_text = "".join(response_content)
        tokens_estimated = False
        if total_tokens == 0 and response_text:
            # Estimate input tokens from messages
            input_text = " ".join(m.get("content", "") for m in messages)
            tokens_input = self._estimate_tokens(input_text)
            tokens_output = self._estimate_tokens(response_text)
            total_tokens = tokens_input + tokens_output
            tokens_estimated = True
        
        # Log AOAI performance
        if should_log_performance():
            perf_data = {
                "duration_ms": round(duration_ms, 2),
                "tokens_input": tokens_input,
                "tokens_output": tokens_output,
                "tokens_total": total_tokens,
                "response_length": len(response_text),
                "message_count": len(messages),
                "chatter_events_count": len(chatter_events)
            }
            if tokens_estimated:
                perf_data["tokens_estimated"] = True
            log_performance_summary(logger, f"aoai_agent_{agent.name}", perf_data)
        
        yield AgentResponse(
            agent_id=agent.name,
            agent_name=agent.name,
            content=response_text,
            tokens_used=total_tokens,
            metadata={
                "duration_ms": round(duration_ms, 2),
                "tokens_input": tokens_input,
                "tokens_output": tokens_output,
                "tokens_estimated": tokens_estimated
            },
            chatter_events=chatter_events
        )
    
    async def _get_next_update(self, async_iterator):
        """Helper to get the next item from an async iterator.
        
        Returns the next item or raises StopAsyncIteration when done.
        This allows us to wrap the iterator in a task for concurrent waiting.
        """
        return await async_iterator.__anext__()
    
    def _extract_token_usage(self, update, current_input: int, current_output: int) -> tuple[int, int]:
        """Try multiple ways to extract token usage from a streaming update."""
        tokens_input = current_input
        tokens_output = current_output
        
        # Method 1: Direct usage attribute (OpenAI style)
        if hasattr(update, 'usage') and update.usage:
            usage = update.usage
            if hasattr(usage, 'prompt_tokens'):
                tokens_input = usage.prompt_tokens or 0
            if hasattr(usage, 'completion_tokens'):
                tokens_output = usage.completion_tokens or 0
            if hasattr(usage, 'input_tokens'):
                tokens_input = usage.input_tokens or 0
            if hasattr(usage, 'output_tokens'):
                tokens_output = usage.output_tokens or 0
        
        # Method 2: Dict-style usage
        if hasattr(update, 'usage') and isinstance(update.usage, dict):
            tokens_input = update.usage.get('prompt_tokens', 0) or update.usage.get('input_tokens', 0)
            tokens_output = update.usage.get('completion_tokens', 0) or update.usage.get('output_tokens', 0)
        
        # Method 3: Metadata attribute
        if hasattr(update, 'metadata') and update.metadata:
            meta = update.metadata
            if isinstance(meta, dict):
                if 'usage' in meta:
                    usage = meta['usage']
                    tokens_input = usage.get('prompt_tokens', 0) or usage.get('input_tokens', 0)
                    tokens_output = usage.get('completion_tokens', 0) or usage.get('output_tokens', 0)
                tokens_input = meta.get('prompt_tokens', tokens_input) or meta.get('input_tokens', tokens_input)
                tokens_output = meta.get('completion_tokens', tokens_output) or meta.get('output_tokens', tokens_output)
        
        # Method 4: model_extra for pydantic models
        if hasattr(update, 'model_extra') and update.model_extra:
            extra = update.model_extra
            if 'usage' in extra:
                usage = extra['usage']
                if isinstance(usage, dict):
                    tokens_input = usage.get('prompt_tokens', 0) or usage.get('input_tokens', 0)
                    tokens_output = usage.get('completion_tokens', 0) or usage.get('output_tokens', 0)
        
        return tokens_input, tokens_output
    
    def _extract_token_usage_final(self, update) -> tuple[int, int]:
        """Try to extract token usage from final update with debug logging."""
        tokens_input = 0
        tokens_output = 0
        
        # Log available attributes for debugging (only when performance logging is on)
        if should_log_performance():
            attrs = [attr for attr in dir(update) if not attr.startswith('_')]
            logger.debug(f"Final update attributes: {attrs}")
            
            # Log the update object itself if it has a dict representation
            if hasattr(update, '__dict__'):
                logger.debug(f"Final update __dict__: {update.__dict__}")
            if hasattr(update, 'model_dump'):
                try:
                    logger.debug(f"Final update model_dump: {update.model_dump()}")
                except Exception:
                    pass
        
        return self._extract_token_usage(update, tokens_input, tokens_output)
    
    def _estimate_tokens(self, text: str) -> int:
        """
        Estimate token count from text using rough approximation.
        This is a fallback when actual token usage isn't available.
        
        Rule of thumb: ~4 characters per token for English text.
        """
        if not text:
            return 0
        # Rough estimation: 1 token per 4 characters
        return max(1, len(text) // 4)
    
    async def _execute_sequential(
        self,
        agents: list[ChatAgent],
        messages: list[dict]
    ) -> AsyncIterator[AgentResponse]:
        """Execute agents in sequence, passing context between them, with performance tracking."""
        current_messages = messages.copy()
        total_duration_ms = 0
        total_tokens = 0
        
        for agent in agents:
            response_content = []
            tokens_input = 0
            tokens_output = 0
            last_update = None
            
            start_time = time.perf_counter()
            chat_messages = _convert_to_chat_messages(current_messages)
            
            async for update in agent.run_stream(chat_messages):
                last_update = update
                if update.text:
                    response_content.append(update.text)
                tokens_input, tokens_output = self._extract_token_usage(
                    update, tokens_input, tokens_output
                )
            
            # Try final update if no tokens captured
            if last_update and tokens_input == 0 and tokens_output == 0:
                tokens_input, tokens_output = self._extract_token_usage_final(last_update)
            
            duration_ms = (time.perf_counter() - start_time) * 1000
            full_response = "".join(response_content)
            
            # If no token info available, estimate based on text length
            tokens_estimated = False
            if tokens_input == 0 and tokens_output == 0 and full_response:
                input_text = " ".join(m.get("content", "") for m in current_messages)
                tokens_input = self._estimate_tokens(input_text)
                tokens_output = self._estimate_tokens(full_response)
                tokens_estimated = True
            
            agent_tokens = tokens_input + tokens_output
            total_duration_ms += duration_ms
            total_tokens += agent_tokens
            
            # Log per-agent performance
            if should_log_performance():
                perf_data = {
                    "duration_ms": round(duration_ms, 2),
                    "tokens_input": tokens_input,
                    "tokens_output": tokens_output,
                    "tokens_total": agent_tokens
                }
                if tokens_estimated:
                    perf_data["tokens_estimated"] = True
                log_performance_summary(logger, f"aoai_sequential_{agent.name}", perf_data)
            
            yield AgentResponse(
                agent_id=agent.name,
                agent_name=agent.name,
                content=full_response,
                tokens_used=agent_tokens,
                metadata={
                    "pattern": "sequential",
                    "duration_ms": round(duration_ms, 2),
                    "tokens_input": tokens_input,
                    "tokens_output": tokens_output,
                    "tokens_estimated": tokens_estimated
                }
            )
            
            # Pass response to next agent
            current_messages.append({
                "role": "assistant",
                "content": full_response
            })
        
        # Log total sequential execution
        if should_log_performance():
            log_performance_summary(logger, "sequential_total", {
                "total_duration_ms": round(total_duration_ms, 2),
                "total_tokens": total_tokens,
                "agent_count": len(agents)
            })
    
    async def _execute_concurrent(
        self,
        agents: list[ChatAgent],
        messages: list[dict]
    ) -> AsyncIterator[AgentResponse]:
        """Execute agents concurrently and aggregate results with performance tracking."""
        chat_messages = _convert_to_chat_messages(messages)
        concurrent_start = time.perf_counter()
        
        # Run all agents in parallel
        async def run_agent(agent: ChatAgent) -> AgentResponse:
            response_content = []
            tokens_input = 0
            tokens_output = 0
            last_update = None
            
            start_time = time.perf_counter()
            
            async for update in agent.run_stream(chat_messages):
                last_update = update
                if update.text:
                    response_content.append(update.text)
                tokens_input, tokens_output = self._extract_token_usage(
                    update, tokens_input, tokens_output
                )
            
            # Try final update if no tokens captured
            if last_update and tokens_input == 0 and tokens_output == 0:
                tokens_input, tokens_output = self._extract_token_usage_final(last_update)
            
            duration_ms = (time.perf_counter() - start_time) * 1000
            response_text = "".join(response_content)
            
            # If no token info available, estimate based on text length
            tokens_estimated = False
            if tokens_input == 0 and tokens_output == 0 and response_text:
                input_text = " ".join(m.get("content", "") for m in messages)
                tokens_input = self._estimate_tokens(input_text)
                tokens_output = self._estimate_tokens(response_text)
                tokens_estimated = True
            
            agent_tokens = tokens_input + tokens_output
            
            # Log per-agent performance
            if should_log_performance():
                perf_data = {
                    "duration_ms": round(duration_ms, 2),
                    "tokens_input": tokens_input,
                    "tokens_output": tokens_output,
                    "tokens_total": agent_tokens
                }
                if tokens_estimated:
                    perf_data["tokens_estimated"] = True
                log_performance_summary(logger, f"aoai_concurrent_{agent.name}", perf_data)
            
            return AgentResponse(
                agent_id=agent.name,
                agent_name=agent.name,
                content=response_text,
                tokens_used=agent_tokens,
                metadata={
                    "pattern": "concurrent",
                    "duration_ms": round(duration_ms, 2),
                    "tokens_input": tokens_input,
                    "tokens_output": tokens_output,
                    "tokens_estimated": tokens_estimated
                }
            )
        
        tasks = [run_agent(agent) for agent in agents]
        results = await asyncio.gather(*tasks)
        
        concurrent_duration = (time.perf_counter() - concurrent_start) * 1000
        total_tokens = sum(r.tokens_used for r in results)
        
        # Log total concurrent execution
        if should_log_performance():
            log_performance_summary(logger, "concurrent_total", {
                "wall_clock_ms": round(concurrent_duration, 2),
                "total_tokens": total_tokens,
                "agent_count": len(agents)
            })
        
        for response in results:
            yield response
    
    async def _execute_magentic(
        self,
        agents: list[ChatAgent],
        messages: list[dict],
        max_rounds: int
    ) -> AsyncIterator[AgentResponse]:
        """Execute using Magentic-One pattern with orchestrator and performance tracking."""
        if len(agents) < 2:
            raise ValueError("Magentic pattern requires at least 2 agents (1 orchestrator + workers)")
        
        orchestrator = agents[0]
        workers = agents[1:]
        current_messages = messages.copy()
        total_duration_ms = 0
        total_tokens = 0
        
        for round_num in range(max_rounds):
            round_start = time.perf_counter()
            
            # Orchestrator decides what to do
            orchestrator_response = []
            tokens_input = 0
            tokens_output = 0
            last_update = None
            
            orch_start = time.perf_counter()
            chat_messages = _convert_to_chat_messages(current_messages)
            
            async for update in orchestrator.run_stream(chat_messages):
                last_update = update
                if update.text:
                    orchestrator_response.append(update.text)
                tokens_input, tokens_output = self._extract_token_usage(
                    update, tokens_input, tokens_output
                )
            
            # Try final update if no tokens captured
            if last_update and tokens_input == 0 and tokens_output == 0:
                tokens_input, tokens_output = self._extract_token_usage_final(last_update)
            
            orch_duration = (time.perf_counter() - orch_start) * 1000
            orch_tokens = tokens_input + tokens_output
            total_duration_ms += orch_duration
            total_tokens += orch_tokens
            
            orch_content = "".join(orchestrator_response)
            
            if should_log_performance():
                log_performance_summary(logger, f"aoai_magentic_orchestrator_r{round_num}", {
                    "duration_ms": round(orch_duration, 2),
                    "tokens_input": tokens_input,
                    "tokens_output": tokens_output,
                    "tokens_total": orch_tokens
                })
            
            yield AgentResponse(
                agent_id=orchestrator.name,
                agent_name=orchestrator.name,
                content=orch_content,
                tokens_used=orch_tokens,
                metadata={
                    "pattern": "magentic",
                    "round": round_num,
                    "role": "orchestrator",
                    "duration_ms": round(orch_duration, 2)
                }
            )
            
            current_messages.append({"role": "assistant", "content": orch_content})
            
            # Check if orchestrator signals completion
            if "TERMINATE" in orch_content or "DONE" in orch_content:
                break
            
            # Workers respond in sequence
            for worker in workers:
                worker_response = []
                w_tokens_input = 0
                w_tokens_output = 0
                w_last_update = None
                
                worker_start = time.perf_counter()
                chat_messages = _convert_to_chat_messages(current_messages)
                
                async for update in worker.run_stream(chat_messages):
                    w_last_update = update
                    if update.text:
                        worker_response.append(update.text)
                    w_tokens_input, w_tokens_output = self._extract_token_usage(
                        update, w_tokens_input, w_tokens_output
                    )
                
                # Try final update if no tokens captured
                if w_last_update and w_tokens_input == 0 and w_tokens_output == 0:
                    w_tokens_input, w_tokens_output = self._extract_token_usage_final(w_last_update)
                
                worker_duration = (time.perf_counter() - worker_start) * 1000
                worker_tokens = w_tokens_input + w_tokens_output
                total_duration_ms += worker_duration
                total_tokens += worker_tokens
                
                worker_content = "".join(worker_response)
                
                if should_log_performance():
                    log_performance_summary(logger, f"aoai_magentic_worker_{worker.name}_r{round_num}", {
                        "duration_ms": round(worker_duration, 2),
                        "tokens_input": w_tokens_input,
                        "tokens_output": w_tokens_output,
                        "tokens_total": worker_tokens
                    })
                
                yield AgentResponse(
                    agent_id=worker.name,
                    agent_name=worker.name,
                    content=worker_content,
                    tokens_used=worker_tokens,
                    metadata={
                        "pattern": "magentic",
                        "round": round_num,
                        "role": "worker",
                        "duration_ms": round(worker_duration, 2)
                    }
                )
                
                current_messages.append({"role": "assistant", "content": f"[{worker.name}]: {worker_content}"})
            
            round_duration = (time.perf_counter() - round_start) * 1000
            if should_log_performance():
                log_performance_summary(logger, f"magentic_round_{round_num}", {
                    "round_duration_ms": round(round_duration, 2)
                })
        
        # Log total magentic execution
        if should_log_performance():
            log_performance_summary(logger, "magentic_total", {
                "total_duration_ms": round(total_duration_ms, 2),
                "total_tokens": total_tokens,
                "rounds": round_num + 1
            })
    
    async def _execute_group_chat(
        self,
        agents: list[ChatAgent],
        messages: list[dict],
        max_rounds: int
    ) -> AsyncIterator[AgentResponse]:
        """Execute using group chat pattern with performance tracking."""
        # Run conversation
        round_num = 0
        current_messages = messages.copy()
        total_duration_ms = 0
        total_tokens = 0
        
        for _ in range(max_rounds):
            for agent in agents:
                response_content = []
                tokens_input = 0
                tokens_output = 0
                last_update = None
                
                start_time = time.perf_counter()
                chat_messages = _convert_to_chat_messages(current_messages)
                
                async for update in agent.run_stream(chat_messages):
                    last_update = update
                    if update.text:
                        response_content.append(update.text)
                    tokens_input, tokens_output = self._extract_token_usage(
                        update, tokens_input, tokens_output
                    )
                
                # Try final update if no tokens captured
                if last_update and tokens_input == 0 and tokens_output == 0:
                    tokens_input, tokens_output = self._extract_token_usage_final(last_update)
                
                duration_ms = (time.perf_counter() - start_time) * 1000
                agent_tokens = tokens_input + tokens_output
                total_duration_ms += duration_ms
                total_tokens += agent_tokens
                
                full_response = "".join(response_content)
                round_num += 1
                
                if should_log_performance():
                    log_performance_summary(logger, f"aoai_groupchat_{agent.name}_r{round_num}", {
                        "duration_ms": round(duration_ms, 2),
                        "tokens_input": tokens_input,
                        "tokens_output": tokens_output,
                        "tokens_total": agent_tokens
                    })
                
                yield AgentResponse(
                    agent_id=agent.name,
                    agent_name=agent.name,
                    content=full_response,
                    tokens_used=agent_tokens,
                    metadata={
                        "pattern": "group_chat",
                        "round": round_num,
                        "duration_ms": round(duration_ms, 2)
                    }
                )
                
                current_messages.append({
                    "role": "assistant",
                    "content": f"[{agent.name}]: {full_response}"
                })
                
                # Check for termination signal
                if "[DONE]" in full_response or "[END]" in full_response:
                    # Log total group chat execution
                    if should_log_performance():
                        log_performance_summary(logger, "groupchat_total", {
                            "total_duration_ms": round(total_duration_ms, 2),
                            "total_tokens": total_tokens,
                            "rounds": round_num
                        })
                    return
        
        # Log total group chat execution
        if should_log_performance():
            log_performance_summary(logger, "groupchat_total", {
                "total_duration_ms": round(total_duration_ms, 2),
                "total_tokens": total_tokens,
                "rounds": round_num
            })
    
    async def close(self) -> None:
        """Cleanup resources."""
        self._agents_cache.clear()
        self._configs_cache.clear()


# Global instance
agent_manager = AgentManager()
