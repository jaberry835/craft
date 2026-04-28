"""
Admin API Routes
Agent configuration and system administration.
Requires admin role.
"""
from fastapi import APIRouter, Request, HTTPException, Depends, Response
from pydantic import BaseModel, Field

from models import (
    AgentConfig, AgentListResponse, SystemStats,
    MCPServerConfig, MCPServerListResponse, MCPDiscoveryRequest, MCPDiscoveryResponse,
    AgentType, A2AAgentCard, GroundingSource,
    AOAIEndpointConfig, AOAIEndpointListResponse, AOAIDeploymentListResponse, ModelDeployment,
    UISettings, ClassificationBanner
)
from services.cosmos_service import cosmos_service
from services.agent_manager import agent_manager
from services.mcp_discovery import mcp_discovery
from services.a2a_client import a2a_client
from services.grounding_service import grounding_service
from services.aoai_discovery import aoai_discovery
from config import get_settings
from observability import get_logger

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = get_logger(__name__)
settings = get_settings()


def require_admin(request: Request):
    """Dependency to require admin role."""
    user = request.state.user
    
    # In explicit development bypass mode, skip role check.
    if settings.environment == "development" and settings.allow_dev_auth_bypass:
        logger.warning(f"DEV AUTH BYPASS ENABLED: skipping admin role check for {user.email}")
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
    
    # Convert grounding_sources to serializable format
    if "grounding_sources" in agent_dict:
        agent_dict["grounding_sources"] = [
            s.model_dump() if hasattr(s, "model_dump") else s
            for s in agent_dict["grounding_sources"]
        ]
    
    # First save to get the agent ID
    saved = await cosmos_service.save_agent(agent_dict)
    
    # Create grounding index if grounding sources are configured
    grounding_sources = saved.get("grounding_sources", [])
    logger.info(f"Agent create: grounding_sources={len(grounding_sources)}, is_available={grounding_service.is_available}")
    
    # Check if any source is an external (BYOI) index
    external_sources = [s for s in grounding_sources if s.get("type") == "external"]
    managed_sources = [s for s in grounding_sources if s.get("type", "managed") == "managed"]
    
    if external_sources:
        # Use the first external source's index name as the grounding index
        ext_index = external_sources[0].get("index_name")
        if ext_index:
            saved["grounding_index_name"] = ext_index
            await cosmos_service.save_agent(saved)
            logger.info(f"Agent {saved['id']} using external index: {ext_index}")
    elif managed_sources and grounding_service.is_available:
        grounding_index = await grounding_service.create_or_update_grounding_index(
            agent_id=saved["id"],
            agent_name=saved.get("name", "Agent"),
            grounding_sources=managed_sources
        )
        if grounding_index:
            saved["grounding_index_name"] = grounding_index
            # Save again with grounding_index_name
            await cosmos_service.save_agent(saved)
            logger.info(f"Created grounding index {grounding_index} for agent {saved['id']}")
    
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
    
    # Convert grounding_sources to serializable format
    if "grounding_sources" in agent_dict:
        agent_dict["grounding_sources"] = [
            s.model_dump() if hasattr(s, "model_dump") else s
            for s in agent_dict["grounding_sources"]
        ]
    
    # Check if grounding sources changed and update grounding index
    new_grounding = agent_dict.get("grounding_sources", [])
    old_grounding = existing.get("grounding_sources", [])
    existing_grounding_index = existing.get("grounding_index_name")
    
    # Separate external vs managed sources
    new_external = [s for s in new_grounding if s.get("type") == "external"]
    new_managed = [s for s in new_grounding if s.get("type", "managed") == "managed"]
    old_external = [s for s in old_grounding if s.get("type") == "external"]
    old_managed = [s for s in old_grounding if s.get("type", "managed") == "managed"]
    
    logger.info(f"Agent update: new_grounding={len(new_grounding)} (ext={len(new_external)}, mgd={len(new_managed)}), "
                f"old_grounding={len(old_grounding)}, existing_index={existing_grounding_index}, "
                f"is_available={grounding_service.is_available}")
    
    if new_external:
        # External index takes precedence — set grounding_index_name directly
        ext_index = new_external[0].get("index_name")
        if ext_index:
            # If switching from managed to external, clean up old managed index
            if not old_external and existing_grounding_index and grounding_service.is_available:
                await grounding_service.delete_grounding_index(agent_id)
                logger.info(f"Cleaned up managed index when switching to external for agent {agent_id}")
            agent_dict["grounding_index_name"] = ext_index
            logger.info(f"Agent {agent_id} using external index: {ext_index}")
    elif new_managed:
        # Compare managed sources to see if we need to re-index
        grounding_changed = (
            len(new_managed) != len(old_managed) or
            any(
                n.get("container_url") != o.get("container_url") or
                n.get("blob_prefix") != o.get("blob_prefix")
                for n, o in zip(new_managed, old_managed)
            )
        )
        
        if grounding_changed and grounding_service.is_available:
            grounding_index = await grounding_service.create_or_update_grounding_index(
                agent_id=agent_id,
                agent_name=agent_dict.get("name", existing.get("name", "Agent")),
                grounding_sources=new_managed
            )
            agent_dict["grounding_index_name"] = grounding_index
            logger.info(f"Updated grounding index for agent {agent_id}: {grounding_index}")
        else:
            agent_dict["grounding_index_name"] = existing_grounding_index
    else:
        # No grounding sources - delete grounding index
        if existing_grounding_index and grounding_service.is_available:
            # Only delete if it was a managed index (not external)
            if not old_external:
                await grounding_service.delete_grounding_index(agent_id)
        agent_dict["grounding_index_name"] = None
        logger.info(f"Removed grounding index from agent {agent_id}")
    
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
    # Get agent to check for grounding index
    agent = await cosmos_service.get_agent(agent_id)
    
    success = await cosmos_service.delete_agent(agent_id)
    if not success:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    # Clean up grounding index if exists (only for managed sources, not external)
    if agent and agent.get("grounding_sources") and grounding_service.is_available:
        has_external = any(s.get("type") == "external" for s in agent.get("grounding_sources", []))
        if not has_external:
            await grounding_service.delete_grounding_index(agent_id)
            logger.info(f"Deleted grounding index for agent {agent_id}")
    
    await agent_manager.refresh_agents()
    
    logger.info(f"Deleted agent: {agent_id} by {admin.user_id}")
    return {"message": "Agent deleted"}


