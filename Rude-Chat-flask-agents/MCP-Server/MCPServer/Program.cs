using MCPServer.Services;
using MCPServer.Services.Azure;
using MCPServer.Services.Agents;
using MCPServer.Hubs;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Add SignalR
builder.Services.AddSignalR();

// Add Azure services
builder.Services.AddScoped<IAzureDocumentService, AzureDocumentService>();
builder.Services.AddScoped<IChatHistoryService, CosmosChatHistoryService>();

// Register Azure tool services
builder.Services.AddHttpClient<AzureResourceToolService>(); // Needs HttpClient
builder.Services.AddScoped<AzureDataExplorerToolService>(); // Uses Kusto client, not HttpClient

// Register SignalR broadcast service
builder.Services.AddScoped<IAgentActivityBroadcastService, AgentActivityBroadcastService>();

// Register Semantic Kernel services
builder.Services.AddScoped<ISemanticKernelChatService, SemanticKernelChatService>();
builder.Services.AddScoped<IAgentOrchestrator, AgentOrchestrator>();

// Register Agent Manager and individual agents
builder.Services.AddSingleton<IAgentManager, AgentManager>();
builder.Services.AddScoped<CoreAgent>();
builder.Services.AddScoped<AdxAgent>();
builder.Services.AddScoped<MapsAgent>();
builder.Services.AddScoped<DocumentsAgent>();
builder.Services.AddScoped<ResourcesAgent>();

// Register the agent-based tool service
builder.Services.AddScoped<IToolService, AgentBasedToolService>();

// Add CORS for production and development
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAllOrigins", policy =>
    {
        policy.WithOrigins("http://localhost:4200", "https://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials(); // Required for SignalR
    });
});

// Add logging
builder.Services.AddLogging();

var app = builder.Build();

// Initialize agents on startup
using (var scope = app.Services.CreateScope())
{
    var agentManager = scope.ServiceProvider.GetRequiredService<IAgentManager>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    
    try
    {
        // Register all agents
        var coreAgent = scope.ServiceProvider.GetRequiredService<CoreAgent>();
        var adxAgent = scope.ServiceProvider.GetRequiredService<AdxAgent>();
        var mapsAgent = scope.ServiceProvider.GetRequiredService<MapsAgent>();
        var documentsAgent = scope.ServiceProvider.GetRequiredService<DocumentsAgent>();
        var resourcesAgent = scope.ServiceProvider.GetRequiredService<ResourcesAgent>();

        await agentManager.RegisterAgentAsync(coreAgent);
        await agentManager.RegisterAgentAsync(adxAgent);
        await agentManager.RegisterAgentAsync(mapsAgent);
        await agentManager.RegisterAgentAsync(documentsAgent);
        await agentManager.RegisterAgentAsync(resourcesAgent);

        logger.LogInformation("Successfully registered all agents with the agent manager");
        
        // Log agent status
        var agents = await agentManager.GetAllAgentsAsync();
        logger.LogInformation("Total registered agents: {AgentCount}", agents.Count());
        foreach (var agent in agents)
        {
            logger.LogInformation("- {AgentId}: {Name} (Domains: {Domains})", 
                agent.AgentId, agent.Name, string.Join(", ", agent.Domains));
        }
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Failed to initialize agents");
    }
}

// Configure the HTTP request pipeline
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseCors("AllowAllOrigins");

// Enable static files for Angular
app.UseStaticFiles();

app.UseRouting();
app.MapControllers();

// Map SignalR hub
app.MapHub<AgentActivityHub>("/hubs/agent-activity");

// Serve static files and provide SPA fallback for non-API routes
app.MapFallback(async context =>
{
    // Only fallback to index.html for non-API routes
    if (!context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.ContentType = "text/html";
        await context.Response.SendFileAsync(Path.Combine(app.Environment.WebRootPath, "index.html"));
    }
    else
    {
        context.Response.StatusCode = 404;
    }
});

// Add a health check endpoint that includes agent status
app.MapGet("/health", async (IAgentManager agentManager) => 
{
    try
    {
        var agents = await agentManager.GetAllAgentsAsync();
        var healthStatuses = await agentManager.GetAllAgentHealthAsync();
        
        return Results.Ok(new { 
            status = "healthy", 
            timestamp = DateTime.UtcNow,
            environment = app.Environment.EnvironmentName,
            agents = agents.Select(a => new {
                id = a.AgentId,
                name = a.Name,
                domains = a.Domains,
                health = healthStatuses.FirstOrDefault(h => h.AgentId == a.AgentId)
            })
        });
    }
    catch (Exception ex)
    {
        return Results.Ok(new { 
            status = "unhealthy", 
            timestamp = DateTime.UtcNow,
            environment = app.Environment.EnvironmentName,
            error = ex.Message
        });
    }
});

// Add agent status endpoint
app.MapGet("/api/agents/status", async (IAgentManager agentManager) =>
{
    try
    {
        var agents = await agentManager.GetAllAgentsAsync();
        var healthStatuses = await agentManager.GetAllAgentHealthAsync();
        
        return Results.Ok(agents.Select(a => new {
            id = a.AgentId,
            name = a.Name,
            description = a.Description,
            domains = a.Domains,
            health = healthStatuses.FirstOrDefault(h => h.AgentId == a.AgentId)
        }));
    }
    catch (Exception ex)
    {
        return Results.Problem($"Failed to get agent status: {ex.Message}");
    }
});

app.Run();
