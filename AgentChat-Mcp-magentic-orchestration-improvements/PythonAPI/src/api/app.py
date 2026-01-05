"""Flask application factory and configuration."""

# Apply early logging configuration before any Azure imports
try:
    from ..utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()
except ImportError:
    from utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()

import os
import logging
from datetime import datetime
from flask import Flask, request, send_from_directory, send_file, Response, jsonify, stream_with_context
from flask_cors import CORS

try:
    from ..config.settings import settings
    from ..utils.logging import setup_logging, get_logger, setup_flask_telemetry, configure_root_logger
    from src.utils.sse_emitter import sse_emitter  # Use consistent absolute import
    from ..utils.flask_request_logging import setup_request_logging
except ImportError:
    from config.settings import settings
    from utils.logging import setup_logging, get_logger, setup_flask_telemetry, configure_root_logger
    from src.utils.sse_emitter import sse_emitter  # Use consistent absolute import
    from utils.flask_request_logging import setup_request_logging

from .routes import api_bp
from .agent_routes import agent_bp
from .chat_routes import chat_bp
from .document_routes import document_bp
from .mcp_routes import mcp_bp
from .remote_agent_routes import remote_agents_bp, init_agents


def create_app() -> Flask:
    """Create and configure the Flask application."""
    
    # Configure root logger first to ensure all logs are captured
    configure_root_logger(
        connection_string=settings.azure.application_insights_connection_string,
        instrumentation_key=settings.azure.application_insights_instrumentation_key,
        log_level=settings.log_level,
        suppress_azure_logs=settings.suppress_azure_logs,
        suppress_semantic_kernel_logs=settings.suppress_semantic_kernel_logs
    )
    
    # Set up application-specific logging
    logger = setup_logging(
        log_level=settings.log_level,
        logger_name="flask_app",
        connection_string=settings.azure.application_insights_connection_string,
        instrumentation_key=settings.azure.application_insights_instrumentation_key
    )
    
    # Create Flask app with static folder configuration
    static_folder = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'static')
    app = Flask(__name__, static_folder=static_folder, static_url_path='')
    # treat "/foo" and "/foo/" the same—no redirect (and thus no HTTP→HTTPS mishap)
    app.url_map.strict_slashes = False

    # Set up Flask telemetry with Application Insights
    setup_flask_telemetry(
        app,
        connection_string=settings.azure.application_insights_connection_string,
        instrumentation_key=settings.azure.application_insights_instrumentation_key
    )
    
    # Configure Flask's built-in logger to also send to Application Insights
    if settings.azure.application_insights_connection_string or settings.azure.application_insights_instrumentation_key:
        try:
            from opencensus.ext.azure.log_exporter import AzureLogHandler
            
            # Remove existing handlers from Flask's logger
            for handler in app.logger.handlers[:]:
                app.logger.removeHandler(handler)
            
            # Add Azure handler to Flask's logger
            if settings.azure.application_insights_connection_string:
                azure_handler = AzureLogHandler(connection_string=settings.azure.application_insights_connection_string)
            else:
                azure_handler = AzureLogHandler(instrumentation_key=settings.azure.application_insights_instrumentation_key)
            
            app.logger.addHandler(azure_handler)
            app.logger.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))
            
        except Exception as e:
            logger.error(f"Failed to configure Flask logger with Application Insights: {e}")
    
    # Configure CORS
    CORS(app, resources={
        r"/api/*": {"origins": "*"},
        r"/mcp/*": {"origins": "*"}
    })
    
    # Set up request logging middleware
    setup_request_logging(app)
    
    logger.info("Using standard Flask for better Azure compatibility")
    logger.info("Flask application logging configured with Azure Application Insights")
    
    # Register blueprints
    app.register_blueprint(api_bp)
    app.register_blueprint(agent_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(document_bp)
    app.register_blueprint(mcp_bp)
    app.register_blueprint(remote_agents_bp)
    
    # Initialize remote agents on startup
    logger.info("Initializing remote agents...")
    init_agents()
    logger.info("Remote agents initialized successfully")
    
    # Serve Angular frontend at root
    @app.route('/')
    def index():
        """Serve the Angular index.html file."""
        try:
            return send_file(os.path.join(app.static_folder, 'index.html'))
        except Exception as e:
            logger.error(f"Error serving index.html: {e}")
            # Fallback to API info if static files aren't available
            return {
                "message": "Python API with MCP Server",
                "version": "1.0.0",
                "endpoints": {
                    "api": "/api/v1",
                    "agents": "/api/v1/agents",
                    "mcp_sse": f"{settings.mcp.mount_path}",
                    "health": "/api/v1/health",
                    "tools": "/api/v1/tools"
                },
                "mcp_server": {
                    "name": settings.mcp.server_name,
                    "port": settings.mcp.server_port
                }
            }
    
    # Serve static files (CSS, JS, images)
    @app.route('/<path:filename>')
    def static_files(filename):
        """Serve static files from the Angular build."""
        try:
            return send_from_directory(app.static_folder, filename)
        except Exception as e:
            logger.warning(f"Static file not found: {filename}")
            # For Angular routing, serve index.html for unmatched routes
            if not filename.startswith('api/') and not filename.startswith('mcp/'):
                return send_file(os.path.join(app.static_folder, 'index.html'))
            return {"error": "Not found"}, 404
    
    # API info endpoint (moved from root)
    @app.route('/api/info')
    def api_info():
        """Get API information and endpoints."""
        return {
            "message": "Python API with MCP Server",
            "version": "1.0.0",
            "endpoints": {
                "api": "/api/v1",
                "agents": "/api/v1/agents",
                "mcp_sse": f"{settings.mcp.mount_path}",
                "health": "/api/v1/health",
                "tools": "/api/v1/tools"
            },
            "mcp_server": {
                "name": settings.mcp.server_name,
                "port": settings.mcp.server_port
            }
        }
    
    # Add health check at root level
    @app.route('/health')
    def health():
        return {"status": "healthy", "service": "PythonAPI", "timestamp": datetime.now().isoformat()}
    
    # Fast health check for load balancer
    @app.route('/ping')
    def ping():
        return "pong", 200
    
    # SSE endpoint for agent activity
    @app.route('/api/sse/agent-activity/<session_id>')
    def agent_activity_stream(session_id):
        """Server-Sent Events endpoint for agent activity."""
        logger.info(f"📡 Starting SSE stream for session: {session_id}")
        
        # wrap in stream_with_context to keep the Flask context alive across yields
        return Response(
            stream_with_context(sse_emitter.get_session_stream(session_id)),
            mimetype='text/event-stream',
            headers={
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Accel-Buffering': 'no'
            }
        )
    
    # Alternative polling endpoint for Azure App Service compatibility
    @app.route('/api/polling/agent-activity/<session_id>')
    def agent_activity_polling(session_id):
        """Polling endpoint that mimics SSE for better Azure compatibility."""
        logger.info(f"🔄 Polling request for session: {session_id}")
        
        # Get any pending messages for this session
        messages = []
        if session_id in sse_emitter._sessions:
            queue = sse_emitter._sessions[session_id]
            try:
                # Try to get up to 10 messages without blocking
                for _ in range(10):
                    try:
                        message = queue.get_nowait()
                        messages.append(message)
                    except:
                        break
            except Exception as e:
                logger.error(f"Error getting messages for polling: {e}")
        
        # If no messages, return heartbeat
        if not messages:
            messages.append({
                'event': 'heartbeat',
                'data': {'timestamp': datetime.now().isoformat()},
                'timestamp': datetime.now().isoformat()
            })
        
        return jsonify({
            'status': 'success',
            'session_id': session_id,
            'messages': messages,
            'timestamp': datetime.now().isoformat()
        })

    # Health check endpoint for SSE
    @app.route('/api/sse/health')
    def sse_health():
        return {"status": "healthy", "service": "SSE", "active_sessions": len(sse_emitter._sessions)}
    
    # Simple SSE test endpoint that responds immediately
    @app.route('/api/sse/test')
    def sse_test():
        """Simple SSE test endpoint for debugging connection speed."""
        def generate():
            import time
            import json
            # Send immediate response
            yield f"data: {json.dumps({'event': 'test', 'data': {'message': 'SSE test connection', 'timestamp': datetime.now().isoformat()}})}\n\n"
            
            # Send a few test messages quickly
            for i in range(3):
                time.sleep(0.5)  # Very short delay
                yield f"data: {json.dumps({'event': 'test', 'data': {'message': f'Test message {i+1}', 'timestamp': datetime.now().isoformat()}})}\n\n"
            
            # Close connection
            yield f"data: {json.dumps({'event': 'close', 'data': {'message': 'Test complete'}})}\n\n"
        
        return Response(
            generate(),
            mimetype='text/event-stream',
            headers={
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'X-Accel-Buffering': 'no'
            }
        )

    # Test endpoint for triggering agent activity (for debugging)
    @app.route('/api/test/activity/<session_id>', methods=['POST'])
    def test_activity(session_id):
        """Test endpoint to trigger agent activity for debugging."""
        logger.info(f"🧪 Test activity triggered for session: {session_id}")
        
        # Emit a test activity
        sse_emitter.emit_agent_activity(
            session_id=session_id,
            agent_name="TestAgent",
            action="test_action",
            status="completed",
            details="This is a test activity from the backend",
            duration=1.5
        )
        
        return {"status": "success", "message": f"Test activity sent to session {session_id}"}

    # Test SSE endpoint for triggering events
    @app.route('/api/test/sse/<session_id>', methods=['POST'])
    def test_sse_event(session_id):
        """Test endpoint to trigger SSE event for debugging."""
        logger.info(f"🧪 Test SSE event triggered for session: {session_id}")
        
        # Check emitter state before emission
        with sse_emitter._lock:
            session_exists_before = session_id in sse_emitter._sessions
            total_sessions_before = len(sse_emitter._sessions)
            
        logger.info(f"🔍 Before emission - Session exists: {session_exists_before}, Total sessions: {total_sessions_before}")
        
        # Emit a test SSE event
        sse_emitter.emit_agent_activity(
            session_id=session_id,
            agent_name="TestSSEAgent",
            action="test_sse_event",
            status="completed",
            details="This is a test SSE event triggered via API",
            duration=0.5
        )
        
        # Check emitter state after emission
        with sse_emitter._lock:
            session_exists_after = session_id in sse_emitter._sessions
            total_sessions_after = len(sse_emitter._sessions)
            queue_size = 0
            if session_id in sse_emitter._sessions:
                queue_size = sse_emitter._sessions[session_id].qsize()
                
        logger.info(f"🔍 After emission - Session exists: {session_exists_after}, Total sessions: {total_sessions_after}, Queue size: {queue_size}")
        
        return {
            "status": "success", 
            "message": f"Test SSE event sent to session {session_id}",
            "debug": {
                "session_exists_before": session_exists_before,
                "session_exists_after": session_exists_after,
                "total_sessions_before": total_sessions_before,
                "total_sessions_after": total_sessions_after,
                "queue_size": queue_size
            }
        }

    # Debug endpoint to get SSE status (all sessions)
    @app.route('/api/debug/sse/status', methods=['GET'])
    def debug_sse_status():
        """Debug endpoint to get overall SSE status."""
        logger.info("🔍 Debug SSE status - getting all sessions")
        
        status_info = {
            "total_sessions": len(sse_emitter._sessions),
            "active_sessions": list(sse_emitter._sessions.keys()),
            "timestamp": datetime.now().isoformat()
        }
        
        return status_info

    # Debug endpoint to get SSE emission stats
    @app.route('/api/debug/sse/stats', methods=['GET'])
    def debug_sse_stats():
        """Debug endpoint to get SSE emission statistics."""
        logger.info("🔍 Debug SSE stats - getting emission statistics")
        
        stats = {
            "emission_stats": sse_emitter._emission_stats,
            "active_sessions": len(sse_emitter._sessions),
            "timestamp": datetime.now().isoformat()
        }
        
        return stats

    # Debug endpoint to check SSE queue state
    @app.route('/api/debug/sse/<session_id>', methods=['GET'])
    def debug_sse_state(session_id):
        """Debug endpoint to check SSE queue state."""
        logger.info(f"🔍 Debug SSE state for session: {session_id}")
        
        debug_info = {
            "session_id": session_id,
            "session_exists": session_id in sse_emitter._sessions,
            "total_sessions": len(sse_emitter._sessions),
            "active_sessions": list(sse_emitter._sessions.keys()),
            "queue_size": 0,
            "last_activity": None
        }
        
        if session_id in sse_emitter._sessions:
            queue = sse_emitter._sessions[session_id]
            debug_info["queue_size"] = queue.qsize()
            
        if session_id in sse_emitter._session_last_activity:
            debug_info["last_activity"] = sse_emitter._session_last_activity[session_id].isoformat()
            
        return debug_info

    # Add Azure-specific SSE headers
    @app.after_request
    def after_request(response):
        """Add headers for Azure App Service SSE compatibility."""
        # Disable buffering for SSE endpoints
        if request.path.startswith('/api/sse/'):
            response.headers['X-Accel-Buffering'] = 'no'
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
            response.headers['Connection'] = 'keep-alive'
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Headers'] = 'Cache-Control, Content-Type'
            response.headers['Access-Control-Expose-Headers'] = 'Cache-Control'
            # Additional headers for Azure Linux App Service
            response.headers['X-Content-Type-Options'] = 'nosniff'
            response.headers['X-Frame-Options'] = 'DENY'
        return response

    logger.info("Flask application created successfully")
    return app
