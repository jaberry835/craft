"""
Core agent for basic system tools and general-purpose functionality.
Handles tools that don't belong to specific domain areas.
"""

import logging
from typing import List, Dict, Any, Optional
from datetime import datetime

from .base_agent import BaseAgent
try:
    from ..models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, McpProperty, McpToolInputSchema
except ImportError:
    # Fallback for when running directly
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))
    from models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, McpProperty, McpToolInputSchema

logger = logging.getLogger(__name__)

class CoreAgent(BaseAgent):
    """Core agent for basic system tools and general-purpose functionality"""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        
    @property
    def agent_id(self) -> str:
        return "core-agent"
    
    @property
    def name(self) -> str:
        return "Core Agent"
    
    @property
    def description(self) -> str:
        return "Core agent for basic system tools and general-purpose functionality"
    
    @property
    def domains(self) -> List[str]:
        return ["core", "system", "basic", "general"]
    
    async def _on_initialize_async(self, user_token: Optional[str]) -> None:
        """Initialize the Core Agent"""
        logger.info("Initializing Core Agent")
        # No specific initialization needed for core agent
    
    async def get_available_tools_async(self) -> List[McpTool]:
        """Get all tools that this agent can execute"""
        try:
            tools = [
                McpTool(
                    name="hello_world",
                    description="A simple Hello World tool that greets the user",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "name": McpProperty(
                                type="string",
                                description="The name to greet"
                            )
                        },
                        required=["name"]
                    )
                ),
                McpTool(
                    name="system_info",
                    description="Get information about the MCP server system and available agents",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={},
                        required=[]
                    )
                ),
                McpTool(
                    name="echo",
                    description="Echo back the provided message",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "message": McpProperty(
                                type="string",
                                description="The message to echo back"
                            )
                        },
                        required=["message"]
                    )
                ),
                McpTool(
                    name="get_time",
                    description="Get the current server time",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={},
                        required=[]
                    )
                )
            ]
            
            logger.debug(f"Core Agent providing {len(tools)} tools")
            return tools
        except Exception as e:
            logger.error(f"Failed to get Core tools: {str(e)}")
            return []
    
    async def execute_tool_async(self, request: McpToolCallRequest) -> McpToolCallResponse:
        """Execute a tool request"""
        logger.info(f"Core Agent executing tool: {request.name}")
        
        try:
            if request.name == "hello_world":
                return await self._execute_hello_world(request.arguments)
            elif request.name == "system_info":
                return await self._execute_system_info(request.arguments)
            elif request.name == "echo":
                return await self._execute_echo(request.arguments)
            elif request.name == "get_time":
                return await self._execute_get_time(request.arguments)
            else:
                return self._create_cannot_answer_response(f"Unknown core tool: {request.name}")
        except Exception as e:
            return self._create_error_response(f"Core Agent failed to execute tool {request.name}", e)
    
    async def can_handle_tool_async(self, tool_name: str) -> bool:
        """Check if this agent can handle the specified tool"""
        core_tools = ["hello_world", "system_info", "echo", "get_time"]
        return tool_name in core_tools
    
    async def _perform_health_check_async(self) -> bool:
        """Perform Core Agent health check"""
        try:
            # Simple health check - verify we can get tools
            tools = await self.get_available_tools_async()
            return len(tools) > 0
        except Exception as e:
            logger.warning(f"Core Agent health check failed: {str(e)}")
            return False
    
    async def _execute_hello_world(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the hello_world tool"""
        name = arguments.get("name", "World")
        message = f"Hello, {name}! This is the Core Agent from the Python MCP Server."
        return McpToolCallResponse.success(message)
    
    async def _execute_system_info(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the system_info tool"""
        info = {
            "server_name": "Python Azure MCP Server",
            "version": "1.0.0",
            "agent_id": self.agent_id,
            "agent_name": self.name,
            "timestamp": datetime.utcnow().isoformat(),
            "domains": self.domains
        }
        
        message = f"MCP Server System Information:\n"
        for key, value in info.items():
            if isinstance(value, list):
                message += f"- {key}: {', '.join(value)}\n"
            else:
                message += f"- {key}: {value}\n"
        
        return McpToolCallResponse.success(message)
    
    async def _execute_echo(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the echo tool"""
        message = arguments.get("message", "")
        if not message:
            return self._create_error_response("No message provided to echo")
        
        response = f"Echo: {message}"
        return McpToolCallResponse.success(response)
    
    async def _execute_get_time(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the get_time tool"""
        current_time = datetime.utcnow().isoformat()
        message = f"Current server time (UTC): {current_time}"
        return McpToolCallResponse.success(message)
