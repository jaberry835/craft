"""
Azure PostgreSQL Tools for Rude MCP Server
Tools for querying and exploring Azure Database for PostgreSQL Flexible Server
Requires user impersonation via On-Behalf-Of flow for AAD token authentication
"""

import os
import logging
import json
import time
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from fastmcp import FastMCP
from context import current_user_token, current_user_id, current_session_id, get_user_token
from auth import get_obo_credential

# Application Insights integration
try:
    from app_insights import get_application_insights
    APP_INSIGHTS_AVAILABLE = True
except ImportError:
    APP_INSIGHTS_AVAILABLE = False

logger = logging.getLogger(__name__)

# Default OBO scope for Azure Database for PostgreSQL (Azure Government)
POSTGRES_OBO_SCOPE_DEFAULT = "https://ossrdbms-aad.database.usgovcloudapi.net/.default"


@dataclass
class PostgresConfig:
    """Configuration for Azure PostgreSQL Flexible Server connections"""
    host: str
    database: str
    port: int = 5432
    sslmode: str = "require"

    @classmethod
    def from_env(cls) -> "PostgresConfig":
        """Create config from environment variables"""
        host = os.getenv("POSTGRES_HOST")
        if not host:
            raise ValueError("POSTGRES_HOST environment variable is required")

        database = os.getenv("POSTGRES_DATABASE")
        if not database:
            raise ValueError("POSTGRES_DATABASE environment variable is required")

        port = int(os.getenv("POSTGRES_PORT", "5432"))
        sslmode = os.getenv("POSTGRES_SSLMODE", "require")
        return cls(host=host, database=database, port=port, sslmode=sslmode)


class PostgresClientManager:
    """Manages Azure PostgreSQL connections with AAD token authentication via OBO flow"""

    def __init__(self, config: PostgresConfig):
        self.config = config

    def _get_access_token(self, user_token: str) -> str:
        """Get a PostgreSQL-scoped access token via OBO flow.
        
        Returns the raw access token string to use as the password.
        """
        obo_scope = os.getenv("POSTGRES_OBO_SCOPE", POSTGRES_OBO_SCOPE_DEFAULT)
        credential = get_obo_credential(user_token, obo_scope)
        token_result = credential.get_token(obo_scope)
        return token_result.token

    def get_connection(self):
        """Get a psycopg2 connection using the current user's OBO token as the password.
        
        Returns a new connection each call (no pooling) since tokens are short-lived.
        """
        import psycopg2

        user_token = get_user_token()
        if not user_token:
            raise ValueError(
                "No user token available for Azure PostgreSQL access. "
                "User authentication is required for PostgreSQL operations."
            )

        logger.info(f"🔄 Creating PostgreSQL connection to {self.config.host}/{self.config.database}")

        # The AAD username is the user's UPN or object-id — but for AAD token auth
        # with PostgreSQL Flexible Server, the "user" field should be the AAD user
        # principal that was granted access.  We read it from the incoming token.
        import base64
        pg_user = os.getenv("POSTGRES_AAD_USER", "")
        if not pg_user:
            # Try to extract from the user token
            try:
                parts = user_token.split('.')
                if len(parts) >= 2:
                    payload = parts[1]
                    payload += '=' * (4 - len(payload) % 4)
                    decoded = base64.b64decode(payload)
                    token_data = json.loads(decoded)
                    # preferred_username or upn are common claims
                    pg_user = token_data.get('preferred_username') or token_data.get('upn') or token_data.get('unique_name', '')
                    logger.info(f"🔍 Extracted PostgreSQL AAD user from token: {pg_user}")
            except Exception as e:
                logger.warning(f"Could not extract username from token: {e}")

        if not pg_user:
            raise ValueError(
                "Cannot determine PostgreSQL AAD username. "
                "Set POSTGRES_AAD_USER env var or ensure the user token contains preferred_username/upn."
            )

        access_token = self._get_access_token(user_token)

        conn = psycopg2.connect(
            host=self.config.host,
            port=self.config.port,
            database=self.config.database,
            user=pg_user,
            password=access_token,
            sslmode=self.config.sslmode,
        )

        logger.info(f"✅ Connected to PostgreSQL {self.config.host}/{self.config.database}")
        return conn


