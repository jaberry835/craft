import os
import asyncio
import warnings
import sys
import threading
import concurrent.futures
from typing import Any, Dict, Optional

from flask import Flask, request, jsonify
from flask_cors import CORS
from pydantic import BaseModel

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion, OpenAIChatPromptExecutionSettings

HttpMcpPlugin = None

try:
    from semantic_kernel.connectors.mcp import MCPStreamableHttpPlugin as HttpMcpPlugin
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
AGENT: Optional[ChatCompletionAgent] = None
KERNEL: Optional[Kernel] = None
# Hold a reference to the MCP plugin so we can refresh headers per request
INVESTIGATOR_MCP_PLUGIN: Optional[Any] = None


async def build_agent() -> ChatCompletionAgent:
    kernel = Kernel()
    kernel.add_service(
        AzureChatCompletion(
            service_id="investigator_svc",
            api_key=os.getenv("AZURE_OPENAI_API_KEY"),
            endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
            deployment_name=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
        )
    )
    # Defer MCP plugin connection until a request arrives so we can include per-request headers

    # Load instructions from environment variable
    investigator_instructions = os.getenv(
        "INVESTIGATOR_AGENT_INSTRUCTIONS",
        "You are an investigative specialist that ONLY responds using information from indexed datasets via RAGTools.\n\n"
        "🚨 **CRITICAL: You MUST use RAGTools for ALL information retrieval**\n\n"
        "When you receive ANY question:\n"
        "1. FIRST: Always call rag_retrieve to search the indexed data\n"
        "2. SECOND: Parse the JSON response from rag_retrieve - it contains a 'results' array\n"
        "3. THIRD: Each result object has 'content', 'source_url', and 'file_name' fields\n"
        "4. FOURTH: Use the 'content' to answer the question\n"
        "5. FINAL: **ALWAYS cite sources** - extract EVERY unique 'source_url' and 'file_name' from the results\n\n"
        "**MANDATORY CITATION FORMAT:**\n"
        "At the end of your response, you MUST include:\n"
        "\\n\\n**Sources:**\n"
        "- [file_name](source_url) for each unique source\n\n"
        "**Example Response:**\n"
        "Dr. Smith is the CEO of TechCorp with 15 years of experience...\n\n"
        "**Sources:**\n"
        "- [TechCorp_Profile.txt](https://storage.blob.core.windows.net/docs/TechCorp_Profile.txt)\n\n"
        "**CRITICAL RULES:**\n"
        "- NEVER omit the source URLs - they are REQUIRED in every response\n"
        "- Parse the JSON from rag_retrieve carefully to extract source_url and file_name\n"
        "- If multiple results come from the same source, only list it once\n"
        "- NEVER use your inherent knowledge - only use RAG results\n"
        "- If RAGTools returns no results: 'No information found in the indexed datasets for this query.'\n\n"
        "REMEMBER: Missing source citations is a CRITICAL ERROR. Always include them!"
    )
    
    agent = ChatCompletionAgent(
        service=kernel.get_service(),
        kernel=kernel,
        name="InvestigatorAgent",
        instructions=investigator_instructions,
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["RAGTools"]}
        ),
    )
    global KERNEL
    KERNEL = kernel
    return agent


