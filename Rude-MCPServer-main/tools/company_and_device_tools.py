"""
Company and Device Tools for Rude MCP Server
Static demo tools that return company and device information from environment variables.
Provides the same interface as fictional_api_tools.py but uses configurable static data.
"""

import json
import os
from typing import Dict, Any, List
import logging
from fastmcp import FastMCP

logger = logging.getLogger(__name__)

# Default demo data - used if environment variables are not set
DEFAULT_COMPANY_INFO = {
    "company_name": "Contoso Ltd",
    "industry": "Technology",
    "headquarters": "Seattle, WA",
    "employee_count": 5000,
    "founded": 2010,
    "website": "https://contoso.com",
    "description": "A leading technology solutions provider"
}

DEFAULT_DEVICE_INFO = [
    {
        "device_id": "DEV-001",
        "device_name": "Contoso-Workstation-01",
        "device_type": "Workstation",
        "os": "Windows 11 Pro",
        "ip_address": "10.0.1.100",
        "status": "Online",
        "last_seen": "2026-01-28T10:30:00Z"
    },
    {
        "device_id": "DEV-002",
        "device_name": "Contoso-Server-01",
        "device_type": "Server",
        "os": "Windows Server 2022",
        "ip_address": "10.0.1.10",
        "status": "Online",
        "last_seen": "2026-01-28T10:29:00Z"
    },
    {
        "device_id": "DEV-003",
        "device_name": "Contoso-Laptop-01",
        "device_type": "Laptop",
        "os": "Windows 11 Enterprise",
        "ip_address": "10.0.1.150",
        "status": "Offline",
        "last_seen": "2026-01-27T18:00:00Z"
    }
]

DEFAULT_IP_MAPPINGS = {
    "10.0.1.100": "Contoso Ltd",
    "10.0.1.10": "Contoso Ltd",
    "10.0.1.150": "Contoso Ltd",
    "192.168.1.50": "Fabrikam Inc",
    "192.168.1.51": "Fabrikam Inc"
}


def _load_json_env(env_var: str, default: Any) -> Any:
    """Load JSON data from an environment variable, falling back to default"""
    env_value = os.getenv(env_var)
    if env_value:
        try:
            return json.loads(env_value)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse {env_var} as JSON: {e}. Using default.")
            return default
    return default


def get_company_info_data() -> Dict[str, Any]:
    """Get company info from environment variable or default"""
    return _load_json_env("DEMO_COMPANY_INFO", DEFAULT_COMPANY_INFO)


def get_device_info_data() -> List[Dict[str, Any]]:
    """Get device info from environment variable or default"""
    return _load_json_env("DEMO_DEVICE_INFO", DEFAULT_DEVICE_INFO)


def get_ip_mappings_data() -> Dict[str, str]:
    """Get IP to company mappings from environment variable or default"""
    return _load_json_env("DEMO_IP_MAPPINGS", DEFAULT_IP_MAPPINGS)


