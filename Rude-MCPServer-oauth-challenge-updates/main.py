"""
Rude MCP Server - A FastMCP-based server for Math and Azure Data Explorer tools
Designed to be hosted on Azure App Service over HTTP using Streamable transport
"""

import os
import logging
import sys
from typing import Dict, Any, List
from datetime import datetime
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

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
    from tools import register_math_tools, register_adx_tools, register_fictional_api_tools, register_document_tools, register_rag_tools
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


class MCPInitializationMiddleware(BaseHTTPMiddleware):
    """Middleware to handle MCP initialization timing issues with GitHub Copilot"""
    
    def __init__(self, app):
        super().__init__(app)
        self.first_tools_request = True
        self.initialization_delay = 0.3  # Small delay for first tools request
        logger.info(f"🕐 MCP initialization middleware enabled with {self.initialization_delay}s delay")
    
    async def dispatch(self, request: Request, call_next):
        # Check if this is an MCP tools/list request
        if request.url.path in ["/mcp", "/mcp/"] and request.method == "POST":
            try:
                # Read the request body to check if it's a tools/list request
                body = await request.body()
                if body:
                    import json
                    try:
                        data = json.loads(body)
                        method = data.get("method", "")
                        
                        # Check for authentication requirements
                        auth_header = request.headers.get("Authorization")
                        has_token = auth_header and auth_header.startswith("Bearer ")
                        
                        # Handle tools/list timing and authentication
                        if method == "tools/list":
                            if self.first_tools_request:
                                logger.info("🚀 First tools/list request detected - applying initialization delay")
                                import asyncio
                                await asyncio.sleep(self.initialization_delay)
                                self.first_tools_request = False
                                logger.info("✅ Initialization delay complete - proceeding with tools/list")
                            
                            # Check authentication for tools/list
                            if not has_token:
                                # No token - return OAuth challenge for GitHub Copilot
                                logger.info("🔐 tools/list requires authentication - returning OAuth challenge")
                                oauth_enabled = os.getenv("MCP_OAUTH_ENABLED", "false").lower() == "true"
                                if oauth_enabled:
                                    from fastapi.responses import JSONResponse
                                    return JSONResponse(
                                        status_code=401,
                                        content={
                                            "error": "authentication_required",
                                            "message": "OAuth 2.1 authentication required",
                                            "oauth": {
                                                "authorization_url": f"https://login.microsoftonline.us/{os.getenv('AZURE_TENANT_ID')}/oauth2/v2.0/authorize",
                                                "client_id": os.getenv('AZURE_CLIENT_ID'),
                                                "scope": f"{os.getenv('MCP_API_SCOPE')} openid profile",
                                                "redirect_uri": "http://localhost:8000/oauth/redirect"
                                            }
                                        }
                                    )
                            else:
                                logger.info("🔓 tools/list request with bearer token (custom app) - proceeding")
                        
                        # Handle tools/call authentication
                        elif method == "tools/call":
                            if not has_token:
                                logger.info("🔐 tools/call requires authentication - returning OAuth challenge")
                                oauth_enabled = os.getenv("MCP_OAUTH_ENABLED", "false").lower() == "true"
                                if oauth_enabled:
                                    from fastapi.responses import JSONResponse
                                    return JSONResponse(
                                        status_code=401,
                                        content={
                                            "error": "authentication_required",
                                            "message": "OAuth 2.1 authentication required"
                                        }
                                    )
                            else:
                                logger.info("🔓 tools/call request with bearer token (custom app) - proceeding")
                        
                    except json.JSONDecodeError:
                        pass
                
                # Recreate the request with the body for the next middleware
                from starlette.requests import Request as StarletteRequest
                
                async def receive():
                    return {"type": "http.request", "body": body}
                
                # Create a new request with the same properties
                new_request = StarletteRequest(scope=request.scope, receive=receive)
                return await call_next(new_request)
                        
            except Exception as e:
                logger.debug(f"MCP initialization middleware error: {e}")
                
        return await call_next(request)


