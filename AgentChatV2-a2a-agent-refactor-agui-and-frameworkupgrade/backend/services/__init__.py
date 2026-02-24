"""Services module - Azure service integrations."""
from .cosmos_service import cosmos_service
from .agent_manager import agent_manager
from .search_service import search_service
from .mcp_client import mcp_client, MCPClientManager
from .mcp_discovery import mcp_discovery, MCPDiscoveryService
from .embedding_service import embedding_service

__all__ = [
    "cosmos_service",
    "agent_manager", 
    "search_service",
    "mcp_client",
    "MCPClientManager",
    "mcp_discovery",
    "MCPDiscoveryService",
    "embedding_service"
]
