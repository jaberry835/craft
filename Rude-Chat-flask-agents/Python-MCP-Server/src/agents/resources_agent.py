import json
import logging
from typing import List, Dict, Any, Optional
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion
from semantic_kernel.functions import kernel_function
from semantic_kernel.contents import ChatHistory
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from azure.mgmt.resource import ResourceManagementClient
from azure.mgmt.storage import StorageManagementClient
from .base_agent import BaseAgent

logger = logging.getLogger(__name__)

class ResourcesAgentPlugin:
    """Semantic Kernel plugin for Azure resource management operations"""
    
    def __init__(self, azure_config: Dict[str, Any]):
        self.subscription_id = azure_config.get("SubscriptionId", "")
        self.credential = DefaultAzureCredential()
        
        # Initialize Azure management clients
        if self.subscription_id:
            self.resource_client = ResourceManagementClient(
                credential=self.credential,
                subscription_id=self.subscription_id
            )
            self.storage_client = StorageManagementClient(
                credential=self.credential,
                subscription_id=self.subscription_id
            )
        else:
            self.resource_client = None
            self.storage_client = None
            logger.warning("Azure subscription ID not configured - resource management will be limited")
    
    @kernel_function(description="List storage accounts in the subscription")
    async def list_storage_accounts(self, resource_group: str = "") -> str:
        """List storage accounts, optionally filtered by resource group"""
        try:
            if not self.storage_client:
                return json.dumps({"error": "Azure subscription not configured"})
            
            storage_accounts = []
            
            if resource_group:
                accounts = self.storage_client.storage_accounts.list_by_resource_group(resource_group)
            else:
                accounts = self.storage_client.storage_accounts.list()
            
            for account in accounts:
                storage_accounts.append({
                    "name": account.name,
                    "resource_group": account.id.split('/')[4],  # Extract RG from resource ID
                    "location": account.location,
                    "kind": account.kind,
                    "sku": account.sku.name if account.sku else None,
                    "primary_endpoints": {
                        "blob": account.primary_endpoints.blob if account.primary_endpoints else None,
                        "queue": account.primary_endpoints.queue if account.primary_endpoints else None,
                        "table": account.primary_endpoints.table if account.primary_endpoints else None,
                        "file": account.primary_endpoints.file if account.primary_endpoints else None
                    }
                })
            
            return json.dumps({
                "subscription_id": self.subscription_id,
                "resource_group_filter": resource_group,
                "storage_account_count": len(storage_accounts),
                "storage_accounts": storage_accounts
            })
            
        except Exception as e:
            logger.error(f"Error listing storage accounts: {str(e)}")
            return json.dumps({"error": f"Failed to list storage accounts: {str(e)}"})
    
    @kernel_function(description="List containers in a storage account")
    async def list_containers(self, storage_account_name: str, connection_string: str = "") -> str:
        """List containers in a specific storage account"""
        try:
            if connection_string:
                blob_service_client = BlobServiceClient.from_connection_string(connection_string)
            else:
                # Try to use managed identity
                account_url = f"https://{storage_account_name}.blob.core.windows.net"
                blob_service_client = BlobServiceClient(
                    account_url=account_url,
                    credential=self.credential
                )
            
            containers = []
            container_list = blob_service_client.list_containers()
            
            for container in container_list:
                containers.append({
                    "name": container.name,
                    "last_modified": container.last_modified.isoformat() if container.last_modified else None,
                    "metadata": container.metadata or {},
                    "public_access": container.public_access
                })
            
            return json.dumps({
                "storage_account": storage_account_name,
                "container_count": len(containers),
                "containers": containers
            })
            
        except Exception as e:
            logger.error(f"Error listing containers for {storage_account_name}: {str(e)}")
            return json.dumps({"error": f"Failed to list containers: {str(e)}"})
    
    @kernel_function(description="Get status and information about Azure resources")
    async def get_resource_status(self, resource_group: str = "", resource_type: str = "") -> str:
        """Get status and information about Azure resources"""
        try:
            if not self.resource_client:
                return json.dumps({"error": "Azure subscription not configured"})
            
            resources = []
            
            if resource_group:
                resource_list = self.resource_client.resources.list_by_resource_group(resource_group)
            else:
                resource_list = self.resource_client.resources.list()
            
            for resource in resource_list:
                if not resource_type or resource_type.lower() in resource.type.lower():
                    resources.append({
                        "name": resource.name,
                        "type": resource.type,
                        "resource_group": resource.id.split('/')[4],
                        "location": resource.location,
                        "tags": resource.tags or {},
                        "id": resource.id
                    })
            
            return json.dumps({
                "subscription_id": self.subscription_id,
                "resource_group_filter": resource_group,
                "resource_type_filter": resource_type,
                "resource_count": len(resources),
                "resources": resources
            })
            
        except Exception as e:
            logger.error(f"Error getting resource status: {str(e)}")
            return json.dumps({"error": f"Failed to get resource status: {str(e)}"})
    
    @kernel_function(description="List resource groups in the subscription")
    async def list_resource_groups(self) -> str:
        """List all resource groups in the subscription"""
        try:
            if not self.resource_client:
                return json.dumps({"error": "Azure subscription not configured"})
            
            resource_groups = []
            rg_list = self.resource_client.resource_groups.list()
            
            for rg in rg_list:
                resource_groups.append({
                    "name": rg.name,
                    "location": rg.location,
                    "tags": rg.tags or {},
                    "provisioning_state": rg.provisioning_state
                })
            
            return json.dumps({
                "subscription_id": self.subscription_id,
                "resource_group_count": len(resource_groups),
                "resource_groups": resource_groups
            })
            
        except Exception as e:
            logger.error(f"Error listing resource groups: {str(e)}")
            return json.dumps({"error": f"Failed to list resource groups: {str(e)}"})
    
    @kernel_function(description="Get detailed information about a specific resource")
    async def get_resource_details(self, resource_id: str) -> str:
        """Get detailed information about a specific Azure resource"""
        try:
            if not self.resource_client:
                return json.dumps({"error": "Azure subscription not configured"})
            
            # Parse resource ID to extract components
            resource_parts = resource_id.split('/')
            if len(resource_parts) < 9:
                return json.dumps({"error": "Invalid resource ID format"})
            
            resource_group_name = resource_parts[4]
            resource_provider = resource_parts[6]
            resource_type = resource_parts[7]
            resource_name = resource_parts[8]
            
            # Get resource details
            resource = self.resource_client.resources.get_by_id(
                resource_id=resource_id,
                api_version="2021-04-01"  # Generic API version
            )
            
            return json.dumps({
                "resource_id": resource_id,
                "name": resource.name,
                "type": resource.type,
                "resource_group": resource_group_name,
                "location": resource.location,
                "tags": resource.tags or {},
                "properties": resource.properties or {},
                "kind": getattr(resource, 'kind', None),
                "sku": getattr(resource, 'sku', None)
            })
            
        except Exception as e:
            logger.error(f"Error getting resource details for {resource_id}: {str(e)}")
            return json.dumps({"error": f"Failed to get resource details: {str(e)}"})


