"""Azure Application Insights configuration utilities."""

import os
import logging
from typing import Optional

try:
    from opencensus.ext.azure.log_exporter import AzureLogHandler
    from opencensus.trace.tracer import Tracer
    from opencensus.trace.samplers import ProbabilitySampler
    from opencensus.ext.azure.trace_exporter import AzureExporter
    AZURE_INSIGHTS_AVAILABLE = True
except ImportError:
    AZURE_INSIGHTS_AVAILABLE = False


def get_application_insights_config() -> dict:
    """
    Get Application Insights configuration from environment variables.
    
    Returns:
        Dictionary containing Application Insights configuration
    """
    config = {
        'connection_string': os.environ.get('APPLICATIONINSIGHTS_CONNECTION_STRING'),
        'instrumentation_key': os.environ.get('APPINSIGHTS_INSTRUMENTATIONKEY'),
        'enabled': False,
        'available': AZURE_INSIGHTS_AVAILABLE
    }
    
    # Check if Application Insights is configured
    if config['connection_string'] or config['instrumentation_key']:
        config['enabled'] = True
    
    return config


def create_azure_log_handler(connection_string: Optional[str] = None, 
                           instrumentation_key: Optional[str] = None) -> Optional[AzureLogHandler]:
    """
    Create an Azure Log Handler for Application Insights.
    
    Args:
        connection_string: Application Insights connection string
        instrumentation_key: Application Insights instrumentation key
        
    Returns:
        AzureLogHandler instance or None if not configured
    """
    if not AZURE_INSIGHTS_AVAILABLE:
        return None
    
    try:
        if connection_string:
            return AzureLogHandler(connection_string=connection_string)
        elif instrumentation_key:
            return AzureLogHandler(instrumentation_key=instrumentation_key)
        else:
            return None
    except Exception as e:
        logging.error(f"Failed to create Azure Log Handler: {e}")
        return None


def create_azure_tracer(connection_string: Optional[str] = None, 
                       instrumentation_key: Optional[str] = None) -> Optional[Tracer]:
    """
    Create an Azure Tracer for Application Insights.
    
    Args:
        connection_string: Application Insights connection string
        instrumentation_key: Application Insights instrumentation key
        
    Returns:
        Tracer instance or None if not configured
    """
    if not AZURE_INSIGHTS_AVAILABLE:
        return None
    
    try:
        if connection_string:
            exporter = AzureExporter(connection_string=connection_string)
        elif instrumentation_key:
            exporter = AzureExporter(instrumentation_key=instrumentation_key)
        else:
            return None
        
        tracer = Tracer(
            exporter=exporter,
            sampler=ProbabilitySampler(1.0)
        )
        return tracer
    except Exception as e:
        logging.error(f"Failed to create Azure Tracer: {e}")
        return None


def log_application_insights_status():
    """Log the current Application Insights configuration status."""
    config = get_application_insights_config()
    
    logger = logging.getLogger("app_insights_config")
    
    if not config['available']:
        logger.warning("Azure Application Insights packages not available. Install 'opencensus-ext-azure' for full functionality.")
        return
    
    if config['enabled']:
        if config['connection_string']:
            logger.info("Application Insights configured with connection string")
        elif config['instrumentation_key']:
            logger.info("Application Insights configured with instrumentation key")
    else:
        logger.warning("Application Insights not configured. Set APPLICATIONINSIGHTS_CONNECTION_STRING or APPINSIGHTS_INSTRUMENTATIONKEY environment variable.")
        logger.info("To enable Application Insights logging:")
        logger.info("1. Set APPLICATIONINSIGHTS_CONNECTION_STRING environment variable")
        logger.info("2. Or set APPINSIGHTS_INSTRUMENTATIONKEY environment variable")
        logger.info("3. Install required packages: pip install opencensus-ext-azure opencensus-ext-flask")


def setup_custom_properties():
    """Set up custom properties for Application Insights telemetry."""
    custom_properties = {
        'service_name': 'AgentChat-PythonAPI',
        'service_version': '1.0.0',
        'environment': os.environ.get('FLASK_ENV', 'production'),
        'deployment_slot': os.environ.get('WEBSITE_SLOT_NAME', 'production'),
        'instance_id': os.environ.get('WEBSITE_INSTANCE_ID', 'local'),
        'azure_region': os.environ.get('WEBSITE_RESOURCE_GROUP', 'unknown')
    }
    
    return custom_properties


def add_custom_properties_to_handler(handler: AzureLogHandler, custom_properties: dict):
    """Add custom properties to an Azure Log Handler."""
    if handler and hasattr(handler, 'add_telemetry_processor'):
        def add_properties(envelope):
            envelope.tags.update(custom_properties)
            return True
        
        handler.add_telemetry_processor(add_properties)
