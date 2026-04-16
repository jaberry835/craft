"""
Rude MCP Server - A FastMCP-based server for Math and Azure Data Explorer tools
Designed to be hosted on Azure App Service over HTTP using Streamable transport
"""

import os
import logging
import sys
import json
import asyncio
import base64
import traceback
from typing import Dict, Any, List
from datetime import datetime
from urllib.parse import urlencode
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse
from starlette.routing import Route

# Configure logging FIRST, before any other imports or operations
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Log early to confirm logging is working
logger.info("🚀 Starting Rude MCP Server initialization...")

# Initialize Application Insights early in startup
try:
    from app_insights import initialize_application_insights, get_application_insights
    app_insights_ready = initialize_application_insights()
    if app_insights_ready:
        logger.info("📊 Application Insights initialized successfully")
    else:
        logger.info("📊 Application Insights not configured - continuing without telemetry")
except Exception as e:
    logger.warning(f"📊 Application Insights initialization failed: {e}")
    app_insights_ready = False

# Import shared context variables
from context import current_user_id, current_session_id, current_user_token

# Ensure current directory is in Python path for module imports
if os.path.dirname(__file__) not in sys.path:
    sys.path.insert(0, os.path.dirname(__file__))
if os.getcwd() not in sys.path:
    sys.path.insert(0, os.getcwd())

# Load environment variables from .env file if present
try:
    from dotenv import load_dotenv
    load_dotenv()
    logging.info("Environment variables loaded from .env file")
except ImportError:
    logging.info("python-dotenv not available, using system environment variables only")

from fastmcp import FastMCP
from starlette.middleware.cors import CORSMiddleware

# Import tool registration functions
try:
    logger.info("📦 Importing tool registration functions...")
    from tools import register_adx_tools, register_fictional_api_tools, register_document_tools, register_rag_tools, register_company_and_device_tools, register_postgres_tools, register_translation_tools, register_computer_vision_tools, register_knowledge_base_tools, register_policy_document_tools, register_security_package_tools
    logger.info("✅ Tool imports successful")
except ImportError as e:
    logger.error(f"❌ Failed to import tools: {e}")
    logger.error(f"Current working directory: {os.getcwd()}")
    logger.error(f"Python path: {sys.path}")
    logger.error(f"Files in current directory: {os.listdir('.')}")
    if os.path.exists('tools'):
        logger.error(f"Files in tools directory: {os.listdir('tools')}")
    else:
        logger.error("Tools directory does not exist")
    raise