class ContextMiddleware(BaseHTTPMiddleware):
    """Middleware to extract and store request context from headers"""
    
    async def dispatch(self, request: Request, call_next):
        # Extract user context from headers for ALL requests (including MCP)
        user_id = request.headers.get("X-User-ID") or request.headers.get("x-user-id") or "defaMCPUser"
        session_id = request.headers.get("X-Session-ID") or request.headers.get("x-session-id")
        
        # Extract bearer token for user impersonation
        auth_header = request.headers.get("Authorization")
        user_token = None
        if auth_header and auth_header.startswith("Bearer "):
            user_token = auth_header[7:]  # Remove "Bearer " prefix
        
        # Store in context variables
        current_user_id.set(user_id)
        if session_id:
            current_session_id.set(session_id)
        if user_token:
            # Use the new helper function to set in both places
            from context import set_user_token
            set_user_token(user_token)
            logger.info(f"🔧 Stored user token in both contextvars and thread-local storage")
        
        # Log authentication events to Application Insights
        try:
            if app_insights_ready:
                app_insights = get_application_insights()
                auth_mode = "user_token" if user_token else "service_identity"
                app_insights.log_authentication_event(
                    auth_mode=auth_mode,
                    user_id=user_id,
                    success=True
                )
        except Exception as e:
            logger.debug(f"Failed to log authentication event: {e}")
        
        # Enhanced logging for debugging authentication issues
        if not request.url.path.startswith("/health"):
            # Log request details for non-health endpoints
            token_status = "PRESENT" if user_token else "MISSING"
            token_preview = f"{user_token[:50]}..." if user_token else "None"
            
            logger.info(f"🔍 Context middleware processing:")
            logger.info(f"   - Path: {request.url.path}")
            logger.info(f"   - Method: {request.method}")
            logger.info(f"   - User ID: {user_id}")
            logger.info(f"   - Session ID: {session_id}")
            logger.info(f"   - Authorization header: {'PRESENT' if auth_header else 'MISSING'}")
            logger.info(f"   - Bearer token: {token_status}")
            
            if user_token:
                logger.info(f"   - Token preview: {token_preview}")
                logger.info(f"   - Token length: {len(user_token)} characters")
                
                # Try to decode and log token details for debugging
                try:
                    import base64
                    import json
                    parts = user_token.split('.')
                    if len(parts) >= 2:
                        payload = parts[1]
                        payload += '=' * (4 - len(payload) % 4)
                        decoded = base64.b64decode(payload)
                        token_data = json.loads(decoded)
                        
                        logger.info(f"   - Token audience (aud): {token_data.get('aud', 'N/A')}")
                        logger.info(f"   - Token issuer (iss): {token_data.get('iss', 'N/A')}")
                        logger.info(f"   - Token subject (sub): {token_data.get('sub', 'N/A')[:20]}..." if token_data.get('sub') else "   - Token subject: N/A")
                        
                        exp = token_data.get('exp')
                        if exp:
                            from datetime import datetime
                            exp_date = datetime.fromtimestamp(exp)
                            logger.info(f"   - Token expires: {exp_date}")
                except Exception as decode_error:
                    logger.debug(f"   - Could not decode token: {decode_error}")
        
        response = await call_next(request)
        return response


