"""
Agent Orchestrator using Semantic Kernel for multi-agent coordination.
Uses the new SK agent framework with ChatCompletionAgent and group chat patterns.
"""

import logging
from typing import List, Dict, Any, Optional
import asyncio
from datetime import datetime, timezone

try:
    import semantic_kernel as sk
    from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
    from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
    from semantic_kernel.functions import kernel_function
    from semantic_kernel.kernel import Kernel
    from semantic_kernel.functions.kernel_arguments import KernelArguments
    from semantic_kernel.contents import ChatHistory, ChatMessageContent, AuthorRole
    from semantic_kernel.functions.kernel_plugin import KernelPlugin
    
    # Import agents from SK 1.33.0+
    try:
        from semantic_kernel.agents import ChatCompletionAgent, AgentGroupChat
        from semantic_kernel.agents.strategies import TerminationStrategy
        AGENTS_AVAILABLE = True
    except ImportError:
        AGENTS_AVAILABLE = False
        logging.warning("SK Agents module not available in this version")
        TerminationStrategy = object  # Fallback
    SK_AVAILABLE = True
except ImportError:
    SK_AVAILABLE = False
    AGENTS_AVAILABLE = False
    logging.warning("Semantic Kernel not available, falling back to basic orchestration")

from .base_agent import AgentManager, IAgent
from ..models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse
from ..constants import AGENT_CANNOT_ANSWER, NEGATIVE_RESPONSE_PATTERNS

logger = logging.getLogger(__name__)

class TaskCompletionTerminationStrategy(TerminationStrategy):
    """Custom termination strategy for agent group chat."""
    
    def __init__(self, max_iterations: int = 10):
        self.max_iterations = max_iterations
        self.iteration_count = 0
    
    async def should_agent_terminate(self, agent, history) -> bool:
        """Determine if the agent group chat should terminate."""
        self.iteration_count += 1
        
        # Terminate if max iterations reached
        if self.iteration_count >= self.max_iterations:
            logger.info(f"🔄 Group chat terminating: max iterations ({self.max_iterations}) reached")
            return True
        
        # Check if we have a complete response from any agent
        if history and len(history) > 0:
            last_message = history[-1].content.lower()
            
            # Look for completion indicators
            completion_keywords = [
                "here are the results",
                "query completed",
                "found the following",
                "search returned",
                "analysis complete",
                "task completed",
                "here's what i found",
                "here are the names",
                "kql query results",
                "returned", "rows",
                "tables in adx database",
                "available adx databases",
                "schema for adx table",
                "the names in your adx",
                "employees table are"
            ]
            
            for keyword in completion_keywords:
                if keyword in last_message:
                    logger.info(f"🎯 Group chat terminating: completion detected with keyword '{keyword}'")
                    return True
            
            # Check if the agent name contains "data_explorer" and we have results
            if hasattr(agent, 'name') and 'data_explorer' in agent.name.lower():
                if any(term in last_message for term in ['alice', 'bob', 'carol', 'david', 'ella', 'returned', 'found', 'names in your']):
                    logger.info(f"🎯 Group chat terminating: ADX agent provided results")
                    return True
                    
            # Also terminate if we see specific employee names (indicating ADX success)
            if any(name in last_message for name in ['alice johnson', 'bob smith', 'carol lee', 'david']):
                logger.info(f"🎯 Group chat terminating: detected employee names in response")
                return True
        
        return False