class ResourcesAgent(BaseAgent):
    """Resources Agent using Semantic Kernel with Azure resource management integration"""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__("ResourcesAgent", config)
        self.azure_config = config.get("Azure", {})
        self.agent: Optional[ChatCompletionAgent] = None
        self.plugin: Optional[ResourcesAgentPlugin] = None
        
    async def initialize(self) -> None:
        """Initialize the Resources Agent with Semantic Kernel"""
        try:
            # Initialize Azure OpenAI service
            azure_config = self.config["AzureOpenAI"]
            azure_service = AzureChatCompletion(
                deployment_name=azure_config["DeploymentName"],
                endpoint=azure_config["Endpoint"],
                api_key=azure_config["ApiKey"]
            )
            
            # Create kernel and add Resources plugin
            kernel = Kernel()
            self.plugin = ResourcesAgentPlugin(self.azure_config)
            kernel.add_plugin(self.plugin, plugin_name="ResourcesPlugin")
            
            # Create the ChatCompletionAgent
            self.agent = ChatCompletionAgent(
                service=azure_service,
                kernel=kernel,
                name="ResourcesAgent",
                instructions="""You are a specialized Resources Agent that handles Azure resource management and operations.

Your responsibilities:
- Manage Azure storage accounts, containers, and blobs
- Provide information about Azure subscriptions and resource groups
- Handle Azure service configurations and status monitoring
- Assist with Azure resource troubleshooting and management
- Monitor resource health and provide operational insights

Available tools:
- list_storage_accounts: List storage accounts in subscription or resource group
- list_containers: List containers in a specific storage account
- get_resource_status: Get status and information about Azure resources
- list_resource_groups: List all resource groups in the subscription
- get_resource_details: Get detailed information about a specific resource

When processing requests:
1. Use appropriate resource management tools based on the request
2. Provide clear information about Azure resources and their status
3. Help with resource organization and management tasks
4. Monitor resource health and usage patterns
5. Assist with troubleshooting resource-related issues

Always provide clear, actionable information about Azure resources and help users manage their cloud infrastructure effectively."""
            )
            
            logger.info("Resources Agent initialized successfully")
            
        except Exception as e:
            logger.error(f"Failed to initialize Resources Agent: {str(e)}")
            raise
    
    async def process_request(self, request: str, context: Optional[Dict[str, Any]] = None, chat_history: Optional[ChatHistory] = None) -> str:
        """Process a request using the Resources Agent"""
        if not self.agent:
            await self.initialize()
        
        try:
            logger.info(f"Resources Agent processing request: {request}")
            
            # Use the agent to process the request
            response = await self.agent.get_response(
                messages=request,
                thread=chat_history
            )
            
            result = response.content if response.content else "No response generated"
            logger.info(f"Resources Agent response: {result[:100]}...")
            
            return result
            
        except Exception as e:
            logger.error(f"Error in Resources Agent processing: {str(e)}")
            return f"Resources Agent error: {str(e)}"
    
    async def get_capabilities(self) -> List[str]:
        """Get list of capabilities this agent provides"""
        return [
            "list_storage_accounts",
            "list_containers",
            "get_resource_status", 
            "list_resource_groups",
            "get_resource_details",
            "azure_management",
            "resource_monitoring"
        ]
