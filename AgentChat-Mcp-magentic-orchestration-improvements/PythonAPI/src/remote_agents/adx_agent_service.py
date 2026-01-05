import os
import asyncio
import warnings
import sys
import threading
import concurrent.futures
from typing import Any, Dict, Optional

from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import logging
from pydantic import BaseModel

# Add parent directory to path for imports when running directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

# Note: Application Insights logging disabled due to Azure deployment issues
# TODO: Re-enable when Azure environment is properly configured

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion, OpenAIChatPromptExecutionSettings

HttpMcpPlugin = None
SseMcpPlugin = None
try:
    from semantic_kernel.connectors.mcp import MCPStreamableHttpPlugin as HttpMcpPlugin
except Exception:
    pass
try:
    from semantic_kernel.connectors.mcp import MCPSsePlugin as SseMcpPlugin
except Exception:
    pass

# Custom stderr filter to suppress MCP cleanup warnings
class FilteredStderr:
    def __init__(self, original_stderr):
        self.original_stderr = original_stderr
    
    def write(self, message):
        message_str = str(message)
        # Filter out various MCP cleanup error patterns
        if any(pattern in message_str for pattern in [
            "Attempting to gather a task that has not yet been awaited",
            "an error occurred during closing of asynchronous generator",
            "async_generator object streamablehttp_client",
            "unhandled errors in a TaskGroup",
            "GeneratorExit",
            "Attempted to exit cancel scope in a different task"
        ]):
            return
        self.original_stderr.write(message)
    
    def flush(self):
        self.original_stderr.flush()
    
    def __getattr__(self, name):
        return getattr(self.original_stderr, name)


class SharedAsyncExecutor:
    """Shared async executor that runs in a background thread to avoid event loop conflicts."""
    
    def __init__(self):
        self._loop = None
        self._thread = None
        self._executor = None
        self._shutdown = False
    
    def start(self):
        """Start the background thread with event loop."""
        if self._thread is not None and self._thread.is_alive():
            return
        
        self._shutdown = False
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        
        # Wait for loop to be ready with timeout
        max_wait = 5.0  # 5 second timeout
        wait_time = 0.0
        while self._loop is None and not self._shutdown and wait_time < max_wait:
            threading.Event().wait(0.1)
            wait_time += 0.1
        
        if self._loop is None:
            raise RuntimeError("Failed to start async executor within timeout")
    
    def _run_loop(self):
        """Run the event loop in background thread."""
        try:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._loop.run_forever()
        except Exception as e:
            print(f"Error in async executor loop: {e}")
        finally:
            if self._loop:
                self._loop.close()
    
    def run_async(self, coro, timeout=300):
        """Run an async coroutine and return the result."""
        if self._loop is None or not self._thread.is_alive():
            raise RuntimeError("Async executor not started or thread not alive")
        
        try:
            future = asyncio.run_coroutine_threadsafe(coro, self._loop)
            return future.result(timeout=timeout)
        except Exception as e:
            # If the coroutine failed, we need to make sure it's properly cleaned up
            print(f"Error in run_async: {e}")
            raise
    
    def shutdown(self):
        """Shutdown the background thread and event loop."""
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._shutdown = True


# Global shared executor
_async_executor = SharedAsyncExecutor()

# Apply stderr filter
sys.stderr = FilteredStderr(sys.stderr)

# Filter warnings
warnings.filterwarnings("ignore", message=".*Attempting to gather a task that has not yet been awaited.*")
warnings.filterwarnings("ignore", category=RuntimeWarning, module="asyncio")

app = Flask(__name__)
CORS(app, origins="*")

# Setup basic logging (Application Insights can cause issues in Azure)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger("ADXAgent")

