"""
Azure Data Explorer (ADX) agent for data analytics and querying operations.
Handles KQL queries, data exploration, and analytics.
"""

import logging
from typing import List, Dict, Any, Optional

from .base_agent import BaseAgent
try:
    from ..models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, McpProperty, McpToolInputSchema
except ImportError:
    # Fallback for when running directly
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))
    from models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, McpProperty, McpToolInputSchema

# Azure Kusto imports
try:
    from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
    from azure.kusto.data.exceptions import KustoServiceError
    from azure.identity import DefaultAzureCredential, ClientSecretCredential
    KUSTO_AVAILABLE = True
except ImportError:
    KUSTO_AVAILABLE = False
    logging.warning("Azure Kusto libraries not available")

logger = logging.getLogger(__name__)

class ADXAgent(BaseAgent):
    """Specialized agent for Azure Data Explorer operations"""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.kusto_client: Optional[KustoClient] = None
        self.cluster_url = config.get('AzureDataExplorer', {}).get('ClusterUrl', '')
        self.database = config.get('AzureDataExplorer', {}).get('Database', 'Personnel')
        self.azure_config = config.get('Azure', {})
        
    @property
    def agent_id(self) -> str:
        return "adx-agent"
    
    @property
    def name(self) -> str:
        return "Azure Data Explorer Agent"
    @property
    def description(self) -> str:
        return "Specialized agent for Azure Data Explorer analytics and KQL queries"
    
    @property
    def domains(self) -> List[str]:
        return ["adx", "analytics", "data", "kql", "kusto", "query"]
    
    async def _on_initialize_async(self, user_token: Optional[str]) -> None:
        """Initialize the ADX Agent"""
        logger.info("Initializing ADX Agent")
        if not KUSTO_AVAILABLE:
            logger.warning("Azure Kusto libraries not available")
            return
            
        if not self.cluster_url:
            logger.warning("No ADX cluster URL configured")
            return
        
        try:
            # Use DefaultAzureCredential for authentication (like C# version)
            credential = DefaultAzureCredential()
            
            # Build connection string using AAD token credentials
            # Try different possible method names for authentication
            if hasattr(KustoConnectionStringBuilder, 'with_aad_token_provider'):
                kcsb = KustoConnectionStringBuilder.with_aad_token_provider(
                    self.cluster_url, credential.get_token
                )
            elif hasattr(KustoConnectionStringBuilder, 'with_azure_token_credential'):
                kcsb = KustoConnectionStringBuilder.with_azure_token_credential(
                    self.cluster_url, credential
                )
            elif hasattr(KustoConnectionStringBuilder, 'with_aad_device_authentication'):
                # Fallback to device authentication
                kcsb = KustoConnectionStringBuilder.with_aad_device_authentication(
                    self.cluster_url
                )
            else:
                # Use application credentials from config
                if self.azure_config.get('ClientId') and self.azure_config.get('ClientSecret') and self.azure_config.get('TenantId'):
                    kcsb = KustoConnectionStringBuilder.with_aad_application_key_authentication(
                        self.cluster_url,
                        self.azure_config['ClientId'],
                        self.azure_config['ClientSecret'],
                        self.azure_config['TenantId']
                    )
                else:
                    raise Exception("No supported authentication method found")
            
            self.kusto_client = KustoClient(kcsb)
            logger.info(f"✅ ADX Client initialized for cluster: {self.cluster_url}")
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize ADX client: {str(e)}")
            self.kusto_client = None
    
    async def get_available_tools_async(self) -> List[McpTool]:
        """Get all tools that this agent can execute"""
        try:
            tools = [
                McpTool(
                    name="execute_kql_query",
                    description="Execute a KQL (Kusto Query Language) query against Azure Data Explorer",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "query": McpProperty(
                                type="string",
                                description="The KQL query to execute"
                            ),
                            "database": McpProperty(
                                type="string",
                                description="The ADX database to query against (optional)"
                            )
                        },
                        required=["query"]
                    )
                ),
                McpTool(
                    name="list_adx_databases",
                    description="List all available Azure Data Explorer databases",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={},
                        required=[]
                    )
                ),                McpTool(
                    name="list_adx_tables",
                    description=f"List all tables in a specific ADX database (default: {self.database})",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "database": McpProperty(
                                type="string",
                                description=f"The ADX database to list tables from (optional, defaults to '{self.database}')"
                            )
                        },
                        required=[]
                    )
                ),
                McpTool(
                    name="describe_adx_table",
                    description="Get the schema and description of a specific ADX table",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "database": McpProperty(
                                type="string",
                                description="The ADX database containing the table"
                            ),
                            "table": McpProperty(
                                type="string",
                                description="The table name to describe"
                            )
                        },
                        required=["database", "table"]
                    )
                )
            ]
            
            logger.debug(f"ADX Agent providing {len(tools)} tools")
            return tools
        except Exception as e:
            logger.error(f"Failed to get ADX tools: {str(e)}")
            return []
    
    async def execute_tool_async(self, request: McpToolCallRequest) -> McpToolCallResponse:
        """Execute a tool request"""
        logger.info(f"ADX Agent executing tool: {request.name}")
        
        try:
            if request.name == "execute_kql_query":
                return await self._execute_kql_query(request.arguments)
            elif request.name == "list_adx_databases":
                return await self._execute_list_databases(request.arguments)
            elif request.name == "list_adx_tables":
                return await self._execute_list_tables(request.arguments)
            elif request.name == "describe_adx_table":
                return await self._execute_describe_table(request.arguments)
            else:
                return self._create_cannot_answer_response(f"Unknown ADX tool: {request.name}")
        except Exception as e:
            return self._create_error_response(f"ADX Agent failed to execute tool {request.name}", e)
    
    async def can_handle_tool_async(self, tool_name: str) -> bool:
        """Check if this agent can handle the specified tool"""
        adx_tools = ["execute_kql_query", "list_adx_databases", "list_adx_tables", "describe_adx_table"]
        return tool_name in adx_tools
    
    async def _perform_health_check_async(self) -> bool:
        """Perform ADX Agent health check"""
        try:
            # Check if ADX is configured
            adx_cluster = self._config.get("Azure", {}).get("DataExplorer", {}).get("ClusterUri")
            
            if not adx_cluster:
                logger.warning("ADX Agent: Azure Data Explorer cluster not configured")
                return False
                
            # Simple health check - verify we can get tools
            tools = await self.get_available_tools_async()
            return len(tools) > 0
        except Exception as e:
            logger.warning(f"ADX Agent health check failed: {str(e)}")
            return False
    
    async def _execute_kql_query(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute a KQL query"""
        # Unwrap kwargs if present (from Semantic Kernel)
        if 'kwargs' in arguments:
            arguments = arguments['kwargs']
        
        logger.info(f"🔧 Execute KQL query called with arguments: {arguments}")
        
        # Handle both 'query' and 'kql' parameter names for compatibility
        query = arguments.get("query", "") or arguments.get("kql", "")
        database = arguments.get("database", self.database)
        
        # If someone passed a non-existent database name like "Employees" or "default", 
        # fall back to the configured database
        if database and database.lower() in ['employees', 'default', 'personnel_db']:
            logger.info(f"🔧 Mapping database '{database}' to configured database '{self.database}'")
            database = self.database
        
        if not query:
            return self._create_error_response("No KQL query provided")
        
        logger.info(f"🔧 Using database: {database}, query: {query}")
        
        try:
            if not self.kusto_client:
                await self._on_initialize_async(None)
                
            if not self.kusto_client:
                return self._create_error_response("ADX client not initialized. Please check cluster configuration.")
            
            logger.info(f"🔧 Executing KQL query in database '{database}': {query}")
            response = self.kusto_client.execute(database, query)
            
            if response.primary_results and len(response.primary_results) > 0:
                result_table = response.primary_results[0]
                
                # Format results as a table
                message = f"KQL Query Results from database '{database}':\n\n"
                message += f"Query: {query}\n\n"
                
                if len(result_table) > 0:
                    # Get column names
                    columns = [col.column_name for col in result_table.columns] if hasattr(result_table, 'columns') else []
                    
                    if columns:
                        # Header row
                        message += " | ".join(columns) + "\n"
                        message += "-" * (len(" | ".join(columns))) + "\n"
                    
                    # Data rows (limit to first 10 for readability)
                    for i, row in enumerate(result_table):
                        if i >= 10:
                            message += f"... and {len(result_table) - 10} more rows\n"
                            break
                        
                        if columns:
                            # Extract row values using proper KustoResultRow access
                            row_values = []
                            for col in columns:
                                try:
                                    value = row[col]
                                    row_values.append(str(value) if value is not None else '')
                                except (KeyError, TypeError, IndexError) as e:
                                    logger.debug(f"🔧 Column '{col}' not found in row: {e}")
                                    row_values.append('')
                            message += " | ".join(row_values) + "\n"
                        else:
                            # Convert row to string representation safely
                            message += str(row) + "\n"
                    
                    message += f"\nReturned {len(result_table)} rows"
                else:
                    message += "Query executed successfully but returned no results."
            else:
                message = f"Query executed in database '{database}' but no results returned.\n"
                message += f"Query: {query}"
            
            return McpToolCallResponse.success(message)
            
        except Exception as e:
            logger.error(f"Error executing KQL query: {str(e)}")
            return self._create_error_response(f"Failed to execute query: {str(e)}")
    
    async def _execute_list_databases(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """List ADX databases"""
        # Unwrap kwargs if present (from Semantic Kernel)
        if 'kwargs' in arguments:
            arguments = arguments['kwargs']
        
        logger.info(f"🔧 List databases called with arguments: {arguments}")
        
        try:
            if not self.kusto_client:
                # Try to initialize if not already done
                await self._on_initialize_async(None)
                
            if not self.kusto_client:
                return self._create_error_response("ADX client not initialized. Please check cluster configuration.")
              # Query to list all databases
            query = ".show databases"
            logger.info(f"🔧 Executing ADX query: {query}")
            response = self.kusto_client.execute("", query)
            logger.info(f"🔧 ADX response received: {response}")
            
            databases = []
            if response.primary_results and len(response.primary_results) > 0:
                result_table = response.primary_results[0]
                logger.info(f"🔧 Result table has {len(result_table)} rows")
                
                # Debug: Print column names
                if hasattr(result_table, 'columns'):
                    logger.info(f"🔧 Available columns: {[col.column_name for col in result_table.columns]}")
                
                for i, row in enumerate(result_table):
                    # Debug row data safely
                    logger.info(f"🔧 Row {i}: type={type(row)}, repr={repr(row)}")
                    
                    # Try different possible column names
                    db_name = None
                    for col_name in ['DatabaseName', 'Database', 'Name']:
                        try:
                            db_name = row[col_name]
                            if db_name:
                                logger.info(f"🔧 Found database name '{db_name}' in column '{col_name}'")
                                break
                        except (KeyError, TypeError, IndexError) as e:
                            logger.debug(f"🔧 Column '{col_name}' not found: {e}")
                            continue
                    
                    if db_name:
                        databases.append(db_name)
            else:
                logger.warning(f"🔧 No primary results found. Response: {response}")
            
            # Always include the configured database if we have one
            if self.database and self.database not in databases:
                databases.append(self.database)
                logger.info(f"🔧 Added configured database: {self.database}")
            
            if databases:
                message = "Available ADX Databases:\n\n"
                for i, db in enumerate(databases, 1):
                    message += f"{i}. {db}\n"
                message += f"\nFound {len(databases)} databases on cluster: {self.cluster_url}"
            else:
                message = f"Unable to list databases. Let me try to query the configured database '{self.database}' directly.\n"
                message += f"Cluster: {self.cluster_url}\n\n"
                
                # Try to query the configured database to see if it exists
                try:
                    test_query = ".show tables"
                    test_response = self.kusto_client.execute(self.database, test_query)
                    if test_response.primary_results and len(test_response.primary_results) > 0:
                        table_count = len(test_response.primary_results[0])
                        message += f"✅ Successfully connected to database '{self.database}' - found {table_count} tables.\n"
                        message += f"Available database: {self.database}"
                    else:
                        message += f"❌ Database '{self.database}' appears to be empty or inaccessible."
                except Exception as e:
                    message += f"❌ Unable to connect to database '{self.database}': {str(e)}"
            
            return McpToolCallResponse.success(message)
            
        except Exception as e:
            logger.error(f"Error listing ADX databases: {str(e)}")
            return self._create_error_response(f"Failed to list databases: {str(e)}")
    async def _execute_list_tables(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """List tables in an ADX database"""
        # Unwrap kwargs if present (from Semantic Kernel)
        if 'kwargs' in arguments:
            arguments = arguments['kwargs']
        
        logger.info(f"🔧 List tables called with arguments: {arguments}")
        
        # Look for database parameter with fallback to configured database
        database = arguments.get("database") or arguments.get("database_name") or self.database
        
        # If someone passed a non-existent database name like "Employees" or "default", 
        # fall back to the configured database
        if database and database.lower() in ['employees', 'default', 'personnel_db']:
            logger.info(f"🔧 Mapping database '{database}' to configured database '{self.database}'")
            database = self.database
        
        if not database:
            return self._create_error_response("No database name provided and no default database configured")
        
        logger.info(f"🔧 Using database: {database}")
        
        try:
            if not self.kusto_client:
                await self._on_initialize_async(None)
                
            if not self.kusto_client:
                return self._create_error_response("ADX client not initialized. Please check cluster configuration.")
            
            # Query to list all tables in the specified database
            query = ".show tables"
            response = self.kusto_client.execute(database, query)
            
            tables = []
            if response.primary_results and len(response.primary_results) > 0:
                result_table = response.primary_results[0]
                for row in result_table:
                    # Try different possible column names for table names
                    table_name = None
                    for col_name in ['TableName', 'Table', 'Name']:
                        try:
                            table_name = row[col_name]
                            if table_name:
                                break
                        except (KeyError, TypeError, IndexError):
                            continue
                    
                    if table_name:
                        tables.append(table_name)
            
            if tables:
                message = f"Tables in ADX Database '{database}':\n\n"
                for i, table in enumerate(tables, 1):
                    message += f"{i}. {table}\n"
                message += f"\nFound {len(tables)} tables in database '{database}'"
            else:
                message = f"No tables found in database '{database}' or unable to list tables."
            
            return McpToolCallResponse.success(message)
            
        except Exception as e:
            logger.error(f"Error listing ADX tables: {str(e)}")
            return self._create_error_response(f"Failed to list tables in database '{database}': {str(e)}")
    
    async def _execute_describe_table(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Describe an ADX table schema"""
        # Unwrap kwargs if present (from Semantic Kernel)
        if 'kwargs' in arguments:
            arguments = arguments['kwargs']
        
        logger.info(f"🔧 Describe table called with arguments: {arguments}")
        
        # Handle multiple parameter name variations
        database = arguments.get("database", "") or arguments.get("database_name", "") or self.database
        table = arguments.get("table", "") or arguments.get("table_name", "")
        
        # If someone passed a non-existent database name like "Employees" or "default", 
        # fall back to the configured database
        if database and database.lower() in ['employees', 'default', 'personnel_db']:
            logger.info(f"🔧 Mapping database '{database}' to configured database '{self.database}'")
            database = self.database
        
        logger.info(f"🔧 Describing table '{table}' in database '{database}' with args: {arguments}")
        
        if not database or not table:
            return self._create_error_response(f"Database and table names are required. Got database='{database}', table='{table}'")
        
        try:
            if not self.kusto_client:
                await self._on_initialize_async(None)
                
            if not self.kusto_client:
                return self._create_error_response("ADX client not initialized. Please check cluster configuration.")
            
            # Query to describe the table schema
            query = f".show table {table} schema as json"
            logger.info(f"🔧 Executing ADX schema query: {query}")
            response = self.kusto_client.execute(database, query)
            
            message = f"Schema for ADX Table '{database}.{table}':\n\n"
            
            if response.primary_results and len(response.primary_results) > 0:
                result_table = response.primary_results[0]
                
                if len(result_table) > 0:
                    # Get the schema JSON from the result
                    for row in result_table:
                        try:
                            # The schema is typically in a 'Schema' column
                            schema_json = row.get('Schema') or row.get('TableSchema') or str(row)
                            message += f"Table Schema:\n{schema_json}\n\n"
                            break
                        except Exception as e:
                            logger.debug(f"Error extracting schema: {e}")
                            message += f"Raw schema data: {str(row)}\n"
                else:
                    message += "Table schema query returned no results.\n"
            else:
                message += "Unable to retrieve table schema.\n"
            
            # Also try to get column information
            try:
                columns_query = f".show table {table}"
                logger.info(f"🔧 Executing ADX table info query: {columns_query}")
                columns_response = self.kusto_client.execute(database, columns_query)
                
                if columns_response.primary_results and len(columns_response.primary_results) > 0:
                    columns_table = columns_response.primary_results[0]
                    
                    if len(columns_table) > 0:
                        message += "\nTable Information:\n"
                        for row in columns_table:
                            try:
                                # Extract table info
                                message += f"Raw table info: {str(row)}\n"
                            except Exception as e:
                                logger.debug(f"Error extracting table info: {e}")
            except Exception as e:
                logger.debug(f"Could not get table details: {e}")
                message += f"\nNote: Could not retrieve detailed table information: {str(e)}"
            
            return McpToolCallResponse.success(message)
            
        except Exception as e:
            logger.error(f"Error describing ADX table: {str(e)}")
            return self._create_error_response(f"Failed to describe table '{table}' in database '{database}': {str(e)}")