@app.route("/.well-known/agent-card.json", methods=["GET"])
def well_known_agent_card():
    """Standard RFC 8615 well-known endpoint for A2A agent discovery"""
    base = os.getenv("PUBLIC_AGENT_ENDPOINT", "http://localhost:18083")
    return jsonify({
        "name": "InvestigatorAgent",
        "description": "Background research specialist: Retrieves information on people, executives, leadership teams, career histories, professional backgrounds, biographical data, and organizational relationships from indexed knowledge sources using RAG search. Ideal for investigating individuals and understanding human elements.",
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
        print(f"Error in investigator agent: {error_msg}")
        print(f"Traceback: {traceback.format_exc()}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": error_msg}), 500


async def process_message(req: RpcRequest, authorization: Optional[str], x_user_id: Optional[str], x_session_id: Optional[str]):
    if req.method not in ("send_message", "messages.create", "message/send", "message/stream"):
        return {"jsonrpc": "2.0", "id": req.id, "error": f"Unsupported method {req.method}"}
    task = req.params.get("task") or ""
    if not task:
        return {"jsonrpc": "2.0", "id": req.id, "error": "Missing 'task' param"}

    assert AGENT is not None
    from semantic_kernel.contents import ChatHistory
    
    # Refresh MCP plugin with per-request headers so MCP receives caller context
    try:
        global INVESTIGATOR_MCP_PLUGIN
        # Close any previous plugin/session to avoid stale headers
        if INVESTIGATOR_MCP_PLUGIN is not None:
            try:
                if hasattr(INVESTIGATOR_MCP_PLUGIN, "__aexit__"):
                    await INVESTIGATOR_MCP_PLUGIN.__aexit__(None, None, None)
            except Exception:
                pass
            try:
                if KERNEL:
                    KERNEL.remove_plugin("RAGTools")
            except Exception:
                pass
            INVESTIGATOR_MCP_PLUGIN = None

        # Construct forwarding headers
        forward_headers: Dict[str, str] = {}
        if x_user_id:
            forward_headers["X-User-ID"] = x_user_id
        if x_session_id:
            forward_headers["X-Session-ID"] = x_session_id
        if authorization:
            forward_headers["Authorization"] = authorization

        # Create fresh MCP plugin with current headers
        mcp_url = os.getenv("MCP_SERVER_ENDPOINT", "http://localhost:8000/mcp/")
        new_plugin = None
        new_plugin = HttpMcpPlugin(
            name="RAGTools", 
            url=mcp_url, 
            headers=forward_headers,
            load_tools=True,
            load_prompts=False,
            request_timeout=30,
            sse_read_timeout=300,
            terminate_on_close=True,
            description="RAG tools via MCP server"
        )

        if new_plugin is not None:
            await new_plugin.__aenter__()
            
            # Filter tools to only allow Investigator Agent tools
            allowed_tools = {
                "rag_retrieve",
                "rag_rag_answer", 
                "rag_health"
            }
            for attr_name in list(dir(new_plugin)):
                if hasattr(getattr(new_plugin, attr_name, None), '__kernel_function_parameters__'):
                    if attr_name not in allowed_tools:
                        delattr(new_plugin, attr_name)
            
            if KERNEL:
                # Ensure plugin registered under standard name for filter behavior
                try:
                    KERNEL.add_plugin(new_plugin, plugin_name="RAGTools")
                except TypeError:
                    # Older SK versions may not accept plugin_name parameter
                    KERNEL.add_plugin(new_plugin)
                INVESTIGATOR_MCP_PLUGIN = new_plugin
    except Exception:
        # Do not fail the request solely due to header refresh issues
        pass

    chat = ChatHistory()
    chat.add_system_message(
        f"Context: user={x_user_id} session={x_session_id} auth={'yes' if authorization else 'no'}"
    )
    chat.add_user_message(task)
    settings = OpenAIChatPromptExecutionSettings(
        temperature=0.1,
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["RAGTools"]}
        ),
    )
    result = await KERNEL.get_service().get_chat_message_content(
        chat_history=chat,
        settings=settings,
        kernel=KERNEL,
    )
    content = (result.content or "").strip()
    return {"jsonrpc": "2.0", "id": req.id, "result": {"content": content}}


async def startup():
    """Initialize the InvestigatorAgent on startup"""
    global AGENT, KERNEL
    try:
        AGENT = await build_agent()
    except Exception as ex:
        raise


def main():
    port = int(os.getenv("PORT", "18083"))
    os.environ.setdefault("PUBLIC_AGENT_ENDPOINT", f"http://localhost:{port}")
    # Initialize agent
    asyncio.run(startup())
    # Start Flask app
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