# =============================================================================
# Grounding Re-index
# =============================================================================

@router.post("/agents/{agent_id}/reindex")
async def reindex_grounding(
    request: Request,
    agent_id: str,
    admin=Depends(require_admin)
):
    """Force re-index grounding documents for an agent.
    
    Deletes the existing grounding index (if any) and rebuilds it from
    the agent's configured blob sources.  Useful after adding security
    metadata (ss_token) to blobs or when the index schema has changed.
    """
    agent = await cosmos_service.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    
    grounding_sources = agent.get("grounding_sources", [])
    if not grounding_sources:
        raise HTTPException(status_code=400, detail="Agent has no grounding sources configured")
    
    # External indexes cannot be re-indexed from here
    has_external = any(s.get("type") == "external" for s in grounding_sources)
    if has_external:
        raise HTTPException(
            status_code=400,
            detail="This agent uses an external search index. Re-indexing must be done outside this system."
        )
    
    managed_sources = [s for s in grounding_sources if s.get("type", "managed") == "managed"]
    if not managed_sources:
        raise HTTPException(status_code=400, detail="Agent has no managed grounding sources to re-index")
    
    if not grounding_service.is_available:
        raise HTTPException(status_code=503, detail="Grounding service is not available")
    
    # Delete existing index so it gets recreated with current schema
    await grounding_service.delete_grounding_index(agent_id)
    
    # Rebuild
    grounding_index = await grounding_service.create_or_update_grounding_index(
        agent_id=agent_id,
        agent_name=agent.get("name", "Agent"),
        grounding_sources=managed_sources
    )
    
    if grounding_index:
        # Persist the index name
        agent["grounding_index_name"] = grounding_index
        await cosmos_service.save_agent(agent)
        await agent_manager.refresh_agents()
        
        # Get doc count
        status = await grounding_service.get_index_status(agent_id)
        doc_count = status.get("document_count", 0) if status else 0
        
        logger.info(f"Re-indexed grounding for agent {agent_id}: {doc_count} chunks in {grounding_index}")
        return {
            "message": f"Re-indexed {doc_count} document chunks",
            "index_name": grounding_index,
            "document_count": doc_count
        }
    else:
        raise HTTPException(status_code=500, detail="Failed to create grounding index")


