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
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
from context import current_user_token, current_user_id, current_session_id, get_user_token
import msal

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


class SimpleTokenCredential:
    """Simple credential wrapper for pre-obtained ADX tokens"""
    
    def __init__(self, access_token: str):
        self.access_token = access_token
        logger.info("🔧 SimpleTokenCredential created")
        
        # Try to parse token expiration for better expires_on value
        self._actual_expires_on = None
        try:
            import base64
            import json
            parts = access_token.split('.')
            if len(parts) >= 2:
                payload = parts[1]
                payload += '=' * (4 - len(payload) % 4)
                decoded = base64.b64decode(payload)
                token_data = json.loads(decoded)
                exp = token_data.get('exp')
                if exp:
                    self._actual_expires_on = exp
                    logger.info(f"🔍 SimpleTokenCredential: parsed token expiration: {exp}")
        except Exception as e:
            logger.debug(f"Could not parse token expiration: {e}")
        
    def get_token(self, *scopes, **kwargs):
        """Return the pre-obtained token in the format expected by Azure SDK"""
        logger.info(f"🔄 SimpleTokenCredential.get_token called with scopes: {scopes}")
        
        # Create a simple object with the token attribute
        class TokenResponse:
            def __init__(self, token, expires_on):
                self.token = token
                self.expires_on = expires_on
        
        # Use actual expiration if available, otherwise default to 1 hour
        expires_on = self._actual_expires_on if self._actual_expires_on else (int(time.time()) + 3600)
        
        logger.info(f"🔍 SimpleTokenCredential returning token with expires_on: {expires_on}")
        
        return TokenResponse(
            token=self.access_token,
            expires_on=expires_on
        )


class OnBehalfOfCredential:
    """Custom credential class for On-Behalf-Of flow using MSAL"""
    
    def __init__(self, tenant_id: str, client_id: str, client_secret: str, user_assertion: str):
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.user_assertion = user_assertion
        self._token_cache = {}
        
    def get_token(self, *scopes, **kwargs):
        """Get access token using On-Behalf-Of flow"""
        scope_key = "|".join(scopes)
        
        # Check cache first (simple time-based cache could be added)
        if scope_key in self._token_cache:
            cached_token = self._token_cache[scope_key]
            # Simple expiry check (you might want to add buffer time)
            if hasattr(cached_token, 'expires_on') and cached_token.expires_on > time.time():
                return cached_token
        
        try:
            # Create MSAL confidential client app
            # Use Azure Government endpoint for government clouds
            authority_base = os.getenv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.us")
            app = msal.ConfidentialClientApplication(
                self.client_id,
                authority=f"{authority_base}/{self.tenant_id}",
                client_credential=self.client_secret
            )
            
            # Acquire token on behalf of user
            # Request token for ADX specifically
            adx_scope = "https://kusto.kusto.usgovcloudapi.net/.default"
            result = app.acquire_token_on_behalf_of(
                user_assertion=self.user_assertion,
                scopes=[adx_scope]
            )
            
            if "access_token" in result:
                # Create a token response object with the expected attributes
                class TokenResponse:
                    def __init__(self, token, expires_on):
                        self.token = token
                        self.expires_on = expires_on
                
                token_response = TokenResponse(
                    token=result['access_token'],
                    expires_on=result.get('expires_in', 3600) + int(time.time())
                )
                
                # Cache the token response
                self._token_cache[scope_key] = token_response
                
                logger.info("Successfully acquired token via On-Behalf-Of flow")
                return token_response
            else:
                error_msg = result.get('error_description', result.get('error', 'Unknown error'))
                logger.error(f"Failed to acquire token via OBO: {error_msg}")
                raise Exception(f"Failed to acquire token via On-Behalf-Of flow: {error_msg}")
                
        except Exception as e:
            logger.error(f"Error in On-Behalf-Of token acquisition: {e}")
            raise


