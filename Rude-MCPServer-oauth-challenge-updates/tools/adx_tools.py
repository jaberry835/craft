"""
Azure Data Explorer (ADX) Tools for Rude MCP Server
Tools for querying and exploring Azure Data Explorer clusters
Requires user impersonation via On-Behalf-Of flow for authentication
"""

import os
import logging
import json
import time
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from fastmcp import FastMCP
from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
from azure.kusto.data.exceptions import KustoServiceError
from context import current_user_token, current_user_id, current_session_id, get_user_token
from auth import SimpleTokenCredential, OnBehalfOfCredential, get_obo_credential

# Application Insights integration
try:
    from app_insights import get_application_insights
    APP_INSIGHTS_AVAILABLE = True
except ImportError:
    APP_INSIGHTS_AVAILABLE = False

logger = logging.getLogger(__name__)

@dataclass
class KustoConfig:
    """Configuration for Azure Data Explorer (Kusto) connections"""
    cluster_url: str
    database: Optional[str] = None
    
    @classmethod
    def from_env(cls) -> "KustoConfig":
        """Create config from environment variables"""
        cluster_url = os.getenv("KUSTO_CLUSTER_URL")
        if not cluster_url:
            raise ValueError("KUSTO_CLUSTER_URL environment variable is required")
        
        database = os.getenv("KUSTO_DEFAULT_DATABASE")
        return cls(cluster_url=cluster_url, database=database)


class KustoClientManager:
    """Manages Azure Data Explorer client connections with managed identity and user impersonation"""
    
    def __init__(self, config: KustoConfig):
        self.config = config

    def _get_user_credential(self, user_token: str):
        """Get Azure credential for user impersonation via On-Behalf-Of flow.
        
        Delegates to the shared auth module's get_obo_credential helper.
        """
        obo_scope = os.getenv("OBO_SCOPE", "https://kusto.kusto.usgovcloudapi.net/.default")
        return get_obo_credential(user_token, obo_scope)
        
    def get_client(self) -> KustoClient:
        """Get Kusto client with user impersonation - always creates fresh client with current token"""
        try:
            # Check if we have a user token for impersonation using the new helper
            user_token = get_user_token()
            
            # Debug logging
            logger.info(f"🔍 ADX get_client called - user token available: {'YES' if user_token else 'NO'}")
            if user_token:
                logger.info(f"🔍 Token details: length={len(user_token)}, preview={user_token[:10]}...")
            
            if not user_token:
                # No fallback - require user token for impersonation
                raise ValueError("❌ No user token available for Azure Data Explorer access. User authentication is required for ADX operations.")
            
            # USER IMPERSONATION MODE - always create fresh client (no caching)
            logger.info("� Creating fresh user-impersonated Kusto client with current token")
            
            try:
                credential = self._get_user_credential(user_token)
                kcsb = KustoConnectionStringBuilder.with_azure_token_credential(
                    self.config.cluster_url,
                    credential
                )
                client = KustoClient(kcsb)
                logger.info(f"✅ Created fresh Kusto client with user impersonation")
                
                return client
                
            except Exception as e:
                logger.error(f"❌ Failed to create user-impersonated client: {e}")
                logger.error(f"   - Error type: {type(e).__name__}")
                raise ValueError(f"Failed to create user-impersonated ADX client: {e}")
                
        except Exception as e:
            logger.error(f"❌ Error getting Kusto client: {e}")
            logger.error(f"   - Error type: {type(e).__name__}")
            # Re-raise the error instead of falling back
            raise
    



# Global Kusto client manager (initialized on first use)
_kusto_manager: Optional[KustoClientManager] = None

def get_kusto_manager() -> KustoClientManager:
    """Get or create the global Kusto client manager"""
    global _kusto_manager
    if _kusto_manager is None:
        try:
            config = KustoConfig.from_env()
            _kusto_manager = KustoClientManager(config)
        except Exception as e:
            logger.error(f"Failed to initialize Kusto manager: {e}")
            raise
    return _kusto_manager


