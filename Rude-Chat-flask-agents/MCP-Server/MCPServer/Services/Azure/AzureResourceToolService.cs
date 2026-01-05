using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Storage;
using MCPServer.Models;
using System.Text.Json.Serialization;
using System.Text.Json;

namespace MCPServer.Services.Azure;

public class AzureResourceToolService : IAzureToolService
{
    private readonly ILogger<AzureResourceToolService> _logger;
    private readonly IConfiguration _configuration;
    private readonly HttpClient _httpClient;
    private ArmClient? _armClient;

    public AzureResourceToolService(ILogger<AzureResourceToolService> logger, IConfiguration configuration, HttpClient httpClient)
    {
        _logger = logger;
        _configuration = configuration;
        _httpClient = httpClient;
    }

    public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        return new List<McpTool>
        {
            // Azure Resource Group List Tool
            new McpTool
            {
                Name = "list_resource_groups",
                Description = "List all resource groups in the Azure subscription",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>(),
                    Required = Array.Empty<string>()
                }
            },
            
            // Azure Storage Account List Tool
            new McpTool
            {
                Name = "list_storage_accounts",
                Description = "List all storage accounts in a specific Azure resource group. Use this tool to find storage accounts after getting the list of resource groups.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["resourceGroupName"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the resource group to search for storage accounts"
                        }
                    },
                    Required = new[] { "resourceGroupName" }
                }
            },
            
            // Azure Resource Creation Tool
            new McpTool
            {
                Name = "create_resource_group",
                Description = "Create a new Azure resource group",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["name"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The name of the resource group to create"
                        },
                        ["location"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The Azure region where the resource group should be created"
                        }                    },
                    Required = new[] { "name", "location" }
                }
            },
            
            // Azure Maps - Geocoding Tool
            new McpTool
            {
                Name = "geocode_address",
                Description = "Convert an address to coordinates (latitude/longitude) using Azure Maps. Useful for getting location data for mapping and directions.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["address"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The address to geocode (e.g., '1600 Amphitheatre Parkway, Mountain View, CA')"
                        },
                        ["countryCode"] = new McpProperty
                        {
                            Type = "string",
                            Description = "Optional country code to improve accuracy (e.g., 'US', 'CA', 'GB')"
                        }
                    },
                    Required = new[] { "address" }
                }
            },
            
            // Azure Maps - Route Directions Tool
            new McpTool
            {
                Name = "get_route_directions",
                Description = "Get driving directions between two locations using Azure Maps. Returns route information including distance, duration, and turn-by-turn directions.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["origin"] = new McpProperty
                        {
                            Type = "string",
                            Description = "Starting address or location"
                        },
                        ["destination"] = new McpProperty
                        {
                            Type = "string",
                            Description = "Destination address or location"
                        },                        ["travelMode"] = new McpProperty
                        {
                            Type = "string",
                            Description = "Mode of travel (car, pedestrian, bicycle)",
                            Enum = new[] { "car", "pedestrian", "bicycle" }
                        }
                    },
                    Required = new[] { "origin", "destination" }
                }
            },
            
            // Azure Maps - Search Nearby Tool
            new McpTool
            {
                Name = "search_nearby_places",
                Description = "Search for nearby places of interest (restaurants, gas stations, hotels, etc.) around a given location using Azure Maps.",
                InputSchema = new McpToolInputSchema
                {
                    Type = "object",
                    Properties = new Dictionary<string, McpProperty>
                    {
                        ["location"] = new McpProperty
                        {
                            Type = "string",
                            Description = "The center location to search around (address or coordinates)"
                        },
                        ["category"] = new McpProperty
                        {
                            Type = "string",
                            Description = "Category of places to search for (restaurant, gas station, hotel, hospital, etc.)"
                        },
                        ["radius"] = new McpProperty
                        {
                            Type = "number",
                            Description = "Search radius in meters (default: 5000, max: 50000)"
                        }
                    },
                    Required = new[] { "location", "category" }
                }
            }
        };
    }    public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        return request.Name switch
        {
            "list_resource_groups" => await ExecuteListResourceGroupsAsync(request.Arguments),
            "list_storage_accounts" => await ExecuteListStorageAccountsAsync(request.Arguments),
            "create_resource_group" => await ExecuteCreateResourceGroupAsync(request.Arguments),
            "geocode_address" => await ExecuteGeocodeAddressAsync(request.Arguments),
            "get_route_directions" => await ExecuteGetRouteDirectionsAsync(request.Arguments),
            "search_nearby_places" => await ExecuteSearchNearbyPlacesAsync(request.Arguments),
            _ => new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Unknown Azure resource tool: {request.Name}"
                    }
                },
                IsError = true
            }
        };
    }

    /// <summary>
    /// Initialize ARM client using user's delegated token
    /// </summary>
    public async Task InitializeWithUserTokenAsync(string userToken)
    {
        try
        {
            _logger.LogInformation("Initializing ARM client with user token delegation for Azure Government");
            
            var credential = new UserTokenCredential(userToken);
            
            // Configure ARM client for Azure Government cloud
            var armClientOptions = new ArmClientOptions();
            armClientOptions.Environment = ArmEnvironment.AzureGovernment;
            
            _armClient = new ArmClient(credential, default(string), armClientOptions);
            
            _logger.LogInformation("ARM client initialized with user token for Azure Government");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize ARM client with user token");
            throw;
        }
    }

    private async Task<McpToolCallResponse> ExecuteListResourceGroupsAsync(Dictionary<string, object> arguments)
    {
        try
        {
            _logger.LogInformation("Listing resource groups");

            if (_armClient == null)
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Azure authentication not configured. Please ensure you are authenticated."
                        }
                    },
                    IsError = true
                };
            }

            var subscription = _armClient.GetDefaultSubscription();
            var resourceGroups = new List<string>();

            await foreach (var rg in subscription.GetResourceGroups())
            {
                var location = rg.Data.Location.ToString();
                resourceGroups.Add($"- {rg.Data.Name} ({location})");
            }

            var resultText = resourceGroups.Count > 0
                ? $"Found {resourceGroups.Count} resource groups:\n{string.Join("\n", resourceGroups)}"
                : "No resource groups found in the subscription.";

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
            _logger.LogError(ex, "Error listing resource groups");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error listing resource groups: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteListStorageAccountsAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var resourceGroupName = arguments.GetValueOrDefault("resourceGroupName")?.ToString();
            if (string.IsNullOrEmpty(resourceGroupName))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Resource group name is required."
                        }
                    },
                    IsError = true
                };
            }

            if (_armClient == null)
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Azure authentication not configured."
                        }
                    },
                    IsError = true
                };
            }

            var subscription = _armClient.GetDefaultSubscription();
            var resourceGroup = await subscription.GetResourceGroups().GetAsync(resourceGroupName);
            
            // Get storage accounts in the resource group
            var storageAccounts = new List<string>();
            
            try
            {
                await foreach (var storageAccount in resourceGroup.Value.GetStorageAccounts())
                {
                    var location = storageAccount.Data.Location.ToString();
                    var kind = storageAccount.Data.Kind?.ToString() ?? "Unknown";
                    var sku = storageAccount.Data.Sku?.Name.ToString() ?? "Unknown";
                    
                    storageAccounts.Add($"- {storageAccount.Data.Name} (Location: {location}, Kind: {kind}, SKU: {sku})");
                }
                
                var resultText = storageAccounts.Count > 0
                    ? $"Found {storageAccounts.Count} storage account(s) in resource group '{resourceGroupName}':\n{string.Join("\n", storageAccounts)}"
                    : $"No storage accounts found in resource group '{resourceGroupName}'.";
                
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
            catch (Exception storageEx)
            {
                _logger.LogWarning(storageEx, "Could not list storage accounts for resource group {ResourceGroupName}", resourceGroupName);
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"Could not access storage accounts in resource group '{resourceGroupName}'. This may be due to insufficient permissions."
                        }
                    },
                    IsError = false
                };
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing storage accounts");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error listing storage accounts: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteCreateResourceGroupAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var name = arguments.GetValueOrDefault("name")?.ToString();
            var location = arguments.GetValueOrDefault("location")?.ToString();

            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(location))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Both name and location are required to create a resource group."
                        }
                    },
                    IsError = true
                };
            }

            if (_armClient == null)
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Azure authentication not configured."
                        }
                    },
                    IsError = true
                };
            }

            var subscription = _armClient.GetDefaultSubscription();
            var resourceGroupData = new ResourceGroupData(location);
            
            var createOperation = await subscription.GetResourceGroups().CreateOrUpdateAsync(
                WaitUntil.Completed, 
                name, 
                resourceGroupData);

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Successfully created resource group '{name}' in location '{location}'."
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating resource group");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error creating resource group: {ex.Message}"
                    }
                },
                IsError = true            };
        }
    }

    #region Azure Maps Tools

    private async Task<McpToolCallResponse> ExecuteGeocodeAddressAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var address = arguments.GetValueOrDefault("address")?.ToString();
            var countryCode = arguments.GetValueOrDefault("countryCode")?.ToString();

            if (string.IsNullOrEmpty(address))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Address is required for geocoding."
                        }
                    },
                    IsError = true
                };
            }            var subscriptionKey = _configuration["AzureMaps:SubscriptionKey"];
            var mapsBaseUrl = _configuration["AzureMaps:BaseUrl"] ?? "https://atlas.azure.us";
            
            if (string.IsNullOrEmpty(subscriptionKey))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Azure Maps subscription key not configured. Please add AzureMaps:SubscriptionKey to configuration."
                        }
                    },
                    IsError = true
                };
            }

            // Build Azure Maps Geocoding API URL
            // Using configured endpoint for Azure Government compatibility
            var baseUrl = $"{mapsBaseUrl}/search/address/json";
            var queryParams = new List<string>
            {
                $"api-version=1.0",
                $"subscription-key={subscriptionKey}",
                $"query={Uri.EscapeDataString(address)}"
            };

            if (!string.IsNullOrEmpty(countryCode))
            {
                queryParams.Add($"countrySet={countryCode}");
            }

            var requestUrl = $"{baseUrl}?{string.Join("&", queryParams)}";

            _logger.LogInformation("Calling Azure Maps Geocoding API for address: {Address}", address);
            _logger.LogInformation("Request URL: {RequestUrl}", requestUrl.Replace(subscriptionKey, "***"));

            var response = await _httpClient.GetAsync(requestUrl);
            var jsonResponse = await response.Content.ReadAsStringAsync();
            
            _logger.LogInformation("Azure Maps API Response Status: {StatusCode}", response.StatusCode);
            _logger.LogInformation("Azure Maps API Response: {Response}", jsonResponse);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Azure Maps API returned error: {StatusCode} - {Response}", response.StatusCode, jsonResponse);
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"Azure Maps API error: {response.StatusCode} - {jsonResponse}"
                        }
                    },
                    IsError = true
                };
            }

            var geocodeResult = JsonSerializer.Deserialize<AzureMapsGeocodeResponse>(jsonResponse);

            if (geocodeResult?.Results?.Length > 0)
            {
                var result = geocodeResult.Results[0];
                var lat = result.Position.Lat;
                var lon = result.Position.Lon;                // Return rich content with map data (need || delimiter and space between coordinates)
                // Use simple pin format that Azure Maps supports
                var mapUrl = $"{mapsBaseUrl}/map/static/png?api-version=1.0&subscription-key={subscriptionKey}&center={lon},{lat}&zoom=15&width=600&height=400&pins=default|coFF0000||{lat} {lon}";

                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"🗺️ **Location Found**\n\n" +
                                   $"**Address:** {result.Address.FreeformAddress}\n" +
                                   $"**Coordinates:** {lat:F6}, {lon:F6}\n" +
                                   $"**Country:** {result.Address.Country}\n" +
                                   $"**Confidence:** {result.Score:F2}\n\n" +
                                   $"**Map URL:** {mapUrl}\n\n" +
                                   $"*Use this map URL to display a visual map in the UI*"
                        }
                    },
                    IsError = false
                };
            }
            else
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"No location found for address: {address}. API response was successful but returned no results."
                        }
                    },
                    IsError = false
                };
            }
        }        catch (Exception ex)
        {
            _logger.LogError(ex, "Error geocoding address");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error geocoding address: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }        private async Task<McpToolCallResponse> ExecuteGetRouteDirectionsAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var origin = arguments.GetValueOrDefault("origin")?.ToString();
            var destination = arguments.GetValueOrDefault("destination")?.ToString();
            var travelMode = arguments.GetValueOrDefault("travelMode")?.ToString() ?? "car";

            // Map friendly names to Azure Maps API values if needed
            travelMode = MapTravelMode(travelMode);

            if (string.IsNullOrEmpty(origin) || string.IsNullOrEmpty(destination))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Both origin and destination are required for directions."
                        }
                    },
                    IsError = true
                };            }

            var subscriptionKey = _configuration["AzureMaps:SubscriptionKey"];
            var mapsBaseUrl = _configuration["AzureMaps:BaseUrl"] ?? "https://atlas.azure.us";
            
            if (string.IsNullOrEmpty(subscriptionKey))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Azure Maps subscription key not configured."
                        }
                    },
                    IsError = true
                };
            }

            _logger.LogInformation("Getting route directions - Origin: {Origin}, Destination: {Destination}", origin, destination);

            // Check if inputs are coordinate JSON objects or address strings
            GeocodePosition? originCoords = null;
            GeocodePosition? destCoords = null;

            // Try to parse as coordinate JSON first
            if (origin.StartsWith("{") && origin.Contains("latitude"))
            {
                try
                {
                    var coordObj = JsonSerializer.Deserialize<JsonElement>(origin);
                    if (coordObj.TryGetProperty("latitude", out var latProp) && 
                        coordObj.TryGetProperty("longitude", out var lonProp))
                    {
                        originCoords = new GeocodePosition 
                        { 
                            Lat = latProp.GetDouble(), 
                            Lon = lonProp.GetDouble() 
                        };
                        _logger.LogInformation("Parsed origin coordinates from JSON: {Lat}, {Lon}", originCoords.Lat, originCoords.Lon);
                    }
                }
                catch
                {
                    // Fall back to geocoding
                }
            }

            if (destination.StartsWith("{") && destination.Contains("latitude"))
            {
                try
                {
                    var coordObj = JsonSerializer.Deserialize<JsonElement>(destination);
                    if (coordObj.TryGetProperty("latitude", out var latProp) && 
                        coordObj.TryGetProperty("longitude", out var lonProp))
                    {
                        destCoords = new GeocodePosition 
                        { 
                            Lat = latProp.GetDouble(), 
                            Lon = lonProp.GetDouble() 
                        };
                        _logger.LogInformation("Parsed destination coordinates from JSON: {Lat}, {Lon}", destCoords.Lat, destCoords.Lon);
                    }
                }
                catch
                {
                    // Fall back to geocoding
                }
            }

            // If not coordinate objects, geocode the addresses
            if (originCoords == null)
            {
                _logger.LogInformation("Geocoding origin address: {Origin}", origin);
                originCoords = await GeocodeAddressInternal(origin, subscriptionKey);
            }

            if (destCoords == null)
            {
                _logger.LogInformation("Geocoding destination address: {Destination}", destination);
                destCoords = await GeocodeAddressInternal(destination, subscriptionKey);
            }

            if (originCoords == null || destCoords == null)
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Could not geocode one or both addresses for route calculation."
                        }
                    },
                    IsError = true
                };
            }

            _logger.LogInformation("Using coordinates - Origin: {OriginLat},{OriginLon}, Destination: {DestLat},{DestLon}", 
                originCoords.Lat, originCoords.Lon, destCoords.Lat, destCoords.Lon);

            // Get route directions
            var baseUrl = $"{mapsBaseUrl}/route/directions/json";
            var queryParams = new List<string>
            {
                $"api-version=1.0",
                $"subscription-key={subscriptionKey}",
                $"query={originCoords.Lat},{originCoords.Lon}:{destCoords.Lat},{destCoords.Lon}",
                $"travelMode={travelMode}"
            };

            var requestUrl = $"{baseUrl}?{string.Join("&", queryParams)}";

            _logger.LogInformation("Route API Request URL: {RequestUrl}", requestUrl.Replace(subscriptionKey, "***"));

            var response = await _httpClient.GetAsync(requestUrl);
            
            // Log response details before throwing exception
            var responseContent = await response.Content.ReadAsStringAsync();
            _logger.LogInformation("Route directions response status: {StatusCode}, body: {ResponseBody}", response.StatusCode, responseContent);
            
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Route directions failed with status {StatusCode}: {ResponseBody}", response.StatusCode, responseContent);
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"Failed to get route directions. API returned {response.StatusCode}: {responseContent}"
                        }
                    },
                    IsError = true
                };
            }            var jsonResponse = await response.Content.ReadAsStringAsync();
            var routeResult = JsonSerializer.Deserialize<AzureMapsRouteResponse>(responseContent);
            
            _logger.LogInformation("Route result parsed - Routes count: {RoutesCount}", routeResult?.Routes?.Length ?? 0);
            if (routeResult?.Routes?.Length > 0)
            {
                var route = routeResult.Routes[0];
                _logger.LogInformation("First route - Summary: Length={Length}m, Time={Time}s", route.Summary?.LengthInMeters, route.Summary?.TravelTimeInSeconds);
            }

            if (routeResult?.Routes?.Length > 0)
            {
                var route = routeResult.Routes[0];
                var summary = route.Summary;                // Generate a static map with the route and pins
                // Calculate center point and appropriate zoom level
                var centerLat = (originCoords.Lat + destCoords.Lat) / 2;
                var centerLon = (originCoords.Lon + destCoords.Lon) / 2;
                
                // Calculate distance to determine zoom level
                var latDiff = Math.Abs(originCoords.Lat - destCoords.Lat);
                var lonDiff = Math.Abs(originCoords.Lon - destCoords.Lon);
                var maxDiff = Math.Max(latDiff, lonDiff);
                
                // Determine appropriate zoom level based on distance
                int zoom;
                if (maxDiff > 10) zoom = 5;      // Very far apart
                else if (maxDiff > 5) zoom = 6;  // Far apart  
                else if (maxDiff > 2) zoom = 7;  // Medium distance
                else if (maxDiff > 1) zoom = 8;  // Close
                else if (maxDiff > 0.5) zoom = 9; // Very close
                else zoom = 10;                   // Same area                // Create map URL with center/zoom and pins (need || delimiter and space between coordinates)
                var mapUrl = $"{mapsBaseUrl}/map/static/png?api-version=1.0&subscription-key={subscriptionKey}&center={centerLon},{centerLat}&zoom={zoom}&width=800&height=600&pins=default|co00FF00||{originCoords.Lat} {originCoords.Lon}&pins=default|coFF0000||{destCoords.Lat} {destCoords.Lon}";                
                _logger.LogInformation("Generated route map URL with center {Center}, zoom {Zoom}", $"{centerLon},{centerLat}", zoom);// Format distance and travel time
                var distanceKm = summary.LengthInMeters / 1000.0;
                var hours = summary.TravelTimeInSeconds / 3600;
                var minutes = (summary.TravelTimeInSeconds % 3600) / 60;

                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",                            Text = $"�️ **Route from {origin} to {destination}**\n\n" +
                                   $"📏 **Distance:** {distanceKm:F1} km\n" +
                                   $"⏱️ **Travel Time:** {hours}h {minutes}m\n" +
                                   $"🚗 **Travel Mode:** {travelMode}\n\n" +
                                   $"![Route Map]({mapUrl})"
                        }
                    },
                    IsError = false
                };
            }
            else
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"No route found from {origin} to {destination}."
                        }
                    },
                    IsError = false
                };
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting route directions");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error getting directions: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    private async Task<McpToolCallResponse> ExecuteSearchNearbyPlacesAsync(Dictionary<string, object> arguments)
    {
        try
        {
            var location = arguments.GetValueOrDefault("location")?.ToString();
            var category = arguments.GetValueOrDefault("category")?.ToString();
            var radius = arguments.GetValueOrDefault("radius") as int? ?? 5000;

            if (string.IsNullOrEmpty(location) || string.IsNullOrEmpty(category))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Location and category are required for nearby search."
                        }
                    },
                    IsError = true
                };
            }            var subscriptionKey = _configuration["AzureMaps:SubscriptionKey"];
            var mapsBaseUrl = _configuration["AzureMaps:BaseUrl"] ?? "https://atlas.azure.us";
            
            if (string.IsNullOrEmpty(subscriptionKey))
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = "Azure Maps subscription key not configured."
                        }
                    },
                    IsError = true
                };
            }

            // First, geocode the location
            var coords = await GeocodeAddressInternal(location, subscriptionKey);
            if (coords == null)
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"Could not find coordinates for location: {location}"
                        }
                    },
                    IsError = true
                };
            }

            // Search for nearby places
            var baseUrl = $"{mapsBaseUrl}/search/nearby/json";
            var queryParams = new List<string>
            {
                $"api-version=1.0",
                $"subscription-key={subscriptionKey}",
                $"lat={coords.Lat}",
                $"lon={coords.Lon}",
                $"radius={Math.Min(radius, 50000)}", // Max 50km
                $"categorySet={Uri.EscapeDataString(category)}"
            };            var requestUrl = $"{baseUrl}?{string.Join("&", queryParams)}";

            _logger.LogInformation("Searching for {Category} near {Location} with URL: {RequestUrl}", category, location, requestUrl);

            var response = await _httpClient.GetAsync(requestUrl);
            
            // Log response details before throwing exception
            var responseContent = await response.Content.ReadAsStringAsync();
            _logger.LogInformation("Nearby search response status: {StatusCode}, body: {ResponseBody}", response.StatusCode, responseContent);
              if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Nearby search failed with status {StatusCode}: {ResponseBody}", response.StatusCode, responseContent);
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"Failed to search for nearby places. API returned {response.StatusCode}: {responseContent}"
                        }
                    },
                    IsError = true
                };
            }var jsonResponse = await response.Content.ReadAsStringAsync();
            var searchResult = JsonSerializer.Deserialize<AzureMapsSearchResponse>(responseContent);

            if (searchResult?.Results?.Length > 0)
            {
                var places = searchResult.Results
                    .Take(10) // Limit to top 10 results
                    .Select((place, index) => 
                        $"{index + 1}. **{place.Poi?.Name ?? "Unknown"}**\n" +
                        $"   📍 {place.Address?.FreeformAddress}\n" +
                        $"   📞 {place.Poi?.Phone ?? "N/A"}\n" +
                        $"   🏷️ {string.Join(", ", place.Poi?.CategorySet?.Select(c => c.Name) ?? new[] { "N/A" })}\n" +
                        $"   📏 {place.Dist:F0}m away")
                    .ToList();                // Generate map with all nearby places (need || delimiter and space between coordinates)
                var nearbyPins = searchResult.Results.Take(10)
                    .Select(place => $"pins=default|co0000FF||{place.Position.Lat} {place.Position.Lon}")
                    .ToList();
                nearbyPins.Insert(0, $"pins=default|coFF0000||{coords.Lat} {coords.Lon}"); // Add center point first (will be red)

                var mapUrl = $"{mapsBaseUrl}/map/static/png?api-version=1.0&subscription-key={subscriptionKey}&center={coords.Lon},{coords.Lat}&zoom=13&width=800&height=600&{string.Join("&", nearbyPins)}";

                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"📍 **{category} near {location}**\n\n" +
                                   $"Found {searchResult.Results.Length} places within {radius}m:\n\n" +
                                   $"{string.Join("\n\n", places)}\n\n" +
                                   $"**Map URL:** {mapUrl}\n\n" +
                                   $"*Red pin shows your search center, other pins show found places*"
                        }
                    },
                    IsError = false
                };
            }
            else
            {
                return new McpToolCallResponse
                {
                    Content = new[]
                    {
                        new McpContent
                        {
                            Type = "text",
                            Text = $"No {category} found near {location} within {radius}m."
                        }
                    },
                    IsError = false
                };
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error searching nearby places");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error searching nearby places: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }    private async Task<GeocodePosition?> GeocodeAddressInternal(string address, string subscriptionKey)
    {
        try
        {
            var mapsBaseUrl = _configuration["AzureMaps:BaseUrl"] ?? "https://atlas.azure.us";
            var baseUrl = $"{mapsBaseUrl}/search/address/json";
            var requestUrl = $"{baseUrl}?api-version=1.0&subscription-key={subscriptionKey}&query={Uri.EscapeDataString(address)}";

            _logger.LogInformation("GeocodeAddressInternal - Calling: {Address}", address);
            _logger.LogInformation("GeocodeAddressInternal - URL: {Url}", requestUrl.Replace(subscriptionKey, "***"));

            var response = await _httpClient.GetAsync(requestUrl);
            var jsonResponse = await response.Content.ReadAsStringAsync();
            
            _logger.LogInformation("GeocodeAddressInternal - Response Status: {Status}", response.StatusCode);
            _logger.LogInformation("GeocodeAddressInternal - Response Body: {Response}", jsonResponse);

            response.EnsureSuccessStatusCode();

            var geocodeResult = JsonSerializer.Deserialize<AzureMapsGeocodeResponse>(jsonResponse);
            
            _logger.LogInformation("GeocodeAddressInternal - Parsed Results Count: {Count}", geocodeResult?.Results?.Length ?? 0);

            if (geocodeResult?.Results?.Length > 0)
            {
                var result = geocodeResult.Results[0];
                _logger.LogInformation("GeocodeAddressInternal - Found coordinates: {Lat}, {Lon}", result.Position.Lat, result.Position.Lon);
                return new GeocodePosition 
                { 
                    Lat = result.Position.Lat, 
                    Lon = result.Position.Lon 
                };
            }

            _logger.LogWarning("GeocodeAddressInternal - No results found for address: {Address}", address);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GeocodeAddressInternal - Error geocoding address: {Address}", address);
            return null;        }
    }

    private static string MapTravelMode(string travelMode)
    {
        // Map common travel mode names to Azure Maps API values
        return travelMode?.ToLowerInvariant() switch
        {
            "driving" => "car",
            "walking" => "pedestrian",
            "transit" => "bus",
            "cycling" => "bicycle",
            "biking" => "bicycle",
            _ => travelMode ?? "car"
        };
    }

    #endregion

    #region Azure Maps Models

    public class AzureMapsGeocodeResponse
    {
        [JsonPropertyName("results")]
        public GeocodeResult[] Results { get; set; } = Array.Empty<GeocodeResult>();
    }

    public class GeocodeResult
    {
        [JsonPropertyName("position")]
        public GeocodePosition Position { get; set; } = new();
        [JsonPropertyName("address")]
        public GeocodeAddress Address { get; set; } = new();
        [JsonPropertyName("score")]
        public double Score { get; set; }
    }

    public class GeocodePosition
    {
        [JsonPropertyName("lat")]
        public double Lat { get; set; }
        [JsonPropertyName("lon")]
        public double Lon { get; set; }
    }

    public class GeocodeAddress
    {
        [JsonPropertyName("freeformAddress")]
        public string FreeformAddress { get; set; } = "";
        [JsonPropertyName("country")]
        public string Country { get; set; } = "";
    }    public class AzureMapsRouteResponse
    {
        [JsonPropertyName("routes")]
        public RouteResult[] Routes { get; set; } = Array.Empty<RouteResult>();
    }

    public class RouteResult
    {
        [JsonPropertyName("summary")]
        public RouteSummary Summary { get; set; } = new();
        
        [JsonPropertyName("legs")]
        public RouteLeg[] Legs { get; set; } = Array.Empty<RouteLeg>();
    }

    public class RouteSummary
    {
        [JsonPropertyName("lengthInMeters")]
        public int LengthInMeters { get; set; }
        
        [JsonPropertyName("travelTimeInSeconds")]
        public int TravelTimeInSeconds { get; set; }
    }

    public class RouteLeg
    {
        [JsonPropertyName("summary")]
        public RouteSummary Summary { get; set; } = new();
        
        [JsonPropertyName("points")]
        public RoutePoint[] Points { get; set; } = Array.Empty<RoutePoint>();
    }

    public class RoutePoint
    {
        [JsonPropertyName("latitude")]
        public double Latitude { get; set; }
        
        [JsonPropertyName("longitude")]
        public double Longitude { get; set; }
    }

    public class AzureMapsSearchResponse
    {
        public SearchResult[] Results { get; set; } = Array.Empty<SearchResult>();
    }

    public class SearchResult
    {
        public GeocodePosition Position { get; set; } = new();
        public GeocodeAddress Address { get; set; } = new();
        public SearchPoi Poi { get; set; } = new();
        public double Dist { get; set; }
    }

    public class SearchPoi
    {
        public string Name { get; set; } = "";
        public string Phone { get; set; } = "";
        public SearchCategory[] CategorySet { get; set; } = Array.Empty<SearchCategory>();
    }

    public class SearchCategory
    {
        public string Name { get; set; } = "";
    }

    #endregion
}
