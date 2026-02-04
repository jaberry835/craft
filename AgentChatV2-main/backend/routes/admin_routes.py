"""
Admin API Routes
Agent configuration and system administration.
Requires admin role.
"""
from fastapi import APIRouter, Request, HTTPException, Depends
from pydantic import BaseModel, Field

from models import (
    AgentConfig, AgentListResponse, SystemStats,
    MCPServerConfig, MCPServerListResponse, MCPDiscoveryRequest, MCPDiscoveryResponse,
    AgentType, A2AAgentCard
)
from services.cosmos_service import cosmos_service
from services.agent_manager import agent_manager
from services.mcp_discovery import mcp_discovery
from services.a2a_client import a2a_client
from config import get_settings
from observability import get_logger

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = get_logger(__name__)
settings = get_settings()


def require_admin(request: Request):
    """Dependency to require admin role."""
    user = request.state.user
    
    # In development mode, skip role check
    if settings.environment == "development":
        logger.debug(f"Dev mode: skipping admin role check for {user.email}")
        return user
    
    # Check for admin role (case-insensitive)
    user_roles_lower = [r.lower() for r in user.roles]
    if "admin" not in user_roles_lower:
        logger.warning(f"Admin access denied for {user.email}. Roles: {user.roles}")
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# =============================================================================
# Agent Management
# =============================================================================

@router.get("/agents", response_model=AgentListResponse)
async def list_agents(request: Request, admin=Depends(require_admin)):
    """List all configured agents."""
    agents = await cosmos_service.list_agents()
    return AgentListResponse(agents=agents, count=len(agents))


@router.get("/agents/{agent_id}", response_model=AgentConfig)
async def get_agent(request: Request, agent_id: str, admin=Depends(require_admin)):
    """Get a specific agent configuration."""
    agent = await cosmos_service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.post("/agents", response_model=AgentConfig)
async def create_agent(
    request: Request,
    agent_config: AgentConfig,
    admin=Depends(require_admin)
):
    """Create a new agent."""
    agent_dict = agent_config.model_dump(exclude_unset=True)
    
    # Convert mcp_tools to serializable format
    if "mcp_tools" in agent_dict:
        agent_dict["mcp_tools"] = [
            t.model_dump() if hasattr(t, "model_dump") else t
            for t in agent_dict["mcp_tools"]
        ]
    
    saved = await cosmos_service.save_agent(agent_dict)
    
    # Refresh agent cache
    await agent_manager.refresh_agents()
    
    logger.info(f"Created agent: {saved['id']} by {admin.user_id}")
    return saved