def register_adx_tools(mcp: FastMCP):
    """Register all Azure Data Explorer tools with the FastMCP server"""
    
    @mcp.tool
    async def kusto_debug_auth() -> Dict[str, Any]:
        """Debug authentication setup and token information for troubleshooting"""
        try:
            debug_info = {
                "timestamp": time.time(),
                "environment": {},
                "context": {},
                "token_analysis": {},
                "credentials_test": {}
            }
            
            # Environment variables (without secrets)
            env_vars = [
                "KUSTO_CLUSTER_URL", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", 
                "AZURE_AUTHORITY_HOST", "OBO_SCOPE", "AZURE_CLOUD_NAME"
            ]
            
            for var in env_vars:
                value = os.getenv(var)
                if value:
                    if var in ["AZURE_TENANT_ID", "AZURE_CLIENT_ID"]:
                        debug_info["environment"][var] = f"{value[:8]}..."
                    else:
                        debug_info["environment"][var] = value
                else:
                    debug_info["environment"][var] = "NOT_SET"
            
            debug_info["environment"]["AZURE_CLIENT_SECRET"] = "SET" if os.getenv("AZURE_CLIENT_SECRET") else "NOT_SET"
            
            # Context information
            user_token = current_user_token.get(None)
            debug_info["context"]["user_id"] = current_user_id.get("unknown")
            debug_info["context"]["session_id"] = current_session_id.get("unknown")
            debug_info["context"]["has_user_token"] = bool(user_token)
            
            if user_token:
                debug_info["context"]["token_length"] = len(user_token)
                debug_info["context"]["token_preview"] = f"{user_token[:10]}..."
                
                # Token analysis
                try:
                    import base64
                    import json
                    parts = user_token.split('.')
                    if len(parts) >= 2:
                        payload = parts[1]
                        payload += '=' * (4 - len(payload) % 4)
                        decoded = base64.b64decode(payload)
                        token_data = json.loads(decoded)
                        
                        debug_info["token_analysis"]["audience"] = token_data.get('aud', 'N/A')
                        debug_info["token_analysis"]["issuer"] = token_data.get('iss', 'N/A')
                        debug_info["token_analysis"]["subject"] = f"{token_data.get('sub', 'N/A')[:20]}..." if token_data.get('sub') else 'N/A'
                        
                        exp = token_data.get('exp')
                        if exp:
                            from datetime import datetime
                            debug_info["token_analysis"]["expires"] = datetime.fromtimestamp(exp).isoformat()
                            debug_info["token_analysis"]["is_expired"] = exp < time.time()
                        
                        # Check if token is for ADX
                        audience = token_data.get('aud', '')
                        debug_info["token_analysis"]["is_adx_token"] = 'kusto' in audience.lower()
                        
                except Exception as e:
                    debug_info["token_analysis"]["error"] = str(e)
            
            # Test credentials creation (without actual ADX calls)
            try:
                manager = get_kusto_manager()
                
                # Test user credential creation if token available
                if user_token:
                    try:
                        user_cred = manager._get_user_credential(user_token)
                        debug_info["credentials_test"]["user_credential"] = "SUCCESS"
                        debug_info["credentials_test"]["credential_type"] = type(user_cred).__name__
                        
                        # Test token acquisition without storing the credential object
                        try:
                            obo_scope = os.getenv("OBO_SCOPE", "https://kusto.kusto.windows.net/.default")
                            token_result = user_cred.get_token(obo_scope)
                            debug_info["credentials_test"]["token_acquisition"] = "SUCCESS"
                            debug_info["credentials_test"]["token_preview"] = f"{token_result.token[:10]}..." if hasattr(token_result, 'token') else "N/A"
                        except Exception as token_error:
                            debug_info["credentials_test"]["token_acquisition"] = f"FAILED: {str(token_error)}"
                            
                    except Exception as e:
                        debug_info["credentials_test"]["user_credential"] = f"FAILED: {str(e)}"
                

            except Exception as e:
                debug_info["credentials_test"]["manager_error"] = str(e)
            
            logger.info(f"🔍 Authentication debug info generated: {len(str(debug_info))} characters")
            return debug_info
            
        except Exception as e:
            logger.error(f"❌ Failed to generate auth debug info: {e}")
            return {
                "error": str(e),
                "timestamp": time.time(),
                "status": "FAILED"
            }
    
    @mcp.tool
    async def kusto_test_connection() -> Dict[str, Any]:
        """Test connection to ADX with current authentication setup"""
        try:
            logger.info("🧪 Starting connection test...")
            
            manager = get_kusto_manager()
            client = manager.get_client()
            
            # Try cluster-level queries first (don't require specific database access)
            test_queries = [
                (".show version", "cluster management command"),
                (".show cluster", "cluster information"),
                (".show databases", "list accessible databases")
            ]
            
            results = []
            
            for query, description in test_queries:
                try:
                    logger.info(f"🔍 Testing {description}: {query}")
                    
                    start_time = time.time()
                    
                    # Try without specifying a database first
                    try:
                        response = client.execute_mgmt("", query)  # Empty database for management commands
                    except:
                        # Fallback to NetDefaultDB if needed
                        response = client.execute("NetDefaultDB", query)
                    
                    execution_time = (time.time() - start_time) * 1000
                    
                    # Parse response
                    result_data = []
                    if response.primary_results:
                        result_table = response.primary_results[0]
                        for row in result_table:
                            row_dict = {}
                            for i, column_name in enumerate(result_table.columns):
                                column_name_str = str(column_name)
                                row_dict[column_name_str] = row[i] if i < len(row) else None
                            result_data.append(row_dict)
                    
                    logger.info(f"✅ {description} successful in {execution_time:.2f}ms")
                    
                    results.append({
                        "query": query,
                        "description": description,
                        "status": "SUCCESS",
                        "execution_time_ms": execution_time,
                        "row_count": len(result_data),
                        "sample_data": result_data[:3]  # First 3 rows only
                    })
                    
                    # If we got this far, connection is working
                    break
                    
                except Exception as query_error:
                    logger.warning(f"⚠️ {description} failed: {query_error}")
                    results.append({
                        "query": query,
                        "description": description,
                        "status": "FAILED",
                        "error": str(query_error),
                        "error_type": type(query_error).__name__
                    })
                    continue
            
            # Check if any query succeeded
            success_count = sum(1 for r in results if r["status"] == "SUCCESS")
            
            if success_count > 0:
                logger.info(f"✅ Connection test successful - {success_count}/{len(results)} queries worked")
                return {
                    "status": "SUCCESS",
                    "successful_queries": success_count,
                    "total_queries": len(results),
                    "results": results,
                    "authentication_mode": "user_impersonation" if get_user_token() else "no_authentication",
                    "timestamp": time.time()
                }
            else:
                logger.error("❌ All connection tests failed")
                if not current_user_token.get(None):
                    err = "No user bearer token provided. ADX tools require Authorization header with bearer token."
                else:
                    err = "All test queries failed"
                return {
                    "status": "FAILED",
                    "error": err,
                    "results": results,
                    "authentication_mode": "user_impersonation" if get_user_token() else "no_authentication",
                    "timestamp": time.time()
                }
            
        except Exception as e:
            logger.error(f"❌ Connection test failed: {e}")
            error_str = str(e)
            
            # Analyze the error
            error_analysis = {
                "is_401": "401" in error_str,
                "is_403": "403" in error_str,
                "is_timeout": "timeout" in error_str.lower(),
                "is_network": any(term in error_str.lower() for term in ["network", "connection", "dns"]),
                "is_auth": any(term in error_str.lower() for term in ["auth", "credential", "token"])
            }
            
            return {
                "status": "FAILED",
                "error": error_str,
                "error_type": type(e).__name__,
                "error_analysis": error_analysis,
                "authentication_mode": "user_impersonation_only",
                "has_user_token": bool(current_user_token.get(None)),
                "timestamp": time.time()
            }
    
    @mcp.tool
    async def kusto_check_permissions() -> Dict[str, Any]:
        """Check what permissions the current user has in ADX"""
        try:
            logger.info("🔐 Checking user permissions...")
            
            manager = get_kusto_manager()
            client = manager.get_client()
            
            permission_checks = []
            
            # Test 1: Check cluster-level access
            try:
                logger.info("🔍 Testing cluster-level access...")
                response = client.execute_mgmt("", ".show principal access")
                permission_checks.append({
                    "check": "cluster_access",
                    "status": "SUCCESS",
                    "description": "Can access cluster management commands"
                })
            except Exception as e:
                permission_checks.append({
                    "check": "cluster_access", 
                    "status": "FAILED",
                    "error": str(e),
                    "description": "Cannot access cluster management commands"
                })
            
            # Test 2: List accessible databases
            try:
                logger.info("🔍 Listing accessible databases...")
                response = client.execute_mgmt("", ".show databases")
                
                databases = []
                if response.primary_results:
                    result_table = response.primary_results[0]
                    for row in result_table:
                        row_dict = {}
                        for i, column_name in enumerate(result_table.columns):
                            column_name_str = str(column_name)
                            row_dict[column_name_str] = row[i] if i < len(row) else None
                        databases.append(row_dict)
                
                permission_checks.append({
                    "check": "list_databases",
                    "status": "SUCCESS", 
                    "description": f"Can list databases - found {len(databases)}",
                    "databases": [db.get("DatabaseName", "unknown") for db in databases[:10]]
                })
                
            except Exception as e:
                permission_checks.append({
                    "check": "list_databases",
                    "status": "FAILED",
                    "error": str(e),
                    "description": "Cannot list databases"
                })
            
            # Test 3: Check specific database access (NetDefaultDB)
            try:
                logger.info("🔍 Testing NetDefaultDB access...")
                response = client.execute("NetDefaultDB", ".show database schema")
                permission_checks.append({
                    "check": "netdefaultdb_access",
                    "status": "SUCCESS",
                    "description": "Can access NetDefaultDB"
                })
            except Exception as e:
                permission_checks.append({
                    "check": "netdefaultdb_access",
                    "status": "FAILED", 
                    "error": str(e),
                    "description": "Cannot access NetDefaultDB"
                })
            
            # Test 4: Check current principal info
            try:
                logger.info("🔍 Getting current principal info...")
                response = client.execute_mgmt("", ".show current principal")
                
                principal_info = []
                if response.primary_results:
                    result_table = response.primary_results[0]
                    for row in result_table:
                        row_dict = {}
                        for i, column_name in enumerate(result_table.columns):
                            column_name_str = str(column_name)
                            row_dict[column_name_str] = row[i] if i < len(row) else None
                        principal_info.append(row_dict)
                
                permission_checks.append({
                    "check": "current_principal",
                    "status": "SUCCESS",
                    "description": "Retrieved current principal info",
                    "principal_info": principal_info
                })
                
            except Exception as e:
                permission_checks.append({
                    "check": "current_principal",
                    "status": "FAILED",
                    "error": str(e), 
                    "description": "Cannot get current principal info"
                })
            
            success_count = sum(1 for check in permission_checks if check["status"] == "SUCCESS")
            
            if not current_user_token.get(None):
                raise ValueError("No user bearer token present. Cannot check ADX permissions.")
            return {
                "status": "COMPLETED", 
                "successful_checks": success_count,
                "total_checks": len(permission_checks),
                "permission_checks": permission_checks,
                "authentication_mode": "user_impersonation" if get_user_token() else "no_authentication",
                "timestamp": time.time()
            }
            
        except Exception as e:
            logger.error(f"❌ Permission check failed: {e}")
            return {
                "status": "FAILED",
                "error": str(e),
                "error_type": type(e).__name__,
                "timestamp": time.time()
            }
    
    @mcp.tool
    async def kusto_get_auth_info() -> Dict[str, Any]:
        """Get information about the current authentication mode for ADX"""
        try:
            user_token = get_user_token()
            
            auth_info = {
                "has_user_token": bool(user_token),
                "authentication_mode": "user_impersonation" if user_token else "no_authentication",
                "cluster_url": get_kusto_manager().config.cluster_url
            }
            
            if user_token:
                auth_info["token_preview"] = f"{user_token[:10]}..."
                
                # Check if OBO environment variables are configured
                has_secret = bool(os.getenv("AZURE_CLIENT_SECRET"))
                has_cert = bool(os.getenv("AZURE_CLIENT_CERTIFICATE_PATH"))
                obo_vars = {
                    "AZURE_TENANT_ID": bool(os.getenv("AZURE_TENANT_ID")),
                    "AZURE_CLIENT_ID": bool(os.getenv("AZURE_CLIENT_ID")),
                    "AZURE_CLIENT_SECRET": has_secret,
                    "AZURE_CLIENT_CERTIFICATE_PATH": has_cert,
                    "AZURE_CLIENT_CERTIFICATE_THUMBPRINT": bool(os.getenv("AZURE_CLIENT_CERTIFICATE_THUMBPRINT"))
                }
                auth_info["obo_config"] = obo_vars
                auth_info["obo_credential_type"] = "certificate" if has_cert else ("secret" if has_secret else "none")
                auth_info["obo_ready"] = obo_vars["AZURE_TENANT_ID"] and obo_vars["AZURE_CLIENT_ID"] and (has_secret or has_cert)
            
            logger.info(f"Auth info: {auth_info['authentication_mode']}")
            return auth_info
            
        except Exception as e:
            logger.error(f"Error getting auth info: {e}")
            raise ValueError(f"Failed to get authentication info: {e}")
    
    @mcp.tool
    async def kusto_list_databases() -> List[Dict[str, Any]]:
        """List all databases in the Azure Data Explorer cluster"""
        try:
            logger.info("Attempting to connect to Kusto cluster...")
            
            # Debug: Check if user token is available using the new helper
            user_token = get_user_token()
            logger.info(f"🔍 kusto_list_databases - user token available: {'YES' if user_token else 'NO'}")
            if user_token:
                logger.info(f"🔍 Token details: length={len(user_token)}, preview={user_token[:10]}...")
            
            manager = get_kusto_manager()
            client = manager.get_client()
            
            logger.info("Executing .show databases query...")
            query = ".show databases"
            response = client.execute("", query)
            
            databases = []
            for row in response.primary_results[0]:
                databases.append({
                    "database_name": row["DatabaseName"],
                    "persistent_storage": row["PersistentStorage"],
                    "version": row["Version"],
                    "is_current": row["IsCurrent"],
                    "database_access_mode": row["DatabaseAccessMode"]
                })
            
            logger.info(f"Successfully listed {len(databases)} databases")
            return databases
            
        except KustoServiceError as e:
            logger.error(f"Kusto service error: {e}")
            raise ValueError(f"Failed to list databases: {e}")
        except Exception as e:
            logger.error(f"Unexpected error listing databases: {e}")
            logger.error(f"Error type: {type(e).__name__}")
            raise ValueError(f"Failed to list databases: {e}")

    @mcp.tool
    async def kusto_list_tables(database: str) -> List[Dict[str, Any]]:
        """List all tables in a specific database"""
        try:
            manager = get_kusto_manager()
            client = manager.get_client()
            
            query = ".show tables"
            response = client.execute(database, query)
            
            tables = []
            for row in response.primary_results[0]:
                table_info = {
                    "table_name": row["TableName"],
                    "database_name": row["DatabaseName"]
                }
                
                # Add optional fields safely
                try:
                    table_info["folder"] = row["Folder"] if "Folder" in row else ""
                except (KeyError, TypeError):
                    table_info["folder"] = ""
                    
                try:
                    table_info["doc_string"] = row["DocString"] if "DocString" in row else ""
                except (KeyError, TypeError):
                    table_info["doc_string"] = ""
                    
                tables.append(table_info)
            
            logger.info(f"Listed {len(tables)} tables in database '{database}'")
            return tables
            
        except KustoServiceError as e:
            logger.error(f"Kusto service error: {e}")
            raise ValueError(f"Failed to list tables in database '{database}': {e}")
        except Exception as e:
            logger.error(f"Unexpected error listing tables: {e}")
            raise ValueError(f"Failed to list tables in database '{database}': {e}")

    @mcp.tool
    async def kusto_describe_table(database: str, table: str) -> Dict[str, Any]:
        """Describe the schema of a specific table"""
        try:
            manager = get_kusto_manager()
            client = manager.get_client()
            
            # Get table schema
            schema_query = f".show table {table} schema as json"
            schema_response = client.execute(database, schema_query)
            
            # Get table details
            details_query = f".show table {table} details"
            details_response = client.execute(database, details_query)
            
            # Parse schema
            schema_data = json.loads(schema_response.primary_results[0][0]["Schema"])
            columns = []
            for col in schema_data.get("OrderedColumns", []):
                columns.append({
                    "name": col["Name"],
                    "type": col["Type"],
                    "csl_type": col["CslType"]
                })
            
            # Parse details
            details_row = details_response.primary_results[0][0]
            
            # Helper function to safely get values from KustoResultRow
            def safe_get(row, key, default=0):
                try:
                    return row[key] if key in row else default
                except (KeyError, TypeError):
                    return default
            
            result = {
                "database_name": database,
                "table_name": table,
                "columns": columns,
                "total_extents": safe_get(details_row, "TotalExtents", 0),
                "total_original_size": safe_get(details_row, "TotalOriginalSize", 0),
                "total_row_count": safe_get(details_row, "TotalRowCount", 0),
                "hot_original_size": safe_get(details_row, "HotOriginalSize", 0),
                "hot_row_count": safe_get(details_row, "HotRowCount", 0)
            }
            
            logger.info(f"Described table '{table}' in database '{database}' with {len(columns)} columns")
            return result
            
        except KustoServiceError as e:
            logger.error(f"Kusto service error: {e}")
            raise ValueError(f"Failed to describe table '{table}' in database '{database}': {e}")
        except Exception as e:
            logger.error(f"Unexpected error describing table: {e}")
            raise ValueError(f"Failed to describe table '{table}' in database '{database}': {e}")

    @mcp.tool
    async def kusto_query(database: str, query: str, max_rows: int = 1000) -> Dict[str, Any]:
        """Execute a KQL query against the specified database"""
        start_time = time.time()
        
        try:
            if max_rows > 10000:
                raise ValueError("max_rows cannot exceed 10,000 for safety")
                
            manager = get_kusto_manager()
            client = manager.get_client()
            
            # Add row limit to query if not already present
            limited_query = query.strip()
            if not any(keyword in limited_query.lower() for keyword in ['take', 'limit', 'top']):
                limited_query += f" | take {max_rows}"
            
            logger.info(f"Executing query in database '{database}': {limited_query[:100]}...")
            
            response = client.execute(database, limited_query)
            execution_time = (time.time() - start_time) * 1000  # Convert to milliseconds
            
            # Convert results to list of dictionaries
            rows = []
            if response.primary_results:
                result_table = response.primary_results[0]
                for row in result_table:
                    # Convert KustoResultRow to dictionary properly
                    row_dict = {}
                    try:
                        # Try to iterate through the row items
                        for i, column_name in enumerate(result_table.columns):
                            column_name_str = str(column_name)
                            row_dict[column_name_str] = row[i] if i < len(row) else None
                    except Exception as e:
                        logger.warning(f"Failed to parse row properly: {e}")
                        # Fallback: try to use string representation
                        row_dict = {"raw_data": str(row)}
                    rows.append(row_dict)
            
            result = {
                "database": database,
                "query": limited_query,
                "row_count": len(rows),
                "rows": rows,
                "execution_time": execution_time
            }
            
            # Log to Application Insights
            try:
                if APP_INSIGHTS_AVAILABLE:
                    app_insights = get_application_insights()
                    if app_insights.is_initialized():
                        # Determine query type from the query text
                        query_lower = limited_query.lower().strip()
                        if query_lower.startswith('show'):
                            query_type = 'metadata'
                        elif any(keyword in query_lower for keyword in ['count', 'summarize']):
                            query_type = 'aggregation'
                        elif 'where' in query_lower:
                            query_type = 'filtered_search'
                        else:
                            query_type = 'general'
                        
                        app_insights.log_adx_query_event(
                            database=database,
                            query_type=query_type,
                            row_count=len(rows),
                            execution_time=execution_time
                        )
            except Exception as e:
                logger.debug(f"Failed to log ADX query event to Application Insights: {e}")
            
            logger.info(f"Query executed successfully, returned {len(rows)} rows in {execution_time:.2f}ms")
            return result
            
        except KustoServiceError as e:
            execution_time = (time.time() - start_time) * 1000
            logger.error(f"Kusto service error after {execution_time:.2f}ms: {e}")
            
            # Log error to Application Insights
            try:
                if APP_INSIGHTS_AVAILABLE:
                    app_insights = get_application_insights()
                    if app_insights.is_initialized():
                        app_insights.log_custom_event('ADX_Query_Error', {
                            'database': database,
                            'error_type': 'KustoServiceError',
                            'error_message': str(e)
                        }, {
                            'execution_time_ms': execution_time
                        })
            except Exception as log_error:
                logger.debug(f"Failed to log ADX error event: {log_error}")
            
            raise ValueError(f"Failed to execute query: {e}")
        except Exception as e:
            logger.error(f"Unexpected error executing query: {e}")
            raise ValueError(f"Failed to execute query: {e}")

    @mcp.tool
    async def kusto_get_cluster_info() -> Dict[str, Any]:
        """Get information about the Azure Data Explorer cluster"""
        try:
            manager = get_kusto_manager()
            client = manager.get_client()
            
            # Get cluster information
            query = ".show cluster"
            response = client.execute("", query)
            
            cluster_info = {}
            if response.primary_results:
                row = response.primary_results[0][0]
                
                # Helper function to safely get values from KustoResultRow
                def safe_get(row, key, default=""):
                    try:
                        return row[key] if key in row else default
                    except (KeyError, TypeError):
                        return default
                
                cluster_info = {
                    "cluster_name": safe_get(row, "ClusterName", ""),
                    "cluster_type": safe_get(row, "ClusterType", ""),
                    "cluster_state": safe_get(row, "ClusterState", ""),
                    "version": safe_get(row, "Version", ""),
                    "service_uri": safe_get(row, "ServiceUri", "")
                }
            
            # Get database count
            db_query = ".show databases | count"
            db_response = client.execute("", db_query)
            database_count = db_response.primary_results[0][0]["Count"] if db_response.primary_results else 0
            
            cluster_info["database_count"] = database_count
            cluster_info["cluster_url"] = manager.config.cluster_url
            
            logger.info(f"Retrieved cluster info for: {cluster_info.get('cluster_name', 'Unknown')}")
            return cluster_info
            
        except KustoServiceError as e:
            logger.error(f"Kusto service error: {e}")
            raise ValueError(f"Failed to get cluster info: {e}")
        except Exception as e:
            logger.error(f"Unexpected error getting cluster info: {e}")
            raise ValueError(f"Failed to get cluster info: {e}")

    logger.info("Azure Data Explorer tools registered successfully")
