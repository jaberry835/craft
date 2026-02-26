"""
Agent Manager
Creates and orchestrates agents using Microsoft Agent Framework.
Supports dynamic agent configuration and multiple orchestration patterns.
"""
from typing import Optional, AsyncIterator, Union, Any
from dataclasses import dataclass, field
from enum import Enum
import asyncio
import time

from agent_framework import Agent, Message
from agent_framework.azure import AzureOpenAIChatClient

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
        Handles Content objects with type='text', lists, dicts, and primitives.
        """
        if result is None:
            return ""
        
        # Handle Content objects with text attribute
        if hasattr(result, 'text'):
            return str(result.text)
        
        # Handle lists (of Content or other items)
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
        
        chat_messages.append(Message(role=role, text=msg.get("content", "")))
    return chat_messages


class AgentManager:
    """Manages agent creation and orchestration."""
    
    # Limit concurrent specialist agent executions to avoid overwhelming Azure OpenAI
    # When the orchestrator calls multiple specialists in parallel, this serializes them
    MAX_CONCURRENT_SPECIALISTS = 2
    
    def __init__(self):
        self._credential = None
        self._agents_cache: dict[str, Agent] = {}
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
        
        Uses the agent's configured AOAI endpoint if specified, otherwise falls back
        to the global settings from environment variables.
        
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
        
        if aoai_endpoint_id:
            cached_endpoint = agent_config.get("_aoai_endpoint_config")
            if cached_endpoint:
                endpoint_url = cached_endpoint.get("endpoint", endpoint_url)
                cached_key = cached_endpoint.get("api_key")
                if cached_key:
                    api_key = cached_key
                    logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': using API key from AOAI endpoint config "
                                f"(endpoint_id={aoai_endpoint_id}, key_length={len(cached_key)}, "
                                f"key_prefix={cached_key[:6]}...)")
                else:
                    logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': AOAI endpoint config has NO api_key "
                                f"(endpoint_id={aoai_endpoint_id}), will use token auth")
                if cached_endpoint.get("api_version"):
                    api_version = cached_endpoint.get("api_version")
                cloud = cached_endpoint.get("cloud", "unknown")
                logger.info(f"[AOAI-CONFIG] Using custom AOAI endpoint for agent '{agent_name}': "
                            f"endpoint={endpoint_url}, cloud={cloud}, api_version={api_version}")
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
                    f"has_api_key={bool(api_key)}, token_scope={scope}")
        
        # Use API key if available, otherwise use token provider
        if api_key:
            logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': authenticating with API key "
                        f"(length={len(api_key)}, prefix={api_key[:6]}...)")
            return AzureOpenAIChatClient(
                endpoint=endpoint_url,
                deployment_name=deployment_name,
                api_key=api_key
            )
        else:
            logger.info(f"[AOAI-CONFIG] Agent '{agent_name}': authenticating with credential "
                        f"(scope={settings.azure_cognitive_services_scope})")
            return AzureOpenAIChatClient(
                endpoint=endpoint_url,
                deployment_name=deployment_name,
                credential=self._get_token_provider()
            )
    
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
            # Create a search tool that queries the agent's grounded documents
            search_tool = grounding_service.create_search_tool(
                agent_id=agent_config.get("id", ""),
                agent_name=agent_config.get("name", "Agent")
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
        agent = Agent(
            name=sanitized_name,
            description=agent_config.get("description", ""),
            instructions=enhanced_instructions,
            client=chat_client,
            tools=tools if tools else None,
            context_providers=context_providers,
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
            
            # Track tool calls for timing
            seen_tool_calls: set[str] = set()
            seen_tool_results: set[str] = set()
            pending_tool_calls: dict[str, tuple[float, str, Optional[dict]]] = {}  # call_id -> (start_time, tool_name, tool_args)
            total_tokens_input = 0
            total_tokens_output = 0
            
            async for update in agent.run(chat_messages, stream=True):
                if update.text:
                    yield update.text
                
                # Capture tool call/result events if requested
                if include_chatter and hasattr(update, 'contents') and update.contents:
                    for content_item in update.contents:
                        if content_item.type == 'function_call':
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
                        
                        elif content_item.type == 'function_result':
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
                                
                                # Format result for display - extract text from Content objects
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
                        
                        # Handle usage content to capture token counts
                        elif content_item.type == 'usage':
                            details = getattr(content_item, 'usage_details', None)
                            if details:
                                uc_input = details.get('input_token_count') if isinstance(details, dict) else getattr(details, 'input_token_count', None)
                                uc_output = details.get('output_token_count') if isinstance(details, dict) else getattr(details, 'output_token_count', None)
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
                logger.debug(f"run completed for {agent_id}")
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
        eval_agent = Agent(
            name="Evaluator",
            description="Evaluates if more investigation is needed",
            instructions=eval_prompt,
            client=chat_client
        )
        
        # Get evaluation
        eval_messages = [
            Message(role="system", text=eval_prompt),
            Message(role="user", text="Should we continue investigating or do we have enough information?")
        ]
        
        response_parts = []
        async for update in eval_agent.run(eval_messages, stream=True):
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
        user_message: str,
        session_id: str,
        user_id: str,
    ) -> dict:
        """
        Phase 1: Run orchestrator to analyze the request and decide action.

        Uses AgentSession with CosmosHistoryProvider (for automatic
        conversation-history loading) and DocumentRAGProvider (for automatic
        document-context injection) so the orchestrator sees the full
        conversation and any relevant uploaded documents.

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
        
        # Create chat client
        chat_client = self._create_chat_client(orchestrator_config)
        
        # Create analysis agent with context providers for automatic
        # history loading and RAG injection (no manual message building).
        # store_inputs/store_outputs default to False so the analysis
        # agent's internal JSON decision is never persisted to Cosmos.
        analysis_agent = chat_client.as_agent(
            name="Analyzer",
            instructions=analysis_prompt,
            context_providers=[
                CosmosHistoryProvider(cosmos_service),
                DocumentRAGProvider(embedding_service, search_service),
            ],
        )
        
        # Create an AgentSession and populate provider-scoped state so the
        # providers know which Cosmos session to query.
        session = analysis_agent.create_session()
        session.state.setdefault("cosmos-history", {}).update({
            "session_id": session_id,
            "user_id": user_id,
            "current_query": user_message,
        })
        session.state.setdefault("document-rag", {}).update({
            "session_id": session_id,
            "user_id": user_id,
            "user_query": user_message,
        })
        
        # Run — providers automatically load history + RAG; the framework
        # adds user_message as the current input.
        response_parts = []
        async for update in analysis_agent.run(
            user_message, session=session, stream=True
        ):
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
        
        # Emit delegation event — note: for local agents with session context,
        # the framework's CosmosHistoryProvider will also inject conversation
        # history automatically, so the specialist sees more than just this message.
        if chatter_queue:
            has_context = bool(session_id and user_id)
            content_preview = message[:200] + ("..." if len(message) > 200 else "")
            friendly = (
                f"Asking {agent_name} (with conversation history)"
                if has_context
                else f"Asking {agent_name}"
            )
            await chatter_queue.put(ChatterEvent(
                type=ChatterEventType.DELEGATION,
                agent_name=agent_name,
                content=content_preview,
                friendly_message=friendly,
            ))
        
        # --- Local agents: execute directly for rich chatter ---
        if agent_type != "a2a":
            return await self._call_specialist_local(
                agent_id, agent_name, message, user_token, chatter_queue,
                session_id=session_id, user_id=user_id,
            )
        
        # --- External A2A agents: use HTTP protocol ---
        return await self._call_specialist_remote(
            agent_id, agent_name, config, message, user_token, chatter_queue
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
        Execute a local specialist directly with include_chatter=True for
        rich tool call / token usage events.

        When ``session_id`` and ``user_id`` are provided the agent is created
        with the framework's ``CosmosHistoryProvider`` and
        ``DocumentRAGProvider`` so conversation history and RAG document
        context are loaded automatically — the same pattern the orchestrator
        analysis phase uses.  This lets specialists resolve follow-up
        references like "tell me more about section 2" without manual
        message building.
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

            # Track tool calls for timing
            seen_tool_calls: set[str] = set()
            seen_tool_results: set[str] = set()
            pending_tool_calls: dict[str, tuple[float, str, Optional[dict]]] = {}
            total_tokens_input = 0
            total_tokens_output = 0

            async for update in agent.run(message, session=session, stream=True):
                if update.text:
                    response_parts.append(update.text)

                # Capture chatter events (tool calls, results, token usage)
                if hasattr(update, 'contents') and update.contents:
                    for content_item in update.contents:
                        if content_item.type == 'function_call':
                            call_id = getattr(content_item, 'call_id', None)
                            tool_name = getattr(content_item, 'name', None)
                            tool_args = getattr(content_item, 'arguments', None)
                            if call_id and tool_name and call_id not in seen_tool_calls:
                                seen_tool_calls.add(call_id)
                                args_dict = tool_args if isinstance(tool_args, dict) else None
                                pending_tool_calls[call_id] = (time.time(), tool_name, args_dict)
                                friendly_msg = _get_friendly_tool_description(tool_name, args_dict)
                                event = ChatterEvent(
                                    type=ChatterEventType.TOOL_CALL,
                                    agent_name=agent_name,
                                    content=f"Calling {tool_name}",
                                    tool_name=tool_name,
                                    tool_args=args_dict,
                                    friendly_message=friendly_msg,
                                )
                                if chatter_queue:
                                    await chatter_queue.put(event)

                        elif content_item.type == 'function_result':
                            call_id = getattr(content_item, 'call_id', None)
                            result = getattr(content_item, 'result', None)
                            if call_id and call_id not in seen_tool_results:
                                seen_tool_results.add(call_id)
                                duration_ms = None
                                tool_name_result = None
                                if call_id in pending_tool_calls:
                                    st, tool_name_result, _ = pending_tool_calls[call_id]
                                    duration_ms = (time.time() - st) * 1000
                                result_display = ChatterEvent.extract_result_text(result)
                                if len(result_display) > 300:
                                    result_display = result_display[:300] + "..."
                                friendly_msg = _get_friendly_result_summary(tool_name_result or "", result_display)
                                event = ChatterEvent(
                                    type=ChatterEventType.TOOL_RESULT,
                                    agent_name=agent_name,
                                    content=result_display or "Result received",
                                    tool_name=tool_name_result,
                                    duration_ms=duration_ms,
                                    friendly_message=friendly_msg,
                                )
                                if chatter_queue:
                                    await chatter_queue.put(event)

                        elif content_item.type == 'usage':
                            details = getattr(content_item, 'usage_details', None)
                            if details:
                                uc_in = details.get('input_token_count') if isinstance(details, dict) else getattr(details, 'input_token_count', None)
                                uc_out = details.get('output_token_count') if isinstance(details, dict) else getattr(details, 'output_token_count', None)
                                if uc_in:
                                    total_tokens_input += uc_in
                                if uc_out:
                                    total_tokens_output += uc_out
                                if uc_in or uc_out:
                                    event = ChatterEvent(
                                        type=ChatterEventType.THINKING,
                                        agent_name=agent_name,
                                        content=f"LLM call: {uc_in or 0} input, {uc_out or 0} output tokens",
                                        tokens_input=uc_in,
                                        tokens_output=uc_out,
                                        friendly_message="Analyzing information...",
                                    )
                                    if chatter_queue:
                                        await chatter_queue.put(event)

            response_text = "".join(response_parts)
            duration_ms = (time.time() - start_time) * 1000
            
            if should_log_agent():
                logger.info(f"LOCAL specialist {agent_name}: {len(response_text)} chars in {duration_ms:.0f}ms")
            
            # Emit completion event with duration
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Completed ({len(response_text)} chars)",
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
    
    async def _call_specialist_remote(
        self,
        agent_id: str,
        agent_name: str,
        config: dict,
        message: str,
        user_token: Optional[str],
        chatter_queue: Optional[asyncio.Queue]
    ) -> dict:
        """
        Call an external A2A agent via HTTP protocol. Returns only final text
        (no internal tool events available from remote agents).
        """
        if should_log_a2a():
            logger.info(f"A2A CALL (remote): {agent_name} <- {message[:100]}...")
        
        start_time = time.time()
        try:
            result = await a2a_client.call_agent(config, message, user_token)
            duration_ms = (time.time() - start_time) * 1000
            
            if result.get("error"):
                return {"agent_id": agent_id, "agent_name": agent_name, "response": "", "error": result["error"]}
            
            response_text = result.get("text", "")
            if should_log_a2a():
                logger.info(f"A2A RESPONSE from {agent_name}: {response_text[:500]}{'...' if len(response_text) > 500 else ''}")
            
            # Emit completion event
            if chatter_queue:
                await chatter_queue.put(ChatterEvent(
                    type=ChatterEventType.CONTENT,
                    agent_name=agent_name,
                    content=f"Completed ({len(response_text)} chars)",
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
            return {"agent_id": agent_id, "agent_name": agent_name, "response": "", "error": str(e)}
    
    async def _execute_specialists_with_pattern(
        self,
        pattern: OrchestrationPattern,
        specialist_ids: list[str],
        user_message: str,
        user_token: Optional[str] = None,
        chatter_queue: Optional[asyncio.Queue] = None,
        max_rounds: int = 10,
        orchestrator_config: Optional[dict] = None,
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
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
                specialist_ids[0], user_message, user_token, chatter_queue,
                session_id=session_id, user_id=user_id,
            )
            results.append(result)
        
        elif pattern == OrchestrationPattern.SEQUENTIAL:
            # Sequential: Call each in order, passing accumulated context
            accumulated_context = user_message
            for agent_id in specialist_ids:
                result = await self._call_specialist_a2a(
                    agent_id, accumulated_context, user_token, chatter_queue,
                    session_id=session_id, user_id=user_id,
                )
                results.append(result)
                # Add this response to context for next agent
                if result.get("response"):
                    accumulated_context += f"\n\n[{result['agent_name']} said]: {result['response']}"
        
        elif pattern == OrchestrationPattern.CONCURRENT:
            # Concurrent: Call all in parallel
            tasks = [
                self._call_specialist_a2a(agent_id, user_message, user_token, chatter_queue,
                                         session_id=session_id, user_id=user_id)
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
                    agent_id, accumulated_context, user_token, chatter_queue,
                    session_id=session_id, user_id=user_id,
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
                        agent_id, round_context, user_token, chatter_queue,
                        session_id=session_id, user_id=user_id,
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
                        agent_id, current_context, user_token, chatter_queue,
                        session_id=session_id, user_id=user_id,
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
        user_message: str,
    ) -> str:
        """
        Phase 3: Run orchestrator to synthesize specialist results.
        
        Args:
            orchestrator_config: The orchestrator agent configuration.
            specialist_results: Results from specialist agent executions.
            user_message: The original user question.
        
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
        
        # Create synthesis agent — instructions contain the synthesis prompt
        # with specialist responses already embedded.  No providers or session
        # needed; the synthesizer only needs the user question + specialist output.
        synthesis_agent = Agent(
            name="Synthesizer",
            description="Synthesizes results",
            instructions=synthesis_prompt,
            client=chat_client,
        )
        
        # Pass only the user's original question; the specialist responses are
        # embedded in the instructions (system prompt) already.
        response_parts = []
        async for update in synthesis_agent.run(user_message, stream=True):
            if update.text:
                response_parts.append(update.text)
        
        return "".join(response_parts)

    @track_performance("agent_execute_orchestration", MetricType.AGENT_EXECUTION)
    async def execute_orchestration(
        self,
        pattern: OrchestrationPattern,
        agent_ids: list[str],
        user_message: str,
        session_id: str,
        user_id: str,
        user_token: Optional[str] = None,
        max_rounds: int = 10,
    ) -> AsyncIterator[AgentResponse]:
        """
        Execute agents using Two-Phase Orchestration with pattern-controlled execution.

        Conversation history and RAG document context are loaded automatically
        by the Agent Framework's context-provider system (CosmosHistoryProvider
        and DocumentRAGProvider).  Callers only need to supply the current user
        message and session identifiers.

        Phase 1 (Analysis): Orchestrator analyzes request and decides:
                           - Answer directly (generic questions)
                           - Delegate to specialists (domain-specific)

        Phase 2 (Execution): Execute specialists using the session's pattern
                            (sequential, concurrent, magentic, group_chat)

        Phase 3 (Synthesis): Orchestrator synthesizes specialist results into
                            a coherent final response

        Args:
            pattern: The orchestration pattern to use for specialist execution
            agent_ids: List of agent IDs (should include orchestrator + specialists)
            user_message: The current user message
            session_id: Cosmos DB session ID (for history/RAG providers)
            user_id: Cosmos DB user ID (for history/RAG providers)
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
        
        # =====================================================================
        # Phase 1: Analysis - Orchestrator decides how to handle the request
        # Uses AgentSession with CosmosHistoryProvider + DocumentRAGProvider
        # so the orchestrator sees full conversation history and RAG context.
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
            user_message,
            session_id,
            user_id,
        )
        
        if should_log_agent():
            logger.info(f"Phase 1 decision: action={decision.get('action')}, specialists={decision.get('specialists', [])}")
        
        # Emit decision result event
        reasoning = decision.get("reasoning", "")
        action = decision.get("action", "unknown")
        if action == "delegate":
            # Resolve specialist names for the decision event
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
            friendly_message=decision_msg
        )
        
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
        
        # Execute specialists in a background task and stream chatter events
        # in real-time as they arrive (instead of batching after completion).
        specialist_task = asyncio.create_task(
            self._execute_specialists_with_pattern(
                pattern=pattern,
                specialist_ids=specialist_ids,
                user_message=user_message,
                user_token=user_token,
                chatter_queue=chatter_queue,
                max_rounds=max_rounds,
                orchestrator_config=orchestrator_config,
                session_id=session_id,
                user_id=user_id,
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
            user_message,
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
    
    async def close(self) -> None:
        """Cleanup resources."""
        self._agents_cache.clear()
        self._configs_cache.clear()


# Global instance
agent_manager = AgentManager()
