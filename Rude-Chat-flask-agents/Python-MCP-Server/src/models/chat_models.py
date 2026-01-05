from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from datetime import datetime
import uuid

@dataclass
class ChatMessage:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    role: str = ""  # "user" or "assistant"
    content: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.utcnow)
    session_id: str = ""
    user_id: str = ""

@dataclass
class ChatCompletionRequest:
    messages: List[ChatMessage]
    session_id: str
    user_id: str
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None

@dataclass
class ChatCompletionResponse:
    message: ChatMessage
    agent_interactions: List['AgentInteraction'] = field(default_factory=list)

@dataclass
class AgentInteraction:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_name: str = ""
    action: str = ""
    details: str = ""
    status: str = ""  # "in-progress", "success", "error"
    timestamp: datetime = field(default_factory=datetime.utcnow)
    duration: Optional[float] = None  # in seconds

@dataclass
class ChatSession:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str = ""
    title: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    last_message_at: Optional[datetime] = None
    documents: List['DocumentMetadata'] = field(default_factory=list)
    is_archived: bool = False

@dataclass
class DocumentMetadata:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    filename: str = ""
    blob_url: str = ""
    size: int = 0
    content_type: str = ""
    upload_timestamp: datetime = field(default_factory=datetime.utcnow)
    processing_status: int = 0  # 0=uploading, 1=processing, 2=indexed
    user_id: str = ""
    session_id: str = ""

@dataclass
class ChatHistoryRequest:
    user_id: str
    session_id: str
    page_size: int = 50
    continuation_token: Optional[str] = None

@dataclass
class ChatHistoryResponse:
    messages: List[ChatMessage]
    continuation_token: Optional[str] = None
    has_more: bool = False

@dataclass
class SessionListRequest:
    user_id: str
    page_size: int = 20
    continuation_token: Optional[str] = None
    include_archived: bool = False

@dataclass
class SessionListResponse:
    sessions: List[ChatSession]
    continuation_token: Optional[str] = None
    has_more: bool = False

@dataclass
class CreateSessionRequest:
    user_id: str
    title: str = ""

@dataclass
class DocumentSearchRequest:
    query: str
    user_id: str
    session_id: str
    top_k: int = 5

@dataclass
class DocumentSearchResult:
    id: str
    filename: str
    content: str
    score: float
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class McpServerInfo:
    name: str = "Python Azure MCP Server"
    version: str = "1.0.0"
    capabilities: 'McpCapabilities' = field(default_factory=lambda: McpCapabilities())

@dataclass
class McpCapabilities:
    tools: 'McpToolCapabilities' = field(default_factory=lambda: McpToolCapabilities())

@dataclass
class McpToolCapabilities:
    list_changed: bool = False

@dataclass
class McpTool:
    name: str
    description: str
    input_schema: Dict[str, Any] = field(default_factory=dict)

@dataclass
class McpToolCall:
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)

@dataclass
class McpToolResult:
    content: List[Dict[str, Any]] = field(default_factory=list)
    is_error: bool = False

@dataclass
class AgentStatus:
    agent_id: str
    name: str
    description: str
    domains: List[str]
    health: 'AgentHealth' = field(default_factory=lambda: AgentHealth())

@dataclass
class AgentHealth:
    agent_id: str = ""
    status: str = "healthy"  # "healthy", "degraded", "unhealthy"
    last_check: datetime = field(default_factory=datetime.utcnow)
    response_time_ms: float = 0.0
    success_rate: float = 100.0
    error_message: Optional[str] = None
