"""Unified routes for remote agents - exposes all agents on same app/port.

Instead of running 4 separate Flask apps on different ports, all agents
are now accessible as routes on the main application:
- /agents/adx/*
- /agents/document/*  
- /agents/investigator/*
- /agents/fictionalcompanies/*

Each agent maintains its own logic but runs as part of the unified API.
"""

import asyncio
import sys
import os
from flask import Blueprint, request, jsonify
from pydantic import BaseModel
from typing import Dict, Any

# Import the standalone agent service modules - they have all the logic we need
from src.remote_agents import adx_agent_service
from src.remote_agents import document_agent_service  
from src.remote_agents import investigator_agent_service
from src.remote_agents import fictional_companies_agent_service

from src.utils.logging import get_logger

logger = get_logger(__name__)

# Create blueprint for remote agent routes
remote_agents_bp = Blueprint('remote_agents', __name__, url_prefix='/agents')


# Pydantic model for JSON-RPC requests
class RpcRequest(BaseModel):
    jsonrpc: str
    id: str
    method: str
    params: Dict[str, Any] = {}


# ============================================================================
# ADX AGENT ROUTES
# ============================================================================

@remote_agents_bp.route('/adx/.well-known/agent-card.json', methods=['GET'])
def adx_agent_card():
    """ADX Agent discovery endpoint."""
    base = request.host_url.rstrip('/') + '/agents/adx'
    return jsonify({
        "name": "ADXAgent",
        "description": "Database intelligence specialist: Searches security scan data, network logs, vulnerability reports, IP address analysis, device activity records, and threat intelligence using KQL queries. Discovers patterns across multiple tables and databases. Use for investigating IPs, finding security events, analyzing network traffic, and cross-referencing threat data.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": f"{base}/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": ["messages", "tasks"],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
            "headers": {"type": "apiKey", "in": "header", "name": "X-ADX-Token"}
        },
        "security": [{"bearer": []}, {"headers": []}]
    })


@remote_agents_bp.route('/adx/a2a/message', methods=['POST'])
def adx_agent_message():
    """ADX Agent message endpoint."""
    try:
        req_data = request.get_json()
        req = RpcRequest(**req_data)
    except Exception as e:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": f"Invalid request: {e}"}), 400
    
    # Get headers
    authorization = request.headers.get("Authorization")
    x_user_id = request.headers.get("X-User-ID")
    x_session_id = request.headers.get("X-Session-ID")
    x_adx_token = request.headers.get("X-ADX-Token")
    
    # Use the ADX agent's async executor to process
    try:
        if adx_agent_service._async_executor._loop is None:
            adx_agent_service._async_executor.start()
        
        result = adx_agent_service._async_executor.run_async(
            adx_agent_service.process_message(req, authorization, x_user_id, x_session_id, x_adx_token),
            timeout=300
        )
        return jsonify(result)
    except Exception as e:
        logger.error(f"ADX agent error: {e}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": str(e)}), 500


# ============================================================================
# DOCUMENT AGENT ROUTES
# ============================================================================

@remote_agents_bp.route('/document/.well-known/agent-card.json', methods=['GET'])
def document_agent_card():
    """Document Agent discovery endpoint."""
    base = request.host_url.rstrip('/') + '/agents/document'
    return jsonify({
        "name": "DocumentAgent",
        "description": "Handles document listing/search/summarization backed by MCP DocumentTools.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": f"{base}/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": ["messages", "tasks"],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
        },
        "security": [{"bearer": []}]
    })


@remote_agents_bp.route('/document/a2a/message', methods=['POST'])
def document_agent_message():
    """Document Agent message endpoint."""
    try:
        req_data = request.get_json()
        req = RpcRequest(**req_data)
    except Exception as e:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": f"Invalid request: {e}"}), 400
    
    # Get headers
    authorization = request.headers.get("Authorization")
    x_user_id = request.headers.get("X-User-ID")
    x_session_id = request.headers.get("X-Session-ID")
    
    # Use the Document agent's async executor
    try:
        if document_agent_service._async_executor._loop is None:
            document_agent_service._async_executor.start()
        
        result = document_agent_service._async_executor.run_async(
            document_agent_service.process_message(req, authorization, x_user_id, x_session_id),
            timeout=300
        )
        return jsonify(result)
    except Exception as e:
        logger.error(f"Document agent error: {e}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": str(e)}), 500


# ============================================================================
# INVESTIGATOR AGENT ROUTES
# ============================================================================