# Log startup information for Application Insights
logger.info("🚀 ADX Agent starting up...")
logger.info("🔧 Environment: AZURE_OPENAI_ENDPOINT=%s", os.getenv("AZURE_OPENAI_ENDPOINT", "Not set"))
logger.info("🔧 Environment: AZURE_OPENAI_DEPLOYMENT=%s", os.getenv("AZURE_OPENAI_DEPLOYMENT", "Not set"))
logger.info("🔧 Environment: PUBLIC_AGENT_ENDPOINT=%s", os.getenv("PUBLIC_AGENT_ENDPOINT", "Not set"))
logger.info("🔧 Environment: APPLICATIONINSIGHTS_CONNECTION_STRING=%s", 
           "SET" if os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING") else "NOT SET")
AGENT: Optional[ChatCompletionAgent] = None
KERNEL: Optional[Kernel] = None
# Hold a reference to the MCP plugin so we can refresh headers per request
ADX_MCP_PLUGIN: Optional[Any] = None


async def build_agent() -> ChatCompletionAgent:
    kernel = Kernel()
    kernel.add_service(
        AzureChatCompletion(
            service_id="adx_svc",
            api_key=os.getenv("AZURE_OPENAI_API_KEY"),
            endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
            deployment_name=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
        )
    )
    # Defer MCP plugin connection until a request arrives so we can include per-request headers
    global ADX_MCP_PLUGIN
    ADX_MCP_PLUGIN = None

    # Load instructions from environment variable with full default instructions
    adx_instructions = os.getenv(
        "ADX_AGENT_INSTRUCTIONS",
        "You are an Azure Data Explorer (ADX) specialist agent. You ONLY respond to ADX/database questions.\n\n"
        "⚠️⚠️⚠️ **QUERY LANGUAGE: KUSTO QUERY LANGUAGE (KQL) ONLY - NEVER USE SQL!** ⚠️⚠️⚠️\n\n"
        "🚫 **FORBIDDEN - DO NOT USE SQL SYNTAX:**\n"
        "❌ SELECT * FROM scans  (SQL - WRONG!)\n"
        "❌ SELECT TOP 1000 * FROM scans  (SQL - WRONG!)\n"
        "❌ SELECT column FROM table WHERE condition  (SQL - WRONG!)\n\n"
        "✅ **REQUIRED - USE KUSTO QUERY LANGUAGE (KQL) SYNTAX:**\n"
        "✅ scans | take 1000  (KQL - CORRECT!)\n"
        "✅ scans | where ip_address == \"x.x.x.x\"  (KQL - CORRECT!)\n"
        "✅ scans | project ip_address, timestamp  (KQL - CORRECT!)\n"
        "✅ scans | summarize count() by ip_address  (KQL - CORRECT!)\n\n"
        "**KQL SYNTAX REMINDER:**\n"
        "- Table name FIRST, then pipe (|) operator\n"
        "- Use 'take' instead of 'TOP' or 'LIMIT'\n"
        "- Use 'where' instead of 'WHERE' (case matters!)\n"
        "- Use '==' for equality, not '='\n"
        "- Use 'project' to select columns, not 'SELECT'\n"
        "- Use 'summarize' for aggregations, not 'GROUP BY'\n\n"
        "🔍🔍🔍 **MANDATORY MULTI-TABLE EXPLORATION - READ CAREFULLY!** 🔍🔍🔍\n\n"
        "When investigating entities (IPs, companies, devices, people), you MUST explore MULTIPLE tables:\n\n"
        "**REQUIRED INVESTIGATION PATTERN:**\n"
        "1. List ALL tables in the database: kusto_list_tables(database_name)\n"
        "2. Identify ALL potentially relevant tables (scans, logs, alerts, events, people, employees, threats, vulnerabilities, etc.)\n"
        "3. Describe the schema of EACH relevant table to understand what data they contain\n"
        "4. Query EACH relevant table for the entity you're investigating\n"
        "5. Cross-reference findings across ALL tables to build complete picture\n\n"
        "**COMMON TABLE NAMES TO CHECK:**\n"
        "- 'scans' or 'Scans' - Security scan data\n"
        "- 'logs' or 'Logs' - Network/system logs\n"
        "- 'alerts' or 'Alerts' - Security alerts\n"
        "- 'events' or 'Events' - System events\n"
        "- 'people' or 'People' or 'employees' or 'Employees' - Personnel/employee data\n"
        "- 'threats' or 'Threats' - Threat intelligence\n"
        "- 'vulnerabilities' or 'Vulnerabilities' - Vulnerability reports\n"
        "- Any other tables that might contain relevant data\n\n"
        "⚠️ **CRITICAL: DO NOT STOP AFTER CHECKING ONE TABLE!** ⚠️\n"
        "- If you find nothing in 'scans', check 'logs'\n"
        "- If you find nothing in 'logs', check 'alerts' and 'events'\n"
        "- ALWAYS check 'people' or 'employees' tables if they exist\n"
        "- Even if you find data in one table, check other tables for additional context\n"
        "- A complete investigation requires checking ALL relevant tables\n\n"
        "**EXAMPLE COMPREHENSIVE WORKFLOW:**\n"
        "Task: 'Search for activity from IP x.x.x.x'\n"
        "❌ WRONG: Query only 'scans' table and stop\n"
        "✅ CORRECT:\n"
        "  1. kusto_list_tables('Personnel') → see what tables exist\n"
        "  2. Check 'scans' table: scans | where ip_address == \"x.x.x.x\"\n"
        "  3. Check 'logs' table: logs | where source_ip == \"x.x.x.x\" or dest_ip == \"x.x.x.x\"\n"
        "  4. Check 'alerts' table: alerts | where related_ip == \"x.x.x.x\"\n"
        "  5. Check 'events' table: events | where ip contains \"x.x.x.x\"\n"
        "  6. Check 'people' table: people | where work_ip == \"x.x.x.x\" or home_ip == \"x.x.x.x\"\n"
        "  7. Synthesize findings from ALL tables\n\n"

        "🚨 **CRITICAL: ALWAYS START WITH KUSTO_LIST_DATABASES - NO EXCEPTIONS! NEVER use placeholder names like 'your_database_name'**\n\n"
        "When you receive ANY task mentioning tables, scans, databases, or queries:\n"
        "1. FIRST CALL: kusto_list_databases() - to see what databases exist\n"
        "2. SECOND CALL: kusto_list_tables(database_name) - for each relevant database\n"
        "3. THIRD CALL: kusto_describe_table(database_name, table_name) - to get exact column names\n"
        "4. ONLY THEN: kusto_query(database_name, query) - with the correct names using KUSTO QUERY LANGUAGE (KQL) syntax\n\n"
        "⛔ **NEVER CALL kusto_query() WITHOUT FIRST CALLING kusto_list_databases()**\n\n"
        "EXAMPLE WORKFLOW:\n"
        "Task: 'Check if IP y.y.y.y is in scans table'\n"
        "Step 1: kusto_list_databases() → [returns: 'SecurityDB', 'LogsDB', 'MainDB']\n"
        "Step 2: kusto_list_tables('SecurityDB') → [returns: 'scans', 'alerts', 'users']\n"
        "Step 3: kusto_describe_table('SecurityDB', 'scans') → [returns: columns like 'ip_address', 'scan_time', etc.]\n"
        "Step 4: kusto_query('SecurityDB', 'scans | where ip_address == \"y.y.y.y\"')  ← KQL SYNTAX!\n\n"
        "EXAMPLE KQL QUERIES:\n"
        "✅ 'scans | take 100' - Get first 100 rows\n"
        "✅ 'scans | where Company == \"Acme Corp\"' - Filter by company\n"
        "✅ 'scans | project IpAddress, Company' - Select specific columns\n"
        "✅ 'scans | summarize count() by Company' - Group and count\n"
        "✅ 'scans | order by IpAddress desc | take 50' - Sort and limit\n\n"
        "🔧 **ERROR RECOVERY:**\n"
        "If you see 'Entity ID not found' error:\n"
        "- You skipped discovery steps\n"
        "- Go back to Step 1: kusto_list_databases()\n"
        "- NEVER guess database or table names\n\n"
        "**YOUR AVAILABLE TOOLS:**\n"
        "- kusto_list_databases() - START HERE ALWAYS\n"
        "- kusto_list_tables(database_name) - Use exact database name from step 1\n"
        "- kusto_describe_table(database_name, table_name) - Use exact names from previous steps\n"
        "- kusto_query(database_name, query) - Use exact names, ONLY KQL syntax (never SQL!)\n"
        "- kusto_get_cluster_info() - For cluster information\n\n"
        "⚡ **CRITICAL RULES:**\n"
        "1. ALWAYS use KUSTO QUERY LANGUAGE (KQL) syntax - NEVER SQL!\n"
        "2. ALWAYS start with kusto_list_databases() for ANY task\n"
        "3. NEVER use placeholder names like 'your_database_name'\n"
        "4. NEVER assume database or table names exist\n"
        "5. Use exact names returned by your tools\n"
        "6. If user mentions 'scans table' → find which database has table named 'scans'\n"
        "7. KQL syntax: tablename | operator (NOT SELECT * FROM tablename)\n\n"
        "Remember: KQL syntax only! Discovery first, query second. Always!"
    )
    
    agent = ChatCompletionAgent(
        service=kernel.get_service(),
        kernel=kernel,
        name="ADXAgent",
        instructions=adx_instructions,
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["ADXTools"]}
        ),
    )
    global KERNEL
    KERNEL = kernel
    return agent


