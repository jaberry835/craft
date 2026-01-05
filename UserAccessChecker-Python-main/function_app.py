"""
UserAccessChecker Azure Function (Python)
Main function app entry point
"""
import azure.functions as func
import logging

from functions.get_user_access import bp as user_access_bp

app = func.FunctionApp()

# Register the user access blueprint
app.register_functions(user_access_bp)

logging.info("UserAccessChecker Function App initialized")