@remote_agents_bp.route('/investigator/.well-known/agent-card.json', methods=['GET'])
def investigator_agent_card():
    """Investigator Agent discovery endpoint."""
    base = request.host_url.rstrip('/') + '/agents/investigator'
    return jsonify({
        "name": "InvestigatorAgent",
        "description": "Background research specialist: Retrieves information on people, executives, leadership teams, career histories, professional backgrounds, biographical data, and organizational relationships from indexed knowledge sources using RAG search. Ideal for investigating individuals and understanding human elements.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": f"{base}/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": ["messages", "tasks"],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
        },
        "security": [{"bearer": []}]
    })


@remote_agents_bp.route('/investigator/a2a/message', methods=['POST'])
def investigator_agent_message():
    """Investigator Agent message endpoint."""
    try:
        req_data = request.get_json()
        req = RpcRequest(**req_data)
    except Exception as e:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": f"Invalid request: {e}"}), 400
    
    # Get headers
    authorization = request.headers.get("Authorization")
    x_user_id = request.headers.get("X-User-ID")
    x_session_id = request.headers.get("X-Session-ID")
    
    # Use the Investigator agent's async executor
    try:
        if investigator_agent_service._async_executor._loop is None:
            investigator_agent_service._async_executor.start()
        
        result = investigator_agent_service._async_executor.run_async(
            investigator_agent_service.process_message(req, authorization, x_user_id, x_session_id),
            timeout=300
        )
        return jsonify(result)
    except Exception as e:
        logger.error(f"Investigator agent error: {e}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": str(e)}), 500


# ============================================================================
# FICTIONAL COMPANIES AGENT ROUTES
# ============================================================================

@remote_agents_bp.route('/fictionalcompanies/.well-known/agent-card.json', methods=['GET'])
def fictionalcompanies_agent_card():
    """Fictional Companies Agent discovery endpoint."""
    base = request.host_url.rstrip('/') + '/agents/fictionalcompanies'
    return jsonify({
        "name": "FictionalCompaniesAgent",
        "description": "Company intelligence specialist: Retrieves company profiles, business details, network infrastructure, device inventories with IP addresses, organizational structure, and location data. Essential for company research and network analysis starting points.",
        "protocol": "A2A-HTTP-JSONRPC-2.0",
        "endpoints": {
            "jsonrpc": f"{base}/a2a/message"
        },
        "auth": {"type": "bearer-or-headers"},
        "capabilities": ["messages", "tasks"],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
        },
        "security": [{"bearer": []}]
    })


@remote_agents_bp.route('/fictionalcompanies/a2a/message', methods=['POST'])
def fictionalcompanies_agent_message():
    """Fictional Companies Agent message endpoint."""
    try:
        req_data = request.get_json()
        req = RpcRequest(**req_data)
    except Exception as e:
        return jsonify({"jsonrpc": "2.0", "id": None, "error": f"Invalid request: {e}"}), 400
    
    # Get headers
    authorization = request.headers.get("Authorization")
    x_user_id = request.headers.get("X-User-ID")
    x_session_id = request.headers.get("X-Session-ID")
    
    # Use the Fictional Companies agent's async executor
    try:
        if fictional_companies_agent_service._async_executor._loop is None:
            fictional_companies_agent_service._async_executor.start()
        
        result = fictional_companies_agent_service._async_executor.run_async(
            fictional_companies_agent_service.process_message(req, authorization, x_user_id, x_session_id),
            timeout=300
        )
        return jsonify(result)
    except Exception as e:
        logger.error(f"Fictional Companies agent error: {e}")
        return jsonify({"jsonrpc": "2.0", "id": getattr(req, 'id', 'unknown'), "error": str(e)}), 500


# ============================================================================
# AGENT INITIALIZATION
# ============================================================================

async def initialize_all_agents():
    """Initialize all remote agents on startup."""
    logger.info("🚀 Initializing all remote agents...")
    
    try:
        # Initialize each agent
        await adx_agent_service.startup()
        logger.info("✅ ADX Agent initialized")
    except Exception as e:
        logger.error(f"❌ Failed to initialize ADX Agent: {e}")
    
    try:
        await document_agent_service.startup()
        logger.info("✅ Document Agent initialized")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Document Agent: {e}")
    
    try:
        await investigator_agent_service.startup()
        logger.info("✅ Investigator Agent initialized")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Investigator Agent: {e}")
    
    try:
        await fictional_companies_agent_service.startup()
        logger.info("✅ Fictional Companies Agent initialized")
    except Exception as e:
        logger.error(f"❌ Failed to initialize Fictional Companies Agent: {e}")
    
    logger.info("✅ All remote agents initialized")


def init_agents():
    """Synchronous wrapper to initialize agents."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(initialize_all_agents())
    finally:
        loop.close()