class MCPMiddleware(BaseHTTPMiddleware):
    """Unified middleware handling authentication, context propagation, and MCP initialization.

    Replaces the former MCPInitializationMiddleware, ContextMiddleware,
    and AuthenticationMiddleware with a single pass that:
      1. Extracts the Authorization header once.
      2. Sets context variables (user_id, session_id, token).
      3. Logs the request context and token claims.
      4. Enforces OAuth when enabled.
      5. Handles first-request initialisation delay and body parsing for MCP POST requests.
    """

    _SKIP_AUTH_PATHS = ("/health", "/.well-known/", "/debug/", "/api/tools", "/api/download/")

    def __init__(self, app):
        super().__init__(app)
        self.first_tools_request = True
        self.initialization_delay = 0.3
        logger.info(f"MCPMiddleware enabled (init delay: {self.initialization_delay}s)")

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def dispatch(self, request: Request, call_next):
        # 1. Extract auth header & bearer token ONCE
        auth_header = request.headers.get("Authorization")
        user_token = None
        if auth_header and auth_header.startswith("Bearer "):
            user_token = auth_header[7:]

        # 2. Set context variables for downstream tools
        user_id = (
            request.headers.get("X-User-ID")
            or request.headers.get("x-user-id")
            or "defaMCPUser"
        )
        session_id = request.headers.get("X-Session-ID") or request.headers.get("x-session-id")
        current_user_id.set(user_id)
        if session_id:
            current_session_id.set(session_id)
        if user_token:
            from context import set_user_token
            set_user_token(user_token)

        # 3. Log authentication event to Application Insights
        try:
            if app_insights_ready:
                ai = get_application_insights()
                ai.log_authentication_event(
                    auth_mode="user_token" if user_token else "service_identity",
                    user_id=user_id,
                    success=True,
                )
        except Exception as e:
            logger.debug(f"Failed to log authentication event: {e}")

        # 4. Log request context (skip noisy /health calls)
        if not request.url.path.startswith("/health"):
            self._log_request_context(request, user_id, session_id, user_token)

        # 5. OAuth enforcement (when enabled)
        oauth_enabled = os.getenv("MCP_OAUTH_ENABLED", "false").lower() == "true"
        if oauth_enabled and not any(request.url.path.startswith(p) for p in self._SKIP_AUTH_PATHS):
            # Non-MCP, non-skip endpoints require a bearer token
            if not request.url.path.startswith("/mcp") and not user_token:
                return JSONResponse(
                    status_code=401,
                    content={
                        "error": "Authentication required",
                        "message": "Bearer token required for API access",
                    },
                    headers={"WWW-Authenticate": 'Bearer realm="API"'},
                )

        # 6. MCP POST body parsing, init delay, and auth challenges
        if request.url.path in ("/mcp", "/mcp/") and request.method == "POST":
            return await self._handle_mcp_post(request, call_next, user_token, oauth_enabled)

        return await call_next(request)

    # ------------------------------------------------------------------
    # MCP POST handling
    # ------------------------------------------------------------------

    async def _handle_mcp_post(self, request, call_next, user_token, oauth_enabled):
        """Read the MCP POST body once for logging, init delay, and auth challenges."""
        body = b""
        try:
            body = await request.body()
            data = None
            if body:
                try:
                    data = json.loads(body)
                except json.JSONDecodeError:
                    pass

            if data:
                method = data.get("method", "")
                request_id = data.get("id", "no-id")
                has_token = bool(user_token)
                logger.info(f"MCP request - method: '{method}', id: {request_id}")

                if method == "tools/list":
                    if self.first_tools_request:
                        logger.info("First tools/list - applying initialization delay")
                        await asyncio.sleep(self.initialization_delay)
                        self.first_tools_request = False
                    if not has_token and oauth_enabled:
                        return self._oauth_challenge_response()

                elif method == "tools/call":
                    if not has_token and oauth_enabled:
                        return JSONResponse(
                            status_code=401,
                            content={
                                "error": "authentication_required",
                                "message": "OAuth 2.1 authentication required",
                            },
                        )
                    tool_name = data.get("params", {}).get("name", "unknown")
                    tool_args = data.get("params", {}).get("arguments", {})
                    logger.info(f"tools/call - Tool: '{tool_name}', Args: {tool_args}")

            # Recreate the request with the consumed body
            async def receive():
                return {"type": "http.request", "body": body}
            new_request = Request(scope=request.scope, receive=receive)
            return await call_next(new_request)

        except Exception as e:
            logger.error(f"MCPMiddleware error: {e}", exc_info=True)
            try:
                async def receive_recovery():
                    return {"type": "http.request", "body": body}
                new_request = Request(scope=request.scope, receive=receive_recovery)
                return await call_next(new_request)
            except Exception:
                pass

        return await call_next(request)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _oauth_challenge_response(self):
        """Return a 401 JSON response with OAuth discovery hints."""
        return JSONResponse(
            status_code=401,
            content={
                "error": "authentication_required",
                "message": "OAuth 2.1 authentication required",
                "oauth": {
                    "authorization_url": f"https://login.microsoftonline.us/{os.getenv('AZURE_TENANT_ID')}/oauth2/v2.0/authorize",
                    "client_id": os.getenv("AZURE_CLIENT_ID"),
                    "scope": f"{os.getenv('MCP_API_SCOPE')} openid profile",
                    "redirect_uri": "http://localhost:8000/oauth/redirect",
                },
            },
        )

    @staticmethod
    def _log_request_context(request, user_id, session_id, user_token):
        """Compact request + token summary (one or two log lines)."""
        logger.info(
            f"Request: {request.method} {request.url.path} | "
            f"user={user_id} session={session_id} "
            f"token={'PRESENT' if user_token else 'MISSING'}"
        )
        if user_token:
            from auth import decode_jwt_payload
            claims = decode_jwt_payload(user_token)
            if claims:
                exp = claims.get("exp")
                exp_str = datetime.fromtimestamp(exp).isoformat() if exp else "N/A"
                logger.info(
                    f"   Token: aud={claims.get('aud', 'N/A')} "
                    f"iss={claims.get('iss', 'N/A')} exp={exp_str}"
                )


# Initialize FastMCP server
logger.info("🔧 Initializing FastMCP server...")

# For now, let's disable OAuth at the FastMCP level and handle authentication via middleware
# The MCPMiddleware handles Bearer token extraction and OBO flow
mcp = FastMCP("Rude MCP Server")
logger.info("✅ FastMCP server initialized (OAuth handled via middleware)")

