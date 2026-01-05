using System.Text.Json.Serialization;

namespace MCPServer.Models;

// Core MCP Protocol Models
public record McpServerInfo
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "Azure MCP Server";
    
    [JsonPropertyName("version")]
    public string Version { get; init; } = "1.0.0";
    
    [JsonPropertyName("capabilities")]
    public McpCapabilities Capabilities { get; init; } = new();
}

public record McpCapabilities
{
    [JsonPropertyName("tools")]
    public McpToolCapabilities Tools { get; init; } = new();
}

public record McpToolCapabilities
{
    [JsonPropertyName("listChanged")]
    public bool ListChanged { get; init; } = false;
}

public record McpTool
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;
    
    [JsonPropertyName("description")]
    public string Description { get; init; } = string.Empty;
    
    [JsonPropertyName("inputSchema")]
    public McpToolInputSchema InputSchema { get; init; } = new();
}

public record McpToolInputSchema
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "object";
    
    [JsonPropertyName("properties")]
    public Dictionary<string, McpProperty> Properties { get; init; } = new();
    
    [JsonPropertyName("required")]
    public string[] Required { get; init; } = Array.Empty<string>();
}

public record McpProperty
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;
    
    [JsonPropertyName("description")]
    public string Description { get; init; } = string.Empty;
    
    [JsonPropertyName("enum")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string[]? Enum { get; init; }
}

public record McpToolCallRequest
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = string.Empty;
    
    [JsonPropertyName("arguments")]
    public Dictionary<string, object> Arguments { get; init; } = new();
}

public record McpToolCallResponse
{
    [JsonPropertyName("content")]
    public McpContent[] Content { get; init; } = Array.Empty<McpContent>();
    
    [JsonPropertyName("isError")]
    public bool IsError { get; init; } = false;
}

public record McpContent
{
    [JsonPropertyName("type")]
    public string Type { get; init; } = "text";
    
    [JsonPropertyName("text")]
    public string Text { get; init; } = string.Empty;
}

// Azure Resource Models
public record AzureResourceGroup
{
    public string Name { get; init; } = string.Empty;
    public string Location { get; init; } = string.Empty;
    public string Id { get; init; } = string.Empty;
    public Dictionary<string, string> Tags { get; init; } = new();
}

public record AzureStorageAccount
{
    public string Name { get; init; } = string.Empty;
    public string ResourceGroupName { get; init; } = string.Empty;
    public string Location { get; init; } = string.Empty;
    public string Id { get; init; } = string.Empty;
    public string Sku { get; init; } = string.Empty;
    public string Kind { get; init; } = string.Empty;
}
