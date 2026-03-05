# Rude MCP Server 🚀

A Python-based Model Context Protocol (MCP) server built with FastMCP, designed to be hosted on Azure App Service over HTTP using Server-Sent Events (SSE). This server provides two main toolsets: **Math Tools** and **Azure Data Explorer** integration.

## Features

### 🔢 Math Tools
- Basic arithmetic operations (add, subtract, multiply, divide)
- Advanced mathematical functions (power, square root, factorial)
- Statistical calculations (mean, median, standard deviation, etc.)

### 📊 Azure Data Explorer Tools
- List databases in your Kusto cluster
- List tables in specific databases
- Describe table schemas with column information
- Execute KQL queries with safety limits
- Get cluster information and statistics
- **On-Behalf-Of (OBO) authentication** for user impersonation
- Azure Government cloud support

### 🔍 Application Insights Integration
- Comprehensive logging and monitoring
- Authentication event tracking
- ADX query performance metrics
- Error tracking and alerting
- Custom telemetry for business insights

### 🎭 Fictional API Tools
- Mock company data for testing and development
- Device management endpoints
- Company information retrieval

### 📄 Document Tools
- Document search and retrieval
- Content summarization
- Azure AI Search integration

### 🗂️ RAG RAG Tools
- Retrieval over a dedicated RAG Azure AI Search index
- Optional Azure OpenAI generation for grounded answers
- Tools: `rag_retrieve`, `rag_rag_answer`, `rag_health`

### 🌐 Translation Tools
- Text translation to one or multiple languages
- Language detection with confidence scores
- Script transliteration (e.g. Kanji → Latin)
- Dictionary lookups with back-translations and example sentences
- Supports key-based auth or identity-based auth via `DefaultAzureCredential`
- Auto-detects Azure Government vs Commercial from `AZURE_AUTHORITY_HOST`
- Tools: `translate_text`, `translate_text_multiple_languages`, `detect_language`, `get_supported_languages`, `transliterate_text`, `dictionary_lookup`, `dictionary_examples`, `translator_health`

### 👁️ Computer Vision Tools
- Image analysis with tags, object detection, people detection, OCR text extraction, and smart cropping
- Defaults to tags + objects + OCR when no features specified — caller doesn't need to configure anything
- Accepts images via public URL or base64-encoded data
- Supports key-based auth or identity-based auth via `DefaultAzureCredential`
- Auto-detects Azure Government vs Commercial from `AZURE_AUTHORITY_HOST`
- Tools: `analyze_image`, `read_text_from_image`, `computer_vision_health`

## Architecture

```
┌─────────────────┐    HTTP/SSE    ┌──────────────────┐    Managed Identity    ┌─────────────────┐
│   MCP Client    │ ──────────────▶│   Azure App      │ ─────────────────────▶│  Azure Data     │
│                 │                │   Service        │                        │  Explorer       │
└─────────────────┘                └──────────────────┘                        └─────────────────┘
                                           │
                                           │ Logs & Metrics
                                           ▼
                                   ┌──────────────────┐
                                   │ Application      │
                                   │ Insights         │
                                   └──────────────────┘
```

## Prerequisites

- Python 3.11+
- Azure subscription
- Azure CLI or Azure Developer CLI (azd)
- Optional: Azure Data Explorer cluster for ADX tools

## Quick Start

### 1. Clone and Setup

```bash
git clone <your-repo-url>
cd Rude-MCPServer
pip install -r requirements.txt
```

### 2. Local Development

```bash
# Set environment variables (optional for local testing)
$env:KUSTO_CLUSTER_URL = "https://your-cluster.region.kusto.windows.net"
$env:KUSTO_DEFAULT_DATABASE = "your-database"

# Start the server locally
python main.py
```

### 3. Deploy to Azure


#### Manual Deployment

```powershell
# Deploy with settings:
.\deploy.ps1 -AppServiceName "App Name" -ResourceGroup "Resource Group" -SubscriptionId "SubscriptionId"



## Connecting MCP Clients

Once deployed, your MCP server will be available at `https://your-app-service-name.azurewebsites.net/mcp/`.

### 🔗 MCP Endpoint URL

**Important**: The MCP endpoint requires a trailing slash (`/`) for proper connection:

```
✅ Correct: https://your-app-service-name.azurewebsites.net/mcp/
❌ Incorrect: https://your-app-service-name.azurewebsites.net/mcp
```

### 🔧 MCP Inspector

To test your server with MCP Inspector:

