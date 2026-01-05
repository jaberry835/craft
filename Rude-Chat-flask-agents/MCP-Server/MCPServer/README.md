# Azure MCP Server - Modular Tool Architecture

This MCP (Model Context Protocol) server provides a modular, extensible architecture for integrating with various external systems and APIs. The server is designed to work with Azure Government cloud and supports tool execution with user token delegation.

## Architecture Overview

The MCP server follows a **service-per-domain** architecture pattern, where each external system or domain has its own dedicated service. This provides clean separation of concerns, easy testing, and maintainable code.

```
Services/
├── ToolService.cs              # Main orchestrator service
├── IToolService.cs             # Main service interface
├── Azure/                      # Azure-specific tools
│   ├── IAzureToolService.cs
│   ├── AzureResourceToolService.cs
│   ├── AzureSqlToolService.cs
│   └── UserTokenCredential.cs
├── Enterprise/                 # Enterprise system integrations
│   └── SapToolService.cs
└── [YourDomain]/              # Your custom domain services
    ├── I[YourDomain]ToolService.cs
    ├── [YourDomain]ToolService.cs
    └── [YourDomain]Models.cs
```

## Core Components

### 1. Main ToolService (Orchestrator)
- **File**: `Services/ToolService.cs`
- **Role**: Central coordinator that delegates tool execution to domain-specific services
- **Responsibilities**:
  - Aggregate tools from all domain services
  - Route tool execution requests to appropriate services
  - Handle generic tools (like "hello_world")
  - Manage user token delegation

### 2. Domain Services
- **Pattern**: Each external system gets its own service
- **Interface**: Implements common interface for consistency
- **Isolation**: Changes to one domain don't affect others

## Adding New Tools for External Systems

Follow this step-by-step process to integrate with any external API or system:

### Step 1: Create Domain Directory Structure

Create a new directory under `Services/` for your domain:

```
Services/
└── CustomerAppX/               # Replace with your domain name
    ├── ICustomerAppXToolService.cs
    ├── CustomerAppXToolService.cs
    └── CustomerAppXModels.cs   # Optional: for domain-specific models
```

### Step 2: Define the Interface

Create `ICustomerAppXToolService.cs`:

```csharp
using MCPServer.Models;

namespace MCPServer.Services.CustomerAppX;

public interface ICustomerAppXToolService
{
    Task<IEnumerable<McpTool>> GetAvailableToolsAsync();
    Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request);
    
    // Add domain-specific initialization methods as needed
    Task InitializeWithCredentialsAsync(string apiKey, string baseUrl);
    // OR for OAuth: Task InitializeWithTokenAsync(string accessToken);
    // OR for basic auth: Task InitializeWithBasicAuthAsync(string username, string password);
}
```

### Step 3: Implement the Service

Create `CustomerAppXToolService.cs`:

