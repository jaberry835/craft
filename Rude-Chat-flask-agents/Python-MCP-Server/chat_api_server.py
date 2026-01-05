#!/usr/bin/env python3
"""
Flask-SocketIO Chat API Server with CosmosDB integration and MCP tools
"""

import json
import logging
import uuid
import os
import asyncio
import threading
import io
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from flask import Flask, request, jsonify, make_response, send_from_directory, send_file
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosResourceNotFoundError

# Configure Application Insights first (before other logging)
try:
    from opencensus.ext.azure.log_exporter import AzureLogHandler
    from opencensus.ext.azure.trace_exporter import AzureExporter
    from opencensus.ext.flask.flask_middleware import FlaskMiddleware
    from opencensus.trace.samplers import ProbabilitySampler
    
    # Application Insights connection string from environment
    app_insights_connection_string = os.environ.get('APPLICATIONINSIGHTS_CONNECTION_STRING')
    app_insights_instrumentation_key = os.environ.get('APPINSIGHTS_INSTRUMENTATIONKEY')
    
    appinsights_available = bool(app_insights_connection_string or app_insights_instrumentation_key)
    
    if appinsights_available:
        print(f"Application Insights configured with connection string: {bool(app_insights_connection_string)}")
        print(f"Application Insights configured with instrumentation key: {bool(app_insights_instrumentation_key)}")
    else:
        print("Application Insights not configured - no connection string or instrumentation key found")
        
except ImportError as e:
    print(f"Application Insights modules not available: {e}")
    appinsights_available = False

# Set up logging with Application Insights integration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[]  # We'll add handlers manually to avoid duplication
)

# Get root logger and app logger
root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Add console handler for local development
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
root_logger.addHandler(console_handler)

# Add Application Insights handler if available
azure_handler = None
if appinsights_available:
    try:
        if app_insights_connection_string:
            # Use connection string (preferred method)
            azure_handler = AzureLogHandler(connection_string=app_insights_connection_string)
            print(f"Using Application Insights connection string: {app_insights_connection_string[:50]}...")
        elif app_insights_instrumentation_key:
            # Use instrumentation key (legacy method)
            azure_handler = AzureLogHandler(instrumentation_key=app_insights_instrumentation_key)
            print(f"Using Application Insights instrumentation key: {app_insights_instrumentation_key[:10]}...")
        
        if azure_handler:
            # Set formatter for Application Insights
            azure_handler.setFormatter(logging.Formatter('%(name)s - %(levelname)s - %(message)s'))
            
            # Set level to INFO to capture all INFO and above logs
            azure_handler.setLevel(logging.INFO)
            
            # Add to root logger so all loggers inherit it
            root_logger.addHandler(azure_handler)
            
            # Force immediate flush for testing
            azure_handler.flush()
            
            print("Application Insights logging handler added successfully")
            logger.info("Application Insights logging configured successfully")
        
    except Exception as e:
        print(f"Failed to configure Application Insights logging: {e}")
        logger.warning(f"Failed to configure Application Insights logging: {e}")
        appinsights_available = False

# Suppress verbose Azure SDK logging
logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("azure.core").setLevel(logging.WARNING)
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
logging.getLogger("azure.storage").setLevel(logging.WARNING)
logging.getLogger("azure.cosmos").setLevel(logging.WARNING)
logging.getLogger("azure.identity").setLevel(logging.WARNING)

# Suppress SocketIO/EngineIO verbose logging
logging.getLogger("socketio.server").setLevel(logging.WARNING)
logging.getLogger("socketio.client").setLevel(logging.WARNING)
logging.getLogger("engineio.server").setLevel(logging.WARNING)
logging.getLogger("engineio.client").setLevel(logging.WARNING)

# Suppress Werkzeug HTTP logging
logging.getLogger("werkzeug").setLevel(logging.WARNING)

# Suppress urllib3 and requests verbose logging
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("requests").setLevel(logging.WARNING)

# Also suppress werkzeug.serving specifically for dev server logs
logging.getLogger("werkzeug.serving").setLevel(logging.ERROR)

# Suppress Werkzeug (Flask dev server) verbose logging
logging.getLogger("werkzeug").setLevel(logging.WARNING)

# Initialize Flask app
app = Flask(__name__, static_folder='static', static_url_path='')
app.config['SECRET_KEY'] = 'your-secret-key-here'

# Configure Application Insights middleware for request tracing
if appinsights_available:
    try:
        # Configure Flask middleware for Application Insights
        if app_insights_connection_string:
            middleware = FlaskMiddleware(
                app,
                exporter=AzureExporter(connection_string=app_insights_connection_string),
                sampler=ProbabilitySampler(rate=1.0)  # Sample all requests
            )
        elif app_insights_instrumentation_key:
            middleware = FlaskMiddleware(
                app,
                exporter=AzureExporter(instrumentation_key=app_insights_instrumentation_key),
                sampler=ProbabilitySampler(rate=1.0)  # Sample all requests
            )
        
        logger.info("Application Insights Flask middleware configured successfully")
        
    except Exception as e:
        logger.warning(f"Failed to configure Application Insights middleware: {e}")

# Test Application Insights logging
logger.info("Flask app initialized with Application Insights integration")

# Function to flush logs and clean up
def flush_logs():
    """Flush all logging handlers to ensure logs are sent"""
    try:
        for handler in logging.getLogger().handlers:
            handler.flush()
        if azure_handler:
            azure_handler.flush()
        logger.info("Logs flushed successfully")
    except Exception as e:
        print(f"Error flushing logs: {e}")

# Function to test Application Insights logging
def test_application_insights_logging():
    """Test that Application Insights logging is working"""
    try:
        logger.info("🧪 Testing Application Insights logging - INFO level")
        logger.warning("🧪 Testing Application Insights logging - WARNING level")
        logger.error("🧪 Testing Application Insights logging - ERROR level")
        
        # Force immediate flush
        flush_logs()
        
        logger.info("✅ Application Insights logging test completed")
        
    except Exception as e:
        logger.error(f"❌ Error testing Application Insights logging: {e}")

# Set up periodic log flushing
import threading
import time

def periodic_log_flush():
    """Periodically flush logs to ensure they are sent to Application Insights"""
    while True:
        try:
            time.sleep(30)  # Flush every 30 seconds
            flush_logs()
        except Exception as e:
            print(f"Error in periodic log flush: {e}")

# Start background thread for periodic log flushing (only if Azure handler is available)
if azure_handler:
    flush_thread = threading.Thread(target=periodic_log_flush, daemon=True)
    flush_thread.start()
    logger.info("Started periodic log flushing thread")

# Register cleanup function
import atexit
atexit.register(flush_logs)