@app.route("/.well-known/agent-card.json", methods=["GET"])
def well_known_agent_card():
    """Standard RFC 8615 well-known endpoint for A2A agent discovery"""
    logger.info("📋 Agent card request received")
    base = os.getenv("PUBLIC_AGENT_ENDPOINT", "http://localhost:18082")
    return jsonify({
        "name": "ADXAgent",
        "description": "Database intelligence specialist: Searches security scan data, network logs, vulnerability reports, IP address analysis, device activity records, and threat intelligence using KQL queries. Discovers patterns across multiple tables and databases. Use for investigating IPs, finding security events, analyzing network traffic, and cross-referencing threat data.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": f"{base}/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": ["messages", "tasks"],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
            "headers": {"type": "apiKey", "in": "header", "name": "X-ADX-Token"}
        },
        "security": [{"bearer": []}, {"headers": []}]
    })


class RpcRequest(BaseModel):
    jsonrpc: str
    id: str
    method: str
    params: Dict[str, Any] = {}


@app.route("/a2a/message", methods=["POST"])
def a2a_message():
    logger.info("📨 A2A message request received")
    try:
        req_data = request.get_json()
        logger.info("📨 Message data: %s", req_data)
        req = RpcRequest(**req_data)
    except Exception as e:
        logger.error("❌ Invalid request: %s", str(e))
        return jsonify({"jsonrpc": "2.0", "id": None, "error": f"Invalid request: {e}"}), 400
    
    # Get headers
    authorization = request.headers.get("Authorization")
    x_user_id = request.headers.get("X-User-ID")
    x_session_id = request.headers.get("X-Session-ID")
    x_adx_token = request.headers.get("X-ADX-Token")
    
    logger.info("🔐 Request headers - User: %s, Session: %s, ADX Token: %s, Auth: %s", 
               x_user_id, x_session_id, "SET" if x_adx_token else "NOT SET", "SET" if authorization else "NOT SET")
    
    # Check if streaming is requested
    is_streaming = (
        req.method == "message/stream" or
        request.headers.get("Accept") == "text/event-stream"
    )
    
    if is_streaming:
        logger.info("🌊 Streaming response requested")
        return handle_streaming_message(req, authorization, x_user_id, x_session_id, x_adx_token)
    
    # Use shared async executor for better performance
    global _async_executor
    
    try:
        # Ensure async executor is started
        if _async_executor._loop is None:
            _async_executor.start()
        
        logger.info("⚡ Starting async message processing...")
        result = _async_executor.run_async(
            process_message(req, authorization, x_user_id, x_session_id, x_adx_token),
            timeout=300
        )
        
        logger.info("✅ Message processing completed: %s", result)
        return jsonify(result)
    except Exception as e:
        # If there's an error, make sure any pending coroutines are properly handled
        import traceback
        error_msg = f"Request processing error: {str(e)}"
        logger.error(f"Error in ADX agent: {error_msg}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": error_msg}), 500