1. Open [MCP Inspector](https://inspector.modelcontextprotocol.org/)
2. Select **"Streamable HTTP"** as the transport type
3. Enter your server URL: `https://your-app-service-name.azurewebsites.net/mcp/`
4. Click **"Connect"**

### 🌐 Other MCP Clients

For other MCP clients, use these connection details:
- **Transport**: Streamable HTTP
- **URL**: `https://your-app-service-name.azurewebsites.net/mcp/`
- **Protocol**: MCP over HTTP with JSON-RPC

### 🔍 Health Check

You can verify your server is running by checking the health endpoint:
```bash
curl https://your-app-service-name.azurewebsites.net/health
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KUSTO_CLUSTER_URL` | Yes | Azure Data Explorer cluster URL |
| `KUSTO_DEFAULT_DATABASE` | No | Default database name |
| `LOG_LEVEL` | No | Logging level (default: INFO) |
| `MCP_SERVER_NAME` | No | Server display name |
| `CORS_ENABLED` | No | Enable CORS (default: true) |
| `CORS_ORIGINS` | No | Allowed CORS origins (default: *) |
| `AZURE_TRANSLATOR_KEY` | No | Translator resource key (if set, uses key auth) |
| `AZURE_TRANSLATOR_ENDPOINT` | No | Translator endpoint (auto-detected from cloud if not set) |
| `AZURE_TRANSLATOR_REGION` | No | Azure region for Translator (required for key auth) |
| `AZURE_CV_ENDPOINT` | No | Computer Vision resource endpoint URL |
| `AZURE_CV_KEY` | No | Computer Vision resource key (if set, uses key auth) |


*Automatically set by Azure App Service when using managed identity

### Azure Data Explorer Setup

1. **Create a Kusto cluster** in Azure portal
2. **Configure managed identity access**:
   ```bash
   # Add the App Service system identity as a database user
   .add database ['your-database'] users ('aadapp=your-managed-identity-id') 'MCP Server'
   ```
3. **Set environment variables** in App Service configuration

### Azure Translator Setup

The translation tools support two authentication modes:

#### Option 1: Key-Based Auth
Set `AZURE_TRANSLATOR_KEY` and `AZURE_TRANSLATOR_REGION` in your `.env` or App Service configuration. The global endpoint is used automatically.

#### Option 2: Identity-Based Auth (Recommended)
Use `DefaultAzureCredential` (Managed Identity, az login, etc.) with a resource-specific custom-domain endpoint.

**Required RBAC role**: The service principal or managed identity must have the **Cognitive Services User** role on the Translator resource:

```bash
# Get the service principal object ID
sp=$(az ad sp show --id <YOUR_APP_CLIENT_ID> --query id -o tsv)

# Assign Cognitive Services User role on the Translator resource
az role assignment create \
  --assignee $sp \
  --role "Cognitive Services User" \
  --scope "/subscriptions/<SUB_ID>/resourceGroups/<RG>/providers/Microsoft.CognitiveServices/accounts/<TRANSLATOR_RESOURCE_NAME>"
```

When using identity auth, set `AZURE_TRANSLATOR_ENDPOINT` to your resource-specific URL (e.g. `https://<resource>.cognitiveservices.azure.us/`).

### Azure Computer Vision Setup

The computer vision tools use Azure Cognitive Services Image Analysis 4.0.

#### Option 1: Key-Based Auth
Set `AZURE_CV_KEY` and `AZURE_CV_ENDPOINT` in your `.env` or App Service configuration.

#### Option 2: Identity-Based Auth (Recommended)
Use `DefaultAzureCredential` with the resource-specific endpoint.

**Required RBAC role**: The service principal or managed identity must have the **Cognitive Services User** role on the Computer Vision resource:

```bash
az role assignment create \
  --assignee $sp \
  --role "Cognitive Services User" \
  --scope "/subscriptions/<SUB_ID>/resourceGroups/<RG>/providers/Microsoft.CognitiveServices/accounts/<CV_RESOURCE_NAME>"
```

Set `AZURE_CV_ENDPOINT` to your resource URL (e.g. `https://<resource>.cognitiveservices.azure.us`).

### CORS Configuration

For production deployments, configure specific origins instead of allowing all:

```bash
# Set specific allowed origins
az webapp config appsettings set \
  --name your-app-service-name \
  --resource-group your-resource-group \
  --settings "CORS_ORIGINS=https://inspector.modelcontextprotocol.org,https://your-client-domain.com"
```

## API Reference

### Math Tools

```python
# Basic arithmetic
add(a: float, b: float) -> float
subtract(a: float, b: float) -> float
multiply(a: float, b: float) -> float
divide(a: float, b: float) -> float

# Advanced functions
power(base: float, exponent: float) -> float
square_root(number: float) -> float
factorial(n: int) -> int

# Statistics
calculate_statistics(numbers: List[float]) -> Dict[str, float]
```

### Azure Data Explorer Tools

```python
# Cluster management
kusto_get_cluster_info() -> Dict[str, Any]
kusto_list_databases() -> List[Dict[str, Any]]

# Database operations
kusto_list_tables(database: str) -> List[Dict[str, Any]]
kusto_describe_table(database: str, table: str) -> Dict[str, Any]

# Query execution
kusto_query(database: str, query: str, max_rows: int = 1000) -> Dict[str, Any]
```

### Health Check

```python
health_check() -> Dict[str, Any]
```

## Security

- **HTTPS Only**: All communication uses TLS 1.2+
- **Managed Identity**: No stored credentials, uses Azure Managed Identity
- **CORS**: Configurable cross-origin resource sharing
- **Query Limits**: KQL queries are limited to prevent abuse
- **Input Validation**: All inputs are validated and sanitized

## Monitoring

- **Application Insights**: Comprehensive telemetry and logging
- **Log Analytics**: Centralized log collection
- **Health Checks**: Built-in health monitoring endpoint
- **Metrics**: Performance and usage metrics

## Troubleshooting

### Common Issues

1. **"KUSTO_CLUSTER_URL not set"**
   - Add the environment variable in Azure App Service configuration
   - Ensure the URL format is correct: `https://your-cluster.region.kusto.windows.net`

2. **Authentication errors with Azure Data Explorer**
   - Verify managed identity is enabled on App Service
   - Check that managed identity has proper permissions in Kusto cluster
   - Ensure firewall allows App Service outbound connections

3. **Server not starting**
   - Check Application Insights logs in Azure portal
   - Verify Python runtime version (should be 3.11)
   - Check that all dependencies are installed

### Debugging

```bash
# Check app logs
azd logs

# Or using Azure CLI
az webapp log tail --name your-app-name --resource-group your-rg

# Health check endpoint
curl https://your-app.azurewebsites.net/health
```

## Development

### Project Structure

```
Rude-MCPServer/
├── main.py                 # Main MCP server implementation
├── requirements.txt        # Python dependencies
├── azure.yaml             # Azure Developer CLI config
├── startup.sh             # App Service startup script
├── web.config             # IIS configuration for App Service
├── .env.example           # Environment variables template
```

### Adding New Tools

1. **Define the tool function**:
   ```python
   @mcp.tool
   def my_new_tool(param: str) -> str:
       \"\"\"Description of what this tool does\"\"\"
       # Implementation
       return result
   ```

2. **Add tests** in `test_server.py`
3. **Update documentation** in this README
4. **Deploy** using `azd up`

### Testing Locally

```bash
# Install dependencies
pip install -r requirements.txt

# Start server (FastMCP will handle HTTP/SSE automatically)
python main.py
```

## Production Considerations

- **Scale up** the App Service Plan for production workloads
- **Configure custom domain** and SSL certificate
- **Set up monitoring alerts** in Application Insights
- **Implement rate limiting** for public endpoints
- **Review CORS settings** for security
- **Enable backup** for App Service
- **Configure availability zones** for high availability

## Documentation

For detailed information about specific features:

- **[Architecture Overview](docs/Architecture_README.md)** - System design and component interactions
- **[OBO Authentication](docs/OBO_Authentication.md)** - On-Behalf-Of authentication implementation
- **[Application Insights](docs/Application_Insights.md)** - Monitoring and logging configuration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues and questions:
- Check the [troubleshooting section](#troubleshooting)
- Review Application Insights logs
- Create an issue in this repository

---

**Built with 💙 using FastMCP and Azure App Service**

## Copilot Studio Integration

This MCP server can be integrated with Microsoft Copilot Studio to provide AI agents with math and Azure Data Explorer capabilities.

### Prerequisites for Copilot Studio
- Power Apps access for creating custom connectors
- Copilot Studio with Generative Orchestration enabled
- Azure App Service deployment (completed above)

### Integration Steps

1. **Create Custom Connector**:
   - Go to Copilot Studio → Agents → Your Agent → Tools → Add a tool → New tool → Custom connector
   - This takes you to Power Apps to create a new custom connector
   - Select "New custom connector" → "Import OpenAPI file"
   - Use the provided `copilot-studio-schema.yaml` file from this repository
   - Complete the setup in Power Apps

2. **Add to Agent**:
   - Return to Copilot Studio → Agents → Your Agent → Tools → Add a tool → Model Context Protocol
   - Select your newly created MCP connector
   - Authorize the connection if needed
   - Choose "Add to agent" or "Add and configure"

3. **Transport Options**:
   - **Streamable HTTP Endpoint**: `https://rude-mcp.azurewebsites.us/mcp` (Recommended - this is what our server actually provides)
   - Note: Our FastMCP server uses streamable HTTP transport, not SSE

### Known Issues
- **ID Format**: If you encounter "msg Id that comes back from Python is a number and MCS requests it as a string" errors, this may be due to JSON-RPC ID format differences between the MCP server and Copilot Studio's connector layer
- **SSE Deprecation**: SSE transport will be deprecated in August 2025, plan to migrate to streamable transport

### Troubleshooting Copilot Studio
- Verify the OpenAPI schema is correctly imported
- Check that the MCP server is accessible from Copilot Studio's network
- Ensure CORS is properly configured (already handled in this implementation)
- Monitor Azure App Service logs for connection issues