# Register all tools
logger.info("📋 Registering tools...")
register_adx_tools(mcp)
logger.info("✅ ADX tools registered")
register_fictional_api_tools(mcp)
logger.info("✅ Fictional API tools registered")
register_company_and_device_tools(mcp)
logger.info("✅ Company and Device demo tools registered")
register_document_tools(mcp)
logger.info("✅ Document tools registered")
register_rag_tools(mcp)
logger.info("✅ RAG tools registered")
register_postgres_tools(mcp)
logger.info("✅ PostgreSQL tools registered")
register_translation_tools(mcp)
logger.info("✅ Translation tools registered")
register_computer_vision_tools(mcp)
logger.info("✅ Computer Vision tools registered")
register_knowledge_base_tools(mcp)
logger.info("✅ Knowledge Base tools registered")
register_policy_document_tools(mcp)
logger.info("✅ Policy Document tools registered")
register_security_package_tools(mcp)
logger.info("✅ Security Package tools registered")
logger.info("🎉 All tools registered successfully")


# ============================================================================
# HEALTH CHECK AND STATUS TOOLS
# ============================================================================

def get_health_status() -> Dict[str, Any]:
    """Internal health check function (not an MCP tool)"""
    try:
        # Check if Kusto is configured
        kusto_status = "not_configured"
        kusto_cluster = os.getenv("KUSTO_CLUSTER_URL")
        if kusto_cluster:
            try:
                # Import here to avoid circular dependency
                from tools.adx_tools import get_kusto_manager
                manager = get_kusto_manager()
                kusto_status = "configured"
            except Exception:
                kusto_status = "error"
        
        # Check if Fictional API is configured
        fictional_api_status = "configured" if os.getenv("FICTIONAL_COMPANIES_API_URL") else "default_localhost"
        
        # Check if Azure Search is configured for document tools
        document_service_status = "configured" if os.getenv("AZURE_SEARCH_ENDPOINT") else "not_configured"
        
        return {
            "status": "healthy",
            "timestamp": datetime.now().isoformat(),
            "server_name": "Rude MCP Server",
            "version": "1.0.0",
            "features": {
                "azure_data_explorer": kusto_status,
                "fictional_api": fictional_api_status,
                "document_service": document_service_status,
                "rag_tools": True
            },
            "environment": {
                "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "azure_environment": bool(os.getenv("AZURE_CLIENT_ID")),
                "fictional_api_url": os.getenv("FICTIONAL_COMPANIES_API_URL", "http://localhost:8000"),
                "azure_search_endpoint": os.getenv("AZURE_SEARCH_ENDPOINT", "not_configured")
            }
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {
            "status": "unhealthy",
            "timestamp": datetime.now().isoformat(),
            "error": str(e)
        }

@mcp.tool
def health_check() -> Dict[str, Any]:
    """Health check endpoint for Azure App Service (MCP tool version)"""
    return get_health_status()


# ============================================================================
# SERVER STARTUP AND CONFIGURATION
# ============================================================================

# CORS configuration functions
def get_cors_origins() -> List[str]:
    """Get CORS origins from environment variable"""
    cors_origins = os.getenv("CORS_ORIGINS", "*")
    if cors_origins == "*":
        return ["*"]
    return [origin.strip() for origin in cors_origins.split(",")]

def configure_cors(app):
    """Configure CORS middleware for the FastAPI app"""
    cors_origins = get_cors_origins()
    cors_enabled = os.getenv("CORS_ENABLED", "true").lower() == "true"
    
    if cors_enabled:
        logger.info(f"CORS enabled with origins: {cors_origins}")
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
        )
    else:
        logger.info("CORS disabled")

# Create the HTTP app from FastMCP for Azure App Service
logger.info("🌐 Creating HTTP app from FastMCP...")
app = mcp.http_app()

# Use FastMCP's built-in lifespan for proper initialization
# This ensures the StreamableHTTP session manager is properly initialized

# Add unified MCPMiddleware (auth + context + MCP init in one pass)
logger.info("🔧 Adding MCPMiddleware...")
app.add_middleware(MCPMiddleware)

# Configure CORS middleware
logger.info("🔧 Configuring CORS middleware...")
configure_cors(app)

# Add custom routes to the app
async def health_endpoint(request):
    """Azure App Service health check endpoint"""
    return JSONResponse(get_health_status())

