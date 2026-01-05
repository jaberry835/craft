# A2A Agent Development Guide

## Adding New Agent-to-Agent (A2A) Agents to the Multi-Agent System

This guide walks through creating a new A2A agent that can be deployed independently and integrated with the main multi-agent system.

## 📋 Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step-by-Step Implementation](#step-by-step-implementation)
4. [Testing Your Agent](#testing-your-agent)
5. [Deployment](#deployment)
6. [Integration with Main System](#integration-with-main-system)
7. [Troubleshooting](#troubleshooting)

## 🎯 Overview

A2A agents in this system are independent Flask services that:
- Expose standardized A2A endpoints (`/a2a/card` and `/a2a/message`)
- Use Semantic Kernel with specialized instructions
- Connect to MCP (Model Context Protocol) servers for tool access
- Can be deployed independently to Azure App Service
- Are automatically discovered by the main multi-agent router

## 🔧 Prerequisites

- Python 3.13+
- Azure CLI installed and logged in
- Access to Azure OpenAI service
- Understanding of Flask, Semantic Kernel, and MCP
- PowerShell (for deployment scripts)

## 🚀 Step-by-Step Implementation

### 1. Create the Agent Service File

Create a new file: `PythonAPI/src/remote_agents/{your_agent_name}_agent_service.py`

```python
import os
import asyncio
import warnings
import sys
from typing import Any, Dict, Optional

from flask import Flask, request, jsonify
from flask_cors import CORS
import logging
from pydantic import BaseModel

# Add parent directory to path for imports when running directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion, OpenAIChatPromptExecutionSettings

# MCP Plugin imports (optional - for tool access)
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

logger = logging.getLogger("YourAgentNameAgent")

# Log startup information for Application Insights
logger.info("🚀 YourAgentName Agent starting up...")
logger.info("🔧 Environment: AZURE_OPENAI_ENDPOINT=%s", os.getenv("AZURE_OPENAI_ENDPOINT", "Not set"))
logger.info("🔧 Environment: AZURE_OPENAI_DEPLOYMENT=%s", os.getenv("AZURE_OPENAI_DEPLOYMENT", "Not set"))
logger.info("🔧 Environment: PUBLIC_AGENT_ENDPOINT=%s", os.getenv("PUBLIC_AGENT_ENDPOINT", "Not set"))

AGENT: Optional[ChatCompletionAgent] = None
KERNEL: Optional[Kernel] = None
# Hold a reference to the MCP plugin so we can refresh headers per request
YOUR_AGENT_MCP_PLUGIN: Optional[Any] = None


async def build_agent() -> ChatCompletionAgent:
    kernel = Kernel()
    kernel.add_service(
        AzureChatCompletion(
            service_id="your_agent_svc",
            api_key=os.getenv("AZURE_OPENAI_API_KEY"),
            endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
            deployment_name=os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
        )
    )
    # Defer MCP plugin connection until a request arrives so we can include per-request headers
    global YOUR_AGENT_MCP_PLUGIN
    YOUR_AGENT_MCP_PLUGIN = None

    agent = ChatCompletionAgent(
        service=kernel.get_service(),
        kernel=kernel,
        name="YourAgentNameAgent",
        instructions=(
            "You are a [DOMAIN] specialist agent. You ONLY respond to [SPECIFIC DOMAIN] questions.\n\n"
            "🚨 **CRITICAL: YOUR SPECIFIC INSTRUCTIONS HERE**\n\n"
            "When you receive ANY task related to [YOUR DOMAIN]:\n"
            "1. FIRST STEP: [specific_tool_call()]\n"
            "2. SECOND STEP: [another_tool_call()]\n"
            "3. FINAL STEP: [process_and_respond()]\n\n"
            "**YOUR AVAILABLE TOOLS:**\n"
            "- tool_name_1() - Description\n"
            "- tool_name_2() - Description\n\n"
            "⚡ **CRITICAL RULES:**\n"
            "1. Always validate inputs\n"
            "2. Use exact tool responses\n"
            "3. Provide clear, actionable answers\n"
        ),
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["YourMcpToolsPlugin"]}
        ),
    )
    global KERNEL
    KERNEL = kernel
    return agent


@app.route("/a2a/card", methods=["GET"])
def agent_card():
    logger.info("📋 A2A card request received")
    return jsonify({
        "name": "YourAgentNameAgent",
        "description": "Your agent description - what domain it specializes in and what tools it uses.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": os.getenv("PUBLIC_AGENT_ENDPOINT", "http://localhost:18085") + "/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": [
            "your-domain-query",
            "your-domain-analysis",
            "your-domain-processing"
        ]
    })


# RPC request model
class RpcRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: Optional[str] = None
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
    x_your_token = request.headers.get("X-Your-Token")  # If you need special tokens
    
    logger.info("🔐 Request headers - User: %s, Session: %s, Your Token: %s, Auth: %s", 
               x_user_id, x_session_id, "SET" if x_your_token else "NOT SET", "SET" if authorization else "NOT SET")
    
    # Run async function in event loop
    logger.info("⚡ Starting async message processing...")
    result = asyncio.run(process_message(req, authorization, x_user_id, x_session_id, x_your_token))
    logger.info("✅ Message processing completed: %s", result)
    return jsonify(result)


async def process_message(req: RpcRequest, authorization: Optional[str], x_user_id: Optional[str], x_session_id: Optional[str], x_your_token: Optional[str]):
    logger.info("🔄 Starting process_message - method: %s, id: %s", req.method, req.id)
    
    if req.method not in ("send_message", "messages.create"):
        logger.error("❌ Unsupported method: %s", req.method)
        return {"jsonrpc": "2.0", "id": req.id, "error": f"Unsupported method {req.method}"}
    
    task = req.params.get("task") or ""
    if not task:
        logger.error("❌ Missing task parameter")
        return {"jsonrpc": "2.0", "id": req.id, "error": "Missing 'task' param"}
    
    logger.info("📝 Processing task: %s", task[:100] + "..." if len(task) > 100 else task)

    assert AGENT is not None
    from semantic_kernel.contents import ChatHistory

    # Optional: Refresh MCP plugin with per-request headers
    try:
        logger.info("🔄 Refreshing MCP plugin with request headers...")
        global YOUR_AGENT_MCP_PLUGIN
        
        # Close any previous plugin/session to avoid stale headers
        if YOUR_AGENT_MCP_PLUGIN is not None:
            logger.info("🔄 Closing previous MCP plugin...")
            try:
                if hasattr(YOUR_AGENT_MCP_PLUGIN, "__aexit__"):
                    await YOUR_AGENT_MCP_PLUGIN.__aexit__(None, None, None)
                    logger.info("🔄 Previous MCP plugin closed via __aexit__")
            except Exception as e:
                logger.warning("⚠️ Error closing previous MCP plugin: %s", str(e))
                pass
            try:
                if KERNEL:
                    KERNEL.remove_plugin("YourMcpToolsPlugin")
                    logger.info("🔄 YourMcpToolsPlugin plugin removed from kernel")
            except Exception as e:
                logger.warning("⚠️ Error removing YourMcpToolsPlugin plugin: %s", str(e))
                pass
            YOUR_AGENT_MCP_PLUGIN = None
            logger.info("🔄 YOUR_AGENT_MCP_PLUGIN reset to None")

        # Construct forwarding headers
        logger.info("🔧 Constructing forwarding headers...")
        forward_headers: Dict[str, str] = {}
        
        # Include authentication
        if authorization:
            forward_headers["Authorization"] = authorization
            logger.info("🔐 Using authorization header for MCP")
            
        # Include session context
        if x_user_id:
            forward_headers["X-User-ID"] = x_user_id
        if x_session_id:
            forward_headers["X-Session-ID"] = x_session_id
        if x_your_token:
            forward_headers["X-Your-Token"] = x_your_token

        # Create MCP URL - replace with your MCP server URL
        mcp_url = os.getenv("MCP_TOOLS_URL", "https://your-mcp-server.azurewebsites.us/mcp/")
        
        # Create and connect a fresh plugin with correct headers
        new_plugin = None
        logger.info("🔧 DEBUG: Creating MCP plugin for URL: %s", mcp_url)
        logger.info("🔧 DEBUG: Available plugins - HttpMcpPlugin: %s, SseMcpPlugin: %s", 
                   HttpMcpPlugin is not None, SseMcpPlugin is not None)
        logger.info("🔧 DEBUG: Forward headers: %s", {k: v[:20] + "..." if len(str(v)) > 20 else v for k, v in forward_headers.items()})
        
        if HttpMcpPlugin:
            logger.info("🔧 DEBUG: Creating HttpMcpPlugin instance")
            new_plugin = HttpMcpPlugin(name="YourMcpToolsPlugin", url=mcp_url, headers=forward_headers)
        elif SseMcpPlugin:
            logger.info("🔧 DEBUG: Creating SseMcpPlugin instance")
            new_plugin = SseMcpPlugin(name="YourMcpToolsPlugin", url=mcp_url, headers=forward_headers)
        else:
            logger.error("❌ DEBUG: No MCP plugin available!")
            
        if new_plugin is not None:
            try:
                # Prefer explicit connect when available
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
            except Exception as conn_err:
                logger.error("❌ MCP plugin connect failed: %s", conn_err)
                logger.error("❌ DEBUG: Connection error type: %s", type(conn_err).__name__)
                logger.error("❌ DEBUG: MCP URL was: %s", mcp_url)
                logger.error("❌ DEBUG: Headers were: %s", forward_headers)
                raise
            if KERNEL:
                KERNEL.add_plugin(new_plugin)
                logger.info("✅ YourMcpToolsPlugin plugin added to kernel")
            YOUR_AGENT_MCP_PLUGIN = new_plugin
            logger.info("✅ YOUR_AGENT_MCP_PLUGIN updated with new plugin")
    except Exception as mcp_err:
        # Do not fail the request solely due to header refresh issues
        logger.error("❌ MCP plugin refresh failed, continuing without MCP: %s", str(mcp_err))
        logger.error("❌ MCP refresh error type: %s", type(mcp_err).__name__)
        pass

    # Process the message
    logger.info("💬 Setting up chat history...")
    chat = ChatHistory()
    chat.add_system_message(
        f"Context: user={x_user_id} session={x_session_id} auth={'yes' if authorization else 'no'}"
    )
    chat.add_user_message(task)
    settings = OpenAIChatPromptExecutionSettings(
        temperature=0.1,
        function_choice_behavior=FunctionChoiceBehavior.Auto(
            filters={"included_plugins": ["YourMcpToolsPlugin"]}
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
    """Initialize the YourAgentNameAgent on startup"""
    global AGENT, KERNEL
    try:
        logger.info("🚀 YourAgentNameAgent startup: initializing agent...")
        AGENT = await build_agent()
        logger.info("✅ YourAgentNameAgent startup complete")
    except Exception as ex:
        logger.error("❌ YourAgentNameAgent startup failed: %s", ex)
        raise


def main():
    logger.info("🚀 YourAgentName Agent main() starting...")
    port = int(os.getenv("PORT", "18085"))  # Use unique port
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
```

### 2. Create the WSGI Entry Point

Create a new file: `PythonAPI/src/remote_agents/{your_agent_name}_agent_wsgi.py`

```python
"""
WSGI entry point for YourAgentNameAgent service.
Follows the same pattern as the main API's wsgi.py file.
"""

import asyncio
import logging
from src.remote_agents.your_agent_name_agent_service import app, startup

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("YourAgentNameAgent.WSGI")

# Initialize the agent on startup
try:
    asyncio.run(startup())
    logger.info("✅ YourAgentNameAgent initialized for WSGI deployment")
except Exception as e:
    logger.error("❌ Failed to initialize YourAgentNameAgent for WSGI: %s", e)
    raise

# WSGI application entry point
application = app

if __name__ == "__main__":
    # For local testing
    import os
    port = int(os.getenv("PORT", "18085"))  # Use unique port
    app.run(host="0.0.0.0", port=port, debug=False)
```

### 3. Create the Deployment Script

Create a new file: `deploy-{your_agent_name}agent.ps1`

```powershell
# Azure App Service Deployment Script for Your Agent
# PowerShell version for Windows

param(
    [string]$AppName = "",
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$PythonVersion = "3.13"
)

# Color functions for output
function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Blue }
function Write-Success { param([string]$Message) Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
function Write-Warning { param([string]$Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Error { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

# Function to check prerequisites
function Test-Prerequisites {
    Write-Info "Checking prerequisites..."
        
    # Check if user is logged in to Azure
    try {
        az account show --query "name" --output tsv | Out-Null
    }
    catch {
        Write-Error "You are not logged in to Azure. Please run: az login"
        exit 1
    }
        
    Write-Success "Prerequisites check passed!"
}

# Function to get deployment configuration
function Get-DeploymentConfig {
    Write-Info "Setting up YourAgentNameAgent deployment configuration..."
    
    if ([string]::IsNullOrEmpty($AppName)) {
        $AppName = Read-Host "Enter your YourAgentNameAgent App Service name (e.g., Agent-YourAgentName)"
    }
    
    if ([string]::IsNullOrEmpty($ResourceGroup)) {
        $ResourceGroup = Read-Host "Enter your Azure Resource Group name"
    }
    
    if ([string]::IsNullOrEmpty($Location)) {
        $Location = "East US"
    }
    
    Write-Host ""
    Write-Info "YourAgentNameAgent Deployment Configuration:"
    Write-Host "  App Name: $AppName"
    Write-Host "  Resource Group: $ResourceGroup"
    Write-Host "  Location: $Location"
    Write-Host "  Python Version: $PythonVersion"
    Write-Host "  Startup Command: gunicorn src.remote_agents.your_agent_name_agent_wsgi:application"
    Write-Host ""
    
    $confirm = Read-Host "Continue with deployment? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Warning "Deployment cancelled by user"
        exit 0
    }
    
    return @{
        AppName = $AppName
        ResourceGroup = $ResourceGroup
        Location = $Location
        PythonVersion = $PythonVersion
    }
}

# Function to set environment variables
function Set-EnvironmentVariables {
    param([hashtable]$Config)
    
    Write-Info "Setting environment variables..."
    
    # Set the startup command to use gunicorn with correct module path
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --startup-file "gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 300 --keep-alive 75 --no-sendfile --max-requests 1000 --max-requests-jitter 50 --access-logfile - --error-logfile - src.remote_agents.your_agent_name_agent_wsgi:application"
    
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to set startup command, trying alternative approach..."
        # Try setting via app settings as fallback with correct module path
        az webapp config appsettings set `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --settings `
            STARTUP_COMMAND="gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 300 --keep-alive 75 --no-sendfile --max-requests 1000 --max-requests-jitter 50 --access-logfile - --error-logfile - src.remote_agents.your_agent_name_agent_wsgi:application"
    }
    
    # Set Python version and build settings
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --linux-fx-version "PYTHON|$($Config.PythonVersion)"
    
    # Force Python app detection and dependency installation
    az webapp config appsettings set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --settings `
        SCM_DO_BUILD_DURING_DEPLOYMENT="true" `
        ENABLE_ORYX_BUILD="true" `
        BUILD_FLAGS="UseAppInsights=false" `
        PYTHONPATH="/home/site/wwwroot"
}

# Function to deploy the application
function Deploy-Application {
    param([hashtable]$Config)
    
    Write-Info "Deploying application to Azure App Service..."
    
    try {
        # Create deployment zip from PythonAPI contents
        Write-Info "Creating deployment package from PythonAPI contents..."
        $zipPath = "deploy.zip"
        $fullZipPath = Join-Path (Get-Location) $zipPath
        
        if (Test-Path $fullZipPath) {
            Remove-Item $fullZipPath -Force
        }
        
        # Verify required files exist
        if (!(Test-Path "PythonAPI\main.py")) {
            Write-Error "main.py not found in PythonAPI directory"
            exit 1
        }
        
        if (!(Test-Path "PythonAPI\requirements.txt")) {
            Write-Error "requirements.txt not found in PythonAPI directory" 
            exit 1
        }
        
        if (!(Test-Path "PythonAPI\src\remote_agents\your_agent_name_agent_wsgi.py")) {
            Write-Error "your_agent_name_agent_wsgi.py not found in PythonAPI directory" 
            exit 1
        }
        
        # Create zip with PythonAPI contents at root level
        $pythonApiPath = "PythonAPI\*"
        Compress-Archive -Path $pythonApiPath -DestinationPath $fullZipPath -Force
        
        # Deploy using az webapp deploy
        Write-Info "Uploading application to Azure..."
        az webapp deploy `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --src-path $fullZipPath `
            --type zip `
            --async false
        
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Deployment failed"
            exit 1
        }
        
        # Clean up
        if (Test-Path $fullZipPath) {
            Remove-Item $fullZipPath -Force
        }
        
        Write-Success "Application deployed successfully!"
    }
    catch {
        Write-Error "Deployment failed: $_"
        exit 1
    }
}

# Function to show post-deployment information
function Show-DeploymentInfo {
    param([hashtable]$Config)
    
    Write-Info "YourAgentNameAgent deployment completed successfully!"
    Write-Host ""
    Write-Info "Agent Information:"
    Write-Host "  App URL: https://$($Config.AppName).azurewebsites.us"
    Write-Host "  Health Check: https://$($Config.AppName).azurewebsites.us/a2a/card"
    Write-Host "  A2A Endpoint: https://$($Config.AppName).azurewebsites.us/a2a/message"
    Write-Host ""
    Write-Info "Next Steps:"
    Write-Host "1. Set your Azure service environment variables"
    Write-Host "2. Monitor logs: az webapp log tail --name $($Config.AppName) --resource-group $($Config.ResourceGroup)"
    Write-Host "3. Test your application at: https://$($Config.AppName).azurewebsites.us/a2a/card"
}

# Main deployment function
function Main {
    Write-Host "========================================================"
    Write-Host "YourAgentNameAgent Deployment Script"
    Write-Host "========================================================"
    
    # Check prerequisites
    Test-Prerequisites
    
    # Get deployment configuration
    $config = Get-DeploymentConfig
    
    # Set environment variables
    Set-EnvironmentVariables -Config $config
    
    # Deploy application
    Deploy-Application -Config $config
    
    # Show deployment info
    Show-DeploymentInfo -Config $config
}

# Run main function
Main
```

### 6. Update Environment Configuration

Add your agent's URL to the `.env` file:

```bash
# Add to PythonAPI/.env
YOUR_AGENT_NAME_AGENT_URL=https://agent-youragentname.azurewebsites.us
# For local testing:
# YOUR_AGENT_NAME_AGENT_URL=http://localhost:18085
```

**Important**: The environment variable name must follow the pattern `*_AGENT_URL` for automatic discovery to work.

### 5. Update Core System Files

You need to update two core system files to integrate your new agent:

#### A. Update `src/agents/mas_a2a.py`

Add your agent URL to the specialist URLs list:

```python
def __init__(self, azure_openai_api_key: str, azure_openai_endpoint: str, azure_openai_deployment: str):
    self.host = RoutingHost(
        azure_api_key=azure_openai_api_key,
        azure_endpoint=azure_openai_endpoint,
        azure_deployment=azure_openai_deployment,
    )
    self.specialist_urls: List[str] = [
        os.getenv("DOCUMENT_AGENT_URL", "http://localhost:18081"),
        os.getenv("ADX_AGENT_URL", "http://localhost:18082"),
        os.getenv("INVESTIGATOR_AGENT_URL", "http://localhost:18083"),
        os.getenv("FICTIONAL_COMPANIES_AGENT_URL", "http://localhost:18084"),
        os.getenv("YOUR_AGENT_NAME_AGENT_URL", "http://localhost:18085"),  # Add this line
    ]
```

#### B. Update `src/a2a/host_router.py`

Add your agent's capabilities to the router instructions. Find the `_router_instructions` method and update the "AGENT CAPABILITIES" section:

```python
def _router_instructions(self) -> str:
    return (
        "You are an intelligent routing and orchestration agent. Analyze user queries carefully and choose the optimal approach:\n\n"
        
        "AGENT CAPABILITIES:\n"
        "• DocumentAgent: Document analysis, file reading, text extraction, summarization, finding information in uploaded files\n"
        "• ADXAgent: Azure Data Explorer queries, KQL, database searches, scan data, security logs, telemetry analysis\n" 
        "• InvestogatorAgent: Investigative RAG specialist. Use RAGTools to search datasets, retrieve docs, and cite sources from indexed data.\n"
        "• FictionalCompaniesAgent: Company information, IP address ownership, business intelligence, fictional company data\n"
        "• YourAgentNameAgent: [Your domain description] - [specific capabilities]\n\n"  # Add this line
        
        # ... rest of instructions
    )
```

Also add collaboration patterns for your agent in the "COLLABORATION PATTERNS" section:

```python
"3. COLLABORATION PATTERNS:\n"
"   - Document → ADX: Extract info from docs, then query database\n"
"   - Document → Company: Find IPs/companies in docs, then get business intel\n"
"   - ADX → Company: Find IPs in scans, then identify owners\n"
"   - Document → YourAgentName: Extract data from docs, then process with your domain tools\n"  # Add patterns like this
"   - ADX → YourAgentName: Get data from database, then analyze with your domain expertise\n"  # Add patterns like this
"   - Multiple sources: Gather data from 2+ agents for comprehensive analysis\n\n"
```

## 🧪 Testing Your Agent

### Local Testing

1. **Start your agent locally:**
   ```bash
   cd PythonAPI
   python src/remote_agents/your_agent_name_agent_service.py
   ```

2. **Test the agent card endpoint:**
   ```bash
   curl http://localhost:18085/a2a/card
   ```

3. **Test the message endpoint:**
   ```bash
   curl -X POST http://localhost:18085/a2a/message \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "id": "test",
       "method": "send_message", 
       "params": {"task": "test message for your agent"}
     }'
   ```

### Integration Testing

1. **Start the main API with your local agent URL:**
   ```bash
   # In PythonAPI/.env
   YOUR_AGENT_NAME_AGENT_URL=http://localhost:18085
   
   # Start main API
   cd PythonAPI
   python main.py
   ```

2. **Test through the main system:**
   Use the web interface to ask questions that should route to your agent.

## 🚀 Deployment

### Deploy to Azure

1. **Run the deployment script:**
   ```powershell
   .\deploy-youragentname.ps1 -AppName Agent-YourAgentName -ResourceGroup YourResourceGroup
   ```

2. **Set environment variables in Azure:**
   ```bash
   az webapp config appsettings set \
     --name Agent-YourAgentName \
     --resource-group YourResourceGroup \
     --settings \
     AZURE_OPENAI_API_KEY="your-key" \
     AZURE_OPENAI_ENDPOINT="your-endpoint" \
     AZURE_OPENAI_DEPLOYMENT="gpt-4o" \
     MCP_TOOLS_URL="https://your-mcp-server.azurewebsites.us/mcp/" \
     PUBLIC_AGENT_ENDPOINT="https://agent-youragentname.azurewebsites.us"
   ```

3. **Update main system configuration:**
   ```bash
   # Update main API environment
   YOUR_AGENT_NAME_AGENT_URL=https://agent-youragentname.azurewebsites.us
   ```

## 🔗 Integration with Main System

### Router Discovery Process

The main system uses automatic agent discovery:

1. **Environment Variable Scanning**: The system scans for environment variables ending in `_AGENT_URL`
2. **Agent Card Fetching**: For each URL found, it calls `/a2a/card` to get agent metadata
3. **Registration**: Agents are automatically registered in the router's agent list
4. **Capability Integration**: Agent descriptions and capabilities are integrated into the router's instructions

### Routing Intelligence

The router (`host_router.py`) analyzes user queries and decides:
- **Direct delegation**: Simple single-agent tasks
- **Multi-agent collaboration**: Complex tasks requiring multiple specialists
- **Direct response**: General questions the router can answer without delegation

### Collaboration Workflows

Your agent can participate in multi-agent workflows:

```python
# Example collaboration patterns:
"Multi-step analysis example:\n"
"- For document + your-domain analysis: DocumentAgent → YourAgentNameAgent\n"
"- For data + your-domain queries: ADXAgent → YourAgentNameAgent\n"
"- For comprehensive analysis: YourAgentNameAgent → Other specialists\n"
```

The router automatically coordinates these workflows using the `collaborate_agents` function.

## 🐛 Troubleshooting

### Common Issues

1. **Module Import Errors:**
   - Ensure WSGI file has correct module path
   - Check Python path configuration in deployment

2. **MCP Connection Timeouts:**
   - Verify MCP server URL is accessible
   - Check authentication headers are forwarded correctly
   - Review Azure networking settings

3. **Agent Not Discovered:**
   - Verify environment variable naming convention (`*_AGENT_URL`)
   - Check agent card endpoint returns valid JSON
   - Ensure agent is accessible from main system

4. **Deployment Failures:**
   - Verify all required files are included in deployment zip
   - Check Azure CLI authentication
   - Review application logs in Azure portal

### Debugging Tips

1. **Enable detailed logging:**
   ```python
   logging.basicConfig(level=logging.DEBUG)
   ```

2. **Test endpoints manually:**
   ```bash
   # Test card endpoint
   curl https://your-agent.azurewebsites.us/a2a/card
   
   # Test message endpoint
   curl -X POST https://your-agent.azurewebsites.us/a2a/message \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":"1","method":"send_message","params":{"task":"test"}}'
   ```

3. **Monitor Azure logs:**
   ```bash
   az webapp log tail --name YourAgentName --resource-group YourResourceGroup
   ```

## 📚 Additional Resources

- [Semantic Kernel Documentation](https://learn.microsoft.com/en-us/semantic-kernel/)
- [Model Context Protocol (MCP) Specification](https://modelcontextprotocol.io/)
- [Azure App Service Python Documentation](https://docs.microsoft.com/en-us/azure/app-service/quickstart-python)
- [Flask Documentation](https://flask.palletsprojects.com/)

## 🎉 Conclusion

Following this guide, you should be able to:
- Create a new A2A agent with proper structure
- Deploy it independently to Azure
- Integrate it with the main multi-agent system
- Test and debug the agent functionality

Your agent will automatically be discovered and can participate in multi-agent workflows, providing specialized domain expertise to the overall system.



## sample deployment calls:

.\deploy.ps1 -AppServiceName Rude-MCP -ResourceGroup AOAI -SubscriptionId c7e4423a-e570-4786-928d-787dc160b027

.\deploy.ps1 -AppName Agent-A2A -ResourceGroup AOAI
.\deploy-investigatoragent.ps1 -AppName Agent-FEMA -ResourceGroup AOAI
.\deploy-fictionalcompaniesagent.ps1 -AppName Agent-FictionalApi -ResourceGroup AOAI
.\deploy-documentagent.ps1 -AppName Agent-Documents -ResourceGroup AOAI
.\deploy-adxagent.ps1 -AppName Agent-ADX -ResourceGroup AOAI
