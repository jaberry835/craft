"""
MCP (Model Context Protocol) models for tool definitions and execution.
Based on the C# implementation in MCPServer.Models.McpModels.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Union
import json

@dataclass
class McpProperty:
    """Property definition for MCP tool input schema"""
    type: str
    description: str
    enum: Optional[List[str]] = None

@dataclass
class McpToolInputSchema:
    """Input schema definition for MCP tools"""
    type: str = "object"
    properties: Dict[str, McpProperty] = field(default_factory=dict)
    required: List[str] = field(default_factory=list)

@dataclass
@dataclass
class McpTool:
    """MCP tool definition"""
    name: str
    description: str
    input_schema: McpToolInputSchema

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        def convert_property(prop: McpProperty) -> Dict[str, Any]:
            """Convert McpProperty to dictionary"""
            result = {
                "type": prop.type,
                "description": prop.description
            }
            if prop.enum:
                result["enum"] = prop.enum
            return result
        
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": {
                "type": self.input_schema.type,
                "properties": {
                    prop_name: convert_property(prop)
                    for prop_name, prop in self.input_schema.properties.items()
                },
                "required": self.input_schema.required
            }
        }

@dataclass
class McpToolCallRequest:
    """Request to execute an MCP tool"""
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'McpToolCallRequest':
        """Create from dictionary"""
        return cls(
            name=data.get("name", ""),
            arguments=data.get("arguments", {})
        )

@dataclass
class McpContent:
    """Content item in MCP tool response"""
    type: str = "text"
    text: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "type": self.type,
            "text": self.text
        }

@dataclass
class McpToolCallResponse:
    """Response from MCP tool execution"""
    content: List[McpContent] = field(default_factory=list)
    is_error: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "content": [c.to_dict() for c in self.content],
            "isError": self.is_error
        }

    @classmethod
    def success(cls, text: str) -> 'McpToolCallResponse':
        """Create a successful response with text content"""
        return cls(content=[McpContent(text=text)])

    @classmethod
    def error(cls, error_message: str) -> 'McpToolCallResponse':
        """Create an error response"""
        return cls(content=[McpContent(text=error_message)], is_error=True)

@dataclass
class McpToolCapabilities:
    """MCP tool capabilities"""
    list_changed: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {"listChanged": self.list_changed}

@dataclass
class McpCapabilities:
    """MCP server capabilities"""
    tools: McpToolCapabilities = field(default_factory=McpToolCapabilities)

    def to_dict(self) -> Dict[str, Any]:
        return {"tools": self.tools.to_dict()}

@dataclass
class McpServerInfo:
    """MCP server information"""
    name: str = "Python Azure MCP Server"
    version: str = "1.0.0"
    capabilities: McpCapabilities = field(default_factory=McpCapabilities)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "capabilities": self.capabilities.to_dict()
        }

@dataclass
class AgentHealthStatus:
    """Health status of an agent"""
    agent_id: str
    name: str
    is_healthy: bool
    last_check: str
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "agentId": self.agent_id,
            "name": self.name,
            "isHealthy": self.is_healthy,
            "lastCheck": self.last_check,
            "errorMessage": self.error_message
        }
