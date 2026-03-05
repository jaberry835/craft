"""
Azure OpenAI Discovery Service
Discovers model deployments from Azure OpenAI endpoints using the ARM (Azure Resource Manager) API.

Note: The data plane API does not support listing deployments.
We must use the ARM API which requires subscription_id and resource_group.

Supports multiple Azure clouds:
  - AzureCommercial (default): management.azure.com
  - AzureGovernment: management.usgovcloudapi.net
  - AzureChina: management.chinacloudapi.cn
"""
import httpx
import re
from typing import Optional
from urllib.parse import urlparse

from models import ModelDeployment
from config import get_azure_credential
from observability import get_logger

logger = get_logger(__name__)

# Cloud-specific ARM endpoints and token scopes
CLOUD_CONFIG = {
    "AzureCommercial": {
        "arm_endpoint": "https://management.azure.com",
        "arm_scope": "https://management.azure.com/.default",
    },
    "AzureGovernment": {
        "arm_endpoint": "https://management.usgovcloudapi.net",
        "arm_scope": "https://management.usgovcloudapi.net/.default",
    },
    "AzureChina": {
        "arm_endpoint": "https://management.chinacloudapi.cn",
        "arm_scope": "https://management.chinacloudapi.cn/.default",
    },
}

# Map endpoint URL suffixes to cloud names for auto-detection
ENDPOINT_CLOUD_MAP = {
    ".azure.us": "AzureGovernment",
    ".azure.com": "AzureCommercial",
    ".azure.cn": "AzureChina",
}


