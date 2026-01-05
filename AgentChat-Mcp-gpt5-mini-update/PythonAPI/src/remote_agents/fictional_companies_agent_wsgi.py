"""
WSGI entry point for FictionalCompaniesAgent service.
Follows the same pattern as the main API's wsgi.py file.
"""

import asyncio
import logging
from src.remote_agents.fictional_companies_agent_service import app, startup

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("FictionalCompaniesAgent.WSGI")

# Initialize the agent on startup
try:
    asyncio.run(startup())
    logger.info("✅ FictionalCompaniesAgent initialized for WSGI deployment")
except Exception as e:
    logger.error("❌ Failed to initialize FictionalCompaniesAgent for WSGI: %s", e)
    raise

# WSGI application entry point
application = app

if __name__ == "__main__":
    # For local testing
    import os
    port = int(os.getenv("PORT", "18084"))
    app.run(host="0.0.0.0", port=port, debug=False)
