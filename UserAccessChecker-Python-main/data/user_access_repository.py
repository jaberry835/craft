"""
UserAccessRepository
Handles Cosmos DB queries for user access data
"""
import logging
from typing import Optional
from azure.cosmos import CosmosClient, PartitionKey
from azure.identity import DefaultAzureCredential


class UserAccessRepository:
    """Repository for querying user access data from Cosmos DB"""
    
    def __init__(self, endpoint: str, database_name: str, container_name: str, key: Optional[str] = None):
        """
        Initialize the repository
        
        Args:
            endpoint: Cosmos DB endpoint URL
            database_name: Database name
            container_name: Container name
            key: Optional Cosmos DB key. If not provided, uses DefaultAzureCredential
        """
        if not endpoint:
            raise ValueError("AZURE_COSMOS_DB_ENDPOINT is required")
        if not database_name:
            raise ValueError("AZURE_COSMOS_DB_DATABASE is required")
        if not container_name:
            raise ValueError("AZURE_COSMOS_DB_CONTAINER is required")
        
        self.logger = logging.getLogger(__name__)
        self.database_name = database_name
        self.container_name = container_name
        
        # Create Cosmos client with key or managed identity
        if key:
            self.logger.info("Initializing Cosmos client with key authentication")
            self.client = CosmosClient(endpoint, credential=key)
        else:
            self.logger.info("Initializing Cosmos client with DefaultAzureCredential")
            self.client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    
    async def get_access_by_login_async(self, login: str) -> Optional[str]:
        """
        Query Cosmos DB for user access by login ID
        
        Args:
            login: User login ID (e.g., email)
            
        Returns:
            Access level string if found, None otherwise
        """
        try:
            database = self.client.get_database_client(self.database_name)
            container = database.get_container_client(self.container_name)
            
            # Query for the user's access level
            query = "SELECT c.Access FROM c WHERE c.LoginID = @login"
            parameters = [{"name": "@login", "value": login}]
            
            # Use partition key for efficient query
            items = list(container.query_items(
                query=query,
                parameters=parameters,
                partition_key=login,
                max_item_count=1
            ))
            
            if items and len(items) > 0:
                access = items[0].get('Access')
                self.logger.info(f"Found access record for {login}")
                return access
            
            self.logger.info(f"No access record found for {login}")
            return None
            
        except Exception as e:
            self.logger.error(f"Error querying Cosmos DB: {str(e)}", exc_info=True)
            raise