# =============================================================================
# Grounding Source Validation
# =============================================================================

class GroundingValidationRequest(BaseModel):
    """Request to validate a grounding source URL."""
    container_url: str = Field(..., min_length=1)


class GroundingValidationResponse(BaseModel):
    """Response from grounding source validation."""
    valid: bool
    message: str
    is_available: bool = True  # Whether grounding service is available


@router.post("/grounding/validate", response_model=GroundingValidationResponse)
async def validate_grounding_source(
    request: Request,
    validation_request: GroundingValidationRequest,
    admin=Depends(require_admin)
):
    """Validate that a grounding source container URL is accessible."""
    if not grounding_service.is_available:
        return GroundingValidationResponse(
            valid=False,
            message="Grounding service is not configured. Set AZURE_AI_FOUNDRY_ENDPOINT to enable document grounding.",
            is_available=False
        )
    
    is_valid, message = await grounding_service.validate_container_access(
        validation_request.container_url
    )
    return GroundingValidationResponse(
        valid=is_valid,
        message=message,
        is_available=True
    )


@router.get("/grounding/status")
async def get_grounding_status(
    request: Request,
    admin=Depends(require_admin)
):
    """Get grounding service status."""
    return {
        "available": grounding_service.is_available,
        "message": "Grounding service is configured and ready" if grounding_service.is_available 
                   else "Grounding service is not configured. Set AZURE_AI_FOUNDRY_ENDPOINT to enable."
    }


