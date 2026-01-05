"""Azure App Service entry point - Flask app with static Angular files."""

import os
import sys
from pathlib import Path

# Add src to Python path
src_path = Path(__file__).parent / "src"
sys.path.insert(0, str(src_path))

# Apply early logging configuration before any Azure imports
try:
    from src.utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()
except ImportError:
    from utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()

from flask import Flask, send_from_directory, send_file
from flask_cors import CORS

# Import your existing app factory
try:
    from src.api.app import create_app as create_base_app
    from src.config.settings import settings
    from src.utils.logging import setup_logging, get_logger, configure_root_logger
except ImportError:
    # Fallback for direct execution
    import sys
    from pathlib import Path
    src_path = Path(__file__).parent / "src"
    sys.path.insert(0, str(src_path))
    from api.app import create_app as create_base_app
    from config.settings import settings
    from utils.logging import setup_logging, get_logger, configure_root_logger

def create_app():
    """Create Flask app with static Angular files for Azure App Service."""
    
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
        logger_name="azure_app",
        connection_string=settings.azure.application_insights_connection_string,
        instrumentation_key=settings.azure.application_insights_instrumentation_key
    )
    
    # Create the base app with all API routes
    app = create_base_app()
    
    # Configure static file serving for Angular
    static_folder = Path(__file__).parent / "static"
    app.static_folder = str(static_folder)
    
    # Override the root route to serve Angular index.html
    @app.route('/')
    def serve_angular_index():
        """Serve Angular index.html for the root route."""
        try:
            return send_from_directory(app.static_folder, 'index.html')
        except FileNotFoundError:
            # Fallback if Angular build not found
            return {
                "message": "Python API with MCP Server",
                "version": "1.0.0",
                "note": "Angular app not built yet - run deployment script",
                "endpoints": {
                    "api": "/api/v1",
                    "agents": "/api/v1/agents",
                    "mcp_sse": f"{settings.mcp.mount_path}",
                    "health": "/api/v1/health",
                    "tools": "/api/v1/tools"
                }
            }
    
    # Serve Angular static files for any non-API routes
    @app.route('/<path:path>')
    def serve_angular_static(path):
        """Serve Angular static files."""
        try:
            # Check if it's an API route, if so let the API handle it
            if path.startswith('api/'):
                return None  # Let the API routes handle this
            
            # Try to serve the static file
            return send_from_directory(app.static_folder, path)
        except FileNotFoundError:
            # For Angular routing, serve index.html for unknown routes
            try:
                return send_from_directory(app.static_folder, 'index.html')
            except FileNotFoundError:
                return {"error": "Static files not found - run deployment script"}, 404
    
    logger.info("Azure App Service Flask application created successfully")
    return app


# Create the app instance for Azure App Service
app = create_app()

# This is what gunicorn will look for
if __name__ == "__main__":
    # For local development
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
