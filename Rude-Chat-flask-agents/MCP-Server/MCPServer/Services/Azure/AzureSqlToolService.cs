using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using MCPServer.Models;
using System.Data.SqlClient;

namespace MCPServer.Services.Azure;

public class AzureSqlToolService : IAzureToolService
{
    private readonly ILogger<AzureSqlToolService> _logger;
    private readonly IConfiguration _configuration;
    private ArmClient? _armClient;

    public AzureSqlToolService(ILogger<AzureSqlToolService> logger, IConfiguration configuration)
    {
        _logger = logger;
        _configuration = configuration;
    }

    public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        return new List<McpTool>
        {
            new McpTool
            {
                Name = "list_sql_servers",
                Description = "List all Azure SQL servers in the subscription",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>(),
                    Required = Array.Empty<string>()
                }
            },
            new McpTool
            {
                Name = "list_sql_databases",
                Description = "List all databases in an Azure SQL server",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["serverName"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the SQL server"
                        },
                        ["resourceGroupName"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the resource group containing the SQL server"
                        }
                    },
                    Required = new[] { "serverName", "resourceGroupName" }
                }
            },
            new McpTool
            {
                Name = "query_sql_database",
                Description = "Execute a SELECT query against an Azure SQL database",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["serverName"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the SQL server"
                        },
                        ["databaseName"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the database"
                        },
                        ["query"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The SELECT query to execute (read-only queries only)"
                        }
                    },
                    Required = new[] { "serverName", "databaseName", "query" }
                }
            }
        };
    }

    public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        return request.Name switch
        {
            "list_sql_servers" => await ExecuteListSqlServersAsync(request.Arguments),
            "list_sql_databases" => await ExecuteListSqlDatabasesAsync(request.Arguments),
            "query_sql_database" => await ExecuteQuerySqlDatabaseAsync(request.Arguments),
            _ => new McpToolCallResponse
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
            }
        };
    }

    private async Task<McpToolCallResponse> ExecuteListSqlServersAsync(Dictionary<string, object> arguments)
    {
        try
        {
            // Implementation for listing SQL servers
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "SQL server listing would be implemented here using Azure.ResourceManager.Sql package."
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing SQL servers");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error listing SQL servers: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteListSqlDatabasesAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var serverName = arguments.GetValueOrDefault("serverName")?.ToString();
            var resourceGroupName = arguments.GetValueOrDefault("resourceGroupName")?.ToString();

            if (string.IsNullOrEmpty(serverName) || string.IsNullOrEmpty(resourceGroupName))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Server name and resource group name are required."
                        }
                    },
                    IsError = true
                };
            }

            // Implementation for listing databases in a SQL server
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Database listing for SQL server '{serverName}' in resource group '{resourceGroupName}' would be implemented here."
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing SQL databases");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error listing SQL databases: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteQuerySqlDatabaseAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var serverName = arguments.GetValueOrDefault("serverName")?.ToString();
            var databaseName = arguments.GetValueOrDefault("databaseName")?.ToString();
            var query = arguments.GetValueOrDefault("query")?.ToString();

            if (string.IsNullOrEmpty(serverName) || string.IsNullOrEmpty(databaseName) || string.IsNullOrEmpty(query))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Server name, database name, and query are required."
                        }
                    },
                    IsError = true
                };
            }

            // Validate that it's a SELECT query (security measure)
            if (!query.Trim().ToUpperInvariant().StartsWith("SELECT"))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Only SELECT queries are allowed for security reasons."
                        }
                    },
                    IsError = true
                };
            }

            // Implementation for executing SQL query
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Query execution against database '{databaseName}' on server '{serverName}' would be implemented here using proper authentication and connection strings."
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing SQL query");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing SQL query: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    /// <summary>
    /// Initialize ARM client using user's delegated token
    /// </summary>
    public async Task InitializeWithUserTokenAsync(string userToken)
    {
        try
        {
            _logger.LogInformation("Initializing ARM client with user token delegation for Azure Government (SQL service)");
            
            var credential = new UserTokenCredential(userToken);
            
            // Configure ARM client for Azure Government cloud
            var armClientOptions = new ArmClientOptions();
            armClientOptions.Environment = ArmEnvironment.AzureGovernment;
            
            _armClient = new ArmClient(credential, default(string), armClientOptions);
            
            _logger.LogInformation("ARM client initialized with user token for Azure Government (SQL service)");
            
            await Task.CompletedTask;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize ARM client with user token for SQL service");
            throw;
        }
    }
}