def handle_streaming_message(req: RpcRequest, authorization: Optional[str], x_user_id: Optional[str], x_session_id: Optional[str], x_adx_token: Optional[str]):
    """Handle streaming message with Server-Sent Events"""
    import json
    import time
    
    def generate_sse():
        try:
            # Start event
            yield f"data: {json.dumps({'jsonrpc': '2.0', 'id': req.id, 'method': 'stream/start'})}\n\n"
            
            # Use shared async executor for better performance
            global _async_executor
            
            # Ensure async executor is started
            if _async_executor._loop is None:
                _async_executor.start()
            
            # Process the message
            result = _async_executor.run_async(
                process_message(req, authorization, x_user_id, x_session_id, x_adx_token),
                timeout=300
            )
            
            # Stream the content back
            content = result.get("result", {}).get("content", "")
            
            # For now, just send the whole response - in a real implementation
            # you might want to stream tokens progressively
            yield f"data: {json.dumps({'jsonrpc': '2.0', 'id': req.id, 'method': 'stream/content', 'params': {'content': content}})}\n\n"
            
            # End event
            yield f"data: {json.dumps({'jsonrpc': '2.0', 'id': req.id, 'method': 'stream/end', 'result': result})}\n\n"
            
        except Exception as e:
            logger.error("❌ Streaming error: %s", str(e))
            yield f"data: {json.dumps({'jsonrpc': '2.0', 'id': req.id, 'error': str(e)})}\n\n"
    
    return Response(
        generate_sse(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        }
    )