# Global manager (initialized on first use)
_postgres_manager: Optional[PostgresClientManager] = None


def get_postgres_manager() -> PostgresClientManager:
    """Get or create the global PostgreSQL client manager"""
    global _postgres_manager
    if _postgres_manager is None:
        try:
            config = PostgresConfig.from_env()
            _postgres_manager = PostgresClientManager(config)
        except Exception as e:
            logger.error(f"Failed to initialize PostgreSQL manager: {e}")
            raise
    return _postgres_manager


def register_postgres_tools(mcp: FastMCP):
    """Register all Azure PostgreSQL tools with the FastMCP server"""

    @mcp.tool
    async def postgres_test_connection() -> Dict[str, Any]:
        """Test connection to Azure PostgreSQL with current authentication setup"""
        try:
            logger.info("🧪 Starting PostgreSQL connection test...")

            manager = get_postgres_manager()
            conn = manager.get_connection()
            cur = conn.cursor()

            cur.execute("SELECT version();")
            version = cur.fetchone()[0]

            cur.execute("SELECT current_user, current_database(), inet_server_addr(), inet_server_port();")
            info = cur.fetchone()

            cur.close()
            conn.close()

            return {
                "status": "SUCCESS",
                "server_version": version,
                "current_user": info[0],
                "current_database": info[1],
                "server_address": str(info[2]) if info[2] else None,
                "server_port": info[3],
                "authentication_mode": "aad_obo_token",
                "timestamp": time.time()
            }

        except Exception as e:
            logger.error(f"❌ PostgreSQL connection test failed: {e}")
            return {
                "status": "FAILED",
                "error": str(e),
                "error_type": type(e).__name__,
                "has_user_token": bool(get_user_token()),
                "timestamp": time.time()
            }

    @mcp.tool
    async def postgres_list_databases() -> List[Dict[str, Any]]:
        """List all databases on the Azure PostgreSQL server that the current user can access"""
        try:
            manager = get_postgres_manager()
            conn = manager.get_connection()
            cur = conn.cursor()

            cur.execute("""
                SELECT datname, pg_catalog.pg_encoding_to_char(encoding) AS encoding,
                       datcollate, datctype,
                       pg_catalog.pg_database_size(datname) AS size_bytes
                FROM pg_catalog.pg_database
                WHERE datistemplate = false
                ORDER BY datname;
            """)

            columns = [desc[0] for desc in cur.description]
            databases = [dict(zip(columns, row)) for row in cur.fetchall()]

            cur.close()
            conn.close()

            logger.info(f"Listed {len(databases)} databases")
            return databases

        except Exception as e:
            logger.error(f"Failed to list databases: {e}")
            raise ValueError(f"Failed to list databases: {e}")

    @mcp.tool
    async def postgres_list_tables(schema: str = "public") -> List[Dict[str, Any]]:
        """List all tables in the specified schema of the current database
        
        Args:
            schema: The schema to list tables from (default: 'public')
        """
        try:
            manager = get_postgres_manager()
            conn = manager.get_connection()
            cur = conn.cursor()

            cur.execute("""
                SELECT table_name, table_type,
                       pg_catalog.obj_description(
                           (quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, 'pg_class'
                       ) AS comment
                FROM information_schema.tables
                WHERE table_schema = %s
                ORDER BY table_name;
            """, (schema,))

            columns = [desc[0] for desc in cur.description]
            tables = [dict(zip(columns, row)) for row in cur.fetchall()]

            cur.close()
            conn.close()

            logger.info(f"Listed {len(tables)} tables in schema '{schema}'")
            return tables

        except Exception as e:
            logger.error(f"Failed to list tables: {e}")
            raise ValueError(f"Failed to list tables in schema '{schema}': {e}")

    @mcp.tool
    async def postgres_describe_table(table: str, schema: str = "public") -> Dict[str, Any]:
        """Describe the schema of a specific table including columns, types, and constraints
        
        Args:
            table: The table name to describe
            schema: The schema containing the table (default: 'public')
        """
        try:
            manager = get_postgres_manager()
            conn = manager.get_connection()
            cur = conn.cursor()

            # Get columns
            cur.execute("""
                SELECT column_name, data_type, character_maximum_length,
                       is_nullable, column_default,
                       col_description(
                           (quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass,
                           ordinal_position
                       ) AS comment
                FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s
                ORDER BY ordinal_position;
            """, (schema, table))

            col_columns = [desc[0] for desc in cur.description]
            columns = [dict(zip(col_columns, row)) for row in cur.fetchall()]

            if not columns:
                cur.close()
                conn.close()
                raise ValueError(f"Table '{schema}.{table}' not found or has no columns")

            # Get primary key
            cur.execute("""
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_schema = %s AND tc.table_name = %s
                ORDER BY kcu.ordinal_position;
            """, (schema, table))
            primary_key_columns = [row[0] for row in cur.fetchall()]

            # Get indexes
            cur.execute("""
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = %s AND tablename = %s
                ORDER BY indexname;
            """, (schema, table))
            indexes = [{"name": row[0], "definition": row[1]} for row in cur.fetchall()]

            # Get row count estimate
            cur.execute("""
                SELECT reltuples::bigint AS estimated_row_count,
                       pg_total_relation_size(quote_ident(%s) || '.' || quote_ident(%s)) AS total_size_bytes
                FROM pg_class
                WHERE oid = (quote_ident(%s) || '.' || quote_ident(%s))::regclass;
            """, (schema, table, schema, table))
            stats = cur.fetchone()

            cur.close()
            conn.close()

            result = {
                "schema": schema,
                "table_name": table,
                "columns": columns,
                "primary_key": primary_key_columns,
                "indexes": indexes,
                "estimated_row_count": stats[0] if stats else None,
                "total_size_bytes": stats[1] if stats else None,
            }

            logger.info(f"Described table '{schema}.{table}' with {len(columns)} columns")
            return result

        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to describe table: {e}")
            raise ValueError(f"Failed to describe table '{schema}.{table}': {e}")

    @mcp.tool
    async def postgres_query(query: str, max_rows: int = 1000) -> Dict[str, Any]:
        """Execute a SQL query against the Azure PostgreSQL database.
        
        For safety, SELECT queries are automatically limited. Non-SELECT statements
        (INSERT, UPDATE, DELETE, etc.) will be executed within a transaction and committed.
        
        Args:
            query: The SQL query to execute
            max_rows: Maximum number of rows to return (default: 1000, max: 10000)
        """
        start_time = time.time()

        try:
            if max_rows > 10000:
                raise ValueError("max_rows cannot exceed 10,000 for safety")

            manager = get_postgres_manager()
            conn = manager.get_connection()
            cur = conn.cursor()

            trimmed = query.strip().rstrip(';')
            is_select = trimmed.lower().startswith('select') or trimmed.lower().startswith('with')

            if is_select:
                # Wrap in a subquery with LIMIT if not already limited
                lower_q = trimmed.lower()
                if 'limit' not in lower_q:
                    execute_query = f"{trimmed} LIMIT {max_rows}"
                else:
                    execute_query = trimmed
            else:
                execute_query = trimmed

            logger.info(f"Executing PostgreSQL query: {execute_query[:100]}...")

            cur.execute(execute_query)
            execution_time = (time.time() - start_time) * 1000

            if is_select and cur.description:
                columns = [desc[0] for desc in cur.description]
                rows_raw = cur.fetchmany(max_rows)
                rows = []
                for row in rows_raw:
                    row_dict = {}
                    for i, col in enumerate(columns):
                        val = row[i]
                        # Convert non-JSON-serializable types to strings
                        if isinstance(val, (bytes, memoryview)):
                            val = val.hex() if isinstance(val, bytes) else bytes(val).hex()
                        elif hasattr(val, 'isoformat'):
                            val = val.isoformat()
                        elif isinstance(val, set):
                            val = list(val)
                        row_dict[col] = val
                    rows.append(row_dict)

                result = {
                    "database": manager.config.database,
                    "query": execute_query,
                    "row_count": len(rows),
                    "rows": rows,
                    "execution_time_ms": execution_time,
                }
            else:
                # DML or DDL — commit and report affected rows
                affected = cur.rowcount
                conn.commit()
                result = {
                    "database": manager.config.database,
                    "query": execute_query,
                    "rows_affected": affected,
                    "execution_time_ms": execution_time,
                }

            cur.close()
            conn.close()

            # Log to Application Insights
            try:
                if APP_INSIGHTS_AVAILABLE:
                    app_insights = get_application_insights()
                    if app_insights.is_initialized():
                        app_insights.log_custom_event('PostgreSQL_Query', {
                            'database': manager.config.database,
                            'query_type': 'select' if is_select else 'dml',
                            'row_count': str(result.get('row_count', result.get('rows_affected', 0))),
                        }, {
                            'execution_time_ms': execution_time,
                        })
            except Exception as log_err:
                logger.debug(f"Failed to log PostgreSQL query event: {log_err}")

            logger.info(f"Query executed successfully in {execution_time:.2f}ms")
            return result

        except Exception as e:
            logger.error(f"Failed to execute PostgreSQL query: {e}")
            raise ValueError(f"Failed to execute query: {e}")

    @mcp.tool
    async def postgres_list_schemas() -> List[Dict[str, Any]]:
        """List all schemas in the current PostgreSQL database"""
        try:
            manager = get_postgres_manager()
            conn = manager.get_connection()
            cur = conn.cursor()

            cur.execute("""
                SELECT schema_name, schema_owner
                FROM information_schema.schemata
                WHERE schema_name NOT IN ('pg_toast', 'pg_catalog', 'information_schema')
                ORDER BY schema_name;
            """)

            columns = [desc[0] for desc in cur.description]
            schemas = [dict(zip(columns, row)) for row in cur.fetchall()]

            cur.close()
            conn.close()

            logger.info(f"Listed {len(schemas)} schemas")
            return schemas

        except Exception as e:
            logger.error(f"Failed to list schemas: {e}")
            raise ValueError(f"Failed to list schemas: {e}")

    @mcp.tool
    async def postgres_get_auth_info() -> Dict[str, Any]:
        """Get information about the current authentication configuration for PostgreSQL"""
        try:
            user_token = get_user_token()

            auth_info = {
                "has_user_token": bool(user_token),
                "authentication_mode": "aad_obo_token" if user_token else "no_authentication",
                "postgres_host": os.getenv("POSTGRES_HOST", "NOT_SET"),
                "postgres_database": os.getenv("POSTGRES_DATABASE", "NOT_SET"),
                "postgres_port": os.getenv("POSTGRES_PORT", "5432"),
                "postgres_obo_scope": os.getenv("POSTGRES_OBO_SCOPE", POSTGRES_OBO_SCOPE_DEFAULT),
            }

            if user_token:
                auth_info["token_preview"] = f"{user_token[:10]}..."
                has_secret = bool(os.getenv("AZURE_CLIENT_SECRET"))
                has_cert = bool(os.getenv("AZURE_CLIENT_CERTIFICATE_PATH"))
                auth_info["obo_credential_type"] = "certificate" if has_cert else ("secret" if has_secret else "none")
                auth_info["obo_ready"] = (
                    bool(os.getenv("AZURE_TENANT_ID"))
                    and bool(os.getenv("AZURE_CLIENT_ID"))
                    and (has_secret or has_cert)
                )

            logger.info(f"PostgreSQL auth info: {auth_info['authentication_mode']}")
            return auth_info

        except Exception as e:
            logger.error(f"Error getting PostgreSQL auth info: {e}")
            raise ValueError(f"Failed to get PostgreSQL authentication info: {e}")

    logger.info("Azure PostgreSQL tools registered successfully")
