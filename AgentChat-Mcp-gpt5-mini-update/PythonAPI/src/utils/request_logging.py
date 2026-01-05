"""HTTP request/response logging middleware for Flask."""

import time
import logging
from flask import request, g
from functools import wraps


def setup_request_logging(app):
    """Set up comprehensive request/response logging for Flask app."""
    
    logger = logging.getLogger("flask.request")
    
    @app.before_request
    def log_request_info():
        """Log incoming request information."""
        g.start_time = time.time()
        
        # Log request details
        logger.info("HTTP Request", extra={
            'method': request.method,
            'url': request.url,
            'path': request.path,
            'query_string': request.query_string.decode('utf-8') if request.query_string else None,
            'remote_addr': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'content_type': request.headers.get('Content-Type'),
            'content_length': request.headers.get('Content-Length'),
            'host': request.headers.get('Host'),
            'referer': request.headers.get('Referer'),
            'accept': request.headers.get('Accept'),
            'accept_encoding': request.headers.get('Accept-Encoding'),
            'accept_language': request.headers.get('Accept-Language'),
            'request_id': id(request)  # Simple request ID
        })
        
        # Log request body for POST/PUT requests (be careful with sensitive data)
        if request.method in ['POST', 'PUT', 'PATCH'] and request.is_json:
            try:
                # Only log if body is not too large
                if request.content_length and request.content_length < 1024:  # 1KB limit
                    logger.debug("Request body", extra={
                        'request_id': id(request),
                        'body_size': request.content_length,
                        'is_json': request.is_json
                    })
            except Exception as e:
                logger.warning(f"Failed to log request body: {e}")
    
    @app.after_request
    def log_response_info(response):
        """Log outgoing response information."""
        try:
            # Calculate response time
            response_time = time.time() - g.start_time if hasattr(g, 'start_time') else 0
            
            # Log response details
            logger.info("HTTP Response", extra={
                'method': request.method,
                'path': request.path,
                'status_code': response.status_code,
                'response_time_ms': round(response_time * 1000, 2),
                'content_type': response.content_type,
                'content_length': response.content_length,
                'request_id': id(request)
            })
            
            # Log slow requests
            if response_time > 1.0:  # More than 1 second
                logger.warning("Slow HTTP request", extra={
                    'method': request.method,
                    'path': request.path,
                    'response_time_ms': round(response_time * 1000, 2),
                    'status_code': response.status_code,
                    'request_id': id(request)
                })
            
            # Log error responses
            if response.status_code >= 400:
                log_level = logging.ERROR if response.status_code >= 500 else logging.WARNING
                logger.log(log_level, "HTTP Error Response", extra={
                    'method': request.method,
                    'path': request.path,
                    'status_code': response.status_code,
                    'response_time_ms': round(response_time * 1000, 2),
                    'request_id': id(request),
                    'remote_addr': request.remote_addr,
                    'user_agent': request.headers.get('User-Agent', 'unknown')
                })
            
        except Exception as e:
            logger.error(f"Failed to log response info: {e}")
        
        return response
    
    @app.errorhandler(404)
    def log_404_error(error):
        """Log 404 errors with additional context."""
        logger.warning("404 Not Found", extra={
            'method': request.method,
            'path': request.path,
            'remote_addr': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'referer': request.headers.get('Referer'),
            'request_id': id(request)
        })
        return {'error': 'Not Found', 'path': request.path}, 404
    
    @app.errorhandler(500)
    def log_500_error(error):
        """Log 500 errors with additional context."""
        logger.error("500 Internal Server Error", extra={
            'method': request.method,
            'path': request.path,
            'remote_addr': request.remote_addr,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'error': str(error),
            'request_id': id(request)
        })
        return {'error': 'Internal Server Error'}, 500
    
    logger.info("Request logging middleware configured")


def log_api_usage(endpoint_name: str):
    """Decorator to log API endpoint usage."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            logger = logging.getLogger(f"api.{endpoint_name}")
            
            start_time = time.time()
            
            try:
                result = func(*args, **kwargs)
                
                # Log successful API call
                logger.info(f"API call completed: {endpoint_name}", extra={
                    'endpoint': endpoint_name,
                    'method': request.method,
                    'path': request.path,
                    'duration_ms': round((time.time() - start_time) * 1000, 2),
                    'status': 'success',
                    'request_id': id(request)
                })
                
                return result
                
            except Exception as e:
                # Log API call failure
                logger.error(f"API call failed: {endpoint_name}", extra={
                    'endpoint': endpoint_name,
                    'method': request.method,
                    'path': request.path,
                    'duration_ms': round((time.time() - start_time) * 1000, 2),
                    'status': 'error',
                    'error': str(e),
                    'request_id': id(request)
                })
                raise
                
        return wrapper
    return decorator
