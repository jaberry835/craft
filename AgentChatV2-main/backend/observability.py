"""
Observability - Application Insights Logging & Telemetry
Clean, focused logging without bloat for production troubleshooting.
Includes conditional performance metrics for AOAI, MCP, CosmosDB, Search, etc.
"""
import logging
import time
from functools import wraps
from typing import Any, Callable, Optional
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import Enum

from config import get_settings

settings = get_settings()

# Context for request-scoped data
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="")
user_id_ctx: ContextVar[str] = ContextVar("user_id", default="anonymous")


class MetricType(str, Enum):
    """Types of performance metrics."""
    AOAI_CHAT = "aoai_chat"
    AOAI_EMBEDDING = "aoai_embedding"
    MCP_CALL = "mcp_call"
    COSMOS_READ = "cosmos_read"
    COSMOS_WRITE = "cosmos_write"
    COSMOS_QUERY = "cosmos_query"
    SEARCH_QUERY = "search_query"
    SEARCH_INDEX = "search_index"
    AGENT_EXECUTION = "agent_execution"
    HTTP_REQUEST = "http_request"
    MIDDLEWARE = "middleware"


@dataclass
class PerformanceMetrics:
    """Container for performance metrics."""
    operation: str
    metric_type: MetricType
    duration_ms: float = 0.0
    tokens_input: int = 0
    tokens_output: int = 0
    tokens_total: int = 0
    item_count: int = 0
    request_units: float = 0.0  # CosmosDB RUs
    cache_hit: bool = False
    error: Optional[str] = None
    additional: dict = field(default_factory=dict)
    
    def to_log_dict(self) -> dict:
        """Convert to dictionary for logging."""
        result = {
            "operation": self.operation,
            "type": self.metric_type.value,
            "duration_ms": round(self.duration_ms, 2),
        }
        if self.tokens_input:
            result["tokens_input"] = self.tokens_input
        if self.tokens_output:
            result["tokens_output"] = self.tokens_output
        if self.tokens_total:
            result["tokens_total"] = self.tokens_total
        if self.item_count:
            result["item_count"] = self.item_count
        if self.request_units:
            result["request_units"] = round(self.request_units, 2)
        if self.cache_hit:
            result["cache_hit"] = self.cache_hit
        if self.error:
            result["error"] = self.error
        if self.additional:
            result.update(self.additional)
        return result


class StructuredFormatter(logging.Formatter):
    """Formatter for structured, readable logs."""
    
    def format(self, record: logging.LogRecord) -> str:
        req_id = request_id_ctx.get("")
        user_id = user_id_ctx.get("anonymous")
        
        # Add context to log record
        record.request_id = req_id[:8] if req_id else "-"
        record.user_id = user_id[:8] if user_id else "-"
        
        return super().format(record)


def setup_telemetry() -> None:
    """Initialize Application Insights and logging."""
    log_format = (
        "%(asctime)s | %(levelname)-8s | %(request_id)s | %(user_id)s | "
        "%(name)s | %(message)s"
    )
    
    handler = logging.StreamHandler()
    handler.setFormatter(StructuredFormatter(log_format))
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, settings.log_level.upper()))
    root_logger.handlers = [handler]
    
    # Reduce noise from libraries
    logging.getLogger("azure").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    
    # Suppress verbose logs from external libraries unless debugging
    # These libraries log at INFO level for every function call
    if not settings.show_agent_logs:
        logging.getLogger("mcp").setLevel(logging.WARNING)
        logging.getLogger("mcp.client").setLevel(logging.WARNING)
        logging.getLogger("agent_framework").setLevel(logging.WARNING)
    else:
        logging.getLogger("mcp").setLevel(logging.INFO)
        logging.getLogger("agent_framework").setLevel(logging.INFO)
    
    # Setup Application Insights if configured
    if settings.appinsights_connection_string:
        try:
            from azure.monitor.opentelemetry import configure_azure_monitor
            configure_azure_monitor(
                connection_string=settings.appinsights_connection_string
            )
            logging.getLogger(__name__).info("Application Insights configured")
        except Exception as e:
            logging.getLogger(__name__).warning(f"App Insights setup failed: {e}")


def get_logger(name: str) -> logging.Logger:
    """Get a logger with the module name."""
    return logging.getLogger(name)


def should_log_performance() -> bool:
    """Check if performance logging is enabled."""
    return settings.show_performance_logs


def should_log_auth() -> bool:
    """Check if auth logging is enabled."""
    return settings.show_auth_logs


def should_log_a2a() -> bool:
    """Check if A2A logging is enabled."""
    return settings.show_a2a_logs


def should_log_mcp() -> bool:
    """Check if MCP logging is enabled."""
    return settings.show_mcp_logs


def should_log_agent() -> bool:
    """Check if agent logging is enabled."""
    return settings.show_agent_logs


