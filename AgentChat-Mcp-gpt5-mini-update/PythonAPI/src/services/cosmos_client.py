"""Azure Cosmos DB client configuration and initialization."""

# Apply early logging suppressions before Azure imports
try:
    from ..utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()
except ImportError:
    from utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()

import os
import logging
from typing import Optional
from azure.cosmos import CosmosClient
from azure.cosmos.exceptions import CosmosHttpResponseError

from src.utils.logging import get_logger

logger = get_logger(__name__)


class CosmosDBClient:
    """Cosmos DB client wrapper for configuration and connection management."""
    
    def __init__(self):
        self.client: Optional[CosmosClient] = None
        self.database = None
        self.sessions_container = None
        self.messages_container = None
        self._config = self._load_config()
        self._initialize_client()
    
    def _load_config(self) -> dict:
        """Load Cosmos DB configuration from environment variables."""
        return {
            'endpoint': os.getenv("AZURE_COSMOS_DB_ENDPOINT"),
            'key': os.getenv("AZURE_COSMOS_DB_KEY"),
            'database_name': os.getenv("AZURE_COSMOS_DB_DATABASE", "ChatDatabase"),
            'sessions_container': os.getenv("AZURE_COSMOS_DB_SESSIONS_CONTAINER", "Sessions"),
            'messages_container': os.getenv("AZURE_COSMOS_DB_MESSAGES_CONTAINER", "Messages")
        }
    
    def _initialize_client(self):
        """Initialize the Cosmos DB client and containers."""
        try:
            if not self._config['endpoint'] or not self._config['key']:
                logger.error("Cosmos DB environment variables not set (COSMOS_DB_ENDPOINT, COSMOS_DB_KEY)")
                return
            
            # Initialize client
            self.client = CosmosClient(self._config['endpoint'], self._config['key'])
            
            # Get database
            self.database = self.client.get_database_client(self._config['database_name'])
            
            # Get containers
            self.sessions_container = self.database.get_container_client(self._config['sessions_container'])
            self.messages_container = self.database.get_container_client(self._config['messages_container'])
            
            logger.info(
                f"✅ Cosmos DB client initialized successfully - "
                f"Database: {self._config['database_name']}, "
                f"Sessions: {self._config['sessions_container']}, "
                f"Messages: {self._config['messages_container']}"
            )
            
        except Exception as e:
            logger.error(f"❌ Error initializing Cosmos DB client: {str(e)}")
            self.client = None
    
    def is_available(self) -> bool:
        """Check if Cosmos DB is available."""
        return self.client is not None
    
    def get_config(self) -> dict:
        """Get current configuration."""
        return self._config.copy()
    
    def reconnect(self):
        """Reconnect to Cosmos DB (useful for error recovery)."""
        logger.info("Attempting to reconnect to Cosmos DB...")
        self._initialize_client()


# Global client instance
cosmos_client = CosmosDBClient()