# Load configuration for CORS and other settings
def load_config():
    """Load configuration from environment variables first, then config.json"""
    config = {}
    
    # First, try to load from config.json
    try:
        config_path = os.path.join(os.path.dirname(__file__), 'config.json')
        with open(config_path, 'r') as f:
            config = json.load(f)
    except Exception as e:
        logger.info(f"No config.json found or error loading it: {e}")
    
    # Override with environment variables (Azure App Service style)
    # CosmosDB configuration
    cosmos_config = {}
    if os.environ.get('CosmosDB__Endpoint'):
        cosmos_config['Endpoint'] = os.environ['CosmosDB__Endpoint']
    if os.environ.get('CosmosDB__Key'):
        cosmos_config['Key'] = os.environ['CosmosDB__Key']
    if os.environ.get('CosmosDB__DatabaseName'):
        cosmos_config['DatabaseName'] = os.environ['CosmosDB__DatabaseName']
    if os.environ.get('CosmosDB__MessagesContainer'):
        cosmos_config['MessagesContainer'] = os.environ['CosmosDB__MessagesContainer']
    if os.environ.get('CosmosDB__SessionsContainer'):
        cosmos_config['SessionsContainer'] = os.environ['CosmosDB__SessionsContainer']
    
    if cosmos_config:
        config['CosmosDB'] = cosmos_config
    
    # CORS origins from environment or config
    if os.environ.get('CORS_ORIGINS'):
        # Parse JSON array or comma-separated string
        cors_origins_env = os.environ.get('CORS_ORIGINS')
        try:
            config['CORS_ORIGINS'] = json.loads(cors_origins_env)
        except:
            # Fallback to comma-separated string
            config['CORS_ORIGINS'] = [origin.strip() for origin in cors_origins_env.split(',')]
    
    # Azure OpenAI configuration
    if os.environ.get('AzureOpenAI__Endpoint'):
        if 'AzureOpenAI' not in config:
            config['AzureOpenAI'] = {}
        config['AzureOpenAI']['Endpoint'] = os.environ['AzureOpenAI__Endpoint']
    if os.environ.get('AzureOpenAI__ApiKey'):
        if 'AzureOpenAI' not in config:
            config['AzureOpenAI'] = {}
        config['AzureOpenAI']['ApiKey'] = os.environ['AzureOpenAI__ApiKey']
    if os.environ.get('AzureOpenAI__DeploymentName'):
        if 'AzureOpenAI' not in config:
            config['AzureOpenAI'] = {}
        config['AzureOpenAI']['DeploymentName'] = os.environ['AzureOpenAI__DeploymentName']
    
    # Azure AI Search configuration
    if os.environ.get('AzureAISearch__Endpoint'):
        if 'AzureAISearch' not in config:
            config['AzureAISearch'] = {}
        config['AzureAISearch']['Endpoint'] = os.environ['AzureAISearch__Endpoint']
    if os.environ.get('AzureAISearch__ApiKey'):
        if 'AzureAISearch' not in config:
            config['AzureAISearch'] = {}
        config['AzureAISearch']['ApiKey'] = os.environ['AzureAISearch__ApiKey']
    if os.environ.get('AzureAISearch__IndexName'):
        if 'AzureAISearch' not in config:
            config['AzureAISearch'] = {}
        config['AzureAISearch']['IndexName'] = os.environ['AzureAISearch__IndexName']
    
    # Azure Storage configuration
    if os.environ.get('AzureStorage__ConnectionString'):
        if 'AzureStorage' not in config:
            config['AzureStorage'] = {}
        config['AzureStorage']['ConnectionString'] = os.environ['AzureStorage__ConnectionString']
    if os.environ.get('AzureStorage__ContainerName'):
        if 'AzureStorage' not in config:
            config['AzureStorage'] = {}
        config['AzureStorage']['ContainerName'] = os.environ['AzureStorage__ContainerName']
    
    # Azure Data Explorer configuration
    if os.environ.get('AzureDataExplorer__ClusterUri'):
        if 'AzureDataExplorer' not in config:
            config['AzureDataExplorer'] = {}
        config['AzureDataExplorer']['ClusterUrl'] = os.environ['AzureDataExplorer__ClusterUri']
    if os.environ.get('AzureDataExplorer__DefaultDatabase'):
        if 'AzureDataExplorer' not in config:
            config['AzureDataExplorer'] = {}
        config['AzureDataExplorer']['DefaultDatabase'] = os.environ['AzureDataExplorer__DefaultDatabase']
    
    # Azure Document Intelligence configuration
    if os.environ.get('AzureDocumentIntelligence__Endpoint'):
        if 'AzureDocumentIntelligence' not in config:
            config['AzureDocumentIntelligence'] = {}
        config['AzureDocumentIntelligence']['Endpoint'] = os.environ['AzureDocumentIntelligence__Endpoint']
    if os.environ.get('AzureDocumentIntelligence__ApiKey'):
        if 'AzureDocumentIntelligence' not in config:
            config['AzureDocumentIntelligence'] = {}
        config['AzureDocumentIntelligence']['ApiKey'] = os.environ['AzureDocumentIntelligence__ApiKey']
    
    # Azure Maps configuration
    if os.environ.get('AzureMaps__SubscriptionKey'):
        if 'AzureMaps' not in config:
            config['AzureMaps'] = {}
        config['AzureMaps']['SubscriptionKey'] = os.environ['AzureMaps__SubscriptionKey']
    if os.environ.get('AzureMaps__BaseUrl'):
        if 'AzureMaps' not in config:
            config['AzureMaps'] = {}
        config['AzureMaps']['BaseUrl'] = os.environ['AzureMaps__BaseUrl']
    
    # System Prompt
    if os.environ.get('SystemPrompt'):
        config['SystemPrompt'] = os.environ['SystemPrompt']
    
    # Set CORS origins for production - add the production URL
    if not config.get('CORS_ORIGINS'):
        production_url = "https://rude-chat-python.azurewebsites.us"
        config['CORS_ORIGINS'] = [production_url, "http://localhost:4200", "https://localhost:4200"]
    
    return config

# Load configuration
config = load_config()

# Log configuration status (without sensitive data)
logger.info("Configuration loaded:")
logger.info(f"  CosmosDB Endpoint configured: {bool(config.get('CosmosDB', {}).get('Endpoint'))}")
logger.info(f"  Azure OpenAI configured: {bool(config.get('AzureOpenAI', {}).get('Endpoint'))}")
logger.info(f"  Azure AI Search configured: {bool(config.get('AzureAISearch', {}).get('Endpoint'))}")
logger.info(f"  Azure Storage configured: {bool(config.get('AzureStorage', {}).get('ConnectionString'))}")
logger.info(f"  Azure Document Intelligence configured: {bool(config.get('AzureDocumentIntelligence', {}).get('Endpoint'))}")
logger.info(f"  Azure Data Explorer configured: {bool(config.get('AzureDataExplorer', {}).get('ClusterUrl'))}")
logger.info(f"  Azure Maps configured: {bool(config.get('AzureMaps', {}).get('SubscriptionKey'))}")
logger.info(f"  System Prompt configured: {bool(config.get('SystemPrompt'))}")

