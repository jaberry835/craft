"""
MCP Discovery Service
Discovers available tools from MCP servers using the MCP protocol.

This service handles the connection to MCP servers for tool discovery,
passing through user authentication tokens for secured MCP servers.

MCP Protocol Flow (Streamable HTTP Transport):
1. POST /mcp with initialize request → Server returns SSE stream with response
2. POST /mcp with mcp-session-id header for tools/list → Server returns SSE stream
3. Parse SSE events from response body to get JSON-RPC responses
"""
from typing import Optional, Dict, Any
from datetime import datetime
import httpx
import json

from models import MCPToolConfig, MCPServerConfig, MCPDiscoveryResponse
from observability import get_logger, should_log_mcp

logger = get_logger(__name__)


class MCPDiscoveryService:
    """Service for discovering tools from MCP servers using Streamable HTTP transport."""
    
    def __init__(self):
        self._timeout = 30.0  # seconds
    
    def _normalize_url(self, url: str) -> str:
        """
        Normalize the MCP server URL.
        - Remove trailing slash (MCP servers expect /mcp not /mcp/)
        """
        return url.rstrip('/')
    
    def _build_headers(
        self,
        auth_token: Optional[str] = None,
        user_id: Optional[str] = None,
        mcp_session_id: Optional[str] = None
    ) -> Dict[str, str]:
        """
        Build headers for MCP server requests.
        
        Args:
            auth_token: Bearer token for authentication (REQUIRED for secured servers)
            user_id: User ID for context
            mcp_session_id: MCP session ID (required after initialization)
        """
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"
        }
        
        # Add Authorization header with Bearer token - ALWAYS include if available
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
            if should_log_mcp():
                logger.info(f"MCP headers: Authorization header SET (token len={len(auth_token)})")
        else:
            if should_log_mcp():
                logger.warning("MCP headers: NO Authorization header - token is None/empty!")
        
        # Add context headers (used by some MCP servers for user impersonation)
        if user_id:
            headers["X-User-ID"] = user_id
            if should_log_mcp():
                logger.debug(f"MCP headers: X-User-ID = {user_id}")
        
        # Add MCP session ID for subsequent requests after initialization
        if mcp_session_id:
            headers["mcp-session-id"] = mcp_session_id
            if should_log_mcp():
                logger.debug(f"MCP headers: mcp-session-id = {mcp_session_id}")
        
        return headers
    
    def _parse_sse_response(self, response_text: str) -> Optional[Dict[str, Any]]:
        """
        Parse SSE (Server-Sent Events) formatted response to extract JSON-RPC data.
        
        SSE format:
        event: message
        data: {"jsonrpc":"2.0","id":1,"result":{...}}
        
        Args:
            response_text: The raw SSE response text
            
        Returns:
            Parsed JSON data or None if parsing fails
        """
        if should_log_mcp():
            logger.debug(f"Parsing SSE response: {response_text[:500]}...")
        
        # Split by lines and look for data lines
        for line in response_text.split('\n'):
            line = line.strip()
            if line.startswith('data:'):
                # Extract the JSON data after "data:"
                json_str = line[5:].strip()
                if json_str:
                    try:
                        return json.loads(json_str)
                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to parse SSE data line: {e}")
                        continue
        
        # If no SSE format found, try parsing as plain JSON
        try:
            return json.loads(response_text)
        except json.JSONDecodeError:
            pass
        
        return None
    
    async def _send_mcp_request(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: Dict[str, str],
        payload: Dict[str, Any]
    ) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
        """
        Send an MCP request and parse the streaming response.
        
        Returns:
            Tuple of (parsed_response, mcp_session_id)
        """
        if should_log_mcp():
            logger.info(f"Sending MCP request: {payload.get('method')}")
        
        # Use streaming to read the response
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            if should_log_mcp():
                logger.info(f"Response status: {response.status_code}")
                logger.info(f"Response content-type: {response.headers.get('content-type')}")
            
            response.raise_for_status()
            
            # Get session ID from headers
            mcp_session_id = response.headers.get("mcp-session-id")
            if mcp_session_id and should_log_mcp():
                logger.info(f"Got MCP session ID: {mcp_session_id}")
            
            # Read the full response body
            response_text = ""
            async for chunk in response.aiter_text():
                response_text += chunk
            
            if should_log_mcp():
                logger.debug(f"Raw response: {response_text[:1000]}")
            
            # Parse the response (handles both SSE and plain JSON)
            parsed_data = self._parse_sse_response(response_text)
            
            if parsed_data:
                if should_log_mcp():
                    logger.info(f"Parsed response: {parsed_data}")
            else:
                if should_log_mcp():
                    logger.warning(f"Could not parse response: {response_text[:500]}")
            
            return parsed_data, mcp_session_id
    
    async def discover_tools(
        self,
        server_url: str,
        auth_token: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None
    ) -> MCPDiscoveryResponse:
        """
        Discover available tools from an MCP server using Streamable HTTP transport.
        
        This follows the correct MCP protocol:
        1. POST with initialize request (no session ID yet)
        2. POST with tools/list request (with session ID from step 1)
        
        Args:
            server_url: The MCP server endpoint URL (e.g., http://localhost:8000/mcp)
            auth_token: Optional authentication token
            user_id: Optional user ID for context
            session_id: Optional session ID for context (NOT the MCP session)
            
        Returns:
            MCPDiscoveryResponse with discovered tools or error
        """
        # Normalize URL - remove trailing slash
        server_url = self._normalize_url(server_url)
        
        if should_log_mcp():
            logger.info(f"Discovering tools from MCP server: {server_url}")
            logger.info(f"Auth token provided: {'yes' if auth_token else 'no'}")
        
        mcp_session_id: Optional[str] = None
        
        try:
            async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False) as client:
                # Step 1: Initialize the MCP session
                init_headers = self._build_headers(auth_token, user_id, mcp_session_id=None)
                
                init_payload = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "AgentChatV2",
                            "version": "1.0.0"
                        }
                    }
                }
                
                if should_log_mcp():
                    logger.info(f"Step 1: Sending initialize request to {server_url}")
                
                init_data, mcp_session_id = await self._send_mcp_request(
                    client, server_url, init_headers, init_payload
                )
                
                if not init_data:
                    raise Exception("Failed to parse initialize response")
                
                if "error" in init_data:
                    error_msg = init_data["error"].get("message", "Unknown error")
                    raise Exception(f"Initialize failed: {error_msg}")
                
                if should_log_mcp():
                    logger.info(f"Initialize successful, session ID: {mcp_session_id}")
                
                # Step 2: List available tools (with session ID)
                list_headers = self._build_headers(auth_token, user_id, mcp_session_id)
                
                list_payload = {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/list",
                    "params": {}
                }
                
                if should_log_mcp():
                    logger.info(f"Step 2: Sending tools/list request to {server_url}")
                
                list_data, _ = await self._send_mcp_request(
                    client, server_url, list_headers, list_payload
                )
                
                if not list_data:
                    raise Exception("Failed to parse tools/list response")
                
                if "error" in list_data:
                    error_msg = list_data["error"].get("message", "Unknown error")
                    raise Exception(f"tools/list failed: {error_msg}")
                
                # Parse tools from response
                tools_data = list_data.get("result", {}).get("tools", [])
                
                discovered_tools = []
                for tool in tools_data:
                    tool_config = MCPToolConfig(
                        name=tool.get("name", "unknown"),
                        server_url=server_url,
                        description=tool.get("description"),
                        input_schema=tool.get("inputSchema")
                    )
                    discovered_tools.append(tool_config)
                
                if should_log_mcp():
                    logger.info(f"Successfully discovered {len(discovered_tools)} tools from {server_url}")
                
                return MCPDiscoveryResponse(
                    url=server_url,
                    tools=discovered_tools
                )
                
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error from {server_url}: {e.response.status_code} - {e.response.text}")
            return MCPDiscoveryResponse(
                url=server_url,
                tools=[],
                error=f"HTTP {e.response.status_code}: {e.response.text}"
            )
        except Exception as e:
            logger.error(f"Failed to discover tools from {server_url}: {e}")
            return MCPDiscoveryResponse(
                url=server_url,
                tools=[],
                error=str(e)
            )
    
    async def auto_discover(
        self,
        server_url: str,
        auth_token: Optional[str] = None,
        user_id: Optional[str] = None,
        session_id: Optional[str] = None
    ) -> MCPDiscoveryResponse:
        """
        Discover tools from an MCP server.
        Uses Streamable HTTP transport which is the standard MCP transport.
        
        Args:
            server_url: The MCP server URL (e.g., http://localhost:8000/mcp)
            auth_token: Optional authentication token
            user_id: Optional user ID for context
            session_id: Optional session ID for context
        """
        # Normalize URL
        server_url = self._normalize_url(server_url)
        
        if should_log_mcp():
            logger.info(f"Auto-discovering tools from: {server_url}")
            logger.info(f"Auth context: token={'yes' if auth_token else 'no'}, user={user_id}")
        
        # Use Streamable HTTP transport (the standard MCP transport)
        return await self.discover_tools(server_url, auth_token, user_id, session_id)


# Global instance
mcp_discovery = MCPDiscoveryService()
