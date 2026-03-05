"""
Application Insights integration for Rude MCP Server
Configures logging, request tracking, and performance monitoring
"""

import os
import logging
from typing import Optional
from opencensus.ext.azure.log_exporter import AzureLogHandler
from opencensus.ext.azure.trace_exporter import AzureExporter
from opencensus.trace.samplers import ProbabilitySampler
from opencensus.trace.tracer import Tracer
from opencensus.trace import config_integration
from opencensus.ext.requests import RequestsIntegration

logger = logging.getLogger(__name__)

class ApplicationInsights:
    """Application Insights integration for comprehensive monitoring"""
    
    def __init__(self):
        self.connection_string: Optional[str] = None
        self.instrumentation_key: Optional[str] = None
        self.tracer: Optional[Tracer] = None
        self._initialized = False
    
    def initialize(self) -> bool:
        """Initialize Application Insights with environment configuration"""
        try:
            # Get connection string from environment (preferred method)
            self.connection_string = os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING")
            
            # Fallback to instrumentation key (legacy method)
            if not self.connection_string:
                self.instrumentation_key = os.getenv("APPINSIGHTS_INSTRUMENTATIONKEY")
            
            if not self.connection_string and not self.instrumentation_key:
                logger.warning("❌ Application Insights not configured - missing connection string or instrumentation key")
                return False
            
            # Configure logging integration
            self._configure_logging()
            
            # Configure request tracing
            self._configure_tracing()
            
            # Configure integrations
            self._configure_integrations()
            
            self._initialized = True
            logger.info("✅ Application Insights initialized successfully")
            
            # Log configuration info (without secrets)
            if self.connection_string:
                logger.info("🔧 Using Application Insights connection string")
            else:
                logger.info("🔧 Using Application Insights instrumentation key (legacy)")
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to initialize Application Insights: {e}")
            return False
    
    def _configure_logging(self):
        """Configure Azure Log Handler for centralized logging"""
        try:
            # Create Azure log handler
            if self.connection_string:
                azure_handler = AzureLogHandler(connection_string=self.connection_string)
            else:
                azure_handler = AzureLogHandler(instrumentation_key=self.instrumentation_key)
            
            # Configure the handler
            azure_handler.setLevel(logging.INFO)
            
            # Create formatter for structured logging
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
            azure_handler.setFormatter(formatter)
            
            # Add custom properties processor
            def add_custom_properties(envelope):
                """Add custom properties to all telemetry"""
                envelope.tags['ai.cloud.role'] = 'rude-mcp-server'
                envelope.tags['ai.cloud.roleInstance'] = os.getenv('WEBSITE_INSTANCE_ID', 'local-dev')
                
                # Add custom properties
                if hasattr(envelope, 'data') and hasattr(envelope.data, 'baseData'):
                    if hasattr(envelope.data.baseData, 'properties'):
                        envelope.data.baseData.properties['service'] = 'mcp-server'
                        envelope.data.baseData.properties['version'] = os.getenv('MCP_SERVER_VERSION', '1.0.0')
                        envelope.data.baseData.properties['environment'] = os.getenv('ENVIRONMENT', 'production')
            
            azure_handler.add_telemetry_processor(add_custom_properties)
            
            # Add handler to root logger and key loggers
            root_logger = logging.getLogger()
            root_logger.addHandler(azure_handler)
            
            # Add to specific loggers that are important
            important_loggers = [
                'tools.adx_tools',
                'main',
                'fastmcp',
                'uvicorn',
                'gunicorn',
                '__main__'  # Add main module logger
            ]
            
            for logger_name in important_loggers:
                specific_logger = logging.getLogger(logger_name)
                specific_logger.addHandler(azure_handler)
                # Ensure we capture DEBUG level for ADX tools in production
                if logger_name == 'tools.adx_tools':
                    specific_logger.setLevel(logging.INFO)  # Capture INFO and above
            
            logger.info("📊 Application Insights logging configured")
            
        except Exception as e:
            logger.error(f"❌ Failed to configure Application Insights logging: {e}")
    
    def _configure_tracing(self):
        """Configure distributed tracing for requests"""
        try:
            # Create tracer with Azure exporter
            if self.connection_string:
                exporter = AzureExporter(connection_string=self.connection_string)
            else:
                exporter = AzureExporter(instrumentation_key=self.instrumentation_key)
            
            # Create tracer with sampling (sample 100% for now, adjust in production)
            sampler = ProbabilitySampler(rate=1.0)
            self.tracer = Tracer(exporter=exporter, sampler=sampler)
            
            logger.info("🔍 Application Insights tracing configured")
            
        except Exception as e:
            logger.error(f"❌ Failed to configure Application Insights tracing: {e}")
    
    def _configure_integrations(self):
        """Configure automatic integrations for common libraries"""
        try:
            # Configure integrations for automatic instrumentation
            integrations = [
                RequestsIntegration(),  # HTTP requests
            ]
            
            config_integration.trace_integrations(integrations)
            
            logger.info("🔌 Application Insights integrations configured")
            
        except Exception as e:
            logger.error(f"❌ Failed to configure Application Insights integrations: {e}")
    
    def is_initialized(self) -> bool:
        """Check if Application Insights is properly initialized"""
        return self._initialized
    
    def log_custom_event(self, event_name: str, properties: dict = None, measurements: dict = None):
        """Log a custom event to Application Insights"""
        try:
            if not self._initialized:
                return
            
            # Create a logger specifically for custom events
            event_logger = logging.getLogger('custom_events')
            
            # Ensure all properties are serializable
            safe_properties = {}
            if properties:
                for key, value in properties.items():
                    if isinstance(value, (str, int, float, bool, type(None))):
                        safe_properties[key] = value
                    else:
                        # Convert complex objects to strings
                        safe_properties[key] = str(value)
            
            # Ensure all measurements are numeric
            safe_measurements = {}
            if measurements:
                for key, value in measurements.items():
                    try:
                        # Try to convert to float
                        safe_measurements[key] = float(value) if value is not None else 0.0
                    except (ValueError, TypeError):
                        # If conversion fails, skip the measurement
                        logger.debug(f"Skipping non-numeric measurement: {key}={value}")
            
            # Format the event data
            event_data = {
                'event': event_name,
                'properties': safe_properties,
                'measurements': safe_measurements
            }
            
            event_logger.info(f"CUSTOM_EVENT: {event_data}")
            
        except Exception as e:
            logger.error(f"❌ Failed to log custom event '{event_name}': {e}")
    
    def log_authentication_event(self, auth_mode: str, user_id: str = None, success: bool = True):
        """Log authentication-related events"""
        properties = {
            'authentication_mode': auth_mode,
            'success': str(success)
        }
        
        if user_id:
            properties['user_id'] = user_id
        
        self.log_custom_event('Authentication', properties)
    
    def log_adx_query_event(self, database: str, query_type: str, row_count: int = None, execution_time: float = None):
        """Log ADX query events"""
        properties = {
            'database': database,
            'query_type': query_type
        }
        
        measurements = {}
        if row_count is not None:
            measurements['row_count'] = row_count
        if execution_time is not None:
            measurements['execution_time_ms'] = execution_time
        
        self.log_custom_event('ADX_Query', properties, measurements)


# Global Application Insights instance
app_insights = ApplicationInsights()

def initialize_application_insights() -> bool:
    """Initialize Application Insights - call this early in application startup"""
    return app_insights.initialize()

def get_application_insights() -> ApplicationInsights:
    """Get the global Application Insights instance"""
    return app_insights
