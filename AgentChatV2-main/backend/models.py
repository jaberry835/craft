"""
Pydantic models for request/response validation.
"""
from typing import Optional, Any
from datetime import datetime
from pydantic import BaseModel, Field
from enum import Enum


# =============================================================================
# Enums
# =============================================================================

class OrchestrationPattern(str, Enum):
    """Orchestration pattern types."""
    SINGLE = "single"
    SEQUENTIAL = "sequential"
    CONCURRENT = "concurrent"
    MAGENTIC = "magentic"
    GROUP_CHAT = "group_chat"


class MessageRole(str, Enum):
    """Message role types."""
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class AgentType(str, Enum):
    """Agent type - local or external A2A."""
    LOCAL = "local"      # Hosted by this platform (ChatAgent)
    A2A = "a2a"          # External A2A agent (A2AAgent)


# =============================================================================
# Agent Models
# =============================================================================

class MCPToolConfig(BaseModel):
    """MCP tool configuration - a specific tool from an MCP server."""
    name: str
    server_url: Optional[str] = None  # URL of the MCP server this tool belongs to
    description: Optional[str] = None
    input_schema: Optional[dict[str, Any]] = None  # JSON Schema for tool parameters


class MCPServerConfig(BaseModel):
    """MCP Server configuration with discovered tools."""
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=100)
    url: str = Field(..., min_length=1)  # MCP server endpoint URL
    description: Optional[str] = None
    discovered_tools: list[MCPToolConfig] = Field(default_factory=list)  # All tools from this server
    is_active: bool = True
    last_discovered_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class MCPServerListResponse(BaseModel):
    """Response for listing MCP servers."""
    servers: list[MCPServerConfig]
    count: int


class MCPDiscoveryRequest(BaseModel):
    """Request to discover tools from an MCP server."""
    url: str = Field(..., min_length=1)
    name: Optional[str] = None  # Optional friendly name


class MCPDiscoveryResponse(BaseModel):
    """Response from MCP tool discovery."""
    url: str
    name: Optional[str] = None
    tools: list[MCPToolConfig]
    error: Optional[str] = None


class A2AAgentSkill(BaseModel):
    """A2A agent skill from agent card."""
    id: str
    name: str
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)


class A2AAgentCard(BaseModel):
    """Cached A2A agent card metadata."""
    name: str
    description: Optional[str] = None
    url: str
    version: Optional[str] = None
    protocol_version: Optional[str] = None
    skills: list[A2AAgentSkill] = Field(default_factory=list)
    capabilities: Optional[dict[str, Any]] = None
    default_input_modes: list[str] = Field(default_factory=list)
    default_output_modes: list[str] = Field(default_factory=list)


class AgentConfig(BaseModel):
    """Agent configuration model - supports both local and external A2A agents."""
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    agent_type: AgentType = Field(default=AgentType.LOCAL)  # Local ChatAgent or external A2A
    
    # For LOCAL agents only
    system_prompt: Optional[str] = Field(default=None)  # Required for local, optional for A2A
    model: Optional[str] = Field(default=None)  # Required for local agents - Azure OpenAI deployment name
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=128000)
    mcp_tools: list[MCPToolConfig | str] = Field(default_factory=list)  # Selected tools for this agent
    mcp_servers: list[str] = Field(default_factory=list)  # MCP server IDs this agent can use
    
    # For A2A agents only
    a2a_url: Optional[str] = None  # External A2A agent endpoint URL
    a2a_card: Optional[A2AAgentCard] = None  # Cached agent card from discovery
    
    # Common fields
    is_orchestrator: bool = False
    a2a_enabled: bool = True  # Enable Agent-to-Agent protocol (expose via A2A)
    
    # Orchestrator-specific prompts (used only when is_orchestrator=True)
    analysis_prompt: Optional[str] = None  # Phase 1: Analyze request and decide delegation
    synthesis_prompt: Optional[str] = None  # Phase 3: Synthesize specialist responses
    
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    
    def model_post_init(self, __context):
        """Validate that local agents have required fields."""
        if self.agent_type == AgentType.LOCAL:
            # Only validate if this is a create/update (id might be set for existing)
            if self.id is None:
                if not self.system_prompt:
                    raise ValueError("system_prompt is required for local agents")
                if not self.model:
                    raise ValueError("model (Azure OpenAI deployment name) is required for local agents")


class AgentListResponse(BaseModel):
    """Response for listing agents."""
    agents: list[AgentConfig]
    count: int


# =============================================================================
# Session Models
# =============================================================================

class SessionCreate(BaseModel):
    """Request to create a new session."""
    title: str = Field(..., min_length=1, max_length=200)
    orchestration_type: OrchestrationPattern = OrchestrationPattern.SEQUENTIAL
    selected_agents: list[str] = Field(default_factory=list)


