import os
import asyncio
import warnings
import sys
import threading
import concurrent.futures
from typing import Any, Dict, Optional

from flask import Flask, request, jsonify
from flask_cors import CORS
import logging
from pydantic import BaseModel

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion, OpenAIChatPromptExecutionSettings
from semantic_kernel.exceptions.service_exceptions import ServiceResponseException

# Reuse shared settings so this agent matches the main app config
try:
    from src.config.settings import settings as app_settings
except Exception:
    app_settings = None

# Try both MCP plugin names across SK versions
MCPStreamableHttpPlugin = None
try:
    from semantic_kernel.connectors.mcp import MCPStreamableHttpPlugin
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
logger = logging.getLogger("DocumentAgent")
AGENT: Optional[ChatCompletionAgent] = None
KERNEL: Optional[Kernel] = None
# Hold a reference to the MCP plugin so we can refresh headers per request
DOC_MCP_PLUGIN: Optional[Any] = None


# (No extra helpers: rely on LLM + tools as in legacy)


async def build_agent() -> ChatCompletionAgent:
    kernel = Kernel()
    kernel.add_service(
        AzureChatCompletion(
            service_id="doc_svc",
            api_key=os.getenv("AZURE_OPENAI_API_KEY"),
            endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
            deployment_name=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
            api_version=os.getenv("AZURE_OPENAI_API_VERSION", "2024-02-01"),
        )
    )
    # Defer MCP plugin connection until a request arrives so we can include per-request headers
    global DOC_MCP_PLUGIN
    DOC_MCP_PLUGIN = None

    agent = ChatCompletionAgent(
        service=kernel.get_service(),
        kernel=kernel,
        name="DocumentAgent",
        instructions=(
            "You are a document management specialist for the current user's chat session.\n\n"
            "Primary purpose: work ONLY with documents uploaded to the CURRENT session by the CURRENT user.\n"
            "You have MCP tools: DocumentTools: list_documents, search_documents, get_document, get_document_content_summary.\n\n"
            "Smart document resolution when requests are vague (e.g., 'summarize that document'):\n"
            "1) Always begin by calling list_documents() to enumerate session-scoped files (filtered by X-Session-ID and X-User-ID).\n"
            "2) If zero docs: inform the user to upload a document.\n"
            "3) If one doc: treat it as the target and proceed without asking the user for an ID.\n"
            "4) If multiple docs: prefer search_documents() to disambiguate by filename/title; ask ONE short clarifying question only if needed.\n"
            "5) After identifying the target, call get_document_content_summary(documentId) and return a concise summary.\n\n"
            "Filename rules: preserve the EXACT filename as uploaded (case/spacing).\n"
            "Critical rules: NEVER ask the user to provide a document ID; use the tools to discover it. \n"
            "Never fabricate content or documents; only use tool outputs. Keep responses concise."
        ),
        # Match legacy behavior: allow the model to choose tools with strong instructions
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["DocumentTools"]}
        ),
    )
    global KERNEL
    KERNEL = kernel
    return agent


@app.route("/.well-known/agent-card.json", methods=["GET"])
def well_known_agent_card():
    """Standard RFC 8615 well-known endpoint for A2A agent discovery"""
    base = os.getenv("PUBLIC_AGENT_ENDPOINT", "http://localhost:18081")
    return jsonify({
        "name": "DocumentAgent",
        "description": "Handles document listing/search/summarization backed by MCP DocumentTools.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": f"{base}/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": ["messages", "tasks"],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
        },
        "security": [{"bearer": []}]
    })


class RpcRequest(BaseModel):
    jsonrpc: str
    id: str
    method: str
    params: Dict[str, Any] = {}


@app.route("/a2a/message", methods=["POST"])
def a2a_message():
    try:
        req_data = request.get_json()
        req = RpcRequest(**req_data)
    except Exception as e:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": f"Invalid request: {e}"}), 400
    
    # Get headers
    authorization = request.headers.get("Authorization")
    x_user_id = request.headers.get("X-User-ID")
    x_session_id = request.headers.get("X-Session-ID")
    
    # Use shared async executor for better performance
    global _async_executor
    
    try:
        # Ensure async executor is started
        if _async_executor._loop is None:
            _async_executor.start()
        
        # Create and run the coroutine
        result = _async_executor.run_async(
            process_message(req, authorization, x_user_id, x_session_id),
            timeout=300
        )
        return jsonify(result)
    except Exception as e:
        # If there's an error, make sure any pending coroutines are properly handled
        import traceback
        error_msg = f"Request processing error: {str(e)}"
        print(f"Error in document agent: {error_msg}")
        print(f"Traceback: {traceback.format_exc()}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": error_msg}), 500


