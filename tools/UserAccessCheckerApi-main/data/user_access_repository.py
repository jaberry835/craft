"""
UserAccessRepository
Handles Cosmos DB queries for user access data.
(Ported from the Azure Function version — no Azure Functions dependency.)
"""
import logging
from typing import Optional

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential


class UserAccessRepository:
    """Repository for querying user access data from Cosmos DB."""

    def __init__(
        self,
        endpoint: str,
        database_name: str,
        container_name: str,
        key: Optional[str] = None,
    ):
        if not endpoint:
            raise ValueError("AZURE_COSMOS_DB_ENDPOINT is required")
        if not database_name:
            raise ValueError("AZURE_COSMOS_DB_DATABASE is required")
        if not container_name:
            raise ValueError("AZURE_COSMOS_DB_CONTAINER is required")

        self.logger = logging.getLogger(__name__)
        self.database_name = database_name
        self.container_name = container_name

        if key:
            self.logger.info("Initializing Cosmos client with key authentication")
            self.client = CosmosClient(endpoint, credential=key)
        else:
            self.logger.info("Initializing Cosmos client with DefaultAzureCredential")
            self.client = CosmosClient(endpoint, credential=DefaultAzureCredential())

    async def get_ss_tokens_by_login_async(self, login: str) -> Optional[list]:
        """Return the ss_tokens list for *login*, or None if not found."""
        try:
            database = self.client.get_database_client(self.database_name)
            container = database.get_container_client(self.container_name)

            query = "SELECT c.ss_tokens FROM c WHERE c.LoginID = @login"
            parameters = [{"name": "@login", "value": login}]

            items = list(
                container.query_items(
                    query=query,
                    parameters=parameters,
                    partition_key=login,
                    max_item_count=1,
                )
            )

            if items:
                ss_tokens = items[0].get("ss_tokens")
                self.logger.info("Found ss_tokens for %s", login)
                return ss_tokens

            self.logger.info("No ss_tokens found for %s", login)
            return None

        except Exception as exc:
            self.logger.error(
                "Error querying Cosmos DB for ss_tokens: %s", exc, exc_info=True
            )
            raise