@router.get("/search/indexes")
async def list_search_indexes(
    request: Request,
    admin=Depends(require_admin)
):
    """List all Azure AI Search indexes on the configured search service.
    
    Used by the admin UI to populate the 'Use Existing Index' dropdown
    for the BYOI (Bring Your Own Index) feature.
    """
    if not grounding_service.is_available:
        raise HTTPException(
            status_code=503,
            detail="Azure AI Search is not configured. Set AZURE_SEARCH_ENDPOINT to enable."
        )
    
    indexes = await grounding_service.list_indexes()
    return {"indexes": indexes, "count": len(indexes)}


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
    a2a_client_id: str | None = Field(
        default=None,
        description="Entra ID client ID of the external agent's app registration. "
                    "Set this when the remote agent uses a different app registration."
    )
    a2a_scope: str | None = Field(
        default=None,
        description="Custom scope for OBO exchange. Defaults to api://{a2a_client_id}/.default"
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
            a2a_client_id=discovery_request.a2a_client_id,  # For OBO token exchange
            a2a_scope=discovery_request.a2a_scope,
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
# Azure OpenAI Endpoint Management
# =============================================================================

@router.get("/aoai-endpoints", response_model=AOAIEndpointListResponse)
async def list_aoai_endpoints(request: Request, admin=Depends(require_admin)):
    """List all registered Azure OpenAI endpoints.

    Endpoints whose stored shape can't be validated against the current
    AOAIEndpointConfig schema (e.g. records written by a feature branch with
    an unknown `endpoint_type`) are skipped with a warning rather than
    failing the whole request, so the admin page stays usable.
    """
    raw_endpoints = await cosmos_service.list_aoai_endpoints()
    endpoints: list[AOAIEndpointConfig] = []
    skipped: list[dict] = []
    for row in raw_endpoints:
        try:
            endpoints.append(AOAIEndpointConfig(**row))
        except Exception as e:
            skipped.append({
                "id": row.get("id"),
                "name": row.get("name"),
                "endpoint_type": row.get("endpoint_type"),
                "error": str(e),
            })
            logger.warning(
                "Skipping AOAI endpoint %s (%s): unsupported on this build "
                "(endpoint_type=%r): %s",
                row.get("name"), row.get("id"), row.get("endpoint_type"), e,
            )
    if skipped:
        logger.warning(
            "list_aoai_endpoints: returned %d, skipped %d unsupported entr%s",
            len(endpoints), len(skipped), "y" if len(skipped) == 1 else "ies",
        )
    return AOAIEndpointListResponse(endpoints=endpoints, count=len(endpoints))


@router.get("/aoai-endpoints/deployments", response_model=AOAIDeploymentListResponse)
async def list_all_deployments(request: Request, admin=Depends(require_admin)):
    """
    List all available model deployments across all registered AOAI endpoints.
    This is used to populate the model dropdown when creating/editing agents.
    """
    endpoints = await cosmos_service.list_aoai_endpoints()
    all_deployments = []
    
    for endpoint in endpoints:
        if not endpoint.get("is_active", True):
            continue
        
        endpoint_deployments = endpoint.get("deployments", [])
        for deployment in endpoint_deployments:
            all_deployments.append({
                "endpoint_id": endpoint.get("id"),
                "endpoint_name": endpoint.get("name", "Unknown"),
                "deployment_name": deployment.get("deployment_name"),
                "model_name": deployment.get("model_name", ""),
                "model_version": deployment.get("model_version"),
            })
    
    return AOAIDeploymentListResponse(deployments=all_deployments, count=len(all_deployments))


@router.get("/aoai-endpoints/{endpoint_id}", response_model=AOAIEndpointConfig)
async def get_aoai_endpoint(
    request: Request,
    endpoint_id: str,
    admin=Depends(require_admin)
):
    """Get a specific Azure OpenAI endpoint configuration."""
    endpoint = await cosmos_service.get_aoai_endpoint(endpoint_id)
    if not endpoint:
        raise HTTPException(status_code=404, detail="AOAI endpoint not found")
    return endpoint


@router.post("/aoai-endpoints", response_model=AOAIEndpointConfig)
async def create_aoai_endpoint(
    request: Request,
    endpoint_config: AOAIEndpointConfig,
    admin=Depends(require_admin)
):
    """
    Register a new Azure OpenAI endpoint.
    Attempts auto-discovery of deployments, falls back to manually provided deployments.
    """
    logger.info(f"Creating AOAI endpoint: {endpoint_config.name} (type={endpoint_config.endpoint_type}) by {admin.user_id}")
    
    endpoint_dict = endpoint_config.model_dump(exclude_unset=True)
    
    # Try to auto-discover deployments (only for direct Azure OpenAI endpoints)
    discovered_deployments = []
    discovery_error = None
    is_apim = endpoint_config.endpoint_type == "apim"
    if is_apim:
        logger.info("APIM endpoint - skipping ARM auto-discovery (add deployments manually)")
    elif endpoint_config.subscription_id and endpoint_config.resource_group:
        try:
            discovered = await aoai_discovery.discover_deployments(
                endpoint=endpoint_config.endpoint,
                subscription_id=endpoint_config.subscription_id,
                resource_group=endpoint_config.resource_group,
                cloud=endpoint_config.cloud
            )
            discovered_deployments = [d.model_dump() for d in discovered]
            logger.info(f"Auto-discovered {len(discovered_deployments)} deployments")
        except Exception as e:
            discovery_error = str(e)
            logger.warning(f"Auto-discovery failed: {e}")
    else:
        logger.info("Subscription ID or Resource Group not provided - skipping auto-discovery")
    
    # Use discovered deployments if we got any, otherwise use manually provided
    if discovered_deployments:
        endpoint_dict["deployments"] = discovered_deployments
    elif "deployments" in endpoint_dict and endpoint_dict["deployments"]:
        endpoint_dict["deployments"] = [
            d.model_dump() if hasattr(d, "model_dump") else d
            for d in endpoint_dict["deployments"]
        ]
        logger.info(f"Using {len(endpoint_dict['deployments'])} manually provided deployments")
    else:
        endpoint_dict["deployments"] = []
    
    saved = await cosmos_service.save_aoai_endpoint(endpoint_dict)
    logger.info(f"Created AOAI endpoint: {saved['id']} with {len(endpoint_dict.get('deployments', []))} deployments")
    # Refresh agent cache so agents pick up the new endpoint config
    await agent_manager.refresh_agents()
    return saved


@router.put("/aoai-endpoints/{endpoint_id}", response_model=AOAIEndpointConfig)
async def update_aoai_endpoint(
    request: Request,
    endpoint_id: str,
    endpoint_config: AOAIEndpointConfig,
    admin=Depends(require_admin)
):
    """Update an existing Azure OpenAI endpoint configuration."""
    existing = await cosmos_service.get_aoai_endpoint(endpoint_id)
    if not existing:
        raise HTTPException(status_code=404, detail="AOAI endpoint not found")
    
    endpoint_dict = endpoint_config.model_dump(exclude_unset=True)
    endpoint_dict["id"] = endpoint_id
    
    # Convert deployments to serializable format
    if "deployments" in endpoint_dict and endpoint_dict["deployments"]:
        endpoint_dict["deployments"] = [
            d.model_dump() if hasattr(d, "model_dump") else d
            for d in endpoint_dict["deployments"]
        ]
    
    saved = await cosmos_service.save_aoai_endpoint(endpoint_dict)
    logger.info(f"Updated AOAI endpoint: {endpoint_id} by {admin.user_id}")
    # Refresh agent cache so agents pick up the updated endpoint config (new keys, URLs, etc.)
    await agent_manager.refresh_agents()
    return saved


@router.delete("/aoai-endpoints/{endpoint_id}")
async def delete_aoai_endpoint(
    request: Request,
    endpoint_id: str,
    admin=Depends(require_admin)
):
    """Delete an Azure OpenAI endpoint registration."""
    success = await cosmos_service.delete_aoai_endpoint(endpoint_id)
    if not success:
        raise HTTPException(status_code=404, detail="AOAI endpoint not found")
    
    logger.info(f"Deleted AOAI endpoint: {endpoint_id} by {admin.user_id}")
    # Refresh agent cache so agents no longer reference the deleted endpoint
    await agent_manager.refresh_agents()
    return {"message": "AOAI endpoint deleted"}


@router.post("/aoai-endpoints/{endpoint_id}/refresh", response_model=AOAIEndpointConfig)
async def refresh_aoai_deployments(
    request: Request,
    endpoint_id: str,
    admin=Depends(require_admin)
):
    """
    Re-discover model deployments from an existing Azure OpenAI endpoint.
    Uses the Azure Resource Manager API to list deployments.
    Requires subscription_id and resource_group to be set on the endpoint.
    """
    existing = await cosmos_service.get_aoai_endpoint(endpoint_id)
    if not existing:
        raise HTTPException(status_code=404, detail="AOAI endpoint not found")
    
    # APIM endpoints don't support ARM auto-discovery
    if existing.get("endpoint_type") == "apim":
        raise HTTPException(
            status_code=400,
            detail="APIM endpoints do not support ARM auto-discovery. "
                   "Please add deployments manually."
        )
    
    subscription_id = existing.get("subscription_id")
    resource_group = existing.get("resource_group")
    
    if not subscription_id or not resource_group:
        raise HTTPException(
            status_code=400,
            detail="Subscription ID and Resource Group are required for deployment discovery. "
                   "Please edit the endpoint and provide these values."
        )
    
    try:
        discovered = await aoai_discovery.discover_deployments(
            endpoint=existing.get("endpoint"),
            subscription_id=subscription_id,
            resource_group=resource_group,
            cloud=existing.get("cloud")
        )
        
        # Update endpoint with discovered deployments
        existing["deployments"] = [d.model_dump() for d in discovered]
        saved = await cosmos_service.save_aoai_endpoint(existing)
        
        logger.info(f"Refreshed AOAI endpoint {endpoint_id}: found {len(discovered)} deployments")
        return saved
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error refreshing AOAI deployments: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to discover deployments: {str(e)}"
        )


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
# UI Settings (Public read, Admin write)
# =============================================================================

