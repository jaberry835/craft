"""
WSGI entry point for InvestigatorAgent service.
Follows the same pattern as the main API's wsgi.py file.
"""

import asyncio
import logging
from src.remote_agents.investigator_agent_service import app, startup

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("InvestigatorAgent.WSGI")

# Initialize the agent on startup
try:
    asyncio.run(startup())
    logger.info("✅ InvestigatorAgent initialized for WSGI deployment")
except Exception as e:
    logger.error("❌ Failed to initialize InvestigatorAgent for WSGI: %s", e)
    raise

# WSGI application entry point
application = app

if __name__ == "__main__":
    # For local testing
    import os
    port = int(os.getenv("PORT", "18083"))
    app.run(host="0.0.0.0", port=port, debug=False)
