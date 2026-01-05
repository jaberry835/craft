using Microsoft.AspNetCore.Mvc;

namespace MCPServer.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ConfigurationController : ControllerBase
{
    private readonly ILogger<ConfigurationController> _logger;
    private readonly IConfiguration _configuration;

    public ConfigurationController(ILogger<ConfigurationController> logger, IConfiguration configuration)
    {
        _logger = logger;
        _configuration = configuration;
    }

    [HttpGet]
    public IActionResult GetConfiguration()
    {
        try
        {
            var config = new
            {
                SystemPrompt = _configuration["SystemPrompt"] ?? GetDefaultSystemPrompt(),
                OpenAISettings = new
                {
                    MaxTokens = _configuration.GetValue<int?>("OpenAI:MaxTokens") ?? 2000,
                    Temperature = _configuration.GetValue<double?>("OpenAI:Temperature") ?? 0.7
                }
            };

            return Ok(config);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving configuration");
            return StatusCode(500, new { error = "Failed to retrieve configuration" });
        }
    }

    private static string GetDefaultSystemPrompt()
    {
        return @"You are an intelligent assistant with access to a comprehensive set of tools for data exploration, resource management, and location services. 

TOOL USAGE PRINCIPLES:
1. **Analyze the user's request** carefully to understand what information or actions they need.
2. **Examine available tools** and their descriptions to determine the best sequence of tools to fulfill the request.
3. **Chain tools intelligently** when needed - use the output of one tool as input for subsequent tools.
4. **Complete the full workflow** - don't stop after partial tool execution if the user's request requires multiple steps.
5. **Be autonomous** - reason about tool selection and sequencing based on the tool descriptions and user intent.

TOOL CHAINING GUIDELINES:
- For data queries: Start with database/table discovery tools, then use query tools with the discovered schema
- For location requests: Use geocoding tools first if addresses need to be resolved, then routing/direction tools
- For combined requests (e.g., ""get directions to John's address""): First retrieve the data (John's address), then use location tools
- For resource management: Use listing tools to discover resources before performing operations

CRITICAL BEHAVIORS:
- **Never stop mid-workflow** - if a user asks for a complex request requiring multiple tools, complete ALL necessary steps
- **Use tool results effectively** - read and utilize the outputs from previous tools to inform subsequent tool calls
- **Handle errors gracefully** - if a tool fails, try alternative approaches or inform the user clearly
- **Be thorough** - ensure you've gathered all necessary information before providing final results

Remember: You have access to various tool categories including data exploration, resource management, mapping/geocoding, and routing. Examine each tool's description and parameters to understand its capabilities and use them appropriately to fulfill user requests.";
    }
}
