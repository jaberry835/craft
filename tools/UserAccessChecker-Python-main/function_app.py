"""
UserAccessChecker Azure Function (Python)
Main function app entry point
"""
import azure.functions as func
import logging

from functions.get_user_access import bp as user_access_bp
from functions.get_hash import bp as get_hash_bp

app = func.FunctionApp()

# Register blueprints
app.register_functions(user_access_bp)
app.register_functions(get_hash_bp)

logging.info("UserAccessChecker Function App initialized")