async def process_message(req: RpcRequest, authorization: Optional[str], x_user_id: Optional[str], x_session_id: Optional[str]):
    logger.info("🔄 Processing message - method: %s, user: %s, session: %s", req.method, x_user_id, x_session_id)
    
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
    # Refresh MCP plugin with per-request headers so MCP receives caller context (session/user scoping)
    try:
        logger.info("🔄 Refreshing MCP plugin connection...")
        global DOC_MCP_PLUGIN
        # Close any previous plugin/session to avoid stale headers
        if DOC_MCP_PLUGIN is not None:
            logger.info("🔄 Closing previous MCP plugin...")
            try:
                if hasattr(DOC_MCP_PLUGIN, "__aexit__"):
                    await DOC_MCP_PLUGIN.__aexit__(None, None, None)
            except Exception:
                pass
            try:
                if KERNEL:
                    KERNEL.remove_plugin("DocumentTools")
                    logger.info("🔄 DocumentTools plugin removed from kernel")
            except Exception:
                pass
            DOC_MCP_PLUGIN = None

        # Construct forwarding headers
        logger.info("🔧 Constructing forwarding headers...")
        forward_headers: Dict[str, str] = {}
        if x_user_id:
            forward_headers["X-User-ID"] = x_user_id
        if x_session_id:
            forward_headers["X-Session-ID"] = x_session_id
        if authorization:
            forward_headers["Authorization"] = authorization
            
        logger.info("🔐 Forward headers: %s", {k: v[:20] + "..." if len(str(v)) > 20 else v for k, v in forward_headers.items()})

        # Resolve MCP URL consistently with MAS settings; default matches .env MCP_SERVER_ENDPOINT
        mcp_url: str | None = None
        try:
            if app_settings and getattr(app_settings, "mcp", None):
                mcp_url = getattr(app_settings.mcp, "server_endpoint", None)
        except Exception:
            mcp_url = None
        if not mcp_url:
            mcp_url = os.getenv("MCP_SERVER_ENDPOINT", "http://localhost:8000/mcp/")

        # Create and connect a fresh plugin with correct headers
        new_plugin = None
        logger.info("🔌 Attempting MCP connection to: %s", mcp_url)
        if MCPStreamableHttpPlugin:
            try:
                new_plugin = MCPStreamableHttpPlugin(
                    name="DocumentTools",
                    url=mcp_url,
                    headers=forward_headers,
                    load_tools=True,
                    load_prompts=False,
                    request_timeout=30,
                    sse_read_timeout=300,
                    terminate_on_close=True,
                    description="Document tools via MCP server",
                )
                logger.info("✅ MCPStreamableHttpPlugin created successfully")
            except Exception as create_err:
                logger.error("❌ Failed to create MCPStreamableHttpPlugin: %s", create_err)
                new_plugin = None
        else:
            logger.error("❌ MCPStreamableHttpPlugin not available")
            
        if new_plugin is not None:
            try:
                # Connect directly like legacy MAS (no timeout wrapper that might cause CancelledError)
                logger.info("🔌 Connecting to MCP server...")
                await new_plugin.connect()
                logger.info("✅ MCP connection successful")
            except BaseException as conn_err:
                # Catch BaseException to include asyncio/anyio CancelledError
                logger.error("❌ MCP plugin connect failed (continuing without tools): %s", conn_err)
                new_plugin = None

            if new_plugin:
                # Filter tools to only the document-related ones
                allowed_tools = {
                    "list_documents",
                    "search_documents", 
                    "get_document",
                    "get_document_content_summary",
                }
                logger.info("🔧 Filtering MCP tools to document-related ones...")
                filtered_count = 0
                available_tools = []
                for attr_name in list(dir(new_plugin)):
                    try:
                        attr = getattr(new_plugin, attr_name, None)
                        if hasattr(attr, "__kernel_function_parameters__"):
                            available_tools.append(attr_name)
                            if attr_name not in allowed_tools:
                                delattr(new_plugin, attr_name)
                                filtered_count += 1
                            else:
                                logger.info("✅ Keeping document tool: %s", attr_name)
                    except Exception:
                        pass
                logger.info("🔧 Available tools: %s", available_tools)
                logger.info("🔧 Filtered out %d non-document tools", filtered_count)

            if new_plugin is not None and KERNEL:
                # Ensure plugin registered under standard name for filter behavior
                try:
                    KERNEL.add_plugin(new_plugin, plugin_name="DocumentTools")
                    logger.info("✅ DocumentTools plugin added to kernel")
                except TypeError:
                    # Older SK versions may not accept plugin_name parameter
                    KERNEL.add_plugin(new_plugin)
                    logger.info("✅ DocumentTools plugin added to kernel (legacy method)")
                DOC_MCP_PLUGIN = new_plugin
        else:
            logger.warning("⚠️ No MCP plugin available - will run without document tools")
            
        logger.info("🧰 Document tools available: %s", bool(DOC_MCP_PLUGIN))
    except Exception as mcp_err:
        # Do not fail the request solely due to header refresh issues
        logger.error("❌ MCP plugin setup failed: %s", mcp_err)
        pass

    # LLM-driven flow like legacy: strong system prompt + Auto tool choice
    logger.info("💬 Setting up chat history and system prompt...")
    chat = ChatHistory()
    base_ctx = (
        f"Context: user={x_user_id} session={x_session_id} auth={'yes' if authorization else 'no'}. "
        "Begin with list_documents(), then search_documents if needed, and finally "
        "get_document_content_summary when the target is known. Never ask the user for document IDs. "
        "Use only MCP tool outputs; do not invent documents or content."
    )
    chat.add_system_message(base_ctx)
    chat.add_user_message(task)
    settings = OpenAIChatPromptExecutionSettings()
    try:
        # Use the agent to orchestrate tool calls and responses (enables function-calling loops)
        assert AGENT is not None
        logger.info("🤖 Calling agent to process request...")
        # Provide messages list: system context + user task
        response_item = await AGENT.get_response(messages=[base_ctx, task], kernel=KERNEL)
        content = (response_item.message.content or "").strip()
        logger.info("✅ Agent response completed: %s", content[:100] + "..." if len(content) > 100 else content)
        return {"jsonrpc": "2.0", "id": req.id, "result": {"content": content}}
    except ServiceResponseException as srx:
        logger.error("❌ Azure OpenAI request failed: %s", srx)
        return {"jsonrpc": "2.0", "id": req.id, "error": f"Azure OpenAI error: {srx}"}
    except BaseException as ex:
        # Guardrail: never 500. Return a graceful fallback when unexpected cancellations/errors occur.
        logger.error("❌ Unhandled error in DocumentAgent.get_response (returning fallback): %s", ex)
        fallback = (
            "DocumentAgent encountered a transient issue. "
            "If this persists, verify the MCP endpoint and try again."
        )
        return {"jsonrpc": "2.0", "id": req.id, "result": {"content": fallback}}


async def startup():
    """Initialize the DocumentAgent on startup"""
    global AGENT, KERNEL
    try:
        logger.info("🚀 DocumentAgent startup: initializing agent...")
        AGENT = await build_agent()
        logger.info("✅ DocumentAgent startup complete")
    except Exception as ex:
        logger.error("❌ DocumentAgent startup failed: %s", ex)
        raise


def main():
    logger.info("🚀 Document Agent main() starting...")
    port = int(os.getenv("PORT", "18081"))
    os.environ.setdefault("PUBLIC_AGENT_ENDPOINT", f"http://localhost:{port}")
    logger.info("🔧 Running on port: %s", port)
    logger.info("🔧 PUBLIC_AGENT_ENDPOINT set to: %s", os.environ.get("PUBLIC_AGENT_ENDPOINT"))
    logger.info("🔧 MCP_SERVER_ENDPOINT: %s", os.getenv("MCP_SERVER_ENDPOINT", "Not set"))
    
    # Initialize agent
    logger.info("🔄 Initializing agent...")
    asyncio.run(startup())
    
    # Start Flask app
    logger.info("🌐 Starting Flask app...")
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
