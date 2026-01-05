"""Flask request logging middleware for comprehensive request tracking."""

import time
import logging
from flask import request, g
from functools import wraps
import json


def setup_request_logging(app):
    """Set up comprehensive request logging for Flask app."""
    
    logger = logging.getLogger("flask_requests")
    
    @app.before_request
    def log_request_start():
        """Log the start of each request."""
        g.request_start_time = time.time()
        
        # Log basic request info
        logger.info("Request started", extra={
            'method': request.method,
            'url': request.url,
            'path': request.path,
            'remote_addr': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'content_type': request.headers.get('Content-Type', 'unknown'),
            'content_length': request.headers.get('Content-Length', 0),
            'referrer': request.headers.get('Referer', 'unknown'),
            'request_id': id(request)
        })
        
        # Log query parameters if present
        if request.args:
            logger.info("Request query parameters", extra={
                'query_params': dict(request.args),
                'request_id': id(request)
            })
    
    @app.after_request
    def log_request_end(response):
        """Log the end of each request."""
        request_duration = time.time() - g.get('request_start_time', time.time())
        
        logger.info("Request completed", extra={
            'method': request.method,
            'url': request.url,
            'path': request.path,
            'status_code': response.status_code,
            'response_size': response.content_length or 0,
            'duration_ms': round(request_duration * 1000, 2),
            'remote_addr': request.remote_addr,
            'request_id': id(request)
        })
        
        # Log slow requests as warnings
        if request_duration > 1.0:  # More than 1 second
            logger.warning("Slow request detected", extra={
                'method': request.method,
                'url': request.url,
                'path': request.path,
                'duration_ms': round(request_duration * 1000, 2),
                'status_code': response.status_code,
                'request_id': id(request)
            })
        
        return response
    
    @app.errorhandler(Exception)
    def log_unhandled_exception(error):
        """Log unhandled exceptions."""
        logger.error("Unhandled exception occurred", extra={
            'method': request.method,
            'url': request.url,
            'path': request.path,
            'remote_addr': request.remote_addr,
            'error': str(error),
            'error_type': type(error).__name__,
            'request_id': id(request)
        })
        
        # Re-raise the exception to let Flask handle it normally
        raise


def log_api_call(endpoint_name: str = None):
    """Decorator to log API calls with detailed information."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            logger = logging.getLogger("api_calls")
            
            # Log API call start
            logger.info(f"API call started: {endpoint_name or f.__name__}", extra={
                'function': f.__name__,
                'endpoint': endpoint_name or f.__name__,
                'args': str(args) if args else None,
                'kwargs': str(kwargs) if kwargs else None,
                'method': request.method,
                'path': request.path,
                'request_id': id(request)
            })
            
            start_time = time.time()
            
            try:
                # Execute the function
                result = f(*args, **kwargs)
                
                # Log successful completion
                duration = time.time() - start_time
                logger.info(f"API call completed: {endpoint_name or f.__name__}", extra={
                    'function': f.__name__,
                    'endpoint': endpoint_name or f.__name__,
                    'duration_ms': round(duration * 1000, 2),
                    'method': request.method,
                    'path': request.path,
                    'success': True,
                    'request_id': id(request)
                })
                
                return result
                
            except Exception as e:
                # Log error
                duration = time.time() - start_time
                logger.error(f"API call failed: {endpoint_name or f.__name__}", extra={
                    'function': f.__name__,
                    'endpoint': endpoint_name or f.__name__,
                    'duration_ms': round(duration * 1000, 2),
                    'method': request.method,
                    'path': request.path,
                    'error': str(e),
                    'error_type': type(e).__name__,
                    'success': False,
                    'request_id': id(request)
                })
                
                # Re-raise the exception
                raise
                
        return decorated_function
    return decorator


def log_database_operation(operation_type: str):
    """Decorator to log database operations."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            logger = logging.getLogger("database_operations")
            
            start_time = time.time()
            
            logger.info(f"Database operation started: {operation_type}", extra={
                'operation': operation_type,
                'function': f.__name__,
                'request_id': getattr(request, 'request_id', None) if request else None
            })
            
            try:
                result = f(*args, **kwargs)
                
                duration = time.time() - start_time
                logger.info(f"Database operation completed: {operation_type}", extra={
                    'operation': operation_type,
                    'function': f.__name__,
                    'duration_ms': round(duration * 1000, 2),
                    'success': True,
                    'request_id': getattr(request, 'request_id', None) if request else None
                })
                
                return result
                
            except Exception as e:
                duration = time.time() - start_time
                logger.error(f"Database operation failed: {operation_type}", extra={
                    'operation': operation_type,
                    'function': f.__name__,
                    'duration_ms': round(duration * 1000, 2),
                    'error': str(e),
                    'error_type': type(e).__name__,
                    'success': False,
                    'request_id': getattr(request, 'request_id', None) if request else None
                })
                
                raise
                
        return decorated_function
    return decorator
