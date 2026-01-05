using MCPServer.Models;
using System.Text.Json;
using Azure.Core;
using Azure.Identity;
using System.Text;
using Kusto.Data;
using Kusto.Data.Net.Client;
using Kusto.Data.Common;
using System.Data;

namespace MCPServer.Services.Azure;

public class AzureDataExplorerToolService : IAzureToolService
{
    private readonly ILogger<AzureDataExplorerToolService> _logger;
    private readonly IConfiguration _configuration;
    private readonly TokenCredential _credential;
    private string? _clusterUri;
    private string? _defaultDatabase;
    private ICslQueryProvider? _queryProvider;

    public AzureDataExplorerToolService(
        ILogger<AzureDataExplorerToolService> logger,
        IConfiguration configuration)
    {
        _logger = logger;
        _configuration = configuration;
        _credential = new DefaultAzureCredential();
        
        // Load configuration
        _clusterUri = _configuration["AzureDataExplorer:ClusterUri"];
        _defaultDatabase = _configuration["AzureDataExplorer:DefaultDatabase"];
    }

    public async Task InitializeWithUserTokenAsync(string userToken)
    {
        // Initialize Kusto client with user token or default credentials
        if (!string.IsNullOrEmpty(_clusterUri))
        {
            var connectionStringBuilder = new KustoConnectionStringBuilder(_clusterUri)
                .WithAadAzureTokenCredentialsAuthentication(_credential);
            
            _queryProvider = KustoClientFactory.CreateCslQueryProvider(connectionStringBuilder);
        }
        
        await Task.CompletedTask;
    }    public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        return await Task.FromResult(new[]
        {
            // List ADX databases
            new McpTool
            {
                Name = "adx_list_databases",
                Description = "List all databases available in the Azure Data Explorer cluster. Use this to discover what databases are available for querying.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>(),
                    Required = new string[] { }
                }
            },            // List tables in a database
            new McpTool
            {
                Name = "adx_list_tables",
                Description = "🔍 MANDATORY FIRST STEP: List all tables in an Azure Data Explorer database. ALWAYS use this before adx_query to discover actual table names. NEVER assume table names like 'Addresses' exist - use this tool to find the real table names like 'Employees'. This helps understand the data structure and available tables for querying.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["database"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The database name to list tables from. If not provided, uses the default database."
                        }
                    },
                    Required = new string[] { }
                }
            },            // Describe table schema
            new McpTool
            {
                Name = "adx_describe_table",
                Description = "📋 REQUIRED BEFORE QUERYING: Get the schema and structure of a specific table in Azure Data Explorer, including column names, types, and sample data. Use this after adx_list_tables to understand what columns are available before writing queries. NEVER assume column names exist.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["tableName"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the table to describe"
                        },
                        ["database"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The database name. If not provided, uses the default database."
                        }
                    },
                    Required = new[] { "tableName" }
                }
            },            // Execute Kusto query
            new McpTool
            {
                Name = "adx_query",
                Description = "Execute a Kusto Query Language (KQL) query against Azure Data Explorer. ⚠️ CRITICAL: NEVER use this tool without first using adx_list_databases, adx_list_tables, and adx_describe_table to discover actual database/table/column names. NEVER assume table names like 'Addresses' exist. IMPORTANT: Use KQL syntax, NOT SQL syntax. KQL uses pipes (|) and operators like 'where', 'project', 'take'. Table names are CASE-SENSITIVE - use exact casing from adx_list_tables results. Examples: 'Employees | where Name contains \"Frank\"', 'TableName | take 10', 'TableName | where ColumnName == \"value\" | project Name, Address'.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["query"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The Kusto Query Language (KQL) query to execute. MUST use KQL syntax with pipes (|). Table names are CASE-SENSITIVE. Examples: 'Employees | where Name contains \"searchterm\"', 'TableName | take 10', 'TableName | project Column1, Column2'. Do NOT use SQL syntax like SELECT/FROM."
                        },
                        ["database"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The database to query against. If not provided, uses the default database."
                        },
                        ["maxRows"] = new McpProperty
                        {
                            Type = "integer",                            Description = "Maximum number of rows to return (default: 100, max: 1000)"
                        }
                    },
                    Required = new[] { "query" }
                }
            }
        });
    }public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        try
        {
            return request.Name switch
            {
                "adx_list_databases" => await ExecuteListDatabasesAsync(),
                "adx_list_tables" => await ExecuteListTablesAsync(request.Arguments),
                "adx_describe_table" => await ExecuteDescribeTableAsync(request.Arguments),
                "adx_query" => await ExecuteQueryAsync(request.Arguments),
                _ => throw new ArgumentException($"Unknown tool: {request.Name}")
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing Azure Data Explorer tool: {ToolName}", request.Name);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing Azure Data Explorer tool '{request.Name}': {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteListDatabasesAsync()
    {
        if (string.IsNullOrEmpty(_clusterUri))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Azure Data Explorer cluster URI not configured. Please add AzureDataExplorer:ClusterUri to configuration."
                    }
                },
                IsError = true
            };
        }

        try
        {
            if (_queryProvider == null)
            {
                await InitializeWithUserTokenAsync("");
            }

            var query = ".show databases";
            var result = await ExecuteKustoQueryAsync(query, "");

            if (result.IsError)
                return result;

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"📊 **Azure Data Explorer Databases**\n\n" +
                               $"**Cluster:** {_clusterUri}\n\n" +
                               $"**Available Databases:**\n{result.Content?[0]?.Text ?? "No databases found"}"
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing ADX databases");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error listing databases: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteListTablesAsync(Dictionary<string, object>? arguments)
    {
        var database = arguments?.GetValueOrDefault("database")?.ToString() ?? _defaultDatabase;

        if (string.IsNullOrEmpty(database))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Database name is required. Either provide a database parameter or configure AzureDataExplorer:DefaultDatabase."
                    }
                },
                IsError = true
            };
        }

        try
        {
            if (_queryProvider == null)
            {
                await InitializeWithUserTokenAsync("");
            }

            var query = ".show tables";
            var result = await ExecuteKustoQueryAsync(query, database);

            if (result.IsError)
                return result;

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"📊 **Tables in Database '{database}'**\n\n" +
                               (result.Content?[0]?.Text ?? "No tables found")
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing ADX tables for database: {Database}", database);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error listing tables in database '{database}': {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteDescribeTableAsync(Dictionary<string, object>? arguments)
    {
        var tableName = arguments?.GetValueOrDefault("tableName")?.ToString();
        var database = arguments?.GetValueOrDefault("database")?.ToString() ?? _defaultDatabase;

        if (string.IsNullOrEmpty(tableName))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Table name is required."
                    }
                },
                IsError = true
            };
        }

        if (string.IsNullOrEmpty(database))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Database name is required. Either provide a database parameter or configure AzureDataExplorer:DefaultDatabase."
                    }
                },
                IsError = true
            };
        }

        try
        {
            if (_queryProvider == null)
            {
                await InitializeWithUserTokenAsync("");
            }

            // Get table schema
            var schemaQuery = $".show table {tableName} schema as json";
            var schemaResult = await ExecuteKustoQueryAsync(schemaQuery, database);

            // Get sample data
            var sampleQuery = $"{tableName} | limit 5";
            var sampleResult = await ExecuteKustoQueryAsync(sampleQuery, database);

            var responseText = $"📊 **Table Schema: {tableName}**\n\n";
            responseText += $"**Database:** {database}\n\n";            responseText += "**Schema:**\n";
            responseText += schemaResult.IsError ? $"Error getting schema: {schemaResult.Content?[0]?.Text}" : schemaResult.Content?[0]?.Text;
            responseText += "\n\n**Sample Data (first 5 rows):**\n";
            responseText += sampleResult.IsError ? $"Error getting sample data: {sampleResult.Content?[0]?.Text}" : sampleResult.Content?[0]?.Text;
            
            // Add KQL query examples
            responseText += "\n\n💡 **KQL Query Examples for " + tableName + ":**\n";
            responseText += "• **Search by name/text:** `" + tableName + " | where columnName contains 'search_term'`\n";
            responseText += "• **Get all records:** `" + tableName + " | take 10`\n";
            responseText += "• **Filter and project:** `" + tableName + " | where condition | project column1, column2`\n";
            responseText += "• **Count records:** `" + tableName + " | count`\n";
            responseText += "\n🎯 **Ready to query!** Use the `adx_query` tool with the database '" + database + "' to search this table for specific information.\n";
            responseText += "**Next Step:** Based on the user's request, search for the specific data they mentioned using a targeted KQL query.\n";
            responseText += "\n⚠️ **IMPORTANT:** If the user is looking for a specific person or name, you MUST NOW call the `adx_query` tool with a query like:\n";
            responseText += "`" + tableName + " | where Name contains 'PersonName' | project Name, Address`\n";
            responseText += "**DO NOT STOP HERE - Complete the user's request by making the actual query now!**";

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = responseText
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error describing ADX table: {TableName}", tableName);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error describing table '{tableName}': {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteQueryAsync(Dictionary<string, object>? arguments)
    {
        var query = arguments?.GetValueOrDefault("query")?.ToString();
        var database = arguments?.GetValueOrDefault("database")?.ToString() ?? _defaultDatabase;
        var maxRows = 100;

        if (arguments?.ContainsKey("maxRows") == true && int.TryParse(arguments["maxRows"]?.ToString(), out var parsedMaxRows))
        {
            maxRows = Math.Min(Math.Max(parsedMaxRows, 1), 1000); // Clamp between 1 and 1000
        }

        if (string.IsNullOrEmpty(query))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Kusto query is required."
                    }
                },
                IsError = true
            };
        }

        if (string.IsNullOrEmpty(database))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Database name is required. Either provide a database parameter or configure AzureDataExplorer:DefaultDatabase."
                    }
                },
                IsError = true
            };
        }

        try
        {
            if (_queryProvider == null)
            {
                await InitializeWithUserTokenAsync("");
            }

            // Add limit to query if not already present
            var finalQuery = query.Trim();
            if (!finalQuery.ToLower().Contains("| limit") && !finalQuery.ToLower().Contains("| take"))
            {
                finalQuery += $" | limit {maxRows}";
            }

            _logger.LogInformation("Executing ADX query in database '{Database}': {Query}", database, finalQuery);

            var result = await ExecuteKustoQueryAsync(finalQuery, database);

            if (result.IsError)
                return result;

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"📊 **Query Results**\n\n" +
                               $"**Database:** {database}\n" +
                               $"**Query:** ```kusto\n{query}\n```\n\n" +
                               $"**Results:**\n{result.Content?[0]?.Text ?? "No results"}"
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing ADX query: {Query}", query);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing query: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteKustoQueryAsync(string query, string database)
    {
        if (string.IsNullOrEmpty(_clusterUri))
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Azure Data Explorer cluster URI not configured."
                    }
                },
                IsError = true
            };
        }

        if (_queryProvider == null)
        {
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = "Kusto query provider not initialized."
                    }
                },
                IsError = true
            };
        }

        try
        {
            _logger.LogInformation("Executing Kusto query: {Query} in database: {Database}", query, database);

            // Execute the query using Kusto client
            var clientRequestProperties = new ClientRequestProperties();
            clientRequestProperties.SetOption(ClientRequestProperties.OptionServerTimeout, TimeSpan.FromMinutes(5));

            var reader = await _queryProvider.ExecuteQueryAsync(database, query, clientRequestProperties);
            
            // Format and return the results
            var formattedResult = FormatKustoDataReader(reader);

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = formattedResult
                    }
                },
                IsError = false
            };
        }        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing Kusto query: {Query}", query);
            
            // Check if this is a table name case sensitivity issue
            if (ex.Message.Contains("Failed to resolve table or column expression"))
            {
                // Try to find the correct table name by checking available tables
                try
                {
                    var tablesQuery = ".show tables";
                    var tablesReader = await _queryProvider.ExecuteQueryAsync(database, tablesQuery, new ClientRequestProperties());
                    var tableNames = new List<string>();
                      while (tablesReader.Read())
                    {
                        try
                        {
                            var tableNameOrdinal = tablesReader.GetOrdinal("TableName");
                            var tableName = tablesReader.GetString(tableNameOrdinal);
                            if (!string.IsNullOrEmpty(tableName))
                            {
                                tableNames.Add(tableName);
                            }
                        }
                        catch
                        {
                            // If TableName column doesn't exist, try first column
                            if (tablesReader.FieldCount > 0)
                            {
                                var tableName = tablesReader.GetValue(0)?.ToString();
                                if (!string.IsNullOrEmpty(tableName))
                                {
                                    tableNames.Add(tableName);
                                }
                            }
                        }
                    }
                    
                    // Find potential matches (case-insensitive)
                    var queryLower = query.ToLower();
                    var potentialMatches = tableNames.Where(tn => 
                        queryLower.Contains(tn.ToLower()) && !queryLower.Contains(tn)).ToList();
                    
                    if (potentialMatches.Any())
                    {
                        var suggestions = string.Join(", ", potentialMatches);
                        return new McpToolCallResponse
                        {
                            Content = new[]
                            {
                                new McpContent
                                {
                                    Type = "text",
                                    Text = $"Error executing Kusto query: {ex.Message}\n\n" +
                                           $"💡 **Tip**: Table names are case-sensitive. Did you mean one of these tables?\n" +
                                           $"Available tables: {suggestions}\n\n" +
                                           $"Try using the exact table name case, for example: `{potentialMatches.First()} | where ...`"
                                }
                            },
                            IsError = true
                        };
                    }
                }
                catch (Exception tablesEx)
                {
                    _logger.LogWarning(tablesEx, "Could not retrieve table names for suggestion");
                }
            }
            
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing Kusto query: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private string FormatKustoDataReader(IDataReader reader)
    {
        try
        {
            var sb = new StringBuilder();
            
            if (reader.FieldCount == 0)
            {
                return "No results returned.";
            }

            // Add column headers
            var headers = new List<string>();
            for (int i = 0; i < reader.FieldCount; i++)
            {
                headers.Add(reader.GetName(i).PadRight(20));
            }
            sb.AppendLine(string.Join(" | ", headers));
            sb.AppendLine(new string('-', string.Join(" | ", headers).Length));

            // Add rows
            int rowCount = 0;
            while (reader.Read() && rowCount < 50) // Limit display to 50 rows
            {
                var row = new List<string>();
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    var value = reader.IsDBNull(i) ? "NULL" : reader.GetValue(i)?.ToString() ?? "";
                    row.Add(value.Length > 20 ? value.Substring(0, 17) + "..." : value.PadRight(20));
                }
                sb.AppendLine(string.Join(" | ", row));
                rowCount++;
            }

            // Check if there are more rows
            if (reader.Read())
            {
                sb.AppendLine("... (more rows available, showing first 50)");
            }

            return sb.ToString();
        }
        catch (Exception ex)
        {
            return $"Error formatting results: {ex.Message}";
        }
    }
}