# OAuth discovery endpoints for GitHub Copilot and other MCP clients
async def oauth_metadata(request):
    """OAuth 2.1 authorization server metadata for MCP clients like GitHub Copilot"""
    
    tenant_id = os.getenv("AZURE_TENANT_ID")
    client_id = os.getenv("AZURE_CLIENT_ID")
    authority_host = os.getenv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.us")
    api_scope = os.getenv("MCP_API_SCOPE", f"api://{client_id}/mcp-access")
    
    metadata = {
        "issuer": f"{authority_host}/{tenant_id}/v2.0",
        "authorization_endpoint": f"{authority_host}/{tenant_id}/oauth2/v2.0/authorize",
        "token_endpoint": f"{authority_host}/{tenant_id}/oauth2/v2.0/token",
        "userinfo_endpoint": f"{authority_host}/{tenant_id}/oidc/userinfo",
        "jwks_uri": f"{authority_host}/{tenant_id}/discovery/v2.0/keys",
        "scopes_supported": [
            "openid",
            "profile", 
            "email",
            api_scope
        ],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
        "claims_supported": [
            "sub", "iss", "aud", "exp", "iat", "name", "email"
        ]
    }
    
    logger.info("🔍 OAuth metadata requested by MCP client")
    return JSONResponse(metadata)

async def mcp_oauth_metadata(request):
    """MCP-specific OAuth configuration for clients like GitHub Copilot"""
    
    client_id = os.getenv("AZURE_CLIENT_ID")
    api_scope = os.getenv("MCP_API_SCOPE", f"api://{client_id}/mcp-access")
    
    metadata = {
        "auth_required": True,
        "auth_type": "oauth2",
        "client_id": client_id,
        "scopes": [api_scope, "openid", "profile"],
        "auth_url": "/.well-known/oauth-authorization-server"
    }
    
    logger.info("🔍 MCP OAuth metadata requested by client")
    return JSONResponse(metadata)

# Redirect handler to fix 127.0.0.1 vs localhost redirect URI issue
async def oauth_redirect_handler_with_port(request):
    """Handle OAuth redirects from Azure AD and forward to GitHub Copilot on specific port"""
    
    # Get the port from the URL path
    port = request.path_params.get("port", "33418")
    
    # Get all query parameters from the Azure AD redirect
    query_params = dict(request.query_params)
    logger.info(f"🔄 OAuth redirect received for port {port} with params: {list(query_params.keys())}")
    
    # Construct the localhost redirect URL that matches Azure AD app registration
    localhost_redirect = f"http://localhost:{port}/?{urlencode(query_params)}"
    
    logger.info(f"🔄 Redirecting to GitHub Copilot at: http://localhost:{port}")
    
    return RedirectResponse(url=localhost_redirect)

# Redirect handler to fix 127.0.0.1 vs localhost redirect URI issue
async def oauth_redirect_handler(request):
    """Handle OAuth redirects from Azure AD and forward to GitHub Copilot"""
    
    # Get all query parameters from the Azure AD redirect
    query_params = dict(request.query_params)
    logger.info(f"🔄 OAuth redirect received with params: {list(query_params.keys())}")
    
    # Extract the original redirect_uri from the state or use a default port
    # GitHub Copilot typically uses ports in the 33400+ range
    copilot_port = "33418"  # Default port, could be dynamic
    
    # Check if we can extract the actual port from the referrer or state
    if "state" in query_params:
        try:
            # Try to decode state if it contains port info
            state_data = json.loads(base64.b64decode(query_params["state"]).decode())
            if "port" in state_data:
                copilot_port = str(state_data["port"])
        except:
            pass  # Use default port if state parsing fails
    
    # Construct the localhost redirect URL that matches Azure AD app registration
    localhost_redirect = f"http://localhost:{copilot_port}/?{urlencode(query_params)}"
    
    logger.info(f"🔄 Redirecting to GitHub Copilot at: http://localhost:{copilot_port}")
    
    return RedirectResponse(url=localhost_redirect)