def register_company_and_device_tools(mcp: FastMCP):
    """Register all company and device demo tools with the FastMCP server"""
    
    @mcp.tool
    def demo_get_ip_company_info(ip_address: str) -> Dict[str, Any]:
        """
        Get demo company information for a given IP address.
        Returns static company data configured via environment variables.
        
        Environment Variables:
        - DEMO_IP_MAPPINGS: JSON object mapping IP addresses to company names
        - DEMO_COMPANY_INFO: JSON object with company details
        """
        logger.info(f"🔍 demo_get_ip_company_info called with ip_address: {ip_address}")
        try:
            ip_mappings = get_ip_mappings_data()
            company_info = get_company_info_data()
            logger.info(f"📊 Loaded {len(ip_mappings)} IP mappings, company: {company_info.get('company_name', 'N/A')}")
            
            if ip_address in ip_mappings:
                company_name = ip_mappings[ip_address]
                result = {
                    "status": "success",
                    "data": {
                        "ip_address": ip_address,
                        "company_name": company_name,
                        "company_details": company_info
                    },
                    "message": f"Retrieved demo company information for IP {ip_address}"
                }
                logger.info(f"✅ Found company '{company_name}' for IP {ip_address}")
                return result
            else:
                result = {
                    "status": "not_found",
                    "data": {
                        "ip_address": ip_address,
                        "company_name": None,
                        "company_details": None
                    },
                    "message": f"No company mapping found for IP {ip_address}"
                }
                logger.info(f"⚠️ No mapping found for IP {ip_address}. Available IPs: {list(ip_mappings.keys())}")
                return result
                
        except Exception as e:
            logger.error(f"Error fetching demo IP company info: {e}")
            return {
                "status": "error",
                "message": f"Failed to get company info for IP {ip_address}: {str(e)}",
                "data": None
            }

    @mcp.tool
    def demo_get_company_devices(company_name: str) -> Dict[str, Any]:
        """
        Get demo device information for a given company.
        Returns static device data configured via environment variables.
        
        Environment Variables:
        - DEMO_DEVICE_INFO: JSON array of device objects
        - DEMO_COMPANY_INFO: JSON object with company details (used for company name matching)
        """
        logger.info(f"🔍 demo_get_company_devices called with company_name: {company_name}")
        try:
            devices = get_device_info_data()
            company_info = get_company_info_data()
            logger.info(f"📊 Loaded {len(devices)} devices, configured company: {company_info.get('company_name', 'N/A')}")
            
            # Check if the requested company matches our demo company
            demo_company_name = company_info.get("company_name", "").lower()
            
            if company_name.lower() in demo_company_name or demo_company_name in company_name.lower():
                result = {
                    "status": "success",
                    "data": {
                        "company_name": company_info.get("company_name"),
                        "device_count": len(devices),
                        "devices": devices
                    },
                    "message": f"Retrieved demo device information for company {company_name}"
                }
                logger.info(f"✅ Found {len(devices)} devices for company '{company_name}'")
                return result
            else:
                result = {
                    "status": "not_found",
                    "data": {
                        "company_name": company_name,
                        "device_count": 0,
                        "devices": []
                    },
                    "message": f"No devices found for company {company_name}"
                }
                logger.info(f"⚠️ Company '{company_name}' not found. Configured company: '{company_info.get('company_name')}'")
                return result
                
        except Exception as e:
            logger.error(f"Error fetching demo company devices: {e}")
            return {
                "status": "error",
                "message": f"Failed to get device info for company {company_name}: {str(e)}",
                "data": None
            }

    @mcp.tool
    def demo_get_company_summary(company_name: str) -> Dict[str, Any]:
        """
        Get comprehensive demo summary for a given company.
        Returns combined company and device data from environment variables.
        
        Environment Variables:
        - DEMO_COMPANY_INFO: JSON object with company details
        - DEMO_DEVICE_INFO: JSON array of device objects
        """
        logger.info(f"🔍 demo_get_company_summary called with company_name: {company_name}")
        try:
            company_info = get_company_info_data()
            devices = get_device_info_data()
            logger.info(f"📊 Loaded company: {company_info.get('company_name', 'N/A')}, {len(devices)} devices")
            
            # Check if the requested company matches our demo company
            demo_company_name = company_info.get("company_name", "").lower()
            
            if company_name.lower() in demo_company_name or demo_company_name in company_name.lower():
                # Calculate device statistics
                online_devices = sum(1 for d in devices if d.get("status", "").lower() == "online")
                offline_devices = len(devices) - online_devices
                
                result = {
                    "status": "success",
                    "data": {
                        "company": company_info,
                        "device_summary": {
                            "total_devices": len(devices),
                            "online_devices": online_devices,
                            "offline_devices": offline_devices,
                            "device_types": list(set(d.get("device_type", "Unknown") for d in devices))
                        },
                        "devices": devices
                    },
                    "message": f"Retrieved demo company summary for {company_name}"
                }
                logger.info(f"✅ Returning summary for '{company_name}': {len(devices)} devices ({online_devices} online)")
                return result
            else:
                result = {
                    "status": "not_found",
                    "data": None,
                    "message": f"No summary found for company {company_name}"
                }
                logger.info(f"⚠️ Company '{company_name}' not found. Configured company: '{company_info.get('company_name')}'")
                return result
                
        except Exception as e:
            logger.error(f"Error fetching demo company summary: {e}")
            return {
                "status": "error",
                "message": f"Failed to get company summary for {company_name}: {str(e)}",
                "data": None
            }

    @mcp.tool
    def demo_api_health_check() -> Dict[str, Any]:
        """
        Check the health of the demo company and device API.
        Validates that environment variables are properly configured.
        """
        logger.info("🔍 demo_api_health_check called")
        try:
            company_info = get_company_info_data()
            devices = get_device_info_data()
            ip_mappings = get_ip_mappings_data()
            
            # Check if using defaults or custom env vars
            using_custom_company = os.getenv("DEMO_COMPANY_INFO") is not None
            using_custom_devices = os.getenv("DEMO_DEVICE_INFO") is not None
            using_custom_ip_mappings = os.getenv("DEMO_IP_MAPPINGS") is not None
            
            logger.info(f"📊 Health check - Company: {company_info.get('company_name')}, Devices: {len(devices)}, IP mappings: {len(ip_mappings)}")
            logger.info(f"📊 Using custom env vars - Company: {using_custom_company}, Devices: {using_custom_devices}, IP mappings: {using_custom_ip_mappings}")
            
            result = {
                "status": "success",
                "data": {
                    "service": "Demo Company and Device API",
                    "version": "1.0.0",
                    "configuration": {
                        "using_custom_company_info": using_custom_company,
                        "using_custom_device_info": using_custom_devices,
                        "using_custom_ip_mappings": using_custom_ip_mappings
                    },
                    "stats": {
                        "configured_company": company_info.get("company_name"),
                        "device_count": len(devices),
                        "ip_mapping_count": len(ip_mappings)
                    }
                },
                "message": "Demo Company and Device API is healthy and available"
            }
            logger.info("✅ Health check passed")
            return result
            
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return {
                "status": "error",
                "message": f"Health check failed: {str(e)}",
                "data": None
            }

    @mcp.tool
    def demo_list_all_devices() -> Dict[str, Any]:
        """
        List all demo devices configured in the system.
        Returns all device data from environment variables.
        """
        logger.info("🔍 demo_list_all_devices called")
        try:
            devices = get_device_info_data()
            company_info = get_company_info_data()
            logger.info(f"📊 Listing {len(devices)} devices for company: {company_info.get('company_name', 'N/A')}")
            
            result = {
                "status": "success",
                "data": {
                    "company_name": company_info.get("company_name"),
                    "total_devices": len(devices),
                    "devices": devices
                },
                "message": "Retrieved all demo devices"
            }
            logger.info(f"✅ Returning {len(devices)} devices")
            return result
            
        except Exception as e:
            logger.error(f"Error listing demo devices: {e}")
            return {
                "status": "error",
                "message": f"Failed to list devices: {str(e)}",
                "data": None
            }

    @mcp.tool
    def demo_get_device_by_id(device_id: str) -> Dict[str, Any]:
        """
        Get a specific demo device by its ID.
        
        Args:
            device_id: The unique identifier of the device (e.g., "DEV-001")
        """
        logger.info(f"🔍 demo_get_device_by_id called with device_id: {device_id}")
        try:
            devices = get_device_info_data()
            logger.info(f"📊 Searching through {len(devices)} devices")
            
            for device in devices:
                if device.get("device_id", "").lower() == device_id.lower():
                    logger.info(f"✅ Found device: {device.get('device_name')}")
                    return {
                        "status": "success",
                        "data": device,
                        "message": f"Retrieved demo device {device_id}"
                    }
            
            available_ids = [d.get("device_id") for d in devices]
            logger.info(f"⚠️ Device '{device_id}' not found. Available IDs: {available_ids}")
            return {
                "status": "not_found",
                "data": None,
                "message": f"No device found with ID {device_id}"
            }
            
        except Exception as e:
            logger.error(f"Error fetching demo device: {e}")
            return {
                "status": "error",
                "message": f"Failed to get device {device_id}: {str(e)}",
                "data": None
            }

    logger.info("Company and Device demo tools registered successfully")