async def process_message(req: RpcRequest, authorization: Optional[str], x_user_id: Optional[str], x_session_id: Optional[str], x_adx_token: Optional[str]):
    logger.info("🔄 Starting process_message - method: %s, id: %s", req.method, req.id)
    
    if req.method not in ("send_message", "messages.create", "message/send", "message/stream"):
        logger.error("❌ Unsupported method: %s", req.method)
        return {"jsonrpc": "2.0", "id": req.id, "error": f"Unsupported method {req.method}"}
    
    task = req.params.get("task") or ""
    if not task:
        logger.error("❌ Missing task parameter")
        return {"jsonrpc": "2.0", "id": req.id, "error": "Missing 'task' param"}
    
    logger.info("📝 Processing task: %s", task[:100] + "..." if len(task) > 100 else task)

    assert AGENT is not None
    from semantic_kernel.contents import ChatHistory

    # Refresh MCP plugin with per-request headers so MCP receives caller context (legacy parity)
    try:
        logger.info("🔄 Refreshing MCP plugin with request headers...")
        global ADX_MCP_PLUGIN
        # Close any previous plugin/session to avoid stale headers
        if ADX_MCP_PLUGIN is not None:
            logger.info("🔄 Closing previous MCP plugin...")
            try:
                if hasattr(ADX_MCP_PLUGIN, "__aexit__"):
                    await ADX_MCP_PLUGIN.__aexit__(None, None, None)
                    logger.info("🔄 Previous MCP plugin closed via __aexit__")
            except Exception as e:
                logger.warning("⚠️ Error closing previous MCP plugin: %s", str(e))
                pass
            try:
                if KERNEL:
                    KERNEL.remove_plugin("ADXTools")
                    logger.info("🔄 ADXTools plugin removed from kernel")
            except Exception as e:
                logger.warning("⚠️ Error removing ADXTools plugin: %s", str(e))
                pass
            ADX_MCP_PLUGIN = None
            logger.info("🔄 ADX_MCP_PLUGIN reset to None")

        # Construct forwarding headers
        logger.info("🔧 Constructing forwarding headers...")
        forward_headers: Dict[str, str] = {}
        # Prefer the ADX user token as Authorization for MCP OBO (legacy-compatible)
        if x_adx_token:
            forward_headers["Authorization"] = f"Bearer {x_adx_token}"
            logger.info("🔐 Using ADX token for MCP authorization")
            forward_headers["X-ADX-Token"] = x_adx_token
        elif authorization:
            forward_headers["Authorization"] = authorization
        # Add auxiliary headers for context/compatibility
        if x_user_id:
            forward_headers["X-User-ID"] = x_user_id
        if x_session_id:
            forward_headers["X-Session-ID"] = x_session_id
        # Preserve the original caller Authorization for diagnostics or secondary use
        if authorization:
            forward_headers["X-Client-Authorization"] = authorization

        # Normalize MCP URL to avoid redirects
        mcp_url = (os.getenv("MCP_SERVER_ENDPOINT", "http://localhost:8000/mcp/"))

        # Create and connect a fresh plugin with correct headers
        new_plugin = None
        logger.info("🔧 DEBUG: Creating MCP plugin for URL: %s", mcp_url)
        logger.info("🔧 DEBUG: Available plugins - HttpMcpPlugin: %s, SseMcpPlugin: %s", 
                   HttpMcpPlugin is not None, SseMcpPlugin is not None)
        logger.info("🔧 DEBUG: Forward headers: %s", {k: v[:20] + "..." if len(str(v)) > 20 else v for k, v in forward_headers.items()})
        
        if HttpMcpPlugin:
            logger.info("🔧 DEBUG: Creating HttpMcpPlugin instance")
            new_plugin = HttpMcpPlugin(
                name="ADXTools", 
                url=mcp_url, 
                headers=forward_headers,
                load_tools=True,
                load_prompts=False,
                request_timeout=30,
                sse_read_timeout=300,
                terminate_on_close=True,
                description="ADX tools via MCP server"
            )
        elif SseMcpPlugin:
            logger.info("🔧 DEBUG: Creating SseMcpPlugin instance")
            new_plugin = SseMcpPlugin(
                name="ADXTools", 
                url=mcp_url, 
                headers=forward_headers,
                load_tools=True,
                load_prompts=False,
                request_timeout=30,
                sse_read_timeout=300,
                terminate_on_close=True,
                description="ADX tools via MCP server"
            )
        else:
            logger.error("❌ DEBUG: No MCP plugin available!")
            
        if new_plugin is not None:
            try:
                # Prefer explicit connect when available (matches legacy behavior)
                if hasattr(new_plugin, "connect"):
                    logger.info(
                        "🔌 Connecting MCP plugin to %s (auth=%s user=%s session=%s)",
                        mcp_url,
                        "yes" if ("Authorization" in forward_headers) else "no",
                        forward_headers.get("X-User-ID"),
                        forward_headers.get("X-Session-ID"),
                    )
                    logger.info("🔧 DEBUG: About to call new_plugin.connect()...")
                    
                    # Add timeout to prevent hanging
                    import asyncio
                    try:
                        await asyncio.wait_for(new_plugin.connect(), timeout=30.0)
                        logger.info("✅ DEBUG: MCP plugin connected successfully")
                    except asyncio.TimeoutError:
                        logger.error("⏰ DEBUG: MCP plugin connection timed out after 30 seconds")
                        raise Exception("MCP connection timeout after 30 seconds")
                    except Exception as timeout_err:
                        logger.error("❌ DEBUG: MCP plugin connection failed with error: %s", str(timeout_err))
                        logger.error("❌ DEBUG: Error type: %s", type(timeout_err).__name__)
                        raise
                else:
                    logger.info("🔧 DEBUG: Using __aenter__ for MCP plugin connection")
                    await asyncio.wait_for(new_plugin.__aenter__(), timeout=30.0)
                    logger.info("✅ DEBUG: MCP plugin connected via __aenter__")
                    
                # Filter tools to only allow ADX Agent tools
                allowed_tools = {
                    "kusto_debug_auth",
                    "kusto_test_connection", 
                    "kusto_check_permissions",
                    "kusto_get_auth_info",
                    "kusto_list_databases",
                    "kusto_list_tables",
                    "kusto_describe_table",
                    "kusto_query",
                    "kusto_get_cluster_info",
                    "kusto_clear_user_client_cache"
                }
                logger.info("🔧 Filtering MCP tools to only allow ADX tools...")
                for attr_name in list(dir(new_plugin)):
                    if hasattr(getattr(new_plugin, attr_name, None), '__kernel_function_parameters__'):
                        if attr_name not in allowed_tools:
                            logger.info("🚫 Removing non-ADX tool: %s", attr_name)
                            delattr(new_plugin, attr_name)
                        else:
                            logger.info("✅ Keeping ADX tool: %s", attr_name)
                            
            except Exception as conn_err:
                logger.error("❌ MCP plugin connect failed: %s", conn_err)
                logger.error("❌ DEBUG: Connection error type: %s", type(conn_err).__name__)
                logger.error("❌ DEBUG: MCP URL was: %s", mcp_url)
                logger.error("❌ DEBUG: Headers were: %s", forward_headers)
                raise
            if KERNEL:
                KERNEL.add_plugin(new_plugin)
                logger.info("✅ ADXTools plugin added to kernel")
            ADX_MCP_PLUGIN = new_plugin
            logger.info("✅ ADX_MCP_PLUGIN updated with new plugin")
    except Exception as mcp_err:
        # Do not fail the request solely due to header refresh issues
        logger.error("❌ MCP plugin refresh failed, continuing without MCP: %s", str(mcp_err))
        logger.error("❌ MCP refresh error type: %s", type(mcp_err).__name__)
        pass

    # Optionally store or use headers (authorization, user/session ids) to adjust behavior
    logger.info("💬 Setting up chat history...")
    chat = ChatHistory()
    chat.add_system_message(
        f"Context: user={x_user_id} session={x_session_id} auth={'yes' if authorization else 'no'}"
    )
    chat.add_user_message(task)
    settings = OpenAIChatPromptExecutionSettings(
        temperature=0.1,
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["ADXTools"]}
        ),
    )
    logger.info("🤖 Calling chat completion with task...")
    result = await KERNEL.get_service().get_chat_message_content(
        chat_history=chat,
        settings=settings,
        kernel=KERNEL,
    )
    content = (result.content or "").strip()
    logger.info("🎯 Processing completed, returning result: %s", content[:100] + "..." if len(content) > 100 else content)
    return {"jsonrpc": "2.0", "id": req.id, "result": {"content": content}}


async def startup():
    """Initialize the ADXAgent on startup"""
    global AGENT, KERNEL
    try:
        logger.info("🚀 ADXAgent startup: initializing agent...")
        AGENT = await build_agent()
        logger.info("✅ ADXAgent startup complete")
    except Exception as ex:
        logger.error("❌ ADXAgent startup failed: %s", ex)
        raise


def main():
    logger.info("🚀 ADX Agent main() starting...")
    port = int(os.getenv("PORT", "18082"))
    os.environ.setdefault("PUBLIC_AGENT_ENDPOINT", f"http://localhost:{port}")
    logger.info("🔧 Running on port: %s", port)
    logger.info("🔧 PUBLIC_AGENT_ENDPOINT set to: %s", os.environ.get("PUBLIC_AGENT_ENDPOINT"))
    
    # Initialize agent
    logger.info("🔄 Initializing agent...")
    asyncio.run(startup())
    
    # Start Flask app
    logger.info("🌐 Starting Flask app...")
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