# Separate router for public settings endpoint (no admin auth required)
settings_router = APIRouter(prefix="/api/settings", tags=["settings"])


@settings_router.get("/ui", response_model=UISettings)
async def get_ui_settings_public(request: Request, response: Response):
    """
    Get UI settings (classification banner, branding image, etc.).
    This endpoint is public so all users can load the banner/branding on app start.
    """
    # Revalidate settings on navigation/reload to avoid stale UI branding/name.
    response.headers["Cache-Control"] = "no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"

    settings_data = await cosmos_service.get_ui_settings()
    if not settings_data:
        return UISettings()  # Return defaults

    return UISettings(
        id=settings_data.get("id", "ui_settings"),
        classification_banner=ClassificationBanner(**settings_data.get("classification_banner", {})),
        branding_image=settings_data.get("branding_image"),
        branding_image_filename=settings_data.get("branding_image_filename"),
        branding_image_position=settings_data.get("branding_image_position", "sidebar"),
        app_title=settings_data.get("app_title"),
        assistant_display_name=settings_data.get("assistant_display_name"),
        favicon_image=settings_data.get("favicon_image"),
        favicon_image_filename=settings_data.get("favicon_image_filename"),
        updated_at=settings_data.get("updatedAt")
    )


@router.get("/settings/ui", response_model=UISettings)
async def get_ui_settings_admin(request: Request, admin=Depends(require_admin)):
    """Get UI settings (admin endpoint with full access)."""
    settings_data = await cosmos_service.get_ui_settings()
    if not settings_data:
        return UISettings()

    return UISettings(
        id=settings_data.get("id", "ui_settings"),
        classification_banner=ClassificationBanner(**settings_data.get("classification_banner", {})),
        branding_image=settings_data.get("branding_image"),
        branding_image_filename=settings_data.get("branding_image_filename"),
        branding_image_position=settings_data.get("branding_image_position", "sidebar"),
        app_title=settings_data.get("app_title"),
        assistant_display_name=settings_data.get("assistant_display_name"),
        favicon_image=settings_data.get("favicon_image"),
        favicon_image_filename=settings_data.get("favicon_image_filename"),
        updated_at=settings_data.get("updatedAt")
    )


