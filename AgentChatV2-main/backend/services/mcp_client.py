"""
MCP Client Manager
Manages connections to MCP (Model Context Protocol) servers with token pass-through.
"""
from typing import Optional
from collections import defaultdict
import asyncio
import time
import httpx

from agent_framework import MCPStreamableHTTPTool
from observability import get_logger, should_log_performance, should_log_mcp, log_performance_summary

logger = get_logger(__name__)


class MCPClientManager:
    """Manages MCP tool connections with authentication pass-through."""
    
    def __init__(self):
        self._tools_cache: dict[str, MCPStreamableHTTPTool] = {}
        self._lock = asyncio.Lock()
    
    async def get_tool(
        self,
        tool_name: str,
        mcp_endpoint: str,
        user_token: Optional[str] = None
    ) -> MCPStreamableHTTPTool:
        """
        Get or create an MCP tool connection.
        
        Args:
            tool_name: Unique identifier for the tool
            mcp_endpoint: MCP server URL (required)
            user_token: User's auth token for pass-through
        """
        if not mcp_endpoint:
            raise ValueError(f"MCP endpoint URL is required for tool '{tool_name}'")
        
        endpoint = mcp_endpoint
        
        # Create unique cache key including token hash for user-specific connections
        token_hash = hash(user_token) if user_token else "anon"
        cache_key = f"{tool_name}:{endpoint}:{token_hash}"
        
        async with self._lock:
            if cache_key in self._tools_cache:
                if should_log_performance():
                    log_performance_summary(logger, f"mcp_tool_cache_hit_{tool_name}", {
                        "cache_hit": True,
                        "endpoint": endpoint
                    })
                return self._tools_cache[cache_key]
            
            # Build http_client with authentication headers
            http_client = None
            if user_token:
                if should_log_mcp():
                    logger.info(f"Creating MCP tool {tool_name} with auth token (length={len(user_token)})")
                http_client = httpx.AsyncClient(
                    timeout=60.0,
                    headers={"Authorization": f"Bearer {user_token}"}
                )
            else:
                if should_log_mcp():
                    logger.warning(f"Creating MCP tool {tool_name} WITHOUT auth token")
            
            try:
                start_time = time.perf_counter()
                
                tool = MCPStreamableHTTPTool(
                    name=tool_name,
                    url=endpoint,
                    http_client=http_client,
                    load_tools=True,
                    load_prompts=False,
                    request_timeout=30,
                    terminate_on_close=True,
                    description=f"MCP tool: {tool_name}"
                )
                
                duration_ms = (time.perf_counter() - start_time) * 1000
                
                if should_log_performance():
                    log_performance_summary(logger, f"mcp_tool_create_{tool_name}", {
                        "duration_ms": round(duration_ms, 2),
                        "endpoint": endpoint,
                        "cache_hit": False
                    })
                
                self._tools_cache[cache_key] = tool
                if should_log_mcp():
                    logger.info(f"Created MCP tool connection: {tool_name} -> {endpoint}")
                
                return tool
                
            except Exception as e:
                logger.error(f"Failed to create MCP tool {tool_name}: {e}")
                raise
    
    async def get_tools_for_agent(
        self,
        agent_config: dict,
        user_token: Optional[str] = None
    ) -> list[MCPStreamableHTTPTool]:
        """
        Get MCP tools configured for an agent.
        
        This method groups tools by MCP server URL and creates one MCPStreamableHTTPTool
        per server, using the allowed_tools parameter to restrict which tools the agent
        can access from each server.
        
        Args:
            agent_config: Agent configuration with mcp_tools list
            user_token: User's auth token for pass-through
        """
        mcp_configs = agent_config.get("mcp_tools", [])
        if not mcp_configs:
            return []
        
        # Group tools by server URL
        # Key: server_url, Value: list of tool names allowed for this agent
        tools_by_server: dict[str, list[str]] = defaultdict(list)
        
        for mcp_config in mcp_configs:
            if isinstance(mcp_config, str):
                # Simple string format - skip, no server URL
                if should_log_mcp():
                    logger.warning(f"Skipping MCP tool '{mcp_config}' - no server_url provided")
                continue
            else:
                # Dict format with server_url from the tool config
                tool_name = mcp_config.get("name")
                server_url = mcp_config.get("server_url")
                
                if not tool_name:
                    if should_log_mcp():
                        logger.warning("Skipping MCP tool config - missing name")
                    continue
                    
                if not server_url:
                    if should_log_mcp():
                        logger.warning(f"Skipping MCP tool '{tool_name}' - no server_url")
                    continue
                
                tools_by_server[server_url].append(tool_name)
        
        # Create one MCPStreamableHTTPTool per server with filtered allowed_tools
        result_tools = []
        for server_url, allowed_tool_names in tools_by_server.items():
            try:
                tool = await self._get_filtered_tool(
                    server_url=server_url,
                    allowed_tools=allowed_tool_names,
                    user_token=user_token
                )
                result_tools.append(tool)
                if should_log_mcp():
                    logger.info(f"Created MCP tool connection: {allowed_tool_names} -> {server_url}")
            except Exception as e:
                logger.error(f"Failed to create MCP tool for {server_url}: {e}")
        
        return result_tools
    
    async def _get_filtered_tool(
        self,
        server_url: str,
        allowed_tools: list[str],
        user_token: Optional[str] = None
    ) -> MCPStreamableHTTPTool:
        """
        Create an MCP tool connection with specific allowed tools.
        
        Args:
            server_url: MCP server URL
            allowed_tools: List of tool names this connection should expose
            user_token: User's auth token for pass-through
        """
        # Create unique cache key including allowed tools for agent-specific connections
        token_hash = hash(user_token) if user_token else "anon"
        tools_hash = hash(tuple(sorted(allowed_tools)))
        cache_key = f"{server_url}:{tools_hash}:{token_hash}"
        
        async with self._lock:
            if cache_key in self._tools_cache:
                if should_log_performance():
                    log_performance_summary(logger, "mcp_tool_cache_hit", {
                        "cache_hit": True,
                        "server_url": server_url,
                        "allowed_tools": allowed_tools
                    })
                return self._tools_cache[cache_key]
            
            # Build http_client with authentication headers
            http_client = None
            if user_token:
                if should_log_mcp():
                    logger.info(f"Creating filtered MCP tool for {server_url} with auth token (length={len(user_token)})")
                http_client = httpx.AsyncClient(
                    timeout=60.0,
                    headers={"Authorization": f"Bearer {user_token}"}
                )
            else:
                if should_log_mcp():
                    logger.warning(f"Creating filtered MCP tool for {server_url} WITHOUT auth token")
            
            try:
                start_time = time.perf_counter()
                
                # Create tool with allowed_tools filter - this restricts which tools
                # from the server are exposed to the agent
                tool = MCPStreamableHTTPTool(
                    name=f"mcp_{hash(server_url) % 10000}",  # Unique name per server
                    url=server_url,
                    http_client=http_client,
                    load_tools=True,
                    load_prompts=False,
                    request_timeout=30,
                    terminate_on_close=True,
                    allowed_tools=allowed_tools,  # KEY: Filter to only allowed tools
                    description=f"MCP tools: {', '.join(allowed_tools)}"
                )
                
                duration_ms = (time.perf_counter() - start_time) * 1000
                
                if should_log_performance():
                    log_performance_summary(logger, "mcp_tool_create", {
                        "duration_ms": round(duration_ms, 2),
                        "server_url": server_url,
                        "allowed_tools": allowed_tools,
                        "cache_hit": False
                    })
                
                self._tools_cache[cache_key] = tool
                if should_log_mcp():
                    logger.debug(f"Created filtered MCP tool: {allowed_tools} from {server_url}")
                
                return tool
                
            except Exception as e:
                logger.error(f"Failed to create MCP tool for {server_url}: {e}")
                raise
    
    async def clear_cache(self) -> None:
        """Clear all cached tool connections."""
        async with self._lock:
            self._tools_cache.clear()
            if should_log_mcp():
                logger.info("Cleared MCP tools cache")
    
    async def close(self) -> None:
        """Close all connections and cleanup."""
        await self.clear_cache()


# Global instance
mcp_client = MCPClientManager()