```csharp
using MCPServer.Models;
using System.Text.Json;

namespace MCPServer.Services.CustomerAppX;

public class CustomerAppXToolService : ICustomerAppXToolService
{
    private readonly ILogger<CustomerAppXToolService> _logger;
    private readonly IConfiguration _configuration;
    private readonly HttpClient _httpClient;
    private string? _apiKey;
    private string? _baseUrl;

    public CustomerAppXToolService(
        ILogger<CustomerAppXToolService> logger, 
        IConfiguration configuration,
        HttpClient httpClient)
    {
        _logger = logger;
        _configuration = configuration;
        _httpClient = httpClient;
    }

    public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        return new List<McpTool>
        {
            new McpTool
            {
                Name = "get_customer_orders",
                Description = "Retrieve orders for a specific customer",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["customerId"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The unique customer identifier"
                        },
                        ["status"] = new McpProperty
                        {
                            Type = "string",
                            Description = "Filter by order status (optional)",
                            Enum = new[] { "pending", "shipped", "delivered", "cancelled" }
                        }
                    },
                    Required = new[] { "customerId" }
                }
            },
            // Add more tools as needed...
        };
    }

    public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        try
        {
            return request.Name switch
            {
                "get_customer_orders" => await ExecuteGetCustomerOrdersAsync(request.Arguments),
                // Add more tool handlers...
                _ => new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"Unknown CustomerAppX tool: {request.Name}"
                        }
                    },
                    IsError = true
                }
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing CustomerAppX tool {ToolName}", request.Name);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing {request.Name}: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    public async Task InitializeWithCredentialsAsync(string apiKey, string baseUrl)
    {
        _apiKey = apiKey;
        _baseUrl = baseUrl;
        
        // Configure HttpClient
        _httpClient.BaseAddress = new Uri(baseUrl);
        _httpClient.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");
        
        _logger.LogInformation("CustomerAppX service initialized with base URL: {BaseUrl}", baseUrl);
    }

    private async Task<McpToolCallResponse> ExecuteGetCustomerOrdersAsync(Dictionary<string, object> arguments)
    {
        var customerId = arguments.GetValueOrDefault("customerId")?.ToString();
        var status = arguments.GetValueOrDefault("status")?.ToString();

        if (string.IsNullOrEmpty(customerId))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Customer ID is required."
                    }
                },
                IsError = true
            };
        }

        try
        {
            // Build API request
            var queryParams = new List<string> { $"customerId={customerId}" };
            if (!string.IsNullOrEmpty(status))
                queryParams.Add($"status={status}");

            var endpoint = $"/api/orders?{string.Join("&", queryParams)}";
            
            // Make API call
            var response = await _httpClient.GetAsync(endpoint);
            response.EnsureSuccessStatusCode();
            
            var jsonResponse = await response.Content.ReadAsStringAsync();
            var orders = JsonSerializer.Deserialize<CustomerOrder[]>(jsonResponse);

            // Format response
            var resultText = orders?.Length > 0
                ? $"Found {orders.Length} orders for customer {customerId}:\n" +
                  string.Join("\n", orders.Select(o => $"- Order {o.Id}: {o.Status} ({o.Total:C})"))
                : $"No orders found for customer {customerId}.";

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = resultText
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving orders for customer {CustomerId}", customerId);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error retrieving orders: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }
}

// Example model (add to CustomerAppXModels.cs if complex)
public class CustomerOrder
{
    public string Id { get; set; } = "";
    public string Status { get; set; } = "";
    public decimal Total { get; set; }
}
```

### Step 4: Register in Dependency Injection

Update `Program.cs`:

```csharp
using MCPServer.Services.CustomerAppX;

// Add this line with other service registrations:
builder.Services.AddScoped<ICustomerAppXToolService, CustomerAppXToolService>();
builder.Services.AddHttpClient<CustomerAppXToolService>();
```

### Step 5: Integrate with Main ToolService

Update `Services/ToolService.cs`:

1. **Add constructor parameter**:
```csharp
public ToolService(
    ILogger<ToolService> logger, 
    IConfiguration configuration,
    IAzureToolService azureToolService,
    ICustomerAppXToolService customerAppXToolService) // Add this
{
    // ... existing code ...
    _customerAppXToolService = customerAppXToolService;
}
```

2. **Add field**:
```csharp
private readonly ICustomerAppXToolService _customerAppXToolService;
```

3. **Update GetAvailableToolsAsync()**:
```csharp
public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
{
    var tools = new List<McpTool>();

    // ... existing Hello World tool ...

    // Add Azure tools
    var azureTools = await _azureToolService.GetAvailableToolsAsync();
    tools.AddRange(azureTools);

    // Add CustomerAppX tools
    var customerAppXTools = await _customerAppXToolService.GetAvailableToolsAsync();
    tools.AddRange(customerAppXTools);

    return tools;
}
```

