"""
Early logging configuration to suppress verbose Azure SDK logs.
This module should be imported before any Azure SDK modules to ensure
logging configuration takes effect immediately.
"""

import logging
import os

def apply_early_logging_suppressions():
    """Apply logging suppressions early in the startup process."""
    
    # Check if we should suppress Azure logs (default to True if not set)
    suppress_azure = os.getenv("SUPPRESS_AZURE_LOGS", "true").lower() == "true"
    suppress_semantic_kernel = os.getenv("SUPPRESS_SEMANTIC_KERNEL_LOGS", "true").lower() == "true"
    
    if suppress_azure:
        # Suppress verbose Azure SDK logging
        logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
        logging.getLogger("azure.core.pipeline.policies").setLevel(logging.WARNING)
        logging.getLogger("urllib3.connectionpool").setLevel(logging.WARNING)
        logging.getLogger("httpcore.http11").setLevel(logging.WARNING)
        logging.getLogger("httpcore.connection").setLevel(logging.WARNING)
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("openai._base_client").setLevel(logging.WARNING)
    
    if suppress_semantic_kernel:
        # Suppress verbose Semantic Kernel logging
        logging.getLogger("semantic_kernel.prompt_template.kernel_prompt_template").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.functions.kernel_function").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.connectors.ai.open_ai.services.open_ai_handler").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.connectors.ai.chat_completion_client_base").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.chat_completion.chat_completion_agent").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.strategies.termination.termination_strategy").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.strategies.selection.sequential_selection_strategy").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.agents.group_chat.agent_chat").setLevel(logging.WARNING)
        logging.getLogger("semantic_kernel.kernel").setLevel(logging.WARNING)

# Apply suppressions immediately when this module is imported
apply_early_logging_suppressions()