@router.put("/agents/{agent_id}", response_model=AgentConfig)
async def update_agent(
    request: Request,
    agent_id: str,
    agent_config: AgentConfig,
    admin=Depends(require_admin)
):
    """Update an existing agent."""
    existing = await cosmos_service.get_agent(agent_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    agent_dict = agent_config.model_dump(exclude_unset=True)
    agent_dict["id"] = agent_id
    
    if "mcp_tools" in agent_dict:
        agent_dict["mcp_tools"] = [
            t.model_dump() if hasattr(t, "model_dump") else t
            for t in agent_dict["mcp_tools"]
        ]
        logger.info(f"Saving agent with {len(agent_dict['mcp_tools'])} MCP tools")
        for tool in agent_dict["mcp_tools"]:
            logger.debug(f"  Tool: {tool.get('name')} -> {tool.get('server_url')}")
    
    saved = await cosmos_service.save_agent(agent_dict)
    await agent_manager.refresh_agents()
    
    logger.info(f"Updated agent: {agent_id} by {admin.user_id}")
    return saved


@router.delete("/agents/{agent_id}")
async def delete_agent(
    request: Request,
    agent_id: str,
    admin=Depends(require_admin)
):
    """Delete an agent."""
    success = await cosmos_service.delete_agent(agent_id)
    if not success:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    await agent_manager.refresh_agents()
    
    logger.info(f"Deleted agent: {agent_id} by {admin.user_id}")
    return {"message": "Agent deleted"}


# =============================================================================
# A2A Agent Discovery
# =============================================================================

class A2ADiscoveryRequest(BaseModel):
    """Request to discover an external A2A agent."""
    url: str = Field(..., min_length=1, description="Base URL of the A2A agent")
    card_path: str = Field(
        default="/.well-known/agent.json",
        description="Path to agent card (defaults to well-known location)"
    )


class A2ADiscoveryResponse(BaseModel):
    """Response from A2A agent discovery."""
    url: str
    name: str
    description: str | None = None
    skills_count: int
    card: dict
    error: str | None = None


class A2ATestResponse(BaseModel):
    """Response from testing A2A agent connection."""
    success: bool
    agent_name: str | None = None
    description: str | None = None
    skills_count: int = 0
    error: str | None = None


@router.post("/a2a/discover", response_model=A2ADiscoveryResponse)
async def discover_a2a_agent(
    request: Request,
    discovery_request: A2ADiscoveryRequest,
    admin=Depends(require_admin)
):
    """
    Discover an external A2A agent by fetching its agent card.
    
    This endpoint fetches the agent card from an external A2A server,
    allowing admins to review the agent's capabilities before adding it.
    """
    logger.info(f"Discovering A2A agent at {discovery_request.url} by {admin.user_id}")
    
    try:
        card = await a2a_client.discover_agent(
            base_url=discovery_request.url,
            card_path=discovery_request.card_path
        )
        
        return A2ADiscoveryResponse(
            url=discovery_request.url,
            name=card.get("name", "Unknown"),
            description=card.get("description"),
            skills_count=len(card.get("skills", [])),
            card=card,
            error=None
        )
    except Exception as e:
        logger.error(f"A2A discovery failed for {discovery_request.url}: {e}")
        return A2ADiscoveryResponse(
            url=discovery_request.url,
            name="",
            description=None,
            skills_count=0,
            card={},
            error=str(e)
        )


@router.post("/a2a/test")
async def test_a2a_connection(
    request: Request,
    discovery_request: A2ADiscoveryRequest,
    admin=Depends(require_admin)
):
    """
    Test connection to an external A2A agent.
    
    Lighter weight than full discovery - just checks if the agent is reachable.
    """
    result = await a2a_client.test_connection(discovery_request.url)
    return A2ATestResponse(**result)


@router.post("/a2a/add", response_model=AgentConfig)
async def add_a2a_agent(
    request: Request,
    discovery_request: A2ADiscoveryRequest,
    admin=Depends(require_admin)
):
    """
    Discover and add an external A2A agent in one step.
    
    Fetches the agent card from the external A2A server and creates
    a new agent configuration that references the external agent.
    """
    logger.info(f"Adding A2A agent from {discovery_request.url} by {admin.user_id}")
    
    try:
        # Discover the agent
        card = await a2a_client.discover_agent(
            base_url=discovery_request.url,
            card_path=discovery_request.card_path
        )
        
        # Create agent config from discovered card
        agent_config = AgentConfig(
            name=card.get("name", "A2A Agent"),
            description=card.get("description", f"External A2A agent from {discovery_request.url}"),
            agent_type=AgentType.A2A,
            a2a_url=discovery_request.url,
            a2a_card=A2AAgentCard(**card) if card else None,
            system_prompt=None,  # Not used for A2A agents
            is_orchestrator=False,
            a2a_enabled=False  # External agents aren't re-exposed via A2A
        )
        
        # Save to database
        agent_dict = agent_config.model_dump(exclude_unset=True)
        if agent_dict.get("a2a_card"):
            agent_dict["a2a_card"] = agent_config.a2a_card.model_dump() if agent_config.a2a_card else None
        
        saved = await cosmos_service.save_agent(agent_dict)
        await agent_manager.refresh_agents()
        
        logger.info(f"Added A2A agent: {saved['id']} ({card.get('name')}) by {admin.user_id}")
        return saved
        
    except Exception as e:
        logger.error(f"Failed to add A2A agent from {discovery_request.url}: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to add A2A agent: {str(e)}")


# =============================================================================
# MCP Server Management
# =============================================================================

@router.post("/mcp-servers/discover", response_model=MCPDiscoveryResponse)
async def discover_mcp_tools(
    request: Request,
    discovery_request: MCPDiscoveryRequest,
    admin=Depends(require_admin)
):
    """
    Discover available tools from an MCP server.
    This probes the MCP server and returns all available tools.
    
    The user's bearer token is passed through for authentication
    with secured MCP servers.
    """
    logger.info(f"Discovering tools from {discovery_request.url} by {admin.user_id}")
    
    # Get user token and context for pass-through to MCP server
    user_token = getattr(request.state, 'token', None)
    user_id = admin.user_id if admin else None
    
    # Debug: Check what headers we received from frontend
    auth_header = request.headers.get("Authorization", "")
    logger.info(f"MCP discovery - Authorization header from frontend: {auth_header[:50]}..." if auth_header else "MCP discovery - No Authorization header from frontend")
    logger.info(f"MCP discovery context: token={'yes (len=' + str(len(user_token)) + ')' if user_token else 'NO'}, user={user_id}")
    
    result = await mcp_discovery.auto_discover(
        server_url=discovery_request.url,
        auth_token=user_token,
        user_id=user_id
    )
    
    if discovery_request.name:
        result.name = discovery_request.name
    
    return result


@router.get("/mcp-servers", response_model=MCPServerListResponse)
async def list_mcp_servers(request: Request, admin=Depends(require_admin)):
    """List all registered MCP servers."""
    servers = await cosmos_service.list_mcp_servers()
    return MCPServerListResponse(servers=servers, count=len(servers))


@router.get("/mcp-servers/{server_id}", response_model=MCPServerConfig)
async def get_mcp_server(
    request: Request,
    server_id: str,
    admin=Depends(require_admin)
):
    """Get a specific MCP server configuration."""
    server = await cosmos_service.get_mcp_server(server_id)
    if not server:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return server


@router.post("/mcp-servers", response_model=MCPServerConfig)
async def register_mcp_server(
    request: Request,
    server_config: MCPServerConfig,
    admin=Depends(require_admin)
):
    """
    Register a new MCP server.
    The server should have been discovered first to populate its tools.
    """
    server_dict = server_config.model_dump(exclude_unset=True)
    
    # Convert tools to serializable format
    if "discovered_tools" in server_dict:
        server_dict["discovered_tools"] = [
            t.model_dump() if hasattr(t, "model_dump") else t
            for t in server_dict["discovered_tools"]
        ]
    
    saved = await cosmos_service.save_mcp_server(server_dict)
    logger.info(f"Registered MCP server: {saved['id']} by {admin.user_id}")
    return saved


@router.put("/mcp-servers/{server_id}", response_model=MCPServerConfig)
async def update_mcp_server(
    request: Request,
    server_id: str,
    server_config: MCPServerConfig,
    admin=Depends(require_admin)
):
    """Update an existing MCP server configuration."""
    existing = await cosmos_service.get_mcp_server(server_id)
    if not existing:
        raise HTTPException(status_code=404, detail="MCP server not found")
    
    server_dict = server_config.model_dump(exclude_unset=True)
    server_dict["id"] = server_id
    
    if "discovered_tools" in server_dict:
        server_dict["discovered_tools"] = [
            t.model_dump() if hasattr(t, "model_dump") else t
            for t in server_dict["discovered_tools"]
        ]
    
    saved = await cosmos_service.save_mcp_server(server_dict)
    logger.info(f"Updated MCP server: {server_id} by {admin.user_id}")
    return saved


@router.delete("/mcp-servers/{server_id}")
async def delete_mcp_server(
    request: Request,
    server_id: str,
    admin=Depends(require_admin)
):
    """Delete an MCP server registration."""
    success = await cosmos_service.delete_mcp_server(server_id)
    if not success:
        raise HTTPException(status_code=404, detail="MCP server not found")
    
    logger.info(f"Deleted MCP server: {server_id} by {admin.user_id}")
    return {"message": "MCP server deleted"}


@router.post("/mcp-servers/{server_id}/refresh", response_model=MCPServerConfig)
async def refresh_mcp_server(
    request: Request,
    server_id: str,
    admin=Depends(require_admin)
):
    """Re-discover tools from an existing MCP server."""
    existing = await cosmos_service.get_mcp_server(server_id)
    if not existing:
        raise HTTPException(status_code=404, detail="MCP server not found")
    
    user_token = getattr(request.state, 'token', None)
    
    result = await mcp_discovery.auto_discover(
        server_url=existing.url,
        auth_token=user_token
    )
    
    if result.error:
        raise HTTPException(status_code=502, detail=f"Discovery failed: {result.error}")
    
    # Update the server with fresh tools
    server_dict = existing.model_dump()
    server_dict["discovered_tools"] = [t.model_dump() for t in result.tools]
    
    from datetime import datetime
    server_dict["last_discovered_at"] = datetime.utcnow()
    
    saved = await cosmos_service.save_mcp_server(server_dict)
    logger.info(f"Refreshed MCP server {server_id}: found {len(result.tools)} tools")
    return saved


# =============================================================================
# System Administration
# =============================================================================

@router.post("/agents/refresh")
async def refresh_agents(request: Request, admin=Depends(require_admin)):
    """Force refresh of agent cache."""
    await agent_manager.refresh_agents()
    return {"message": "Agent cache refreshed"}


@router.get("/stats", response_model=SystemStats)
async def get_system_stats(request: Request, admin=Depends(require_admin)):
    """Get system statistics."""
    # These would need proper implementation with queries
    agents = await cosmos_service.list_agents()
    
    return SystemStats(
        total_users=0,  # Would need separate tracking
        total_sessions=0,
        total_messages=0,
        total_agents=len(agents),
        active_sessions_24h=0
    )


# =============================================================================
