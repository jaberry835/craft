import logging
from typing import List, Dict, Any, Optional
from azure.kusto.client import KustoClient, KustoConnectionStringBuilder
from azure.identity import DefaultAzureCredential
import json

logger = logging.getLogger(__name__)

class AzureDataExplorerService:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.cluster_url = config["AzureDataExplorer"]["ClusterUrl"]
        self.database = config["AzureDataExplorer"]["Database"]
        self.client: Optional[KustoClient] = None
        
    async def initialize(self) -> None:
        """Initialize the ADX client"""
        try:
            # Use Azure Identity for authentication
            credential = DefaultAzureCredential()
            kcsb = KustoConnectionStringBuilder.with_azure_identity_credential(
                self.cluster_url, credential
            )
            self.client = KustoClient(kcsb)
            logger.info(f"ADX client initialized for cluster: {self.cluster_url}")
        except Exception as e:
            logger.error(f"Failed to initialize ADX client: {str(e)}")
            raise
    
    async def list_databases(self) -> List[str]:
        """List all databases in the cluster"""
        try:
            if not self.client:
                await self.initialize()
            
            query = ".show databases"
            response = self.client.execute("NetDefaultDB", query)
            
            databases = []
            for row in response.primary_results[0]:
                databases.append(row["DatabaseName"])
            
            return databases
        except Exception as e:
            logger.error(f"Error listing databases: {str(e)}")
            raise
    
    async def list_tables(self, database: str) -> List[Dict[str, Any]]:
        """List all tables in a database"""
        try:
            if not self.client:
                await self.initialize()
            
            query = ".show tables"
            response = self.client.execute(database, query)
            
            tables = []
            for row in response.primary_results[0]:
                tables.append({
                    "name": row["TableName"],
                    "folder": row.get("Folder", ""),
                    "doc_string": row.get("DocString", "")
                })
            
            return tables
        except Exception as e:
            logger.error(f"Error listing tables for database {database}: {str(e)}")
            raise
    
    async def describe_table(self, database: str, table: str) -> List[Dict[str, Any]]:
        """Get schema information for a table"""
        try:
            if not self.client:
                await self.initialize()
            
            query = f".show table {table} schema as json"
            response = self.client.execute(database, query)
            
            schema = []
            for row in response.primary_results[0]:
                schema_json = json.loads(row["Schema"])
                for column in schema_json.get("OrderedColumns", []):
                    schema.append({
                        "name": column["Name"],
                        "type": column["Type"],
                        "csl_type": column["CslType"]
                    })
            
            return schema
        except Exception as e:
            logger.error(f"Error describing table {database}.{table}: {str(e)}")
            raise
    
    async def execute_query(self, database: str, query: str) -> List[Dict[str, Any]]:
        """Execute a KQL query"""
        try:
            if not self.client:
                await self.initialize()
            
            # Add query limit for safety
            if not any(keyword in query.lower() for keyword in ["take", "limit", "top"]):
                query = f"{query} | take 100"
            
            response = self.client.execute(database, query)
            
            results = []
            if response.primary_results:
                for row in response.primary_results[0]:
                    # Convert row to dictionary
                    row_dict = {}
                    for i, column in enumerate(response.primary_results[0].columns):
                        row_dict[column.column_name] = row[i] if i < len(row) else None
                    results.append(row_dict)
            
            return results
        except Exception as e:
            logger.error(f"Error executing query in database {database}: {str(e)}")
            raise
