"""
WSGI entry point for DocumentAgent service.
Follows the same pattern as the main API's wsgi.py file.
"""

import asyncio
import logging
from src.remote_agents.document_agent_service import app, startup

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("DocumentAgent.WSGI")

# Initialize the agent on startup
try:
    asyncio.run(startup())
    logger.info("✅ DocumentAgent initialized for WSGI deployment")
except Exception as e:
    logger.error("❌ Failed to initialize DocumentAgent for WSGI: %s", e)
    raise

# WSGI application entry point
application = app

if __name__ == "__main__":
    # For local testing
    import os
    port = int(os.getenv("PORT", "18081"))
    app.run(host="0.0.0.0", port=port, debug=False)