# Get CORS origins from config, with fallback to localhost
cors_origins = config.get('CORS_ORIGINS', ["http://localhost:4200", "https://localhost:4200"])
logger.info(f"CORS Origins: {cors_origins}")

# Configure CORS with dynamic origins
CORS(app,
     origins=cors_origins,
     allow_headers=["Content-Type", "Authorization", "Accept", "Origin", "X-User-Token"],
     methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
     supports_credentials=True)

# Global OPTIONS handler for all preflight requests
@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        # Use the first CORS origin as the primary one, or localhost as fallback
        primary_origin = cors_origins[0] if cors_origins else "http://localhost:4200"
        response = jsonify({})
        response.headers.add("Access-Control-Allow-Origin", primary_origin)
        response.headers.add("Access-Control-Allow-Headers", "Content-Type,Authorization,X-User-Token,Accept,Origin")
        response.headers.add("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        response.headers.add("Access-Control-Allow-Credentials", "true")
        return response

# Initialize SocketIO with CORS support and Azure App Service optimizations
socketio = SocketIO(
    app,
    cors_allowed_origins=cors_origins,
    async_mode='threading',
    logger=False,  # Reduce logging verbosity in production
    engineio_logger=False,  # Reduce logging verbosity in production
    ping_timeout=60,  # Increase timeout for Azure App Service
    ping_interval=25,  # Increase ping interval
    transports=['polling', 'websocket'],  # Allow fallback to polling if WebSocket fails
    allow_upgrades=True,  # Allow upgrade from polling to WebSocket
    cookie=None  # Disable cookies for better Azure App Service compatibility
)

# CosmosDB Configuration - Already loaded config above
cosmos_config = config.get('CosmosDB', {})

# Build connection string from config
COSMOS_ENDPOINT = cosmos_config.get('Endpoint', '')
COSMOS_KEY = cosmos_config.get('Key', '')
COSMOS_DATABASE_NAME = cosmos_config.get('DatabaseName', 'ChatDatabase')
COSMOS_MESSAGES_CONTAINER = cosmos_config.get('MessagesContainer', 'Messages')
COSMOS_SESSIONS_CONTAINER = cosmos_config.get('SessionsContainer', 'Sessions')

# Build connection string
COSMOS_CONNECTION_STRING = f"AccountEndpoint={COSMOS_ENDPOINT};AccountKey={COSMOS_KEY};" if COSMOS_ENDPOINT and COSMOS_KEY else ""

# Initialize CosmosDB client
cosmos_client = None
messages_container = None
sessions_container = None

if not COSMOS_CONNECTION_STRING:
    logger.warning("❌ CosmosDB configuration not found in config.json")
    logger.warning("Chat history will not be persisted")
else:
    try:
        #logger.info(f"🔗 Connecting to CosmosDB: {COSMOS_ENDPOINT}")
        cosmos_client = CosmosClient.from_connection_string(COSMOS_CONNECTION_STRING)
        database = cosmos_client.get_database_client(COSMOS_DATABASE_NAME)
        messages_container = database.get_container_client(COSMOS_MESSAGES_CONTAINER)
        sessions_container = database.get_container_client(COSMOS_SESSIONS_CONTAINER)
        #logger.info("✅ CosmosDB client initialized successfully")
        #logger.info(f"📊 Database: {COSMOS_DATABASE_NAME}")
        #logger.info(f"📨 Messages Container: {COSMOS_MESSAGES_CONTAINER}")
        #logger.info(f"📋 Sessions Container: {COSMOS_SESSIONS_CONTAINER}")
    except Exception as e:
        logger.error(f"❌ Error initializing CosmosDB: {e}")
        logger.warning("Chat history will not be persisted")

# MCP Agent imports
from src.agents.base_agent import AgentManager
from src.agents.core_agent import CoreAgent
from src.agents.documents_agent import DocumentsAgent
from src.agents.adx_agent import ADXAgent
from src.models.mcp_models import McpToolCallRequest, McpServerInfo
from src.services.azure_document_service import AzureDocumentService

# OpenAI imports for chat completions  
import openai
from openai import AsyncAzureOpenAI

# Simple hub for managing connections and sessions
class AgentActivityHub:
    def __init__(self):
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.user_sessions: Dict[str, str] = {}  # user_id -> session_id

    def create_session(self, session_id: str, user_id: str = None):
        self.sessions[session_id] = {
            'id': session_id,
            'user_id': user_id,
            'created_at': datetime.now(timezone.utc).isoformat(),
            'participants': set(),
            'message_count': 0
        }
        if user_id:
            self.user_sessions[user_id] = session_id
        logger.info(f"Created session: {session_id} for user: {user_id}")

    def join_session(self, session_id: str, socket_id: str):
        if session_id in self.sessions:
            self.sessions[session_id]['participants'].add(socket_id)
            logger.info(f"Socket {socket_id} joined session {session_id}")
            return True
        return False

    def leave_session(self, session_id: str, socket_id: str):
        if session_id in self.sessions:
            self.sessions[session_id]['participants'].discard(socket_id)
            logger.info(f"Socket {socket_id} left session {session_id}")

    def send_agent_activity(self, session_id: str, activity_data: dict):
        """Send agent activity to all participants in a session"""
        if session_id in self.sessions:
            activity = {
                'id': activity_data.get('id', str(uuid.uuid4())),
                'agentName': activity_data.get('agentName', 'Unknown Agent'),
                'action': activity_data.get('action', 'Unknown Action'),
                'status': activity_data.get('status', 'in-progress'),
                'result': activity_data.get('result'),
                'timestamp': activity_data.get('timestamp', datetime.now(timezone.utc).isoformat()),
                'sessionId': session_id
            }
            
            # Emit to all clients in the session room
            socketio.emit('agentActivity', activity, room=session_id)
            logger.info(f"Sent agent activity to session {session_id}: {activity['agentName']} - {activity['action']}")

# Global hub instance
hub = AgentActivityHub()

# Initialize Semantic Kernel Agent Orchestrator
from src.agents.agent_orchestrator import AgentOrchestrator
agent_orchestrator = AgentOrchestrator(config, hub)

# Initialize Azure Document Service
azure_document_service = AzureDocumentService(config, sessions_container)

# Initialize agents with config
async def initialize_agents():
    """Initialize all MCP agents"""
    try:
        logger.info("🤖 Initializing MCP agents...")
        
        # Create agents
        core_agent = CoreAgent(config)
        documents_agent = DocumentsAgent(config)
        # Pass cosmos container to documents agent
        documents_agent._cosmos_sessions_container = sessions_container
        adx_agent = ADXAgent(config)
          # Register agents
        await agent_orchestrator.register_agent_async(core_agent)
        await agent_orchestrator.register_agent_async(documents_agent)
        await agent_orchestrator.register_agent_async(adx_agent)
        
        # Initialize the orchestrator (this will initialize Semantic Kernel)
        await agent_orchestrator.initialize_async()
        
        logger.info("✅ MCP agents initialized successfully")
        
        # Log available tools
        tools = await agent_orchestrator.get_all_tools_async()
        logger.info(f"🔧 Available tools: {len(tools)}")
        for tool in tools:
            logger.info(f"  - {tool.name}: {tool.description}")
            
    except Exception as e:
        logger.error(f"❌ Error initializing MCP agents: {e}")

# Initialize OpenAI client
openai_client = None
try:
    openai_config = config.get('AzureOpenAI', {})
    if openai_config.get('Endpoint') and openai_config.get('ApiKey'):
        openai_client = AsyncAzureOpenAI(
            azure_endpoint=openai_config.get('Endpoint'),
            api_key=openai_config.get('ApiKey'),
            api_version=openai_config.get('ApiVersion', '2024-02-01'),
        )
        logger.info("✅ OpenAI client initialized successfully")
        
        # Test Application Insights logging after services are initialized
        if appinsights_available:
            logger.info("🧪 Testing Application Insights logging after service initialization...")
            test_application_insights_logging()
            
    else:
        logger.warning("❌ Azure OpenAI configuration not found in config.json")
        logger.warning("Chat completions will not be available")
except Exception as e:
    logger.error(f"❌ Error initializing OpenAI client: {e}")

# Initialize agents when the module loads

def initialize_agents_sync():
    """Synchronous wrapper for agent initialization"""
    try:
        logger.info("🔄 Starting agent initialization...")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(initialize_agents())
        loop.close()
        logger.info("✅ Agent initialization completed successfully")
    except Exception as e:
        logger.error(f"❌ Error in synchronous agent initialization: {e}")
        logger.error("Application will continue but MCP tools may not be available")

# Initialize agents in background to avoid blocking startup
def initialize_agents_background():
    """Background agent initialization to avoid blocking Flask startup"""
    threading.Thread(target=initialize_agents_sync, daemon=True).start()

# Initialize agents
logger.info("🚀 Starting background agent initialization...")
initialize_agents_background()

# Data Models
class ChatMessage:
    def __init__(self, data: dict):
        self.id = data.get('id', str(uuid.uuid4()))
        self.content = data.get('content', '')
        self.role = data.get('role', 'user')  # 'user', 'assistant', 'system'
        self.timestamp = data.get('timestamp', datetime.now(timezone.utc).isoformat())
        self.session_id = data.get('sessionId', '')
        self.user_id = data.get('userId', '')
        self.metadata = data.get('metadata', {})
        
    def to_dict(self):
        return {
            'id': self.id,
            'content': self.content,
            'role': self.role,
            'timestamp': self.timestamp,
            'sessionId': self.session_id,
            'userId': self.user_id,
            'metadata': self.metadata
        }
    def to_cosmos_dict(self):
        """Convert to CosmosDB document format - matches C# API structure"""
        return {
            'id': self.id,
            'content': self.content,
            'role': self.role,
            'timestamp': self.timestamp,
            'sessionId': self.session_id,
            'userId': self.user_id,
            '_partitionKey': self.user_id,  # CosmosDB partition key (matches C# API)
            'metadata': self.metadata
        }

class ChatSession:
    def __init__(self, data: dict):
        self.id = data.get('id', str(uuid.uuid4()))
        self.title = data.get('title', f'New Chat {datetime.now().strftime("%H:%M")}')
        self.created_at = data.get('createdAt', datetime.now(timezone.utc).isoformat())
        self.updated_at = data.get('updatedAt', datetime.now(timezone.utc).isoformat())
        self.user_id = data.get('userId', '')
        # Set lastMessageAt to createdAt for new sessions, so they appear at the top
        self.last_message_at = data.get('lastMessageAt', self.created_at)
        self.message_count = data.get('messageCount', 0)
        
    def to_dict(self):
        return {
            'id': self.id,
            'title': self.title,
            'createdAt': self.created_at,
            'updatedAt': self.updated_at,
            'userId': self.user_id,
            'lastMessageAt': self.last_message_at,
            'messageCount': self.message_count        }
        
    def to_cosmos_dict(self):
        """Convert to CosmosDB document format - matches C# API structure"""
        return {
            'id': self.id,
            'title': self.title,
            'createdAt': self.created_at,
            'lastMessageAt': self.last_message_at,
            'userId': self.user_id,
            '_partitionKey': self.user_id,  # CosmosDB partition key (matches C# API)
            'messageCount': self.message_count,
            'isArchived': False,
            'documents': []  # Empty for now, matches C# API structure
        }

# CosmosDB Helper Functions
def save_message_to_cosmos(message: ChatMessage) -> str:
    """Save a message to CosmosDB"""
    if not messages_container:
        logger.warning("CosmosDB not available, message not saved")
        return message.id
    
    try:
        cosmos_doc = message.to_cosmos_dict()
        response = messages_container.create_item(body=cosmos_doc)
        # logger.info(f"Message saved to CosmosDB: {message.id}")  # Reduced logging
        
        # Update session's last message time
        update_session_last_message(message.user_id, message.session_id, message.timestamp)
        
        return response['id']
    except Exception as e:
        logger.error(f"Error saving message to CosmosDB: {e}")
        return message.id

def get_chat_history_from_cosmos(user_id: str, session_id: str, page_size: int = 50, continuation_token: str = None) -> dict:
    """Get chat history from CosmosDB"""
    if not messages_container:
        return {'messages': [], 'hasMore': False, 'continuationToken': None}
    
    try:
        query = "SELECT * FROM c WHERE c.userId = @userId AND c.sessionId = @sessionId ORDER BY c.timestamp DESC"
        parameters = [
            {"name": "@userId", "value": user_id},
            {"name": "@sessionId", "value": session_id}
        ]
        
        # Execute the query
        query_iterator = messages_container.query_items(
            query=query,
            parameters=parameters,
            max_item_count=page_size,
            partition_key=user_id
        )
        
        # Convert iterator to list
        items = list(query_iterator)
        
        # Reverse to get chronological order (oldest first)
        items.reverse()
          # Convert to chat message format
        messages = []
        for item in items:
            messages.append({
                'id': item.get('id'),
                'content': item.get('content'),
                'role': item.get('role'),
                'timestamp': item.get('timestamp'),
                'metadata': item.get('metadata', {})
            })
        
        # logger.info(f"Retrieved {len(messages)} messages from CosmosDB for session {session_id}")  # Reduced logging
        
        return {
            'messages': messages,
            'hasMore': False,  # Simplified for now
            'continuationToken': None
        }
        
    except Exception as e:
        logger.error(f"Error retrieving chat history from CosmosDB: {e}")
        return {'messages': [], 'hasMore': False, 'continuationToken': None}

def save_session_to_cosmos(session: ChatSession) -> str:
    """Save a session to CosmosDB"""
    if not sessions_container:
        logger.warning("CosmosDB not available, session not saved")
        return session.id
    
    try:
        cosmos_doc = session.to_cosmos_dict()
        response = sessions_container.create_item(body=cosmos_doc)
        # logger.info(f"Session saved to CosmosDB: {session.id}")  # Reduced logging
        return response['id']
    except Exception as e:
        logger.error(f"Error saving session to CosmosDB: {e}")
        return session.id

def get_user_sessions_from_cosmos(user_id: str, page_size: int = 20) -> dict:
    """Get user sessions from CosmosDB - matches C# API exactly"""
    if not sessions_container:
        return {'sessions': [], 'hasMore': False, 'continuationToken': None}
    
    try:
        # Simple query that matches the C# API exactly
        query = "SELECT * FROM c WHERE c.userId = @userId AND c.isArchived = false ORDER BY c.lastMessageAt DESC"
        parameters = [{"name": "@userId", "value": user_id}]
        
        logger.info(f"Querying sessions for user: {user_id}")
        
        # Execute the query and get results
        query_iterator = sessions_container.query_items(
            query=query,
            parameters=parameters,
            max_item_count=page_size,
            partition_key=user_id
        )
        
        # Convert iterator to list
        items = list(query_iterator)
        logger.info(f"Raw query returned {len(items)} items")
        
        # Convert to session format - matches C# API structure exactly
        sessions = []
        for item in items:
            logger.info(f"Processing session: id={item.get('id')}, title={item.get('title')}, lastMessageAt={item.get('lastMessageAt')}")
                
            sessions.append({
                'id': item.get('id'),
                'title': item.get('title', 'Untitled Chat'),
                'createdAt': item.get('createdAt'),
                'updatedAt': item.get('lastMessageAt'),  # Use lastMessageAt as updatedAt for frontend compatibility
                'userId': item.get('userId'),
                'messageCount': item.get('messageCount', 0),
                'lastMessageAt': item.get('lastMessageAt'),
                'isArchived': item.get('isArchived', False),
                'documents': item.get('documents', [])
            })
        
        # logger.info(f"Retrieved {len(sessions)} sessions from CosmosDB for user {user_id}")  # Reduced logging
        
        return {
            'sessions': sessions,
            'hasMore': False,  # Simplified for now
            'continuationToken': None
        }
        
    except Exception as e:
        logger.error(f"Error retrieving sessions from CosmosDB: {e}")
        return {'sessions': [], 'hasMore': False, 'continuationToken': None}

def update_session_last_message(user_id: str, session_id: str, timestamp: str):
    """Update session's last message timestamp and increment message count"""
    if not sessions_container:
        return
    
    try:
        # Get current session
        session_doc = sessions_container.read_item(item=session_id, partition_key=user_id)
        
        # Update fields
        session_doc['lastMessageAt'] = timestamp
        session_doc['updatedAt'] = datetime.now(timezone.utc).isoformat()
        session_doc['messageCount'] = session_doc.get('messageCount', 0) + 1
        
        # Save back
        sessions_container.replace_item(item=session_id, body=session_doc)
        logger.info(f"Updated session {session_id} last message time")
        
    except CosmosResourceNotFoundError:
        logger.warning(f"Session {session_id} not found when updating last message time")
    except Exception as e:
        logger.error(f"Error updating session last message time: {e}")

# SocketIO Event Handlers
@socketio.on('connect')
def handle_connect():
    logger.info(f"Client connected: {request.sid}")
    emit('connection_status', {'status': 'connected', 'socket_id': request.sid})

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")
    # Clean up any session memberships
    for session_id in list(hub.sessions.keys()):
        hub.leave_session(session_id, request.sid)

@socketio.on('join_session')
def handle_join_session(data):
    session_id = data.get('sessionId')
    user_id = data.get('userId')
    
    logger.info(f"Join session request: {session_id} from socket {request.sid}")
    
    if not session_id:
        emit('error', {'message': 'Session ID is required'})
        return
    
    # Create session if it doesn't exist
    if session_id not in hub.sessions:
        hub.create_session(session_id, user_id)
    
    # Join the SocketIO room
    join_room(session_id)
    hub.join_session(session_id, request.sid)
    
    # Confirm join
    emit('session_joined', {
        'sessionId': session_id,
        'message': f'Successfully joined session {session_id}',
        'timestamp': datetime.now(timezone.utc).isoformat()
    })

@socketio.on('leave_session')
def handle_leave_session(data):
    session_id = data.get('sessionId')
    
    logger.info(f"Leave session request: {session_id} from socket {request.sid}")
    
    if session_id:
        leave_room(session_id)
        hub.leave_session(session_id, request.sid)
        
        emit('session_left', {
            'sessionId': session_id,
            'message': f'Left session {session_id}'
        })

@socketio.on('ping')
def handle_ping():
    """Handle ping/pong for connection health"""
    emit('pong')

# REST API Endpoints

@app.route('/health', methods=['GET'])
def health_check():
    """Simple health check"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'server': 'SocketIO Chat API Server with CosmosDB',
        'cosmosdb': "connected" if cosmos_client else "disconnected",
        'openai': "connected" if openai_client else "disconnected",
        'active_sessions': len(hub.sessions)
    })

@app.route('/api/test-logging', methods=['GET'])
def test_logging():
    """Test Application Insights logging"""
    try:
        test_application_insights_logging()
        return jsonify({
            'status': 'success',
            'message': 'Application Insights logging test completed',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'appinsights_available': appinsights_available,
            'connection_string_configured': bool(app_insights_connection_string),
            'instrumentation_key_configured': bool(app_insights_instrumentation_key)
        })
    except Exception as e:
        logger.error(f"Error in test logging endpoint: {e}")
        return jsonify({
            'status': 'error',
            'message': str(e),
            'timestamp': datetime.now(timezone.utc).isoformat()
        }), 500

@app.route('/api/status', methods=['GET'])
def api_status():
    """API status check"""
    try:
        cosmos_status = "connected" if cosmos_client else "disconnected"
        openai_status = "connected" if openai_client else "disconnected"
        
        return jsonify({
            'status': 'ok',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'services': {
                'cosmosdb': cosmos_status,
                'openai': openai_status,
                'config_loaded': bool(config),
                'cors_origins': len(cors_origins)
            }
        })
    except Exception as e:
        logger.error(f"Error in status check: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500

# Chat API endpoints
@app.route('/api/chat/session', methods=['POST'])
def create_chat_session():
    """Create a new chat session"""
    try:
        data = request.get_json()
        user_id = data.get('userId') or request.headers.get('x-user-token')
        title = data.get('title', f'New Chat {datetime.now().strftime("%H:%M")}')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        # Create session
        session = ChatSession({
            'userId': user_id,
            'title': title
        })
        
        # Save to CosmosDB
        session_id = save_session_to_cosmos(session)
        
        # Create in hub for real-time
        hub.create_session(session.id, user_id)
        
        logger.info(f"Created chat session: {session.id} for user: {user_id}")
        
        return jsonify({
            'sessionId': session.id,
            'message': 'Session created successfully',
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error creating session: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat/sessions', methods=['GET'])
def get_chat_sessions():
    """Get all chat sessions for a user"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        page_size = int(request.args.get('pageSize', 20))
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        # Get sessions from CosmosDB
        result = get_user_sessions_from_cosmos(user_id, page_size)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Error getting sessions: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat/history', methods=['GET'])
def get_chat_history():
    """Get chat history for a session"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        session_id = request.args.get('sessionId')
        page_size = int(request.args.get('pageSize', 50))
        continuation_token = request.args.get('continuationToken')
        
        if not user_id or not session_id:
            return jsonify({'error': 'User ID and Session ID are required'}), 400
        
        # Get history from CosmosDB
        result = get_chat_history_from_cosmos(user_id, session_id, page_size, continuation_token)
        
        return jsonify(result)
        
    except Exception as e:
        logger.error(f"Error getting chat history: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat/message', methods=['POST'])
def create_chat_message():
    """Create a new chat message"""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'Message data is required'}), 400
        
        # Create message
        message = ChatMessage(data)
        
        # Save to CosmosDB
        message_id = save_message_to_cosmos(message)
        
        # Update session message count
        session_id = message.session_id
        if session_id in hub.sessions:
            hub.sessions[session_id]['message_count'] += 1
        
        logger.info(f"Created message: {message.id} for session: {session_id}")
        
        return jsonify({
            'messageId': message.id,
            'message': 'Message created successfully',
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
        
    except Exception as e:
        logger.error(f"Error creating message: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat/session/<session_id>', methods=['PUT'])
def update_chat_session(session_id):
    """Update a chat session"""
    try:
        data = request.get_json()
        user_id = data.get('userId') or request.headers.get('x-user-token')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not sessions_container:
            return jsonify({'error': 'CosmosDB not available'}), 503
        
        # Get current session
        session_doc = sessions_container.read_item(item=session_id, partition_key=user_id)
        
        # Update allowed fields
        if 'title' in data:
            session_doc['title'] = data['title']
        
        session_doc['updatedAt'] = datetime.now(timezone.utc).isoformat()
        
        # Save back
        sessions_container.replace_item(item=session_id, body=session_doc)
        
        logger.info(f"Updated session: {session_id}")
        
        return jsonify({
            'success': True,
            'message': f'Session {session_id} updated successfully',
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
        
    except CosmosResourceNotFoundError:
        return jsonify({'error': 'Session not found'}), 404
    except Exception as e:
        logger.error(f"Error updating session: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat/session/<session_id>', methods=['DELETE'])
def delete_chat_session(session_id):
    """Delete a chat session"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not sessions_container:
            return jsonify({'error': 'CosmosDB not available'}), 503
        
        # Delete from CosmosDB
        sessions_container.delete_item(item=session_id, partition_key=user_id)
        
        # Clean up from hub
        if session_id in hub.sessions:
            del hub.sessions[session_id]
            
        logger.info(f"Deleted session: {session_id}")
        
        return jsonify({
            'success': True,
            'message': f'Session {session_id} deleted successfully',
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
        
    except CosmosResourceNotFoundError:
        return jsonify({'error': 'Session not found'}), 404
    except Exception as e:
        logger.error(f"Error deleting session: {e}")
        return jsonify({'error': str(e)}), 500

# Agent activity endpoints
@app.route('/api/agent/activity/<session_id>', methods=['POST'])
def send_agent_activity(session_id):
    """Send agent activity to a specific session"""
    try:
        activity_data = request.get_json()
        
        if not activity_data:
            return jsonify({'error': 'Activity data is required'}), 400
        
        hub.send_agent_activity(session_id, activity_data)
        
        return jsonify({
            'success': True,
            'message': f'Agent activity sent to session {session_id}',
            'sessionId': session_id
        })
        
    except Exception as e:
        logger.error(f"Error sending agent activity: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/test/activity/<session_id>', methods=['POST'])
def test_agent_activity(session_id):
    """Test endpoint to send sample agent activity"""
    
    # Send a test activity
    hub.send_agent_activity(session_id, {
        'agentName': 'Test Agent',
        'action': 'Test Activity from Backend',
        'status': 'completed',
        'result': f'This is a test message for session {session_id}',
        'timestamp': datetime.now(timezone.utc).isoformat()
    })
    
    return jsonify({
        'success': True,
        'message': f'Test activity sent to session {session_id}',
        'sessionId': session_id,
        'activeConnections': len(hub.sessions.get(session_id, {}).get('participants', set()))
    })

# MCP API endpoints - simplified responses to avoid CORS errors
@app.route('/api/mcp/server/info', methods=['GET'])
def mcp_server_info():
    """MCP server info endpoint"""
    try:
        server_info = {
            'name': 'Python Azure MCP Server',
            'version': '1.0.0',
            'protocolVersion': '2024-11-05',
            'capabilities': {
                'tools': {'listChanged': False}
            }
        }
        return jsonify(server_info)
    except Exception as e:
        logger.error(f"Error getting MCP info: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/mcp/tools/list', methods=['GET'])
def mcp_tools_list():
    """MCP tools list endpoint"""
    try:
        # Get tools from agent orchestrator
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        tools = loop.run_until_complete(agent_orchestrator.get_all_tools_async())
        loop.close()
        
        # Convert tools to JSON format
        tools_json = [tool.to_dict() for tool in tools]
        
        return jsonify({
            'tools': tools_json
        })
    except Exception as e:
        logger.error(f"Error getting MCP tools: {str(e)}")
        return jsonify({'error': str(e), 'tools': []}), 500

@app.route('/api/sessions/status', methods=['GET'])
def get_session_status():
    """Get status of all sessions"""
    return jsonify({
        'sessions': {
            session_id: {
                'participants': len(session_data['participants']),
                'created_at': session_data['created_at'],
                'message_count': session_data['message_count']
            }
            for session_id, session_data in hub.sessions.items()
        },
        'total_sessions': len(hub.sessions),
        'cosmosdb_connected': cosmos_client is not None
    })

# Document API endpoints (for completeness)
@app.route('/api/document', methods=['GET'])
def get_documents():
    """Get documents for a session"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        session_id = request.args.get('sessionId')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        # Get documents using Azure Document Service
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            documents = loop.run_until_complete(
                azure_document_service.get_user_documents_async(user_id, session_id)
            )
        finally:
            loop.close()
        
        # Convert to list of dictionaries
        documents_list = [doc.to_dict() for doc in documents]
        
        return jsonify(documents_list)
        
    except Exception as e:
        logger.error(f"Error getting documents: {e}")
        return jsonify({'error': str(e)}), 500

# Document search endpoint
@app.route('/api/document/search', methods=['POST'])
def search_documents():
    """Search documents for RAG functionality"""
    try:
        data = request.get_json()
        query = data.get('query', '')
        user_id = data.get('userId') or request.headers.get('x-user-token')
        
        logger.info(f"Document search request: '{query}' for user: {user_id}")
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not query:
            return jsonify({'error': 'Query is required'}), 400
        
        # Search documents using Azure Document Service
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            session_id = data.get('sessionId')
            max_results = data.get('maxResults', 5)
            
            chunks = loop.run_until_complete(
                azure_document_service.search_documents_async(query, user_id, session_id, max_results)
            )
        finally:
            loop.close()
        
        # Convert to response format matching C# API
        results = []
        for chunk in chunks:
            results.append({
                'chunkId': chunk.chunk_id,
                'documentId': chunk.document_id,
                'content': chunk.content,
                'score': chunk.score,
                'chunkIndex': chunk.chunk_index
            })
        
        return jsonify({
            'query': query,
            'results': results
        })
        
    except Exception as e:
        logger.error(f"Error in document search: {e}")
        return jsonify({'error': str(e)}), 500

# Document download endpoint
@app.route('/api/document/<document_id>/download', methods=['GET'])
def download_document(document_id):
    """Download a document"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not document_id:
            return jsonify({'error': 'Document ID is required'}), 400
        
        # Download using Azure Document Service
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            content, file_name, content_type = loop.run_until_complete(
                azure_document_service.download_document_async(document_id, user_id)
            )
        finally:
            loop.close()
        
        # Return file content
        from flask import send_file
        import io
        
        file_stream = io.BytesIO(content)
        file_stream.seek(0)
        
        return send_file(
            file_stream,
            as_attachment=True,
            download_name=file_name,
            mimetype=content_type
        )
        
    except ValueError as e:
        logger.warning(f"Document not found or access denied: {document_id}")
        return jsonify({'error': 'Document not found or access denied'}), 404
    except Exception as e:
        logger.error(f"Error downloading document: {document_id}, Error: {e}")
        return jsonify({'error': str(e)}), 500

# Document upload endpoint
@app.route('/api/document/upload', methods=['POST', 'OPTIONS'])
def upload_document():
    """Upload a document for processing and RAG"""
    if request.method == 'OPTIONS':
        # Handle CORS preflight request
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add('Access-Control-Allow-Headers', "*")
        response.headers.add('Access-Control-Allow-Methods', "*")
        return response
        
    try:
        # Check if file is present
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
            
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
            
        # Get form data
        user_id = request.form.get('userId') or request.headers.get('x-user-token')
        session_id = request.form.get('sessionId')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
            
        if not session_id:
            return jsonify({'error': 'Session ID is required'}), 400
            
        logger.info(f"Upload request - File: {file.filename}, UserId: {user_id}, SessionId: {session_id}")
        
        # Validate file type
        allowed_extensions = {'.pdf', '.doc', '.docx', '.txt', '.md'}
        file_ext = os.path.splitext(file.filename)[1].lower()
        
        if file_ext not in allowed_extensions:
            return jsonify({'error': f'File type {file_ext} not supported. Allowed types: {", ".join(allowed_extensions)}'}), 400
            
        # Validate file size (max 10MB)
        max_file_size = 10 * 1024 * 1024
        file.seek(0, os.SEEK_END)
        file_size = file.tell()
        file.seek(0)
        
        if file_size > max_file_size:
            return jsonify({'error': 'File size exceeds 10MB limit'}), 400
        
        # Upload using Azure Document Service
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            document_id = loop.run_until_complete(
                azure_document_service.upload_document_async(file.stream, file.filename, user_id, session_id)
            )
        finally:
            loop.close()
        
        logger.info(f"Document uploaded successfully - DocumentId: {document_id}")
        
        # Start async processing with delay for Cosmos DB consistency
        def process_document_background():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Add delay for Cosmos DB consistency
                loop.run_until_complete(asyncio.sleep(2))
                result = loop.run_until_complete(
                    azure_document_service.process_document_async(document_id)
                )
                if result.success:
                    logger.info(f"Document processed successfully: {document_id}, Chunks: {result.chunk_count}")
                else:
                    logger.error(f"Document processing failed: {document_id}, Error: {result.error_message}")
            except Exception as e:
                logger.error(f"Error in background document processing: {e}")
            finally:
                loop.close()
        
        # Start background processing
        import threading
        processing_thread = threading.Thread(target=process_document_background)
        processing_thread.daemon = True
        processing_thread.start()
        
        return jsonify({
            'documentId': document_id,
            'fileName': file.filename,
            'status': 'uploaded'
        })
        
    except Exception as e:
        logger.error(f"Error uploading document: {e}")
        return jsonify({'error': str(e)}), 500

# Chat completions endpoint - the main LLM endpoint
@app.route('/api/chat/completions', methods=['POST'])
def chat_completions():
    """Handle chat completions using Semantic Kernel orchestrator"""
    try:
        data = request.get_json()
        messages = data.get('messages', [])
        user_id = data.get('userId') or request.headers.get('x-user-token')
        session_id = data.get('sessionId')
        use_rag = data.get('useRAG', False)
        use_mcp_tools = data.get('useMCPTools', True)
        
        logger.info(f"Chat completion request for session: {session_id}, messages: {len(messages)}")
        logger.info(f"RAG: {use_rag}, MCP Tools: {use_mcp_tools}")
        
        if not messages:
            return jsonify({'error': 'No messages provided'}), 400
        
        # Send agent activity for processing
        if session_id:
            hub.send_agent_activity(session_id, {
                'agentName': 'Semantic Kernel Orchestrator',
                'action': 'Processing Request',
                'status': 'in_progress',
                'result': 'Analyzing message and coordinating agents...',
                'timestamp': datetime.now(timezone.utc).isoformat()
            })
        
        # Process request using Semantic Kernel orchestrator
        start_time = datetime.now(timezone.utc)
        
        # Run async operation in event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            response = loop.run_until_complete(
                agent_orchestrator.process_request_async(messages, session_id, user_id)
            )
        finally:
            loop.close()
        
        end_time = datetime.now(timezone.utc)
        duration_ms = int((end_time - start_time).total_seconds() * 1000)
        
        # Create assistant message from Semantic Kernel response
        assistant_message = {
            'id': str(uuid.uuid4()),
            'content': response.get('content', 'No response generated'),
            'role': 'assistant',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'sessionId': session_id,
            'userId': user_id,
            'metadata': {
                'sources': [],
                'toolCalls': response.get('function_calls', []),
                'model': 'semantic-kernel',
                'finish_reason': response.get('finish_reason', 'stop')
            }
        }
        
        # Save assistant message to CosmosDB
        if session_id and user_id:
            try:
                assistant_chat_message = ChatMessage(assistant_message)
                save_message_to_cosmos(assistant_chat_message)
                # logger.info(f"Saved assistant message to CosmosDB: {assistant_chat_message.id}")  # Reduced logging
            except Exception as e:
                logger.error(f"Failed to save assistant message to CosmosDB: {e}")
        
        # Send completion activity
        if session_id:
            hub.send_agent_activity(session_id, {
                'agentName': 'Semantic Kernel Orchestrator',
                'action': 'Response Generated',
                'status': 'completed',
                'result': f'Generated response using Semantic Kernel with agents and tools',
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'duration': duration_ms
            })
        
        logger.info(f"Chat completion response generated for session: {session_id} in {duration_ms}ms")
        
        return jsonify({
            'message': assistant_message,
            'agentInteractions': response.get('agent_interactions', [])
        })
        
    except Exception as e:
        logger.error(f"Error in chat completions: {e}")
        
        # Send error activity
        if 'session_id' in locals() and session_id:
            hub.send_agent_activity(session_id, {
                'agentName': 'Semantic Kernel Orchestrator',
                'action': 'Error',
                'status': 'error',
                'result': f'Error: {str(e)}',
                'timestamp': datetime.now(timezone.utc).isoformat()
            })
        
        return jsonify({'error': str(e)}), 500

# MCP-specific endpoints
@app.route('/api/mcp/tools', methods=['GET'])
def get_mcp_tools():
    """Get all available MCP tools"""
    try:
        # Run in async context
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        tools = loop.run_until_complete(agent_orchestrator.get_all_tools_async())
        loop.close()
        
        # Convert to JSON-serializable format
        tools_json = [tool.to_dict() for tool in tools]
        
        return jsonify({
            'tools': tools_json,
            'count': len(tools_json)
        })
    except Exception as e:
        logger.error(f"Error getting MCP tools: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/mcp/agents', methods=['GET'])
def get_mcp_agents():
    """Get all available MCP agents"""
    try:
        # Run in async context
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        agents = loop.run_until_complete(agent_orchestrator.get_all_agents_async())
        loop.close()
        
        # Convert to JSON-serializable format
        agents_json = []
        for agent in agents:
            agents_json.append({
                'agentId': agent.agent_id,
                'name': agent.name,
                'description': agent.description,
                'domains': agent.domains
            })
        
        return jsonify({
            'agents': agents_json,
            'count': len(agents_json)
        })
    except Exception as e:
        logger.error(f"Error getting MCP agents: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/mcp/health', methods=['GET'])
def get_mcp_health():
    """Get health status of all MCP agents"""
    try:
        # Run in async context
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        health_statuses = loop.run_until_complete(agent_orchestrator.agent_manager.get_all_agent_health_async())
        loop.close()
        
        # Convert to JSON-serializable format
        health_json = [status.to_dict() for status in health_statuses]
        
        return jsonify({
            'agentHealth': health_json,
            'overallHealth': all(status.is_healthy for status in health_statuses)
        })
    except Exception as e:
        logger.error(f"Error getting MCP health: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/mcp/execute', methods=['POST'])
def execute_mcp_tool():
    """Execute an MCP tool directly"""
    try:
        data = request.get_json()
        tool_name = data.get('name')
        arguments = data.get('arguments', {})
        user_id = data.get('userId') or request.headers.get('x-user-token')
        
        if not tool_name:
            return jsonify({'error': 'Tool name is required'}), 400
        
        # Create MCP tool call request
        mcp_request = McpToolCallRequest(
            name=tool_name,
            arguments=arguments
        )
        
        # Run in async context
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        response = loop.run_until_complete(
            agent_orchestrator.agent_manager.execute_tool_async(mcp_request, user_id)
        )
        loop.close()
        
        return jsonify(response.to_dict())
    except Exception as e:
        logger.error(f"Error executing MCP tool: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/mcp/server-info', methods=['GET'])
def get_mcp_server_info():
    """Get MCP server information"""
    try:
        server_info = McpServerInfo()
        return jsonify(server_info.to_dict())
    except Exception as e:
        logger.error(f"Error getting MCP server info: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/config', methods=['GET'])
def get_config():
    """Get sanitized configuration information"""
    try:
        sanitized_config = {
            "services": {
                "azure_openai": bool(config.get("AzureOpenAI", {}).get("Endpoint")),
                "azure_search": bool(config.get("AzureAISearch", {}).get("Endpoint")),
                "cosmos_db": bool(config.get("CosmosDB", {}).get("Endpoint")),
                "azure_storage": bool(config.get("AzureStorage", {}).get("ConnectionString")),
                "azure_data_explorer": bool(config.get("AzureDataExplorer", {}).get("ClusterUrl"))
            },
            "features": {
                "chat_completions": True,
                "real_time_streaming": True,
                "mcp_tools": True,
                "document_upload": True
            },
            "cors_origins": cors_origins
        }
        
        return jsonify(sanitized_config)
        
    except Exception as e:
        logger.error(f"Error getting config: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Static file serving for Angular app
@app.route('/')
def serve_angular_app():
    """Serve the Angular application index.html"""
    try:
        return send_from_directory(app.static_folder, 'index.html')
    except Exception as e:
        logger.error(f"Error serving Angular app: {e}")
        return jsonify({'error': 'Angular app not found. Please build the Angular app first.'}), 404

@app.route('/<path:path>')
def serve_static_files(path):
    """Serve static files or Angular app for client-side routing"""
    try:
        # Try to serve the static file first
        full_path = os.path.join(app.static_folder, path)
        if os.path.isfile(full_path):
            return send_from_directory(app.static_folder, path)
        else:
            # If file doesn't exist, it's probably an Angular route - serve index.html
            return send_from_directory(app.static_folder, 'index.html')
    except Exception as e:
        logger.error(f"Error serving static file {path}: {e}")
        return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    logger.info("🚀 Starting SocketIO Chat API Server on port 5007...")
    logger.info(f"CosmosDB Status: {'Connected' if cosmos_client else 'Disconnected'}")
    logger.info(f"OpenAI Status: {'Connected' if openai_client else 'Disconnected'}")
    logger.info(f"Active Sessions: {len(hub.sessions)}")
    
    # Test Application Insights logging
    if appinsights_available:
        logger.info("🧪 Testing Application Insights logging during startup...")
        test_application_insights_logging()
    
    logger.info("Server ready to accept connections...")
    socketio.run(app, host='0.0.0.0', port=5007, debug=False)
