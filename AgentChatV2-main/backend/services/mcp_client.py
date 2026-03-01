"""
MCP Client Manager
Manages connections to MCP (Model Context Protocol) servers with token pass-through.

Creates one MCPStreamableHTTPTool per MCP server, grouped by server URL, with the
user's bearer token injected via a custom httpx.AsyncClient. Tools are created fresh
per-request to ensure the current token is always used (the constructor is lightweight;
the actual network connection happens at connect() time inside Agent.run()).
"""
from typing import Optional
from collections import defaultdict
import time
import httpx

from agent_framework import MCPStreamableHTTPTool
from observability import get_logger, should_log_performance, should_log_mcp, log_performance_summary

logger = get_logger(__name__)


class MCPClientManager:
    """Manages MCP tool connections with authentication pass-through."""

    async def get_tools_for_agent(
        self,
        agent_config: dict,
        user_token: Optional[str] = None
    ) -> list[MCPStreamableHTTPTool]:
        """
        Get MCP tools configured for an agent.
        
        Groups tools by MCP server URL and creates one MCPStreamableHTTPTool per server,
        using the allowed_tools parameter to restrict which tools the agent can access
        from each server.
        
        Args:
            agent_config: Agent configuration with mcp_tools list
            user_token: User's auth token for pass-through
        """
        mcp_configs = agent_config.get("mcp_tools", [])
        if not mcp_configs:
            return []
        
        # Group tools by server URL
        tools_by_server: dict[str, list[str]] = defaultdict(list)
        
        for mcp_config in mcp_configs:
            if isinstance(mcp_config, str):
                if should_log_mcp():
                    logger.warning(f"Skipping MCP tool '{mcp_config}' - no server_url provided")
                continue

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
                tool = self._create_tool(
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
    
    def _create_tool(
        self,
        server_url: str,
        allowed_tools: list[str],
        user_token: Optional[str] = None
    ) -> MCPStreamableHTTPTool:
        """
        Create an MCP tool connection with specific allowed tools.
        
        Always creates a fresh instance to ensure the current user token is used.
        The constructor is lightweight -- no network calls happen until connect().
        
        Args:
            server_url: MCP server URL
            allowed_tools: List of tool names this connection should expose
            user_token: User's auth token for pass-through
        """
        # Build http_client with authentication headers
        http_client = None
        if user_token:
            if should_log_mcp():
                logger.info(f"Creating MCP tool for {server_url} with auth token")
            http_client = httpx.AsyncClient(
                timeout=60.0,
                headers={"Authorization": f"Bearer {user_token}"}
            )
        else:
            if should_log_mcp():
                logger.warning(f"Creating MCP tool for {server_url} WITHOUT auth token")
        
        start_time = time.perf_counter()
        
        tool = MCPStreamableHTTPTool(
            name=f"mcp_{hash(server_url) % 10000}",
            url=server_url,
            http_client=http_client,
            load_tools=True,
            load_prompts=False,
            request_timeout=30,
            terminate_on_close=True,
            allowed_tools=allowed_tools,
            description=f"MCP tools: {', '.join(allowed_tools)}"
        )
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        if should_log_performance():
            log_performance_summary(logger, "mcp_tool_create", {
                "duration_ms": round(duration_ms, 2),
                "server_url": server_url,
                "allowed_tools": allowed_tools,
            })
        
        return tool


# Global instance
mcp_client = MCPClientManager()