class PerformanceTracker:
    """Track and log performance metrics with conditional logging."""
    
    def __init__(
        self,
        operation: str,
        logger: logging.Logger,
        metric_type: MetricType = MetricType.HTTP_REQUEST
    ):
        self.operation = operation
        self.logger = logger
        self.metric_type = metric_type
        self.start_time: float = 0
        self.metrics = PerformanceMetrics(operation=operation, metric_type=metric_type)
    
    def __enter__(self) -> "PerformanceTracker":
        self.start_time = time.perf_counter()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        duration_ms = (time.perf_counter() - self.start_time) * 1000
        self.metrics.duration_ms = duration_ms
        
        if exc_val:
            self.metrics.error = str(exc_val)
        
        # Only log if performance logging is enabled
        if should_log_performance():
            level = logging.WARNING if duration_ms > 5000 else logging.INFO
            log_data = self.metrics.to_log_dict()
            self.logger.log(
                level,
                f"[PERF] {self.operation}: {duration_ms:.2f}ms | {log_data}"
            )
    
    def add_metric(self, key: str, value: Any) -> None:
        """Add a custom metric to the performance log."""
        self.metrics.additional[key] = value
    
    def set_tokens(self, input_tokens: int = 0, output_tokens: int = 0) -> None:
        """Set token usage metrics (for AOAI calls)."""
        self.metrics.tokens_input = input_tokens
        self.metrics.tokens_output = output_tokens
        self.metrics.tokens_total = input_tokens + output_tokens
    
    def set_item_count(self, count: int) -> None:
        """Set item count (for batch operations)."""
        self.metrics.item_count = count
    
    def set_request_units(self, rus: float) -> None:
        """Set CosmosDB request units consumed."""
        self.metrics.request_units = rus
    
    def set_cache_hit(self, hit: bool) -> None:
        """Mark whether this was a cache hit."""
        self.metrics.cache_hit = hit


class AOAIPerformanceTracker(PerformanceTracker):
    """Specialized tracker for Azure OpenAI calls."""
    
    def __init__(self, operation: str, logger: logging.Logger, is_embedding: bool = False):
        metric_type = MetricType.AOAI_EMBEDDING if is_embedding else MetricType.AOAI_CHAT
        super().__init__(operation, logger, metric_type)
        self.model: str = ""
        self.deployment: str = ""
    
    def set_model_info(self, model: str = "", deployment: str = "") -> None:
        """Set model/deployment info."""
        self.model = model
        self.deployment = deployment
        if model:
            self.metrics.additional["model"] = model
        if deployment:
            self.metrics.additional["deployment"] = deployment


class MCPPerformanceTracker(PerformanceTracker):
    """Specialized tracker for MCP server calls."""
    
    def __init__(self, operation: str, logger: logging.Logger):
        super().__init__(operation, logger, MetricType.MCP_CALL)
        self.tool_name: str = ""
        self.server_url: str = ""
    
    def set_tool_info(self, tool_name: str, server_url: str = "") -> None:
        """Set MCP tool info."""
        self.tool_name = tool_name
        self.server_url = server_url
        self.metrics.additional["tool_name"] = tool_name
        if server_url:
            self.metrics.additional["server_url"] = server_url


class CosmosPerformanceTracker(PerformanceTracker):
    """Specialized tracker for CosmosDB operations."""
    
    def __init__(self, operation: str, logger: logging.Logger, is_write: bool = False, is_query: bool = False):
        if is_query:
            metric_type = MetricType.COSMOS_QUERY
        elif is_write:
            metric_type = MetricType.COSMOS_WRITE
        else:
            metric_type = MetricType.COSMOS_READ
        super().__init__(operation, logger, metric_type)
    
    def set_container(self, container: str) -> None:
        """Set the container name."""
        self.metrics.additional["container"] = container


class SearchPerformanceTracker(PerformanceTracker):
    """Specialized tracker for Azure AI Search operations."""
    
    def __init__(self, operation: str, logger: logging.Logger, is_index: bool = False):
        metric_type = MetricType.SEARCH_INDEX if is_index else MetricType.SEARCH_QUERY
        super().__init__(operation, logger, metric_type)
    
    def set_index(self, index_name: str) -> None:
        """Set the index name."""
        self.metrics.additional["index"] = index_name
    
    def set_result_count(self, count: int) -> None:
        """Set number of search results."""
        self.metrics.item_count = count


def track_performance(operation: str, metric_type: MetricType = MetricType.HTTP_REQUEST):
    """Decorator to track function performance. Handles both regular async functions and async generators.
    
    Only logs if SHOW_PERFORMANCE_LOGS=true in environment.
    """
    def decorator(func: Callable):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            logger = get_logger(func.__module__)
            start_time = time.perf_counter()
            try:
                result = await func(*args, **kwargs)
                return result
            finally:
                if should_log_performance():
                    duration_ms = (time.perf_counter() - start_time) * 1000
                    level = logging.WARNING if duration_ms > 5000 else logging.INFO
                    logger.log(
                        level,
                        f"[PERF] {operation}: {duration_ms:.2f}ms | type={metric_type.value}"
                    )
        
        @wraps(func)
        async def async_gen_wrapper(*args, **kwargs):
            logger = get_logger(func.__module__)
            start_time = time.perf_counter()
            item_count = 0
            try:
                async for item in func(*args, **kwargs):
                    item_count += 1
                    yield item
            finally:
                if should_log_performance():
                    duration_ms = (time.perf_counter() - start_time) * 1000
                    level = logging.WARNING if duration_ms > 5000 else logging.INFO
                    logger.log(
                        level,
                        f"[PERF] {operation}: {duration_ms:.2f}ms | type={metric_type.value} | items={item_count}"
                    )
        
        # Check if the function is an async generator
        import inspect
        if inspect.isasyncgenfunction(func):
            return async_gen_wrapper
        return wrapper
    return decorator


def log_performance_summary(logger: logging.Logger, operation: str, metrics: dict) -> None:
    """Log a performance summary if performance logging is enabled."""
    if should_log_performance():
        logger.info(f"[PERF-SUMMARY] {operation}: {metrics}")
