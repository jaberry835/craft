using Microsoft.AspNetCore.Mvc;
using System.Net.Http;

namespace MCPServer.Controllers;

[ApiController]
[Route("api/[controller]")]
public class MapController : ControllerBase
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<MapController> _logger;
    private readonly IConfiguration _configuration;

    public MapController(HttpClient httpClient, ILogger<MapController> logger, IConfiguration configuration)
    {
        _httpClient = httpClient;
        _logger = logger;
        _configuration = configuration;
    }

    [HttpGet("image")]
    public async Task<IActionResult> GetMapImage([FromQuery] string url)
    {
        if (string.IsNullOrEmpty(url))
        {
            return BadRequest("Map URL is required");
        }

        // Validate that the URL is from a trusted Azure Maps domain
        if (!IsValidAzureMapsUrl(url))
        {
            return BadRequest("Invalid Azure Maps URL");
        }

        try
        {
            _logger.LogInformation("Proxying map image request: {Url}", url);

            var response = await _httpClient.GetAsync(url);
            
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Failed to fetch map image. Status: {Status}", response.StatusCode);
                return StatusCode((int)response.StatusCode, "Failed to fetch map image");
            }

            var contentType = response.Content.Headers.ContentType?.MediaType ?? "image/png";
            var imageBytes = await response.Content.ReadAsByteArrayAsync();

            return File(imageBytes, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error proxying map image request for URL: {Url}", url);
            return StatusCode(500, "Internal server error");
        }
    }

    private bool IsValidAzureMapsUrl(string url)
    {
        if (string.IsNullOrEmpty(url))
            return false;

        try
        {
            var uri = new Uri(url);
            // Allow both Azure Commercial and Azure Government Maps URLs
            return uri.Host == "atlas.microsoft.com" || uri.Host == "atlas.azure.us";
        }
        catch
        {
            return false;
        }
    }
}