@router.put("/settings/ui", response_model=UISettings)
async def update_ui_settings(
    request: Request,
    ui_settings: UISettings,
    admin=Depends(require_admin)
):
    """
    Update UI settings (admin only).
    Handles classification banner, branding image, and app title.
    """
    settings_dict = ui_settings.model_dump(exclude_unset=True)

    # Validate branding image size (max ~500KB base64 string ~ 670KB encoded)
    if settings_dict.get("branding_image"):
        image_size = len(settings_dict["branding_image"])
        max_size = 700_000  # ~500KB before base64
        if image_size > max_size:
            raise HTTPException(
                status_code=400,
                detail=f"Branding image too large ({image_size:,} chars). Max is {max_size:,} chars (~500KB)."
            )

    # Validate favicon image size (max ~100KB base64 string ~ 140KB encoded)
    if settings_dict.get("favicon_image"):
        favicon_size = len(settings_dict["favicon_image"])
        favicon_max = 200_000  # ~100KB before base64
        if favicon_size > favicon_max:
            raise HTTPException(
                status_code=400,
                detail=f"Favicon image too large ({favicon_size:,} chars). Max is {favicon_max:,} chars (~100KB)."
            )

    # Convert classification_banner to dict if it's a model
    if "classification_banner" in settings_dict and hasattr(settings_dict["classification_banner"], "model_dump"):
        settings_dict["classification_banner"] = settings_dict["classification_banner"].model_dump()

    saved = await cosmos_service.save_ui_settings(settings_dict)

    logger.info(f"Updated UI settings by {admin.user_id}")
    return UISettings(
        id=saved.get("id", "ui_settings"),
        classification_banner=ClassificationBanner(**saved.get("classification_banner", {})),
        branding_image=saved.get("branding_image"),
        branding_image_filename=saved.get("branding_image_filename"),
        branding_image_position=saved.get("branding_image_position", "sidebar"),
        app_title=saved.get("app_title"),
        assistant_display_name=saved.get("assistant_display_name"),
        favicon_image=saved.get("favicon_image"),
        favicon_image_filename=saved.get("favicon_image_filename"),
        updated_at=saved.get("updatedAt")
    )