class AuthenticationMiddleware(BaseHTTPMiddleware):
    """Middleware to enforce OAuth authentication for GitHub Copilot integration"""
    
    async def dispatch(self, request: Request, call_next):
        logger.info(f"🔐 AuthenticationMiddleware called for {request.method} {request.url.path}")
        
        # Skip authentication for certain endpoints
        skip_auth_paths = [
            "/health", 
            "/.well-known/",
            "/debug/",
            "/api/tools"  # Allow unauthenticated access to tools list
        ]
        
        logger.info(f"🔐 Checking skip paths for {request.url.path}")
        if any(request.url.path.startswith(path) for path in skip_auth_paths):
            logger.info(f"🔐 Skipping auth for path {request.url.path}")
            return await call_next(request)
        
        # Check if OAuth is enabled
        oauth_enabled = os.getenv("MCP_OAUTH_ENABLED", "false").lower() == "true"
        logger.info(f"🔐 OAuth enabled: {oauth_enabled} (MCP_OAUTH_ENABLED={os.getenv('MCP_OAUTH_ENABLED')})")
        if not oauth_enabled:
            # OAuth disabled - allow all requests (backward compatibility)
            logger.info("🔐 OAuth disabled - allowing request")
            return await call_next(request)
        
        # Extract bearer token from Authorization header
        auth_header = request.headers.get("Authorization")
        token = None
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:]  # Remove "Bearer " prefix
            logger.info(f"🔍 AuthenticationMiddleware: Found bearer token (length: {len(token)})")
        else:
            logger.info(f"🔍 AuthenticationMiddleware: No bearer token found. Auth header: {'PRESENT' if auth_header else 'MISSING'}")
        
        # Handle MCP endpoints with OAuth flow
        if request.url.path.startswith("/mcp"):
            return await self._handle_mcp_request(request, call_next, token)
        
        # Handle direct API calls (non-MCP endpoints) with bearer token authentication
        else:
            return await self._handle_direct_api_request(request, call_next, token)
    
    async def _handle_mcp_request(self, request: Request, call_next, token: str = None):
        """Handle MCP-specific authentication logic"""
        if request.method == "POST":
            logger.info(f"🔐 Processing MCP POST request to {request.url.path}")
            
            # For MCP requests, we need to check authentication but avoid double body consumption
            # If we have a token, allow through. If not, check if this is a request that needs auth
            if token:
                logger.info("🔓 MCP request with valid bearer token - proceeding")
                return await call_next(request)
            else:
                # No token - for MCP requests, we need to peek at the method to decide
                # But to avoid double body consumption, we'll let requests through and handle auth errors later
                # The MCPInitializationMiddleware will handle the body parsing
                logger.info("� MCP request without token - allowing through (will be checked by MCP protocol)")
                return await call_next(request)
        
        # For non-POST MCP requests, just pass through
        return await call_next(request)
    
    async def _handle_direct_api_request(self, request: Request, call_next, token: str = None):
        """Handle direct API calls (non-MCP endpoints) with bearer token authentication"""
        if token:
            logger.info("🔓 Direct API request with valid bearer token - proceeding")
            return await call_next(request)
        else:
            logger.info("🔐 Direct API request missing bearer token - returning 401")
            from starlette.responses import JSONResponse
            return JSONResponse(
                status_code=401,
                content={
                    "error": "Authentication required", 
                    "message": "Bearer token required for API access"
                },
                headers={"WWW-Authenticate": 'Bearer realm="API"'}
            )
    
    async def _create_oauth_challenge(self):
        """Create OAuth challenge response for GitHub Copilot"""
        from starlette.responses import JSONResponse
        
        tenant_id = os.getenv("AZURE_TENANT_ID")
        client_id = os.getenv("AZURE_CLIENT_ID")
        authority_host = os.getenv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.us")
        api_scope = os.getenv("MCP_API_SCOPE", f"api://{client_id}/mcp-access")
        
        # Use our redirect handler to solve the 127.0.0.1 vs localhost issue
        redirect_uri = "http://localhost:8000/oauth/redirect"
        
        logger.info(f"🔐 OAuth challenge details:")
        logger.info(f"   - Authorization URL: {authority_host}/{tenant_id}/oauth2/v2.0/authorize")
        logger.info(f"   - Client ID: {client_id}")
        logger.info(f"   - Scope: {api_scope} openid profile")
        logger.info(f"   - Redirect URI: {redirect_uri}")
        
        # Return OAuth challenge with authentication URLs
        oauth_challenge = {
            "error": {
                "code": -32002,  # MCP authentication required error
                "message": "Authentication required",
                "data": {
                    "auth_required": True,
                    "auth_type": "oauth2",
                    "authorization_url": f"{authority_host}/{tenant_id}/oauth2/v2.0/authorize",
                    "client_id": client_id,
                    "scope": f"{api_scope} openid profile",
                    "redirect_uri": redirect_uri,
                    "auth_discovery_url": "/.well-known/oauth-authorization-server"
                }
            }
        }
        
        # Also set WWW-Authenticate header for HTTP-level OAuth discovery
        headers = {
            "WWW-Authenticate": f'Bearer realm="MCP", scope="{api_scope}"',
            "Location": f"{authority_host}/{tenant_id}/oauth2/v2.0/authorize"
        }
        
        return JSONResponse(
            content=oauth_challenge,
            status_code=401,
            headers=headers
        )


# Initialize FastMCP server
logger.info("🔧 Initializing FastMCP server...")

# For now, let's disable OAuth at the FastMCP level and handle authentication via middleware
# The ContextMiddleware already handles Bearer token extraction and OBO flow
mcp = FastMCP("Rude MCP Server")
logger.info("✅ FastMCP server initialized (OAuth handled via middleware)")