class AOAIDiscoveryService:
    """Service for discovering Azure OpenAI model deployments using ARM API."""
    
    def __init__(self):
        self.timeout = 30.0
        self.arm_api_version = "2023-05-01"
    
    @staticmethod
    def detect_cloud_from_endpoint(endpoint: str) -> str:
        """
        Auto-detect the Azure cloud from the endpoint URL suffix.
        
        E.g., https://myaoai.openai.azure.us -> AzureGovernment
        E.g., https://myaoai.openai.azure.com -> AzureCommercial
        E.g., https://myaoai.openai.azure.cn  -> AzureChina
        """
        endpoint_lower = endpoint.lower()
        for suffix, cloud in ENDPOINT_CLOUD_MAP.items():
            if suffix in endpoint_lower:
                return cloud
        return "AzureCommercial"
    
    @staticmethod
    def _extract_account_name(endpoint: str) -> Optional[str]:
        """
        Extract the account name from an Azure OpenAI endpoint URL.
        
        Supports all Azure clouds:
          https://myaoai.openai.azure.com -> myaoai
          https://myaoai.openai.azure.us  -> myaoai
          https://myaoai.openai.azure.cn  -> myaoai
        Also supports Cognitive Services endpoints:
          https://myaoai.cognitiveservices.azure.com -> myaoai
        """
        try:
            parsed = urlparse(endpoint)
            hostname = parsed.hostname or ""
            # Pattern: {account-name}.openai.azure.{com|us|cn}
            match = re.match(r"^([^.]+)\.openai\.azure\.(com|us|cn)$", hostname)
            if match:
                return match.group(1)
            # Also try cognitiveservices pattern
            match = re.match(r"^([^.]+)\.cognitiveservices\.azure\.(com|us|cn)$", hostname)
            if match:
                return match.group(1)
            return None
        except Exception:
            return None
    
    def _get_cloud_config(self, cloud: str) -> dict:
        """Get ARM configuration for the specified cloud."""
        config = CLOUD_CONFIG.get(cloud)
        if not config:
            raise ValueError(
                f"Unknown cloud '{cloud}'. Supported: {', '.join(CLOUD_CONFIG.keys())}"
            )
        return config
    
    async def discover_deployments(
        self,
        endpoint: str,
        subscription_id: Optional[str] = None,
        resource_group: Optional[str] = None,
        cloud: Optional[str] = None,
        api_key: Optional[str] = None  # Not used for ARM, kept for interface compatibility
    ) -> list[ModelDeployment]:
        """
        Discover available model deployments from an Azure OpenAI resource.
        
        Uses the Azure Resource Manager API to list deployments.
        Requires subscription_id and resource_group.
        
        Args:
            endpoint: Azure OpenAI endpoint URL
            subscription_id: Azure subscription ID
            resource_group: Resource group containing the AOAI resource
            cloud: Azure cloud name (auto-detected from endpoint URL if not provided)
            api_key: Not used (ARM uses managed identity/CLI auth)
            
        Returns:
            List of ModelDeployment objects
        """
        # Normalize endpoint URL
        endpoint = endpoint.rstrip("/")
        
        # Always auto-detect cloud from endpoint URL (most reliable source of truth)
        detected_cloud = self.detect_cloud_from_endpoint(endpoint)
        if cloud and cloud != detected_cloud:
            logger.warning(f"Stored cloud '{cloud}' doesn't match endpoint URL (detected '{detected_cloud}'). Using detected cloud.")
        cloud = detected_cloud
        
        cloud_config = self._get_cloud_config(cloud)
        arm_endpoint = cloud_config["arm_endpoint"]
        arm_scope = cloud_config["arm_scope"]
        
        # Extract account name from endpoint
        account_name = self._extract_account_name(endpoint)
        if not account_name:
            raise ValueError(
                f"Could not parse account name from endpoint URL: {endpoint}. "
                "Expected format: https://<account-name>.openai.azure.com (or .azure.us / .azure.cn)"
            )
        
        # Require subscription and resource group for ARM API
        if not subscription_id or not resource_group:
            raise ValueError(
                "Subscription ID and Resource Group are required for deployment discovery. "
                "Please provide these values or add deployments manually."
            )
        
        logger.info(f"Discovering deployments for {account_name} via ARM API ({cloud})")
        logger.info(f"  Subscription: {subscription_id}")
        logger.info(f"  Resource Group: {resource_group}")
        logger.info(f"  ARM Endpoint: {arm_endpoint}")
        
        # Get ARM token
        try:
            credential = get_azure_credential()
            token = credential.get_token(arm_scope)
            headers = {
                "Authorization": f"Bearer {token.token}",
                "Content-Type": "application/json"
            }
        except Exception as e:
            logger.error(f"Failed to get ARM credential: {e}")
            raise ValueError(f"Failed to authenticate with Azure Resource Manager: {e}")
        
        # Build ARM API URL
        url = (
            f"{arm_endpoint}/subscriptions/{subscription_id}"
            f"/resourceGroups/{resource_group}"
            f"/providers/Microsoft.CognitiveServices/accounts/{account_name}"
            f"/deployments?api-version={self.arm_api_version}"
        )
        
        logger.debug(f"ARM API URL: {url}")
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(url, headers=headers)
                
                if response.status_code == 401:
                    raise ValueError(
                        "ARM authentication failed. Ensure your Azure CLI is logged in "
                        "and has access to this subscription."
                    )
                elif response.status_code == 403:
                    raise ValueError(
                        "Access forbidden. Your account needs 'Reader' or "
                        "'Cognitive Services OpenAI Contributor' role on the Azure OpenAI resource."
                    )
                elif response.status_code == 404:
                    raise ValueError(
                        f"Resource not found. Verify:\n"
                        f"  - Subscription ID: {subscription_id}\n"
                        f"  - Resource Group: {resource_group}\n"
                        f"  - Account Name: {account_name}"
                    )
                
                response.raise_for_status()
                
                data = response.json()
                deployments = []
                
                # ARM API returns {"value": [...]}
                deployment_list = data.get("value", [])
                
                for item in deployment_list:
                    deployment_name = item.get("name")
                    if not deployment_name:
                        continue
                    
                    properties = item.get("properties", {})
                    model = properties.get("model", {})
                    
                    model_name = model.get("name", "")
                    model_version = model.get("version")
                    
                    # Extract SKU info
                    sku = item.get("sku", {})
                    capacity = sku.get("capacity")
                    sku_name = sku.get("name")
                    
                    deployments.append(ModelDeployment(
                        deployment_name=deployment_name,
                        model_name=model_name,
                        model_version=model_version,
                        capacity=capacity,
                        sku=sku_name
                    ))
                
                logger.info(f"Discovered {len(deployments)} deployments from {account_name}")
                return deployments
                
        except httpx.TimeoutException:
            logger.error(f"Timeout connecting to ARM API")
            raise ValueError("Timeout connecting to Azure Resource Manager")
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error from ARM API: {e.response.status_code}")
            raise ValueError(f"ARM API error: {e.response.status_code}")
        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Error discovering deployments: {e}")
            raise ValueError(f"Discovery failed: {str(e)}")


# Singleton instance
aoai_discovery = AOAIDiscoveryService()