async def list_tools_endpoint(request):
    """List all available MCP tools with count (requires authentication)"""
    
    try:
        # Get tools from the MCP server
        tools = await mcp.get_tools()
        
        tool_list = []
        for tool in tools:
            try:
                # Handle different tool object types
                tool_name = tool if isinstance(tool, str) else getattr(tool, 'name', str(tool))
                tool_desc = getattr(tool, 'description', 'No description available') if hasattr(tool, 'description') else 'No description available'
                
                # Get the tool to extract input schema
                retrieved_tool = await mcp.get_tool(tool_name)
                
                tool_list.append({
                    "name": tool_name,
                    "description": tool_desc,
                    "input_schema": getattr(retrieved_tool, 'inputSchema', None) if retrieved_tool else None
                })
            except Exception as e:
                logger.warning(f"Failed to get details for tool: {e}")
                tool_name = tool if isinstance(tool, str) else getattr(tool, 'name', str(tool))
                tool_list.append({
                    "name": tool_name,
                    "description": "Error retrieving tool details",
                    "error": str(e)
                })
        
        # Organize tools by category
        tools_by_category = {
            "math": [t for t in tool_list if any(x in t["name"] for x in ["add", "subtract", "multiply", "divide", "power", "square_root", "statistics", "factorial"])],
            "adx": [t for t in tool_list if t["name"].startswith("kusto_")],
            "fictional_api": [t for t in tool_list if any(x in t["name"] for x in ["company", "device", "fictional"])],
            "document": [t for t in tool_list if any(x in t["name"] for x in ["document", "search"])],
            "rag": [t for t in tool_list if t["name"].startswith("rag_")],
            "translation": [t for t in tool_list if any(x in t["name"] for x in ["translate", "transliterate", "dictionary_", "detect_language", "supported_languages", "translator_health"])],
            "computer_vision": [t for t in tool_list if any(x in t["name"] for x in ["analyze_image", "read_text_from_image", "computer_vision_health"])],
            "system": [t for t in tool_list if t["name"] in ["health_check"]]
        }
        
        return JSONResponse({
            "total_count": len(tool_list),
            "tools": tool_list,
            "tools_by_category": {
                category: {
                    "count": len(tools),
                    "tools": [t["name"] for t in tools]
                }
                for category, tools in tools_by_category.items() if tools
            },
            "server_name": mcp.name,
            "timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Failed to list tools: {e}")
        logger.error(f"Full traceback: {traceback.format_exc()}")
        return JSONResponse({
            "error": "Failed to retrieve tools",
            "details": str(e),
            "timestamp": datetime.now().isoformat()
        }, status_code=500)

async def debug_tools_endpoint(request):
    """Debug endpoint to test tool registration and access"""
    try:
        # Try to get tools via the async method
        tools = await mcp.get_tools()
        tool_info = []
        for tool in tools:
            try:
                # Handle different tool object types - some might be strings, some objects
                tool_name = tool if isinstance(tool, str) else getattr(tool, 'name', str(tool))
                tool_desc = getattr(tool, 'description', 'No description available') if hasattr(tool, 'description') else 'No description available'
                
                retrieved_tool = await mcp.get_tool(tool_name)
                tool_info.append({
                    "name": tool_name,
                    "description": tool_desc,
                    "accessible": True,
                    "tool_type": type(tool).__name__,
                    "input_schema": getattr(retrieved_tool, 'inputSchema', None) if retrieved_tool else None
                })
            except Exception as e:
                tool_name = tool if isinstance(tool, str) else getattr(tool, 'name', str(tool))
                tool_desc = getattr(tool, 'description', 'No description available') if hasattr(tool, 'description') else 'No description available'
                tool_info.append({
                    "name": tool_name,
                    "description": tool_desc,
                    "accessible": False,
                    "tool_type": type(tool).__name__,
                    "error": str(e)
                })
        
        return JSONResponse({
            "total_tools": len(tools),
            "tools": tool_info,
            "mcp_server_name": mcp.name,
            "debug_timestamp": datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Debug tools endpoint error: {e}")
        logger.error(f"Full traceback: {traceback.format_exc()}")
        return JSONResponse({
            "error": "Failed to retrieve tools",
            "details": str(e),
            "debug_timestamp": datetime.now().isoformat()
        }, status_code=500)

async def root(request):
    """Server information endpoint"""
    return JSONResponse({
        "name": "Rude MCP Server",
        "version": "1.0.0",
        "transport": "streamable_http",
        "description": "Modular FastMCP server with Math Tools, Azure Data Explorer, Fictional API, and Document Service integration",
        "endpoints": {
            "mcp": "/mcp/",
            "health": "/health",
            "tools_list": "/api/tools",
            "debug_tools": "/debug/tools"
        },
        "tools": {
            "adx_tools": ["kusto_list_databases", "kusto_list_tables", "kusto_describe_table", "kusto_query", "kusto_get_cluster_info"],
            "fictional_api_tools": ["get_ip_company_info", "get_company_devices", "get_company_summary", "fictional_api_health_check"],
                "document_tools": ["list_documents", "get_document", "search_documents", "get_document_content_summary"],
                "rag_tools": ["rag_retrieve", "rag_rag_answer", "rag_health"],
                "translation_tools": ["translate_text", "translate_text_multiple_languages", "detect_language", "get_supported_languages", "transliterate_text", "dictionary_lookup", "dictionary_examples", "translator_health"],
                "computer_vision_tools": ["analyze_image", "read_text_from_image", "computer_vision_health"]
        }
    })

# Mount routes using Route() objects instead of deprecated @app.route decorator

# Import generated-document registry so the download endpoint can look up files
from tools.policy_document_tools import _generated_documents
from services.blob_storage_service import download_blob_bytes as _download_blob
from starlette.responses import Response


async def download_document_endpoint(request):
    """Serve a generated policy document by document_id.

    The UI renders a download card when the agent returns this URL.
    No credentials are needed by the caller — the server fetches from
    blob storage with its own service principal.
    """
    document_id = request.path_params.get("document_id", "")
    meta = _generated_documents.get(document_id)
    if meta is None:
        return JSONResponse(
            {"error": "Document not found", "document_id": document_id},
            status_code=404,
        )

    try:
        file_bytes = _download_blob(meta["container"], meta["blob_path"])
    except Exception as exc:
        logger.error(f"Download failed for {document_id}: {exc}")
        return JSONResponse(
            {"error": "Failed to retrieve document from storage"},
            status_code=502,
        )

    return Response(
        content=file_bytes,
        media_type=meta["content_type"],
        headers={
            "Content-Disposition": f'attachment; filename="{meta["file_name"]}"',
        },
    )


app.routes.extend([
    Route("/health", health_endpoint),
    Route("/.well-known/oauth-authorization-server", oauth_metadata),
    Route("/.well-known/mcp-oauth", mcp_oauth_metadata),
    Route("/oauth/redirect/{port:path}", oauth_redirect_handler_with_port),
    Route("/oauth/redirect", oauth_redirect_handler),
    Route("/api/download/{document_id}", download_document_endpoint),
    Route("/api/tools", list_tools_endpoint),
    Route("/debug/tools", debug_tools_endpoint),
    Route("/", root),
])

if __name__ == "__main__":
    try:
        # Log startup information
        logger.info("Starting Rude MCP Server for Azure App Service...")
        logger.info("Transport: HTTP Streamable for MCP over HTTP")
        logger.info("Available tools: Math operations, Azure Data Explorer queries, Fictional API calls, Document management")
        logger.info("Tools are loaded from modular tools/ directory")
        
        # Log Application Insights status
        if app_insights_ready:
            logger.info("📊 Application Insights: ENABLED - Telemetry and logging active")
            app_insights = get_application_insights()
            app_insights.log_custom_event("Server_Startup", {
                "server_name": "Rude MCP Server",
                "version": os.getenv("MCP_SERVER_VERSION", "1.0.0"),
                "environment": os.getenv("ENVIRONMENT", "production"),
                "features": "adx_tools,fictional_api_tools,document_tools"
            })
        else:
            logger.info("📊 Application Insights: DISABLED - Add APPLICATIONINSIGHTS_CONNECTION_STRING to enable")
        
        # Check for required environment variables
        kusto_cluster = os.getenv("KUSTO_CLUSTER_URL")
        if kusto_cluster:
            logger.info(f"Azure Data Explorer cluster configured: {kusto_cluster}")
        else:
            logger.warning("KUSTO_CLUSTER_URL not set - Azure Data Explorer tools will not work")
        
        # Check fictional API configuration
        fictional_api_url = os.getenv("FICTIONAL_COMPANIES_API_URL")
        if fictional_api_url:
            logger.info(f"Fictional API configured: {fictional_api_url}")
        else:
            logger.info("FICTIONAL_COMPANIES_API_URL not set - using default localhost:8000")
        
        # Check Azure Search configuration for document tools
        azure_search_endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
        if azure_search_endpoint:
            logger.info(f"Azure AI Search configured: {azure_search_endpoint}")
        else:
            logger.warning("AZURE_SEARCH_ENDPOINT not set - Document tools will not work")
        
        # For local development/testing, run with uvicorn
        import uvicorn
        port = int(os.getenv("PORT", "8000"))
        logger.info(f"Starting server on port {port}")
        uvicorn.run(app, host="0.0.0.0", port=port)
        
    except Exception as e:
        logger.error(f"Failed to start server: {e}")
        raise