4. **Update ExecuteToolAsync()**:
```csharp
public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request, string? userToken = null)
{
    try
    {
        _logger.LogInformation("Executing tool: {ToolName}", request.Name);

        // Handle Hello World tool locally
        if (request.Name == "hello_world")
        {
            return await ExecuteHelloWorldAsync(request.Arguments);
        }

        // Handle Azure tools
        var azureTools = new[] { "list_resource_groups", "list_storage_accounts", "create_resource_group" };
        if (azureTools.Contains(request.Name))
        {
            if (!string.IsNullOrEmpty(userToken))
            {
                await _azureToolService.InitializeWithUserTokenAsync(userToken);
            }
            return await _azureToolService.ExecuteToolAsync(request);
        }

        // Handle CustomerAppX tools
        var customerAppXTools = new[] { "get_customer_orders" }; // Add your tool names here
        if (customerAppXTools.Contains(request.Name))
        {
            // Initialize with credentials from configuration
            var apiKey = _configuration["CustomerAppX:ApiKey"];
            var baseUrl = _configuration["CustomerAppX:BaseUrl"];
            
            if (!string.IsNullOrEmpty(apiKey) && !string.IsNullOrEmpty(baseUrl))
            {
                await _customerAppXToolService.InitializeWithCredentialsAsync(apiKey, baseUrl);
            }
            
            return await _customerAppXToolService.ExecuteToolAsync(request);
        }

        // Unknown tool
        return new McpToolCallResponse
        {
            Content = new[]
            {
                new McpContent
                {
                    Type = "text",
                    Text = $"Unknown tool: {request.Name}"
                }
            },
            IsError = true
        };
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Error executing tool {ToolName}", request.Name);
        return new McpToolCallResponse
        {
            Content = new[]
            {
                new McpContent
                {
                    Type = "text",
                    Text = $"Error executing tool {request.Name}: {ex.Message}"
                }
            },
            IsError = true
        };
    }
}
```

### Step 6: Add Configuration

Update `appsettings.json`:

```json
{
  "CustomerAppX": {
    "BaseUrl": "https://api.customerappx.com",
    "ApiKey": "your-api-key-here",
    "Timeout": "00:00:30"
  }
}
```

For production, use Azure Key Vault or environment variables for sensitive values.

## Authentication Patterns

### API Key Authentication
```csharp
_httpClient.DefaultRequestHeaders.Add("X-API-Key", apiKey);
// OR
_httpClient.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");
```

### OAuth 2.0 / Bearer Token
```csharp
_httpClient.DefaultRequestHeaders.Authorization = 
    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
```

### Basic Authentication
```csharp
var credentials = Convert.ToBase64String(Encoding.ASCII.GetBytes($"{username}:{password}"));
_httpClient.DefaultRequestHeaders.Authorization = 
    new System.Net.Http.Headers.AuthenticationHeaderValue("Basic", credentials);
```

### Custom Headers
```csharp
_httpClient.DefaultRequestHeaders.Add("X-Custom-Auth", authValue);
_httpClient.DefaultRequestHeaders.Add("X-Client-ID", clientId);
```

## Error Handling Best Practices

1. **Service-Level Exception Handling**: Catch and log exceptions in each service
2. **Meaningful Error Messages**: Return user-friendly error descriptions
3. **Structured Logging**: Include relevant context in log messages
4. **Graceful Degradation**: Handle network timeouts and API errors gracefully

## Testing

Each domain service can be unit tested independently:

```csharp
[Test]
public async Task GetCustomerOrders_ValidCustomerId_ReturnsOrders()
{
    // Arrange
    var mockHttpClient = new Mock<HttpClient>();
    var service = new CustomerAppXToolService(logger, config, mockHttpClient.Object);
    
    // Act & Assert
    var result = await service.ExecuteToolAsync(request);
    Assert.IsFalse(result.IsError);
}
```

## Configuration Management

### Development
Use `appsettings.Development.json` for local development settings.

### Production
- Use Azure Key Vault for secrets
- Use environment variables for configuration
- Use managed identities where possible

## Security Considerations

1. **Never hardcode credentials** in source code
2. **Use HTTPS** for all external API calls
3. **Validate inputs** before making API calls
4. **Implement rate limiting** for external APIs
5. **Log security events** appropriately (without exposing sensitive data)

## Deployment

The server can be deployed as:
- **Docker Container**: Use the provided Dockerfile
- **Azure Container Apps**: For cloud deployment
- **Windows Service**: For on-premises deployment

## Monitoring and Observability

- **Structured Logging**: All services use ILogger with structured data
- **Health Checks**: Implement health checks for external dependencies
- **Metrics**: Track API call success/failure rates
- **Tracing**: Use Application Insights for distributed tracing

## Contributing

When adding new domain services:

1. Follow the established patterns and conventions
2. Include comprehensive error handling
3. Add appropriate logging
4. Update this README with your new domain
5. Include unit tests for your service

## Examples in Codebase

- **Azure Tools**: `Services/Azure/AzureResourceToolService.cs`
- **Enterprise Integration**: `Services/Enterprise/SapToolService.cs`
- **Main Orchestrator**: `Services/ToolService.cs`