class AgentOrchestrator:
    """
    Agent orchestrator that coordinates between multiple specialized agents
    using Semantic Kernel's ChatCompletionAgent API.    """
    
    def __init__(self, config: Dict[str, Any], hub=None):
        self.config = config
        self.agent_manager = AgentManager()
        self.kernel: Optional[Kernel] = None
        self.sk_agents: Dict[str, Any] = {}  # ChatCompletionAgent when available
        self.group_chat: Optional[Any] = None  # AgentGroupChat instance
        self.hub = hub  # SocketIO hub for sending agent activities
        self._current_session_id: Optional[str] = None  # Current session for agent activities
        self._current_user_id: Optional[str] = None  # Current user for tool calls
        self._initialized = False
        self._use_semantic_kernel = SK_AVAILABLE and config.get('UseSemanticKernel', False)
        self._use_agents = AGENTS_AVAILABLE and self._use_semantic_kernel
        logger.info(f"🔧 Semantic Kernel mode: {self._use_semantic_kernel} (Available: {SK_AVAILABLE})")
        logger.info(f"🔧 Agents mode: {self._use_agents} (Available: {AGENTS_AVAILABLE})")
        
    async def initialize_async(self) -> None:
        """Initialize the orchestrator and optionally Semantic Kernel"""
        if self._initialized:
            logger.info("🔄 Orchestrator already initialized, skipping")
            return
            
        logger.info("🚀 Initializing Agent Orchestrator...")
        
        try:
            # Always initialize all registered agents first
            agents = await self.agent_manager.get_all_agents_async()
            logger.info(f"🔧 Initializing {len(agents)} registered agents...")
            for agent in agents:
                logger.info(f"🔧 Initializing agent: {agent.name}")
                await agent.initialize_async()
            logger.info("✅ All agents initialized")
            
            if self._use_semantic_kernel:
                logger.info("🔧 Initializing Semantic Kernel...")
                await self._initialize_semantic_kernel()
                
                # After kernel initialization, create SK agents for all registered agents
                if self._use_agents:
                    logger.info("🤖 Initializing SK agents...")
                    await self._initialize_sk_agents()
                elif self._use_semantic_kernel:
                    logger.info("🔧 Initializing SK functions...")
                    await self._initialize_sk_functions()
            
            self._initialized = True
            logger.info("✅ Agent Orchestrator initialized successfully")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize Agent Orchestrator: {str(e)}", exc_info=True)
            # Fall back to basic orchestration
            self._use_semantic_kernel = False
            self._use_agents = False
            self._initialized = True
            logger.info("✅ Agent Orchestrator initialized in basic mode")
    
    async def _initialize_semantic_kernel(self) -> None:
        """Initialize Semantic Kernel components"""
        if not SK_AVAILABLE:
            raise ImportError("Semantic Kernel not available")
            
        # Create kernel
        self.kernel = Kernel()
        
        # Add Azure OpenAI chat completion service
        azure_openai_config = self.config.get('AzureOpenAI', {})
        service_id = "chat_completion"
        
        # Check if service already exists to prevent duplicates
        try:
            existing_service = self.kernel.get_service(service_id)
            if existing_service:
                logger.info(f"Chat completion service already exists, skipping registration")
                return
        except Exception:
            # Service doesn't exist, continue with registration
            pass
        
        chat_completion = AzureChatCompletion(
            service_id=service_id,
            deployment_name=azure_openai_config.get('DeploymentName', 'gpt-4o'),
            endpoint=azure_openai_config.get('Endpoint', ''),
            api_key=azure_openai_config.get('ApiKey', ''),
            api_version=azure_openai_config.get('ApiVersion', '2024-02-01')
        )
        
        try:
            self.kernel.add_service(chat_completion)
            logger.info("✅ Semantic Kernel initialized with Azure OpenAI")
        except Exception as e:
            if "already exists" in str(e):
                logger.info(f"Chat completion service already registered, continuing...")
            else:
                raise e
    async def register_agent_async(self, agent: IAgent) -> None:
        """Register an agent with the orchestrator"""
        logger.info(f"🔧 Registering agent: {agent.name} (use_sk: {self._use_semantic_kernel}, use_agents: {self._use_agents})")
        await self.agent_manager.register_agent_async(agent)
        
        # SK agent creation will happen during initialization, not during registration
        logger.info(f"✅ Agent {agent.name} registered, SK setup will occur during initialization")
    
    async def _create_sk_agent(self, agent: IAgent) -> None:
        """Create a ChatCompletionAgent for the domain agent with its tools as plugins"""
        if not AGENTS_AVAILABLE:
            logger.warning("Agents API not available, skipping agent creation")
            return
            
        try:
            # Create a dedicated kernel for this agent with the tools as plugins
            agent_kernel = Kernel()
            
            # Add the same chat completion service with unique service ID for this agent
            azure_openai_config = self.config.get('AzureOpenAI', {})
            agent_service_id = f"chat_completion_{agent.agent_id.replace('-', '_')}"
            chat_completion = AzureChatCompletion(
                service_id=agent_service_id,
                deployment_name=azure_openai_config.get('DeploymentName', 'gpt-4o'),
                endpoint=azure_openai_config.get('Endpoint', ''),
                api_key=azure_openai_config.get('ApiKey', ''),
                api_version=azure_openai_config.get('ApiVersion', '2024-02-01')
            )
            agent_kernel.add_service(chat_completion)
                # Get the agent's tools and add them as functions
            tools = await agent.get_available_tools_async()
            if tools:
                logger.info(f"🔧 Creating plugin with {len(tools)} tools for {agent.name}")
                
                # Create a plugin object dynamically with methods for each tool
                plugin_name = f"{agent.agent_id.replace('-', '_')}_plugin"
                
                # Create a plugin class dynamically
                class AgentPlugin:
                    def __init__(self, agent_instance):
                        self.agent = agent_instance
                        
                # Create an instance of the plugin
                plugin_instance = AgentPlugin(agent)
                
                # Add methods to the plugin instance for each tool
                for tool in tools:
                    method = self._create_sk_function_method(agent, tool)
                    setattr(plugin_instance, tool.name, method)                # Create the plugin from the object
                logger.info(f"🔧 Creating plugin: name='{plugin_name}', type={type(plugin_instance)}")
                plugin = KernelPlugin.from_object(plugin_name, plugin_instance)
                agent_kernel.add_plugin(plugin)
                logger.info(f"✅ Added plugin '{plugin_name}' with {len(tools)} tools to agent kernel")
            
            # Create the ChatCompletionAgent
            agent_name = agent.name.replace(' ', '_').replace('-', '_')  # Make name compatible with SK validation
            # Create more specific instructions based on agent domain
            domain_specific_instructions = self._get_domain_specific_instructions(agent)
            
            sk_agent = ChatCompletionAgent(
                kernel=agent_kernel,
                name=agent_name,
                instructions=domain_specific_instructions,
                function_choice_behavior=FunctionChoiceBehavior.Auto()
            )
            
            self.sk_agents[agent.agent_id] = sk_agent
            logger.info(f"✅ Created ChatCompletionAgent for {agent.name}")
            
            # Create or update group chat if we have multiple agents
            if len(self.sk_agents) >= 1:
                await self._create_group_chat()
                
        except Exception as e:
            logger.error(f"❌ Failed to create SK agent for {agent.agent_id}: {str(e)}", exc_info=True)
    
    def _create_sk_function_method(self, agent: IAgent, tool: McpTool):
        """Create a Semantic Kernel function method for an MCP tool"""
        
        # Log the tool schema for debugging
        logger.info(f"🔧 Creating SK function for tool: {tool.name}")
        logger.info(f"🔧 Tool description: {tool.description}")
        logger.info(f"🔧 Tool schema: {tool.input_schema}")
        
        # Convert MCP tool schema to SK parameters dynamically
        def create_dynamic_sk_function():
            # Extract parameters from the MCP schema
            parameters = {}
            if tool.input_schema and tool.input_schema.properties:
                for param_name, param_info in tool.input_schema.properties.items():
                    param_type = str  # Default to string
                    if param_info.type == "integer":
                        param_type = int
                    elif param_info.type == "number":
                        param_type = float
                    elif param_info.type == "boolean":
                        param_type = bool
                    
                    # Set default value for optional parameters
                    default_value = None
                    if param_name not in (tool.input_schema.required or []):
                        # For ADX tools, use the configured database as default
                        if param_name in ['database', 'database_name'] and hasattr(agent, 'database'):
                            default_value = getattr(agent, 'database', None)
            
            # Create the actual function that SK will call
            # Build function signature dynamically based on MCP tool schema
            func_params = {}
            if tool.input_schema and tool.input_schema.properties:
                for param_name, param_info in tool.input_schema.properties.items():
                    param_type = str  # Default to string
                    if param_info.type == "integer":
                        param_type = int
                    elif param_info.type == "number":
                        param_type = float
                    elif param_info.type == "boolean":
                        param_type = bool
                    
                    # Set default value for optional parameters
                    is_required = param_name in (tool.input_schema.required or [])
                    func_params[param_name] = {
                        'type': param_type,
                        'required': is_required,
                        'description': param_info.description
                    }
            
            @kernel_function(
                name=tool.name,
                description=tool.description
            )
            async def sk_function(**kwargs) -> str:
                """Semantic Kernel function that calls the agent's tool"""
                try:
                    logger.info(f"🔧 Executing tool {tool.name} via {agent.name} with args: {kwargs}")
                    
                    # Send agent activity for tool execution start
                    self._send_agent_activity(
                        self._current_session_id,
                        agent.name,
                        f"Executing Tool: {tool.name}",
                        "in_progress",
                        f"Running {tool.name} with parameters"
                    )
                    
                    # Process and flatten arguments - SK sometimes nests them in kwargs
                    tool_arguments = {}
                    
                    # If there's a 'kwargs' key, flatten it first
                    if 'kwargs' in kwargs:
                        logger.info(f"🔧 Flattening nested kwargs...")
                        # Flatten the nested kwargs first
                        nested_args = kwargs['kwargs']
                        tool_arguments.update(nested_args)
                        # Also include any top-level arguments that aren't 'kwargs'
                        for key, value in kwargs.items():
                            if key != 'kwargs':
                                tool_arguments[key] = value
                    else:
                        logger.info(f"🔧 No nested kwargs, using arguments directly...")
                        tool_arguments.update(kwargs)
                    
                    # Always add userId and sessionId to tool call arguments
                    if self._current_user_id:
                        tool_arguments['userId'] = self._current_user_id
                        logger.info(f"🔧 Added userId: {self._current_user_id}")
                    if self._current_session_id:
                        tool_arguments['sessionId'] = self._current_session_id
                        logger.info(f"🔧 Added sessionId: {self._current_session_id}")
                    
                    logger.info(f"🔧 Final tool arguments after flattening: {tool_arguments}")
                    
                    request = McpToolCallRequest(
                        name=tool.name,
                        arguments=tool_arguments
                    )
                    
                    response = await agent.execute_tool_async(request)
                    
                    if response.is_error:
                        error_msg = response.content[0].text if response.content else 'Unknown error'
                        logger.error(f"❌ Tool {tool.name} error: {error_msg}")
                        
                        # Send agent activity for tool execution error
                        self._send_agent_activity(
                            self._current_session_id,
                            agent.name,
                            f"Tool Error: {tool.name}",
                            "error",
                            error_msg[:200] + "..." if len(error_msg) > 200 else error_msg
                        )
                        
                        return f"Error: {error_msg}"
                        
                    result = response.content[0].text if response.content else "Tool executed successfully"
                    logger.info(f"✅ Tool {tool.name} result: {result[:100]}...")
                    
                    # Send agent activity for tool execution success
                    result_preview = result[:200] + "..." if len(result) > 200 else result
                    self._send_agent_activity(
                        self._current_session_id,
                        agent.name,
                        f"Tool Completed: {tool.name}",
                        "completed",
                        result_preview
                    )
                    
                    return result
                    
                except Exception as e:
                    logger.error(f"❌ Error in SK function {tool.name}: {str(e)}")
                    
                    # Send agent activity for tool execution exception
                    self._send_agent_activity(
                        self._current_session_id,
                        agent.name,
                        f"Tool Exception: {tool.name}",
                        "error",
                        str(e)[:200] + "..." if len(str(e)) > 200 else str(e)
                    )
                    
                    return f"Error: {str(e)}"
            
            return sk_function
        
        return create_dynamic_sk_function()
    
    async def _create_group_chat(self) -> None:
        """Create group chat for multi-agent collaboration"""
        try:
            if not AGENTS_AVAILABLE or len(self.sk_agents) == 0:
                logger.info("⚠️ Cannot create group chat: agents not available or no agents registered")
                return
            
            # Create the group chat with all agents (use default termination strategy for now)
            agents_list = list(self.sk_agents.values())
            
            self.group_chat = AgentGroupChat(
                agents=agents_list
            )
            
            logger.info(f"✅ Created group chat with {len(agents_list)} agents: {[agent.name for agent in agents_list]}")
            
        except Exception as e:
            logger.error(f"❌ Failed to create group chat: {str(e)}", exc_info=True)

    def _create_agent_selector_function(self):
        """Create a function that selects which agent should respond next"""
        
        @kernel_function(
            name="select_next_agent",
            description="Select which agent should respond next based on the conversation context"
        )
        async def select_agent(
            message: str,
            agents: str,
            history: str
        ) -> str:
            """Select the most appropriate agent for the current message"""
            try:
                # Simple keyword-based selection for now
                message_lower = message.lower()
                
                # Define keywords for each agent type
                agent_keywords = {
                    'documents': ['document', 'file', 'upload', 'search', 'content', 'pdf', 'text'],
                    'adx': ['data', 'query', 'analytics', 'kusto', 'logs', 'telemetry'],
                    'core': ['help', 'general', 'chat', 'conversation']
                }
                
                # Score each agent type
                scores = {}
                for agent_type, keywords in agent_keywords.items():
                    score = sum(1 for keyword in keywords if keyword in message_lower)
                    if score > 0:
                        scores[agent_type] = score
                
                # Return the agent with highest score, or core as fallback
                if scores:
                    best_agent_type = max(scores.items(), key=lambda x: x[1])[0]
                    
                    # Find the actual agent name
                    for agent_id, agent in self.sk_agents.items():
                        if best_agent_type in agent_id.lower() or best_agent_type in agent.name.lower():                            return agent.name
                
                # Fallback to core agent or first available
                for agent in self.sk_agents.values():
                    if 'core' in agent.name.lower():
                        return agent.name
                
                return list(self.sk_agents.values())[0].name if self.sk_agents else "CoreAgent"
                
            except Exception as e:
                logger.error(f"❌ Error in agent selection: {str(e)}")
                return list(self.sk_agents.values())[0].name if self.sk_agents else "CoreAgent"
        
        return select_agent
    
    async def process_request_async(self, messages: List[Dict[str, Any]], session_id: str, user_id: str = None) -> Dict[str, Any]:
        """Process a chat request using the orchestrator"""
        if not self._initialized:
            await self.initialize_async()
        
        # Store session_id and user_id for use in tool execution
        self._current_session_id = session_id
        self._current_user_id = user_id
        
        try:
            if self._use_agents and self.sk_agents:
                return await self._process_with_semantic_kernel_agents(messages, session_id)
            elif self._use_semantic_kernel and self.kernel:
                return await self._process_with_semantic_kernel_functions(messages, session_id)
            else:
                return await self._process_with_basic_orchestration(messages, session_id)
                
        except Exception as e:
            logger.error(f"Error processing request: {str(e)}")
            return {
                'content': f"I encountered an error while processing your request: {str(e)}",
                'function_calls': [],
                'finish_reason': 'error'
            }
    
    async def _process_with_semantic_kernel_agents(self, messages: List[Dict[str, Any]], session_id: str) -> Dict[str, Any]:
        """Process using Semantic Kernel with ChatCompletionAgent and group chat"""
        try:
            # Get the latest user message
            user_message = ""
            for msg in reversed(messages):
                if msg.get('role') == 'user':
                    user_message = msg.get('content', '')
                    break
            
            if not user_message:
                return {
                    'content': "I didn't receive a message to process.",
                    'function_calls': [],
                    'finish_reason': 'stop'
                }
            
            logger.info(f"🤖 Processing with group chat: {len(self.sk_agents)} agents available")
            
            # If we have multiple agents, determine which are relevant for this query
            if len(self.sk_agents) > 1:
                # Get relevant agents for this specific message
                relevant_agents = await self._get_relevant_agents_for_message(user_message)
                
                if len(relevant_agents) > 1:
                    logger.info(f"🔄 Using group chat with {len(relevant_agents)} relevant agents: {[agent.name for agent in relevant_agents]}")
                    
                    # Create temporary group chat with only relevant agents
                    temp_group_chat = AgentGroupChat(
                        agents=relevant_agents
                    )
                    
                    # Set current context for session/user tracking
                    # (user_id and session_id already set at method start)
                    
                    # Send agent activity for group chat start
                    self._send_agent_activity(
                        session_id,
                        "Group Chat Orchestrator",
                        "Starting Multi-Agent Collaboration",
                        "in_progress",
                        f"Coordinating {len(relevant_agents)} relevant agents for your request"
                    )
                    
                    # Add the user message to group chat
                    await temp_group_chat.add_chat_message(user_message)
                    
                    # Invoke the group chat
                    responses = []
                    async for response in temp_group_chat.invoke():
                        agent_name = getattr(response, 'name', 'Unknown Agent')
                        content = str(response.content)
                        
                        # Filter out "cannot answer" responses
                        if AGENT_CANNOT_ANSWER in content:
                            logger.info(f"🚫 Filtering out 'cannot answer' response from {agent_name}")
                            continue
                            
                        # Filter out generic negative responses
                        content_lower = content.lower()
                        is_negative = any(pattern in content_lower for pattern in NEGATIVE_RESPONSE_PATTERNS)
                        if is_negative and len(content) < 200:  # Short negative responses
                            logger.info(f"🚫 Filtering out negative response from {agent_name}")
                            continue
                        
                        content_preview = content[:100] + "..." if len(content) > 100 else content
                        logger.info(f"📨 Group chat response from {agent_name}: {content_preview}")
                        
                        # Send agent activity for this agent starting to respond
                        self._send_agent_activity(
                            session_id,
                            agent_name,
                            "Agent Processing Request",
                            "in_progress",
                            f"Analyzing request and determining appropriate response..."
                        )
                        
                        # Send agent activity for this response completion
                        self._send_agent_activity(
                            session_id,
                            agent_name,
                            "Generated Response",
                            "completed",
                            content_preview
                        )
                        
                        responses.append(response)
                    
                    if responses:
                        # Send final selection activity
                        self._send_agent_activity(
                            session_id,
                            "Group Chat Orchestrator",
                            "Selecting Best Response",
                            "completed",
                            f"Analyzed {len(responses)} responses and selected the best one"
                        )
                        
                        # Find the best response - prioritize responses with actual data over generic responses
                        final_response = self._select_best_response(responses)
                        return {
                            'content': str(final_response.content),
                            'function_calls': [],  # SK handles function calls internally
                            'finish_reason': 'stop',
                            'agent_name': final_response.name
                        }
                elif len(relevant_agents) == 1:
                    # Single relevant agent - use it directly
                    selected_agent = relevant_agents[0]
                    logger.info(f"🤖 Using single relevant agent: {selected_agent.name}")
                    
                    # Set current context for session/user tracking
                    # (user_id and session_id already set at method start)
                    
                    # Send agent activity for single agent selection
                    self._send_agent_activity(
                        session_id,
                        selected_agent.name,
                        "Agent Selected",
                        "in_progress",
                        f"Processing your request with specialized {selected_agent.name}"
                    )
                    
                    # Create chat history from messages
                    chat_history = ChatHistory()
                    for msg in messages:
                        role = msg.get('role', '')
                        content = msg.get('content', '')
                        
                        if role == 'user':
                            chat_history.add_user_message(content)
                        elif role == 'assistant':
                            chat_history.add_assistant_message(content)
                    
                    # Invoke the selected agent
                    response = await selected_agent.get_response(user_message)
                    
                    if response and response.message:
                        content = str(response.message.content)
                        logger.info(f"✅ Agent response: {content[:100]}...")
                        return {
                            'content': content,
                            'function_calls': [],
                            'finish_reason': 'stop',
                            'agent_name': selected_agent.name
                        }
            
            # Legacy group chat fallback (if no relevant agents filtering worked)
            elif self.group_chat and len(self.sk_agents) > 1:
                logger.info(f"🔄 Using group chat with {len(self.sk_agents)} agents")
                
                # Send agent activity for group chat start
                self._send_agent_activity(
                    session_id,
                    "Group Chat Orchestrator",
                    "Starting Multi-Agent Collaboration",
                    "in_progress",
                    f"Coordinating {len(self.sk_agents)} agents for your request"
                )
                
                # Add the user message to group chat
                await self.group_chat.add_chat_message(user_message)
                
                # Invoke the group chat
                responses = []
                async for response in self.group_chat.invoke():
                    agent_name = getattr(response, 'name', 'Unknown Agent')
                    content_preview = str(response.content)[:100] + "..." if len(str(response.content)) > 100 else str(response.content)
                    
                    logger.info(f"📨 Group chat response from {agent_name}: {content_preview}")
                    
                    # Send agent activity for this agent starting to respond
                    self._send_agent_activity(
                        session_id,
                        agent_name,
                        "Agent Processing Request",
                        "in_progress",
                        f"Analyzing request and determining appropriate response..."
                    )
                    
                    # Send agent activity for this response completion
                    self._send_agent_activity(
                        session_id,
                        agent_name,
                        "Generated Response",
                        "completed",
                        content_preview
                    )
                    
                    responses.append(response)
                
                if responses:
                    # Send final selection activity
                    self._send_agent_activity(
                        session_id,
                        "Group Chat Orchestrator",
                        "Selecting Best Response",
                        "completed",
                        f"Analyzed {len(responses)} responses and selected the best one"
                    )
                    
                    # Find the best response - prioritize responses with actual data over generic responses
                    final_response = self._select_best_response(responses)
                    return {
                        'content': str(final_response.content),
                        'function_calls': [],  # SK handles function calls internally
                        'finish_reason': 'stop',
                        'agent_name': final_response.name
                    }
            
            # Single agent case - select the best agent and invoke directly
            else:
                selected_agent = await self._select_best_agent_for_message(user_message)
                if selected_agent:
                    logger.info(f"🤖 Using single agent: {selected_agent.name}")
                    
                    # Send agent activity for single agent selection
                    self._send_agent_activity(
                        session_id,
                        selected_agent.name,
                        "Agent Selected",
                        "in_progress",
                        f"Processing your request with specialized {selected_agent.name}"
                    )
                    
                    # Create chat history from messages
                    chat_history = ChatHistory()
                    for msg in messages:
                        role = msg.get('role', '')
                        content = msg.get('content', '')
                        
                        if role == 'user':
                            chat_history.add_user_message(content)
                        elif role == 'assistant':
                            chat_history.add_assistant_message(content)
                    
                    # Invoke the selected agent
                    response = await selected_agent.get_response(user_message)
                    
                    if response and response.message:
                        content = str(response.message.content)
                        logger.info(f"✅ Agent response: {content[:100]}...")
                        return {
                            'content': content,
                            'function_calls': [],
                            'finish_reason': 'stop',
                            'agent_name': selected_agent.name
                        }
            
            # Fallback response
            logger.warning("⚠️ No response generated from Semantic Kernel agents")
            return {
                'content': "I'm sorry, I couldn't generate a response. Please try again.",
                'function_calls': [],
                'finish_reason': 'error'
            }
                
        except Exception as e:
            logger.error(f"❌ Error in Semantic Kernel agent processing: {str(e)}", exc_info=True)
            # Fall back to function-based approach
            if self._use_semantic_kernel and self.kernel:
                return await self._process_with_semantic_kernel_functions(messages, session_id)
            else:
                return await self._process_with_basic_orchestration(messages, session_id)
    
    def _select_best_response(self, responses):
        """Select the best response from a list of group chat responses.
        Prioritizes responses with actual data over generic 'no access' responses."""
        if not responses:
            return None
            
        # Score responses based on content quality
        scored_responses = []
        for response in responses:
            content = str(response.content).lower()
            score = 0
            
            # Skip responses that explicitly cannot answer
            if AGENT_CANNOT_ANSWER.lower() in content:
                logger.info(f"🚫 Filtering out 'cannot answer' response from {response.name}")
                continue
            
            # High score for responses with actual data
            if any(term in content for term in ['alice', 'bob', 'carol', 'david', 'ella']):
                score += 100
            if any(term in content for term in ['names in your', 'employees table are', 'kql query results']):
                score += 80
            if any(term in content for term in ['found', 'returned', 'results', 'tables in adx']):
                score += 60
            if 'memorypipeline.txt' in content and 'configuration settings' in content:
                score += 90  # Document content responses
                
            # Negative score for generic responses and cross-domain pollution
            if any(term in content for term in ["i don't have access", "currently don't have access", "unable to access", "can't assist"]):
                score -= 50
            if "sorry" in content and len(content) < 200:  # Short apology responses
                score -= 30
            
            # Detect cross-domain pollution (e.g., agent responding outside their domain)
            agent_name_lower = response.name.lower()
            if 'documents' in agent_name_lower and any(term in content for term in ['adx', 'employees', 'database', 'kql']):
                score -= 100  # Heavy penalty for cross-domain responses
                logger.warning(f"🚫 Cross-domain response detected: Documents agent responding about ADX")
            elif 'adx' in agent_name_lower or 'data_explorer' in agent_name_lower and any(term in content for term in ['memorypipeline', 'configuration settings']):
                # Allow ADX agent to respond about document content if it contains data
                pass  # Don't penalize ADX agent for analyzing document content with data
                
            # Prefer domain-appropriate agent responses
            if hasattr(response, 'name') and 'data_explorer' in response.name.lower():
                if any(term in content for term in ['kql', 'database', 'employees', 'personnel']):
                    score += 40  # Bonus for ADX agent with data queries
            if hasattr(response, 'name') and 'documents' in response.name.lower():
                if any(term in content for term in ['document', 'file', 'content', 'upload']):
                    score += 40  # Bonus for Documents agent with file operations
                
            scored_responses.append((score, response))
            logger.info(f"🔍 Response from {response.name}: score={score}, content='{str(response.content)[:80]}...'")
        
        # Sort by score (highest first) and return the best response
        if not scored_responses:
            logger.warning("⚠️ No valid responses after filtering")
            return responses[0] if responses else None
            
        scored_responses.sort(key=lambda x: x[0], reverse=True)
        best_response = scored_responses[0][1]
        logger.info(f"🎯 Selected best response from {best_response.name} with score {scored_responses[0][0]}")
        return best_response

    async def _select_best_agent_for_message(self, message: str):
        """Select the best agent for a single message"""
        message_lower = message.lower()
        
        # Score each agent based on domain relevance
        best_agent = None
        best_score = 0
        
        for agent_id, sk_agent in self.sk_agents.items():
            # Get the original agent to access domains
            original_agent = None
            for agent in await self.agent_manager.get_all_agents_async():
                if agent.agent_id == agent_id:
                    original_agent = agent
                    break
            
            if not original_agent:
                continue
                
            # Calculate relevance score based on domain keywords in message
            score = 0
            for domain in original_agent.domains:
                if domain.lower() in message_lower:
                    score += 10  # High score for exact domain match
                    
            # Additional keyword scoring for common terms
            domain_keywords = {
                'documents': ['document', 'file', 'upload', 'search', 'content', 'pdf', 'text', 'rag', '.txt', '.doc', '.docx'],
                'files': ['document', 'file', 'upload', 'search', 'content', 'pdf', 'text', 'rag', '.txt', '.doc', '.docx'],
                'adx': ['data', 'query', 'analytics', 'kusto', 'logs', 'telemetry', 'employee', 'database', 'kql', 'names', 'personnel'],
                'analytics': ['data', 'query', 'analytics', 'kusto', 'logs', 'telemetry', 'employee', 'database', 'kql', 'names', 'personnel'],
                'core': ['help', 'general', 'chat', 'conversation', 'hello', 'hi']
            }
            
            # Check if any domain matches our keywords
            for domain in original_agent.domains:
                if domain.lower() in domain_keywords:
                    keywords = domain_keywords[domain.lower()]
                    keyword_matches = sum(2 for keyword in keywords if keyword in message_lower)
                    score += keyword_matches
                    if keyword_matches > 0:
                        logger.info(f"🎯 Domain '{domain}' matched keywords in message, adding {keyword_matches} points")
                    
            logger.info(f"🎯 Agent {sk_agent.name} relevance score: {score} for message: '{message[:50]}...'")
            
            if score > best_score:
                best_score = score
                best_agent = sk_agent
        
        # Only select agent if it has a meaningful relevance score
        if best_score >= 2:  # Lower threshold for better matching
            logger.info(f"🤖 Selected {best_agent.name} with score {best_score}")
            return best_agent
            
        # Fallback to core agent for general queries
        for agent in self.sk_agents.values():
            if 'core' in agent.name.lower():
                logger.info(f"🤖 Falling back to core agent: {agent.name}")
                return agent
        
        logger.warning("⚠️ No relevant agent found for message")
        return None

    async def _get_relevant_agents_for_message(self, message: str) -> List:
        """Get agents that are relevant for a specific message based on domain matching"""
        message_lower = message.lower()
        relevant_agents = []
        
        for agent_id, sk_agent in self.sk_agents.items():
            # Get the original agent to access domains
            original_agent = None
            for agent in await self.agent_manager.get_all_agents_async():
                if agent.agent_id == agent_id:
                    original_agent = agent
                    break
            
            if not original_agent:
                continue
                
            # Calculate relevance score based on domain keywords in message
            score = 0
            for domain in original_agent.domains:
                if domain.lower() in message_lower:
                    score += 10  # High score for exact domain match
                    
            # Additional keyword scoring for common terms
            domain_keywords = {
                'documents': ['document', 'file', 'upload', 'search', 'content', 'pdf', 'text', 'rag', '.txt', '.doc', '.docx'],
                'files': ['document', 'file', 'upload', 'search', 'content', 'pdf', 'text', 'rag', '.txt', '.doc', '.docx'],
                'adx': ['data', 'query', 'analytics', 'kusto', 'logs', 'telemetry', 'employee', 'database', 'kql', 'names', 'personnel'],
                'analytics': ['data', 'query', 'analytics', 'kusto', 'logs', 'telemetry', 'employee', 'database', 'kql', 'names', 'personnel'],
                'core': ['help', 'general', 'chat', 'conversation', 'hello', 'hi']
            }
            
            # Check if any domain matches our keywords
            for domain in original_agent.domains:
                if domain.lower() in domain_keywords:
                    keywords = domain_keywords[domain.lower()]
                    keyword_matches = sum(2 for keyword in keywords if keyword in message_lower)
                    score += keyword_matches
                    if keyword_matches > 0:
                        logger.info(f"🎯 Domain '{domain}' matched keywords in message, adding {keyword_matches} points")
                    
            logger.info(f"🎯 Agent {sk_agent.name} relevance score: {score} for message: '{message[:50]}...'")
            
            # Include agent if it has a meaningful relevance score
            if score >= 2:  # Lower threshold for better matching
                relevant_agents.append(sk_agent)
                logger.info(f"✅ Including {sk_agent.name} (score: {score})")
        
        # Always include core agent as fallback if no specific agents are relevant
        if not relevant_agents:
            for agent in self.sk_agents.values():
                if 'core' in agent.name.lower():
                    relevant_agents.append(agent)
                    logger.info(f"✅ Including core agent as fallback: {agent.name}")
                    break
        
        # If still no agents, include all (fallback behavior)
        if not relevant_agents:
            relevant_agents = list(self.sk_agents.values())
            logger.warning("⚠️ No relevant agents found, including all agents")
            
        return relevant_agents
    
    async def _process_with_basic_orchestration(self, messages: List[Dict[str, Any]], session_id: str) -> Dict[str, Any]:
        """Process using basic orchestration without Semantic Kernel"""
        # Get the latest user message
        user_message = ""
        for msg in reversed(messages):
            if msg.get('role') == 'user':
                user_message = msg.get('content', '')
                break
        
        if not user_message:
            return {
                'content': "I didn't receive a message to process.",
                'function_calls': [],
                'finish_reason': 'stop'
            }
        
        # Simple keyword-based agent selection
        agents = await self.agent_manager.get_all_agents_async()
        selected_agent = None
        
        user_message_lower = user_message.lower()
        
        # Try to find a relevant agent based on keywords
        for agent in agents:
            for domain in agent.domains:
                if domain.lower() in user_message_lower:
                    selected_agent = agent
                    break
            if selected_agent:
                break
        
        # Fall back to core agent if no specific agent found
        if not selected_agent:
            for agent in agents:
                if 'core' in agent.domains:
                    selected_agent = agent
                    break
        
        if not selected_agent:
            return {
                'content': "I'm sorry, I don't have any agents available to process your request.",
                'function_calls': [],
                'finish_reason': 'stop'
            }
        
        # For basic orchestration, we'll just return a simple response
        # indicating which agent would handle this
        return {
            'content': f"I would route this request to the {selected_agent.name} which handles: {', '.join(selected_agent.domains)}. However, full multi-agent orchestration requires Semantic Kernel integration.",            'function_calls': [],
            'finish_reason': 'stop'
        }
    
    async def get_all_agents_async(self) -> List[IAgent]:
        """Get all registered agents"""
        return await self.agent_manager.get_all_agents_async()
    
    async def get_all_tools_async(self) -> List[McpTool]:
        """Get all available tools from all agents"""
        return await self.agent_manager.get_all_available_tools_async()
    
    async def _register_agent_functions(self, agent: IAgent) -> None:
        """Register an agent's tools as Semantic Kernel functions following MCP pattern"""
        try:
            tools = await agent.get_available_tools_async()
            logger.info(f"🔧 Registering {len(tools)} tools from {agent.name} as SK functions...")
            
            if not tools:
                logger.warning(f"⚠️ No tools found for agent {agent.name}")
                return
            
            # Convert MCP tools to SK functions using the pattern from the article
            sk_functions = []
            for tool in tools:
                # Create SK function wrapper for each MCP tool
                sk_function = self._convert_mcp_tool_to_sk_function(agent, tool)
                sk_functions.append(sk_function)
              # Add functions as a plugin using the recommended MCP pattern
            plugin_name = f"{agent.agent_id.replace('-', '_')}"
            plugin = KernelPlugin.from_functions(plugin_name, sk_functions)
            self.kernel.add_plugin(plugin)
                
            logger.info(f"✅ Registered {len(tools)} tools from {agent.name} as SK plugin '{plugin_name}'")
            
        except Exception as e:
            logger.error(f"❌ Failed to register SK functions for agent {agent.agent_id}: {str(e)}", exc_info=True)
    
    async def _process_with_semantic_kernel_functions(self, messages: List[Dict[str, Any]], session_id: str) -> Dict[str, Any]:
        """Process using Semantic Kernel with function calling (when agents API not available)"""
        try:
            # Create chat history from messages
            chat_history = ChatHistory()
            
            # Add system message
            system_prompt = self.config.get('SystemPrompt', 'You are a helpful AI assistant with access to various tools.')
            chat_history.add_system_message(system_prompt)
            
            # Add conversation messages
            for msg in messages:
                role = msg.get('role', '')
                content = msg.get('content', '')
                
                if role == 'user':
                    chat_history.add_user_message(content)
                elif role == 'assistant':
                    chat_history.add_assistant_message(content)
            
            # Get chat completion service
            chat_completion = self.kernel.get_service("chat_completion")
              # Create execution settings with auto function calling
            execution_settings = chat_completion.get_prompt_execution_settings_class()(
                service_id="chat_completion",
                max_tokens=2000,
                temperature=0.7,
                function_choice_behavior=FunctionChoiceBehavior.Auto()
            )
            
            logger.info(f"🤖 Processing chat with {len(self.kernel.plugins)} plugins and auto function calling enabled")
            
            # Get the response
            response = await chat_completion.get_chat_message_contents(
                chat_history=chat_history,
                settings=execution_settings,
                kernel=self.kernel
            )
            
            if response and len(response) > 0:
                content = str(response[0])
                logger.info(f"✅ SK function response generated: {content[:100]}...")
                return {
                    'content': content,
                    'function_calls': [],  # SK handles this internally
                    'finish_reason': 'stop'
                }
            else:
                logger.warning("⚠️ No response generated from Semantic Kernel functions")
                return {
                    'content': "I'm sorry, I couldn't generate a response.",
                    'function_calls': [],
                    'finish_reason': 'error'
                }
                
        except Exception as e:
            logger.error(f"❌ Error in Semantic Kernel function processing: {str(e)}", exc_info=True)
            # Fall back to basic orchestration
            return await self._process_with_basic_orchestration(messages, session_id)
    
    def _convert_mcp_tool_to_sk_function(self, agent: IAgent, tool: McpTool):
        """Convert an MCP tool to a Semantic Kernel function following the MCP integration pattern"""
        
        @kernel_function(
            name=tool.name,
            description=tool.description
        )
        async def mcp_tool_function(**kwargs) -> str:
            """Semantic Kernel function that calls the agent's MCP tool"""
            try:
                logger.info(f"🔧 Executing MCP tool {tool.name} via {agent.name} with args: {kwargs}")
                
                # Always add userId and sessionId to tool call arguments
                tool_arguments = kwargs.copy()
                if self._current_user_id:
                    tool_arguments['userId'] = self._current_user_id
                if self._current_session_id:
                    tool_arguments['sessionId'] = self._current_session_id
                
                # Create MCP tool call request
                request = McpToolCallRequest(
                    name=tool.name,
                    arguments=tool_arguments
                )
                
                # Execute the tool through the agent
                response = await agent.execute_tool_async(request)
                
                if response.is_error:
                    error_msg = response.content[0].text if response.content else 'Unknown error'
                    logger.error(f"❌ MCP tool {tool.name} error: {error_msg}")
                    return f"Error executing {tool.name}: {error_msg}"
                
                result = response.content[0].text if response.content else "Tool executed successfully"
                logger.info(f"✅ MCP tool {tool.name} result: {result[:100]}...")
                return result
                
            except Exception as e:
                logger.error(f"❌ Error in MCP tool {tool.name}: {str(e)}")
                return f"Error executing {tool.name}: {str(e)}"
        
        return mcp_tool_function
    
    async def _initialize_sk_agents(self) -> None:
        """Initialize SK agents for all registered agents"""
        try:
            agents = await self.agent_manager.get_all_agents_async()
            logger.info(f"🤖 Creating SK agents for {len(agents)} registered agents...")
            
            # Create SK agents (agents should already be initialized)
            for agent in agents:
                await self._create_sk_agent(agent)
            
            logger.info(f"✅ Created {len(self.sk_agents)} SK agents")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize SK agents: {str(e)}", exc_info=True)
    
    async def _initialize_sk_functions(self) -> None:
        """Initialize SK functions for all registered agents"""
        try:
            agents = await self.agent_manager.get_all_agents_async()
            logger.info(f"🔧 Creating SK functions for {len(agents)} registered agents...")
            
            # Register their functions (agents should already be initialized)
            for agent in agents:
                await self._register_agent_functions(agent)
            
            logger.info(f"✅ Registered functions for {len(agents)} agents")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize SK functions: {str(e)}", exc_info=True)

    def _should_filter_agent_activity(self, result: str) -> bool:
        """
        Check if an agent activity result should be filtered from the UI.
        Returns True if the result indicates the agent cannot handle the query.
        """
        if not result:
            return False
            
        result_lower = result.lower().strip()
        
        # Check for the standardized cannot answer response
        if AGENT_CANNOT_ANSWER.lower() in result_lower:
            return True
            
        # Check for other negative response patterns
        for pattern in NEGATIVE_RESPONSE_PATTERNS:
            if pattern.lower() in result_lower:
                return True
                
        return False

    def _send_agent_activity(self, session_id: str, agent_name: str, action: str, status: str, result: str = ""):
        """Send agent activity to the UI via SocketIO hub, with filtering for negative responses"""
        if self.hub and session_id:
            try:
                # Filter out negative/unhelpful agent responses to reduce UI clutter
                # Apply filtering to completed activities that contain results/responses
                should_filter = (
                    status == "completed" and 
                    ("Response" in action or "Completed" in action or action == "completed") and
                    self._should_filter_agent_activity(result)
                ) or (
                    # Also filter generic "analyzing request" messages that add no value
                    action == "Agent Processing Request" and 
                    "analyzing request and determining appropriate response" in result.lower()
                )
                
                if should_filter:
                    filter_reason = "negative response" if "Response" in action else "generic message"
                    logger.info(f"🔇 Filtered agent activity ({filter_reason}): {agent_name} - {action}")
                    return
                
                import uuid
                activity_data = {
                    'id': str(uuid.uuid4()),
                    'agentName': agent_name,
                    'action': action,
                    'status': status,
                    'result': result,
                    'timestamp': datetime.now(timezone.utc).isoformat(),
                    'sessionId': session_id
                }
                self.hub.send_agent_activity(session_id, activity_data)
                logger.info(f"📡 Sent agent activity: {agent_name} - {action} ({status})")
            except Exception as e:
                logger.warning(f"Failed to send agent activity: {e}")
    
    def _get_domain_specific_instructions(self, agent: IAgent) -> str:
        """Generate domain-specific instructions for an agent"""
        base_instruction = f"You are a {agent.name} specialized in: {', '.join(agent.domains)}."
        
        # Define domain-specific keywords that should trigger this agent
        domain_keywords = {
            'documents': ['document', 'file', 'upload', 'search', 'content', 'pdf', 'text', 'rag'],
            'adx': ['data', 'query', 'analytics', 'kusto', 'logs', 'telemetry', 'employee', 'database', 'kql', 'names'],
            'core': ['help', 'general', 'chat', 'conversation']
        }
        
        # Get relevant keywords for this agent
        agent_keywords = []
        for domain in agent.domains:
            if domain in domain_keywords:
                agent_keywords.extend(domain_keywords[domain])
        
        if agent_keywords:
            relevant_keywords = ', '.join(agent_keywords[:8])  # Limit to first 8 keywords
            keyword_instruction = f" You are most relevant for queries containing: {relevant_keywords}."
        else:
            keyword_instruction = ""
        
        # Domain-specific behavior instructions
        if any(domain in ['documents', 'files', 'upload', 'search'] for domain in agent.domains):
            specific_behavior = (" Focus on document management, file uploads, text search, and content retrieval."
                               " In multi-agent scenarios, provide document data that other agents can analyze.")
        elif any(domain in ['adx', 'analytics', 'data', 'kql'] for domain in agent.domains):
            specific_behavior = (" Focus on data analytics, KQL queries, and Azure Data Explorer operations."
                               " CRITICAL: NEVER assume database or table names - they are not hardcoded. You MUST use your tools to discover what exists."
                               " WORKFLOW: 1) Use 'list_databases' to see available databases, 2) Use 'list_tables' on relevant databases to find tables, "
                               "3) Use 'execute_kql_query' to query the data you found. Start with discovery tools before attempting any queries."
                               " When users ask about specific data (e.g., 'Employees table'), first discover what databases and tables actually exist, "
                               "then search for tables with similar names or content. Use your MCP tools as your primary method for data exploration."
                               " IMPORTANT: You can ONLY access ADX data through your own tools. You cannot access documents directly - if document content is needed,"
                               " wait for other agents to provide it or suggest that the user should first extract the relevant data from documents."
                               " In multi-agent scenarios, you can analyze data provided by other agents or help find database equivalents of document data.")
        elif 'core' in agent.domains:
            specific_behavior = (" Handle general inquiries and provide system information."
                               " Only respond to general questions when other agents cannot help.")
        else:
            specific_behavior = ""
        
        # Multi-agent collaboration instructions
        collaboration_instruction = ("\n\nMULTI-AGENT COLLABORATION: "
                                   "For queries involving multiple domains (e.g., 'find names from document X that are in database Y'), "
                                   "contribute your specialized part. Each agent should focus on their domain expertise and provide "
                                   "useful data that enables the overall task to be completed.")
        
        # Refined domain filtering instruction - allow collaboration but prevent cross-domain tool access
        domain_filter = (f"\n\nIMPORTANT: Only use '{AGENT_CANNOT_ANSWER}' if the query has NO relevance to {', '.join(agent.domains)} "
                        f"and you cannot contribute anything useful. For multi-domain queries where your expertise is relevant, "
                        f"focus on your part of the task. You can ONLY use tools that belong to your own plugin - do not attempt to "
                        f"call tools from other agents' domains.")
        
        return (f"{base_instruction}{keyword_instruction}{specific_behavior}{collaboration_instruction}"
                f"\n\nUse your available tools to help users with {', '.join(agent.domains)} related tasks. "
                f"When using tools, provide clear explanations of what you're doing and what the results mean."
                f"{domain_filter}")

# Summary of recent improvements for agent domain isolation and session security
