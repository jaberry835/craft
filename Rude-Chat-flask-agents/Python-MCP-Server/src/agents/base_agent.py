from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
import logging
from datetime import datetime, timezone
import asyncio

# Import MCP models - using relative import since we're in the src structure
try:
    from ..models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, AgentHealthStatus
    from ..constants import AGENT_CANNOT_ANSWER
except ImportError:
    # Fallback for when running directly
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))
    from models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, AgentHealthStatus
    AGENT_CANNOT_ANSWER = "AGENT_CANNOT_ANSWER: This agent cannot handle this type of query."

logger = logging.getLogger(__name__)

class IAgent(ABC):
    """Base interface for all MCP agents"""
    
    @property
    @abstractmethod
    def agent_id(self) -> str:
        """Unique identifier for this agent"""
        pass
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name for this agent"""
        pass
    
    @property
    @abstractmethod
    def description(self) -> str:
        """Description of what this agent handles"""
        pass
    
    @property
    @abstractmethod
    def domains(self) -> List[str]:
        """Domain areas this agent is responsible for"""
        pass
    
    @abstractmethod
    async def initialize_async(self, user_token: Optional[str] = None) -> None:
        """Initialize the agent with user credentials/tokens"""
        pass
    
    @abstractmethod
    async def get_available_tools_async(self) -> List[McpTool]:
        """Get all tools that this agent can execute"""
        pass
    
    @abstractmethod
    async def execute_tool_async(self, request: McpToolCallRequest) -> McpToolCallResponse:
        """Execute a tool request"""
        pass
    
    @abstractmethod
    async def can_handle_tool_async(self, tool_name: str) -> bool:
        """Check if this agent can handle the specified tool"""
        pass
    
    @abstractmethod
    async def get_health_status_async(self) -> AgentHealthStatus:
        """Get agent health status"""
        pass

class BaseAgent(IAgent):
    """Base implementation for MCP agents"""
    
    def __init__(self, config: Dict[str, Any]):
        self._config = config
        self._initialized = False
        self._user_token: Optional[str] = None
        
    async def initialize_async(self, user_token: Optional[str] = None) -> None:
        """Initialize the agent with user credentials/tokens"""
        if self._initialized:
            return
            
        self._user_token = user_token
        logger.info(f"Initializing agent {self.agent_id}")
        
        try:
            await self._on_initialize_async(user_token)
            self._initialized = True
            logger.info(f"Agent {self.agent_id} initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize agent {self.agent_id}: {str(e)}")
            raise
    
    async def get_health_status_async(self) -> AgentHealthStatus:
        """Get agent health status"""
        try:
            is_healthy = await self._perform_health_check_async()
            return AgentHealthStatus(
                agent_id=self.agent_id,
                name=self.name,
                is_healthy=is_healthy,
                last_check=datetime.now(timezone.utc).isoformat()
            )
        except Exception as e:
            logger.error(f"Health check failed for agent {self.agent_id}: {str(e)}")
            return AgentHealthStatus(
                agent_id=self.agent_id,
                name=self.name,
                is_healthy=False,
                last_check=datetime.now(timezone.utc).isoformat(),
                error_message=str(e)
            )
    
    def _create_error_response(self, message: str, exception: Optional[Exception] = None) -> McpToolCallResponse:
        """Create an error response"""
        error_text = message
        if exception:
            error_text += f": {str(exception)}"
        
        logger.error(f"Agent {self.agent_id} error: {error_text}")
        return McpToolCallResponse.error(error_text)
    
    def _create_cannot_answer_response(self, reason: str = "") -> McpToolCallResponse:
        """Create a standardized 'cannot answer' response that will be filtered from UI"""
        response_text = AGENT_CANNOT_ANSWER
        if reason:
            response_text += f" Reason: {reason}"
        
        return McpToolCallResponse.success(response_text)
    
    @abstractmethod
    async def _on_initialize_async(self, user_token: Optional[str]) -> None:
        """Override in derived classes for specific initialization logic"""
        pass
    
    async def _perform_health_check_async(self) -> bool:
        """Override in derived classes for specific health checks"""
        return True

class AgentManager:
    """Registry and manager for all MCP agents"""
    
    def __init__(self):
        self._agents: Dict[str, IAgent] = {}
        self._lock = asyncio.Lock()
        logger.info("AgentManager initialized")
    
    async def register_agent_async(self, agent: IAgent) -> None:
        """Register an agent with the manager"""
        async with self._lock:
            if agent.agent_id in self._agents:
                logger.warning(f"Agent {agent.agent_id} is already registered")
                return
                
            self._agents[agent.agent_id] = agent
            logger.info(f"Registered agent {agent.agent_id} ({agent.name}) for domains: {', '.join(agent.domains)}")
    
    async def get_all_agents_async(self) -> List[IAgent]:
        """Get all registered agents"""
        async with self._lock:
            return list(self._agents.values())
    
    async def get_all_available_tools_async(self) -> List[McpTool]:
        """Get all available tools from all agents"""
        all_tools = []
        agents = await self.get_all_agents_async()
        
        for agent in agents:
            try:
                tools = await agent.get_available_tools_async()
                all_tools.extend(tools)
            except Exception as e:
                logger.error(f"Failed to get tools from agent {agent.agent_id}: {str(e)}")
        
        return all_tools
    
    async def execute_tool_async(self, request: McpToolCallRequest, user_token: Optional[str] = None) -> McpToolCallResponse:
        """Find the appropriate agent for a tool and execute it"""
        agents = await self.get_all_agents_async()
        
        for agent in agents:
            try:
                if await agent.can_handle_tool_async(request.name):
                    # Initialize agent with user token if needed
                    await agent.initialize_async(user_token)
                    return await agent.execute_tool_async(request)
            except Exception as e:
                logger.error(f"Agent {agent.agent_id} failed to handle tool {request.name}: {str(e)}")
                continue
        
        return McpToolCallResponse.error(f"No agent found to handle tool: {request.name}")
    
    async def get_agent_by_id_async(self, agent_id: str) -> Optional[IAgent]:
        """Get agent by ID"""
        async with self._lock:
            return self._agents.get(agent_id)
    
    async def get_agents_by_domain_async(self, domain: str) -> List[IAgent]:
        """Get agents by domain"""
        agents = await self.get_all_agents_async()
        return [agent for agent in agents if domain.lower() in [d.lower() for d in agent.domains]]
    
    async def get_all_agent_health_async(self) -> List[AgentHealthStatus]:
        """Get health status of all agents"""
        health_statuses = []
        agents = await self.get_all_agents_async()
        
        for agent in agents:
            try:
                status = await agent.get_health_status_async()
                health_statuses.append(status)
            except Exception as e:
                logger.error(f"Failed to get health status for agent {agent.agent_id}: {str(e)}")
                health_statuses.append(AgentHealthStatus(
                    agent_id=agent.agent_id,
                    name=agent.name,
                    is_healthy=False,
                    last_check=datetime.now(timezone.utc).isoformat(),
                    error_message=str(e)
                ))
        
        return health_statuses
    
    async def initialize_all_agents_async(self, user_token: Optional[str] = None) -> None:
        """Initialize all agents with user token"""
        agents = await self.get_all_agents_async()
        
        for agent in agents:
            try:
                await agent.initialize_async(user_token)
            except Exception as e:
                logger.error(f"Failed to initialize agent {agent.agent_id}: {str(e)}")
                # Continue with other agents even if one fails
