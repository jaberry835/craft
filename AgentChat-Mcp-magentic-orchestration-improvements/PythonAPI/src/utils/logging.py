"""Logging utilities for the application with Azure Application Insights integration."""

import logging
import sys
import os
from typing import Optional
from pathlib import Path

# Azure Application Insights imports
try:
    from opencensus.ext.azure.log_exporter import AzureLogHandler
    from opencensus.ext.azure.trace_exporter import AzureExporter
    from opencensus.ext.flask.flask_middleware import FlaskMiddleware
    from opencensus.trace.tracer import Tracer
    from opencensus.trace.samplers import ProbabilitySampler
    AZURE_INSIGHTS_AVAILABLE = True
except ImportError:
    AZURE_INSIGHTS_AVAILABLE = False
    print("Azure Application Insights packages not available. Install 'opencensus-ext-azure' for full functionality.")


def setup_logging(
    log_level: str = "INFO",
    log_file: Optional[str] = None,
    logger_name: Optional[str] = None,
    connection_string: Optional[str] = None,
    instrumentation_key: Optional[str] = None
) -> logging.Logger:
    """
    Set up logging configuration with Azure Application Insights integration.
    
    Args:
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_file: Optional log file path
        logger_name: Optional logger name
        connection_string: Azure Application Insights connection string
        instrumentation_key: Azure Application Insights instrumentation key (legacy)
        
    Returns:
        Configured logger instance
    """
    # Create logger
    logger = logging.getLogger(logger_name or __name__)
    logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))
    
    # Clear existing handlers
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
    
    # Create formatter
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    
    # File handler (if specified)
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    
    # Azure Application Insights handler
    if AZURE_INSIGHTS_AVAILABLE and (connection_string or instrumentation_key):
        try:
            # Prefer connection string over instrumentation key
            if connection_string:
                azure_handler = AzureLogHandler(connection_string=connection_string)
                logger.info("Azure Application Insights logging configured with connection string")
            elif instrumentation_key:
                azure_handler = AzureLogHandler(instrumentation_key=instrumentation_key)
                logger.info("Azure Application Insights logging configured with instrumentation key")
            else:
                azure_handler = None
            
            if azure_handler:
                # Set custom formatter for Azure handler
                azure_formatter = logging.Formatter(
                    '%(name)s - %(levelname)s - %(message)s'
                )
                azure_handler.setFormatter(azure_formatter)
                logger.addHandler(azure_handler)
                
                # Log a test message to verify Application Insights is working
                logger.info("Azure Application Insights logging initialized successfully")
                
        except Exception as e:
            logger.error(f"Failed to initialize Azure Application Insights logging: {e}")
    elif not AZURE_INSIGHTS_AVAILABLE:
        logger.warning("Azure Application Insights packages not available. Install 'opencensus-ext-azure' for Application Insights integration.")
    else:
        logger.warning("Azure Application Insights not configured. Set APPLICATIONINSIGHTS_CONNECTION_STRING or APPINSIGHTS_INSTRUMENTATIONKEY environment variable.")
    
    return logger


def setup_flask_telemetry(app, connection_string: Optional[str] = None, instrumentation_key: Optional[str] = None):
    """
    Set up Flask telemetry with Azure Application Insights.
    
    Args:
        app: Flask application instance
        connection_string: Azure Application Insights connection string
        instrumentation_key: Azure Application Insights instrumentation key (legacy)
    """
    if not AZURE_INSIGHTS_AVAILABLE:
        return
    
    try:
        # Configure Application Insights for Flask
        if connection_string:
            middleware = FlaskMiddleware(
                app,
                exporter=AzureExporter(connection_string=connection_string),
                sampler=ProbabilitySampler(rate=1.0)  # Sample 100% of requests
            )
        elif instrumentation_key:
            middleware = FlaskMiddleware(
                app,
                exporter=AzureExporter(instrumentation_key=instrumentation_key),
                sampler=ProbabilitySampler(rate=1.0)  # Sample 100% of requests
            )
        else:
            return
            
        # Enable request tracking
        app.logger.info("Flask telemetry configured with Azure Application Insights")
        
    except Exception as e:
        app.logger.error(f"Failed to configure Flask telemetry: {e}")


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance with the specified name."""
    return logging.getLogger(name)


def configure_root_logger(
    connection_string: Optional[str] = None,
    instrumentation_key: Optional[str] = None,
    log_level: str = "INFO",
    suppress_azure_logs: bool = True,
    suppress_semantic_kernel_logs: bool = True
):
    """
    Configure the root logger to send all application logs to Application Insights.
    This ensures that all logging throughout the application is captured.
    
    Args:
        connection_string: Azure Application Insights connection string
        instrumentation_key: Azure Application Insights instrumentation key (legacy)
        log_level: Logging level
        suppress_azure_logs: Whether to suppress verbose Azure SDK logs
        suppress_semantic_kernel_logs: Whether to suppress verbose Semantic Kernel logs
    """
    root_logger = logging.getLogger()
    
    # Set log level
    root_logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))
    
    # Suppress verbose third-party logging if requested
    if suppress_azure_logs:
        # Suppress verbose Azure SDK logging - reduce noise
        logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
        logging.getLogger("azure.core.pipeline.policies").setLevel(logging.WARNING)
        logging.getLogger("urllib3.connectionpool").setLevel(logging.WARNING)
        logging.getLogger("httpcore.http11").setLevel(logging.WARNING)
        logging.getLogger("httpcore.connection").setLevel(logging.WARNING)
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("openai._base_client").setLevel(logging.WARNING)
    
    if suppress_semantic_kernel_logs:
        # Suppress verbose Semantic Kernel logging - reduce noise
        logging.getLogger("semantic_kernel.prompt_template.kernel_prompt_template").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.functions.kernel_function").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.connectors.ai.open_ai.services.open_ai_handler").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.connectors.ai.chat_completion_client_base").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.chat_completion.chat_completion_agent").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.strategies.termination.termination_strategy").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.strategies.selection.sequential_selection_strategy").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.group_chat.agent_chat").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.kernel").setLevel(logging.WARNING)
    
    # Add Azure handler to root logger if not already present
    if AZURE_INSIGHTS_AVAILABLE and (connection_string or instrumentation_key):
        try:
            # Check if Azure handler already exists
            azure_handler_exists = any(
                isinstance(handler, AzureLogHandler) for handler in root_logger.handlers
            )
            
            if not azure_handler_exists:
                if connection_string:
                    azure_handler = AzureLogHandler(connection_string=connection_string)
                elif instrumentation_key:
                    azure_handler = AzureLogHandler(instrumentation_key=instrumentation_key)
                else:
                    return
                
                # Set formatter
                azure_formatter = logging.Formatter(
                    '%(name)s - %(levelname)s - %(message)s'
                )
                azure_handler.setFormatter(azure_formatter)
                root_logger.addHandler(azure_handler)
                
                root_logger.info("Root logger configured with Azure Application Insights")
                
        except Exception as e:
            root_logger.error(f"Failed to configure root logger with Azure Application Insights: {e}")