class KustoClientManager:
    """Manages Azure Data Explorer client connections with managed identity and user impersonation"""
    
    def __init__(self, config: KustoConfig):
        self.config = config
        self._service_client: Optional[KustoClient] = None  # Cache only for service identity
        self._service_credential = None

    def _get_service_credential(self):  # Deprecated path retained to avoid accidental calls
        raise RuntimeError("Service identity authentication disabled: user bearer token required")
    
    def _get_user_credential(self, user_token: str):
        """Get Azure credential for user impersonation via On-Behalf-Of flow"""
        try:
            logger.info("🔄 Starting user credential creation for OBO flow...")
            logger.info(f"🔍 Token preview: {user_token[:50]}...")
            logger.info(f"🔍 Token length: {len(user_token)} characters")
            
            # Check if the token is already for ADX (based on audience)
            # If so, we can use it directly instead of OBO flow
            import base64
            import json
            
            try:
                logger.info("🔍 Attempting to decode JWT token to check audience...")
                # Decode the JWT token to check the audience
                parts = user_token.split('.')
                if len(parts) >= 2:
                    # Add padding if needed
                    payload = parts[1]
                    payload += '=' * (4 - len(payload) % 4)
                    decoded = base64.b64decode(payload)
                    token_data = json.loads(decoded)
                    audience = token_data.get('aud', '')
                    issuer = token_data.get('iss', '')
                    subject = token_data.get('sub', '')
                    
                    logger.info(f"🔍 Token decoded successfully:")
                    logger.info(f"   - Audience (aud): {audience}")
                    logger.info(f"   - Issuer (iss): {issuer}")
                    logger.info(f"   - Subject (sub): {subject[:20]}..." if subject else "   - Subject: None")
                    
                    # If token is already for ADX, create a simple credential wrapper
                    if 'kusto' in audience.lower():
                        logger.info("✅ Token is already for ADX, using directly with SimpleTokenCredential")
                        return SimpleTokenCredential(user_token)
                    else:
                        logger.info("🔄 Token is not for ADX, proceeding with OBO flow")
                        logger.info(f"   - Expected: audience containing 'kusto'")
                        logger.info(f"   - Actual: {audience}")
                        
                        # Check if token is expired
                        exp = token_data.get('exp')
                        if exp:
                            import time
                            from datetime import datetime
                            if exp < time.time():
                                logger.error("❌ Token is expired!")
                                logger.error(f"   - Expired at: {datetime.fromtimestamp(exp)}")
                                logger.error(f"   - Current time: {datetime.fromtimestamp(time.time())}")
                                raise ValueError("User token is expired")
                        
                        # Check token type
                        token_use = token_data.get('token_use', 'unknown')
                        logger.info(f"🔍 Token use: {token_use}")
                        
                        # Validate it's an access token (not ID token)
                        if token_use == 'id':
                            logger.warning("⚠️ This appears to be an ID token, not an access token")
                            logger.warning("   OBO flow may fail - need an access token instead")
            except Exception as e:
                logger.warning(f"⚠️ Could not decode token, proceeding with OBO: {e}")
            
            # Log environment configuration for OBO flow
            logger.info("🔧 Checking OBO flow environment configuration...")
            
            # Get required environment variables for OBO flow
            tenant_id = os.getenv("AZURE_TENANT_ID")
            client_id = os.getenv("AZURE_CLIENT_ID") 
            client_secret = os.getenv("AZURE_CLIENT_SECRET")
            authority_host = os.getenv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.com")
            obo_scope = os.getenv("OBO_SCOPE", "https://kusto.kusto.windows.net/.default")
            
            logger.info(f"🔍 Environment variables:")
            logger.info(f"   - AZURE_TENANT_ID: {'SET (' + tenant_id[:8] + '...)' if tenant_id else 'NOT_SET'}")
            logger.info(f"   - AZURE_CLIENT_ID: {'SET (' + client_id[:8] + '...)' if client_id else 'NOT_SET'}")
            logger.info(f"   - AZURE_CLIENT_SECRET: {'SET (****)' if client_secret else 'NOT_SET'}")
            logger.info(f"   - AZURE_AUTHORITY_HOST: {authority_host}")
            logger.info(f"   - OBO_SCOPE: {obo_scope}")
            
            if not all([tenant_id, client_id, client_secret]):
                missing = [name for name, value in [
                    ("AZURE_TENANT_ID", tenant_id),
                    ("AZURE_CLIENT_ID", client_id), 
                    ("AZURE_CLIENT_SECRET", client_secret)
                ] if not value]
                error_msg = f"Missing required environment variables for OBO flow: {', '.join(missing)}"
                logger.error(f"❌ {error_msg}")
                raise ValueError(error_msg)
            
            # Create OBO credential with logging
            logger.info("🔧 Creating OnBehalfOfCredential...")
            try:
                credential = OnBehalfOfCredential(
                    tenant_id=tenant_id,
                    client_id=client_id,
                    client_secret=client_secret,
                    user_assertion=user_token
                )
                
                logger.info("✅ OnBehalfOfCredential created successfully")
                
                # Test the credential by getting a token
                logger.info("🧪 Testing OBO credential by requesting token...")
                try:
                    token_scope = obo_scope
                    logger.info(f"🔍 Requesting token for scope: {token_scope}")
                    token_result = credential.get_token(token_scope)
                    logger.info(f"✅ OBO token obtained successfully")
                    logger.info(f"   - Token preview: {token_result.token[:50]}...")
                    logger.info(f"   - Expires on: {token_result.expires_on}")
                    
                    # Validate the new token
                    try:
                        import base64
                        import json
                        new_parts = token_result.token.split('.')
                        if len(new_parts) >= 2:
                            new_payload = new_parts[1]
                            new_payload += '=' * (4 - len(new_payload) % 4)
                            new_decoded = base64.b64decode(new_payload)
                            new_token_data = json.loads(new_decoded)
                            new_audience = new_token_data.get('aud', '')
                            logger.info(f"🔍 New token audience: {new_audience}")
                            logger.info(f"🔍 New token is for ADX: {'kusto' in new_audience.lower()}")
                    except Exception as validate_error:
                        logger.debug(f"Could not validate new token: {validate_error}")
                    
                except Exception as token_error:
                    logger.error(f"❌ Failed to get OBO token: {token_error}")
                    logger.error(f"   - Error type: {type(token_error).__name__}")
                    logger.error(f"   - Scope attempted: {token_scope}")
                    
                    # More specific error analysis
                    error_str = str(token_error).lower()
                    if "aadsts50013" in error_str:
                        logger.error("🔍 AADSTS50013: Assertion is not valid - token may be wrong type")
                    elif "aadsts500131" in error_str:
                        logger.error("🔍 AADSTS500131: Invalid audience - check OBO_SCOPE configuration")
                    elif "aadsts65001" in error_str:
                        logger.error("🔍 AADSTS65001: App not found - check AZURE_CLIENT_ID")
                    elif "aadsts7000215" in error_str:
                        logger.error("🔍 AADSTS7000215: Invalid client secret")
                    elif "401" in error_str:
                        logger.error("🔍 401 Unauthorized in OBO token request")
                    
                    raise
                
                return credential
                
            except Exception as cred_error:
                logger.error(f"❌ Failed to create OnBehalfOfCredential: {cred_error}")
                logger.error(f"   - Error type: {type(cred_error).__name__}")
                raise
            
        except Exception as e:
            logger.error(f"❌ _get_user_credential failed: {e}")
            logger.error(f"   - Error type: {type(e).__name__}")
            raise
            
        except Exception as e:
            logger.error(f"Failed to create user credential: {e}")
            raise
        
    def get_client(self) -> KustoClient:
        """Get Kusto client with user impersonation - always creates fresh client with current token"""
        try:
            # Check if we have a user token for impersonation using the new helper
            user_token = get_user_token()
            
            # Debug logging
            logger.info(f"🔍 ADX get_client called - user token available: {'YES' if user_token else 'NO'}")
            if user_token:
                logger.info(f"🔍 Token details: length={len(user_token)}, preview={user_token[:30]}...")
            
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
    
    def _get_service_client(self) -> KustoClient:
        """Get or create service identity Kusto client"""
        if self._service_client is None:
            try:
                logger.info("🔐 Creating service identity Kusto client...")
                logger.info("🔍 Using DefaultAzureCredential (tries: ManagedIdentity → WorkloadIdentity → AzureCLI → ...)")
                
                credential = self._get_service_credential()
                kcsb = KustoConnectionStringBuilder.with_azure_token_credential(
                    self.config.cluster_url,
                    credential
                )
                self._service_client = KustoClient(kcsb)
                logger.info(f"✅ Connected to Kusto cluster with service identity: {self.config.cluster_url}")
                
                # Test the service client
                logger.info("🧪 Testing service identity client connection...")
                try:
                    test_response = self._service_client.execute("NetDefaultDB", "print 'SERVICE_IDENTITY_TEST'")
                    logger.info("✅ Service identity client test successful")
                except Exception as test_error:
                    logger.error(f"❌ Service identity client test failed: {test_error}")
                    logger.error(f"   - Error type: {type(test_error).__name__}")
                    # Don't fail here, let the actual query attempt handle the error
                
            except Exception as e:
                logger.error(f"❌ Failed to create service Kusto client: {e}")
                logger.error(f"   - Error type: {type(e).__name__}")
                logger.error(f"   - Cluster URL: {self.config.cluster_url}")
                raise
        else:
            logger.info("♻️ Reusing existing service identity client")
            
        return self._service_client


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
                debug_info["context"]["token_preview"] = f"{user_token[:50]}..."
                
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
                            debug_info["credentials_test"]["token_preview"] = f"{token_result.token[:50]}..." if hasattr(token_result, 'token') else "N/A"
                        except Exception as token_error:
                            debug_info["credentials_test"]["token_acquisition"] = f"FAILED: {str(token_error)}"
                            
                    except Exception as e:
                        debug_info["credentials_test"]["user_credential"] = f"FAILED: {str(e)}"
                
                # Test service credential creation
                try:
                    service_cred = manager._get_service_credential()
                    debug_info["credentials_test"]["service_credential"] = "SUCCESS"
                    debug_info["credentials_test"]["service_credential_type"] = type(service_cred).__name__
                except Exception as e:
                    debug_info["credentials_test"]["service_credential"] = f"FAILED: {str(e)}"
                
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
                auth_info["token_preview"] = f"{user_token[:20]}..." if len(user_token) > 20 else user_token
                
                # Check if OBO environment variables are configured
                obo_vars = {
                    "AZURE_TENANT_ID": bool(os.getenv("AZURE_TENANT_ID")),
                    "AZURE_CLIENT_ID": bool(os.getenv("AZURE_CLIENT_ID")),
                    "AZURE_CLIENT_SECRET": bool(os.getenv("AZURE_CLIENT_SECRET"))
                }
                auth_info["obo_config"] = obo_vars
                auth_info["obo_ready"] = all(obo_vars.values())
            
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
                logger.info(f"🔍 Token details: length={len(user_token)}, preview={user_token[:30]}...")
            
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