class SessionUpdate(BaseModel):
    """Request to update a session."""
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    orchestration_type: Optional[OrchestrationPattern] = None
    selected_agents: Optional[list[str]] = None


class SessionDocumentRef(BaseModel):
    """Reference to an uploaded document in a session."""
    id: str
    title: str
    file_type: str = Field(default="", validation_alias="fileType", serialization_alias="fileType")
    size_bytes: int = Field(default=0, validation_alias="sizeBytes", serialization_alias="sizeBytes")
    uploaded_at: Optional[str] = Field(default=None, validation_alias="uploadedAt", serialization_alias="uploadedAt")
    chunks_count: int = Field(default=0, validation_alias="chunksCount", serialization_alias="chunksCount")
    
    model_config = {"populate_by_name": True, "by_alias": True}


class Session(BaseModel):
    """Session model."""
    id: str
    user_id: Optional[str] = Field(default=None, serialization_alias="userId")
    title: str
    orchestration_type: str = Field(default="sequential", serialization_alias="orchestrationType")
    selected_agents: list[str] = Field(default_factory=list, serialization_alias="selectedAgents")
    documents: list[SessionDocumentRef] = Field(default_factory=list)
    created_at: Optional[datetime] = Field(default=None, serialization_alias="createdAt")
    last_message_at: Optional[datetime] = Field(default=None, serialization_alias="lastMessageAt")
    message_count: int = Field(default=0, serialization_alias="messageCount")
    
    model_config = {"populate_by_name": True, "by_alias": True}


class SessionListResponse(BaseModel):
    """Response for listing sessions with pagination."""
    sessions: list[Session]
    continuation_token: Optional[str] = None
    has_more: bool = False


# =============================================================================
# Message Models
# =============================================================================

class Message(BaseModel):
    """Chat message model."""
    id: str
    session_id: str = Field(alias="sessionId")
    role: MessageRole
    content: str
    timestamp: datetime
    metadata: dict = Field(default_factory=dict)
    
    model_config = {"populate_by_name": True}


class MessageListResponse(BaseModel):
    """Response for listing messages with pagination."""
    messages: list[Message]
    continuation_token: Optional[str] = None
    has_more: bool = False


# =============================================================================
# Chat Models
# =============================================================================

class ChatRequest(BaseModel):
    """Request to send a chat message."""
    message: str = Field(..., min_length=1)
    session_id: Optional[str] = None
    orchestration_type: Optional[OrchestrationPattern] = None
    agent_ids: Optional[list[str]] = None
    include_documents: bool = True


class ChatStreamChunk(BaseModel):
    """Streaming chat response chunk."""
    type: str  # "content", "agent_start", "agent_end", "error", "done"
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    content: Optional[str] = None
    metadata: dict = Field(default_factory=dict)


class TokenUsage(BaseModel):
    """Token usage information."""
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    estimated_cost: float


class ChatResponse(BaseModel):
    """Non-streaming chat response."""
    session_id: str
    message_id: str
    content: str
    agent_responses: list[dict] = Field(default_factory=list)
    token_usage: Optional[TokenUsage] = None


# =============================================================================
# Document Models
# =============================================================================

class DocumentMetadata(BaseModel):
    """Uploaded document metadata."""
    id: str
    session_id: str
    title: str
    file_type: str
    size_bytes: int
    uploaded_at: datetime
    chunks_count: int


class DocumentUploadResponse(BaseModel):
    """Response after document upload."""
    document: DocumentMetadata
    message: str


class DocumentSearchResult(BaseModel):
    """Search result for a document."""
    id: str
    title: str
    content_snippet: str
    file_type: str
    score: float


class DocumentSearchResponse(BaseModel):
    """Response for document search."""
    results: list[DocumentSearchResult]
    query: str


# =============================================================================
# Health Models
# =============================================================================

class ServiceHealth(BaseModel):
    """Individual service health status."""
    name: str
    status: str  # "healthy", "degraded", "unhealthy"
    latency_ms: Optional[float] = None
    message: Optional[str] = None


class HealthResponse(BaseModel):
    """Overall health check response."""
    status: str  # "healthy", "degraded", "unhealthy"
    version: str
    services: list[ServiceHealth]
    timestamp: datetime


# =============================================================================
# Admin Models
# =============================================================================

class SystemStats(BaseModel):
    """System statistics for admin dashboard."""
    total_users: int
    total_sessions: int
    total_messages: int
    total_agents: int
    active_sessions_24h: int


class CostWarning(BaseModel):
    """Token cost warning."""
    session_id: str
    user_id: str
    tokens_used: int
    token_limit: int
    estimated_cost: float
    warning_level: str  # "info", "warning", "critical"