# Register all tools
logger.info("📋 Registering tools...")
#register_math_tools(mcp)
#logger.info("✅ Math tools registered")
register_adx_tools(mcp)
logger.info("✅ ADX tools registered")
register_fictional_api_tools(mcp)
logger.info("✅ Fictional API tools registered")
register_document_tools(mcp)
logger.info("✅ Document tools registered")
register_rag_tools(mcp)
logger.info("✅ RAG tools registered")
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
        document_service_status = "configured" if (os.getenv("AZURE_SEARCH_ENDPOINT") and os.getenv("AZURE_SEARCH_KEY")) else "not_configured"
        
        return {
            "status": "healthy",
            "timestamp": datetime.now().isoformat(),
            "server_name": "Rude MCP Server",
            "version": "1.0.0",
            "features": {
                #"math_tools": True,
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

# Add the MCP initialization middleware FIRST to handle timing issues
logger.info("🚀 Adding MCP initialization middleware...")
app.add_middleware(MCPInitializationMiddleware)

# Add the context middleware BEFORE other middleware
logger.info("🔧 Adding context middleware...")
app.add_middleware(ContextMiddleware)

# Add the authentication middleware for OAuth enforcement
logger.info("🔐 Adding authentication middleware...")
app.add_middleware(AuthenticationMiddleware)

# Configure CORS middleware
logger.info("🔧 Configuring CORS middleware...")
configure_cors(app)

# Add custom routes to the app
@app.route("/health")
async def health_endpoint(request):
    """Azure App Service health check endpoint"""
    from starlette.responses import JSONResponse
    return JSONResponse(get_health_status())

# OAuth discovery endpoints for GitHub Copilot and other MCP clients
@app.route("/.well-known/oauth-authorization-server")
async def oauth_metadata(request):
    """OAuth 2.1 authorization server metadata for MCP clients like GitHub Copilot"""
    from starlette.responses import JSONResponse
    
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

@app.route("/.well-known/mcp-oauth")
async def mcp_oauth_metadata(request):
    """MCP-specific OAuth configuration for clients like GitHub Copilot"""
    from starlette.responses import JSONResponse
    
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
@app.route("/oauth/redirect/{port:path}")
async def oauth_redirect_handler_with_port(request):
    """Handle OAuth redirects from Azure AD and forward to GitHub Copilot on specific port"""
    from starlette.responses import RedirectResponse
    from urllib.parse import urlencode
    
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
@app.route("/oauth/redirect")
async def oauth_redirect_handler(request):
    """Handle OAuth redirects from Azure AD and forward to GitHub Copilot"""
    from starlette.responses import RedirectResponse
    from urllib.parse import urlencode
    
    # Get all query parameters from the Azure AD redirect
    query_params = dict(request.query_params)
    logger.info(f"🔄 OAuth redirect received with params: {list(query_params.keys())}")
    
    # Extract the original redirect_uri from the state or use a default port
    # GitHub Copilot typically uses ports in the 33400+ range
    copilot_port = "33418"  # Default port, could be dynamic
    
    # Check if we can extract the actual port from the referrer or state
    if "state" in query_params:
        try:
            import base64
            import json
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

@app.route("/api/tools")
async def list_tools_endpoint(request):
    """List all available MCP tools with count (requires authentication)"""
    from starlette.responses import JSONResponse
    
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
        import traceback
        logger.error(f"Full traceback: {traceback.format_exc()}")
        return JSONResponse({
            "error": "Failed to retrieve tools",
            "details": str(e),
            "timestamp": datetime.now().isoformat()
        }, status_code=500)

@app.route("/debug/tools")
async def debug_tools_endpoint(request):
    """Debug endpoint to test tool registration and access"""
    from starlette.responses import JSONResponse
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
        import traceback
        logger.error(f"Full traceback: {traceback.format_exc()}")
        return JSONResponse({
            "error": "Failed to retrieve tools",
            "details": str(e),
            "debug_timestamp": datetime.now().isoformat()
        }, status_code=500)

@app.route("/")
async def root(request):
    """Server information endpoint"""
    from starlette.responses import JSONResponse
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
            #"math_tools": ["add", "subtract", "multiply", "divide", "power", "square_root", "calculate_statistics", "factorial"],
            "adx_tools": ["kusto_list_databases", "kusto_list_tables", "kusto_describe_table", "kusto_query", "kusto_get_cluster_info"],
            "fictional_api_tools": ["get_ip_company_info", "get_company_devices", "get_company_summary", "fictional_api_health_check"],
                "document_tools": ["list_documents", "get_document", "search_documents", "get_document_content_summary"],
                "rag_tools": ["rag_retrieve", "rag_rag_answer", "rag_health"]
        }
    })

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
                #"features": "math_tools,adx_tools,fictional_api_tools,document_tools"
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
