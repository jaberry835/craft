using MCPServer.Models;
using System.Text.Json;
using System.Text;
using Azure.Storage.Blobs;
using Azure.AI.FormRecognizer.DocumentAnalysis;
using Azure.AI.OpenAI;
using Azure.Search.Documents;
using Azure.Search.Documents.Indexes;
using Azure.Search.Documents.Indexes.Models;
using Azure.Search.Documents.Models;
using Azure;

namespace MCPServer.Services.Azure;

public interface IAzureDocumentService
{
    Task<string> UploadDocumentAsync(Stream documentStream, string fileName, string userId, string sessionId);
    Task<DocumentProcessingResult> ProcessDocumentAsync(string documentId, string? blobUrl = null);
    Task<List<DocumentChunk>> SearchDocumentsAsync(string query, string userId, string? sessionId = null, int maxResults = 5);
    Task DeleteDocumentAsync(string documentId, string userId);
    Task<List<DocumentMetadata>> GetUserDocumentsAsync(string userId, string? sessionId = null);
    Task<(Stream content, string fileName, string contentType)> DownloadDocumentAsync(string documentId, string userId);
    Task<string> GetDocumentContentAsync(string documentId, string userId);
}

public class AzureDocumentService : IAzureDocumentService
{
    private readonly ILogger<AzureDocumentService> _logger;
    private readonly IConfiguration _configuration;
    private readonly BlobServiceClient? _blobServiceClient;
    private readonly DocumentAnalysisClient? _documentAnalysisClient;    private readonly AzureOpenAIClient? _openAIClient;
    private readonly SearchClient? _searchClient;    private readonly SearchIndexClient? _searchIndexClient;
    private readonly IChatHistoryService _chatHistoryService;

    public AzureDocumentService(
        ILogger<AzureDocumentService> logger,
        IConfiguration configuration,
        IChatHistoryService chatHistoryService)
    {
        _logger = logger;
        _configuration = configuration;
        _chatHistoryService = chatHistoryService;

        try
        {
            // Initialize Azure services
            var storageConnectionString = _configuration.GetConnectionString("AzureStorage");
            if (!string.IsNullOrEmpty(storageConnectionString) && !storageConnectionString.Contains("["))
            {
                _blobServiceClient = new BlobServiceClient(storageConnectionString);
            }

            var documentIntelligenceEndpoint = _configuration["AzureDocumentIntelligence:Endpoint"];
            var documentIntelligenceKey = _configuration["AzureDocumentIntelligence:ApiKey"];
            if (!string.IsNullOrEmpty(documentIntelligenceEndpoint) && !documentIntelligenceEndpoint.Contains("[") &&
                !string.IsNullOrEmpty(documentIntelligenceKey) && !documentIntelligenceKey.Contains("["))
            {
                _documentAnalysisClient = new DocumentAnalysisClient(new Uri(documentIntelligenceEndpoint), new AzureKeyCredential(documentIntelligenceKey));
            }

            var openAIEndpoint = _configuration["AzureOpenAI:Endpoint"];
            var openAIKey = _configuration["AzureOpenAI:ApiKey"];
            if (!string.IsNullOrEmpty(openAIEndpoint) && !openAIEndpoint.Contains("[") &&
                !string.IsNullOrEmpty(openAIKey) && !openAIKey.Contains("["))
            {
                _openAIClient = new AzureOpenAIClient(new Uri(openAIEndpoint), new AzureKeyCredential(openAIKey));
            }            var searchEndpoint = _configuration["AzureAISearch:Endpoint"];
            var searchKey = _configuration["AzureAISearch:ApiKey"];
            var indexName = _configuration["AzureAISearch:IndexName"];
            
            _logger.LogInformation("Azure AI Search Config - Endpoint: {Endpoint}, HasKey: {HasKey}, IndexName: {IndexName}", 
                searchEndpoint, !string.IsNullOrEmpty(searchKey), indexName);
            
            if (!string.IsNullOrEmpty(searchEndpoint) && !searchEndpoint.Contains("[") &&
                !string.IsNullOrEmpty(searchKey) && !searchKey.Contains("[") &&
                !string.IsNullOrEmpty(indexName))
            {
                _searchIndexClient = new SearchIndexClient(new Uri(searchEndpoint), new AzureKeyCredential(searchKey));
                _searchClient = new SearchClient(new Uri(searchEndpoint), indexName, new AzureKeyCredential(searchKey));
                
                // Ensure search index exists
                _ = Task.Run(EnsureSearchIndexAsync);
                _logger.LogInformation("Azure AI Search client initialized successfully");
            }
            else
            {                _logger.LogWarning("Azure AI Search not configured - vector search will not be available. Endpoint: {Endpoint}, HasKey: {HasKey}", 
                    searchEndpoint, !string.IsNullOrEmpty(searchKey));
            }

            _logger.LogInformation("AzureDocumentService initialized with Azure services");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to initialize some Azure services, some features may not be available");
        }
    }

    private async Task EnsureSearchIndexAsync()
    {
        try
        {
            if (_searchIndexClient == null) return;

            var indexName = _configuration["AzureAISearch:IndexName"];
            
            var fields = new List<SearchField>
            {
                new SimpleField("chunkId", SearchFieldDataType.String) { IsKey = true },
                new SearchableField("documentId") { IsFilterable = true },
                new SearchableField("userId") { IsFilterable = true },
                new SearchableField("sessionId") { IsFilterable = true },
                new SearchableField("fileName"),
                new SearchableField("content"),
                new SimpleField("chunkIndex", SearchFieldDataType.Int32),
                new SimpleField("uploadedAt", SearchFieldDataType.DateTimeOffset),
                new VectorSearchField("contentVector", 1536, "default")
            };

            var definition = new SearchIndex(indexName, fields);
            
            // Add vector search configuration
            definition.VectorSearch = new VectorSearch();
            definition.VectorSearch.Profiles.Add(new VectorSearchProfile("default", "myHnsw"));
            definition.VectorSearch.Algorithms.Add(new HnswAlgorithmConfiguration("myHnsw"));

            await _searchIndexClient.CreateOrUpdateIndexAsync(definition);
            _logger.LogInformation("Search index '{IndexName}' created/updated successfully", indexName);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating search index");
        }
    }

    public async Task<string> UploadDocumentAsync(Stream documentStream, string fileName, string userId, string sessionId)
    {
        try
        {
            var documentId = Guid.NewGuid().ToString();
            
            // Upload to Azure Blob Storage if available
            string blobUrl = "";
            if (_blobServiceClient != null)
            {
                var containerName = _configuration["AzureStorage:ContainerName"] ?? "documents";
                var containerClient = _blobServiceClient.GetBlobContainerClient(containerName);
                await containerClient.CreateIfNotExistsAsync();

                var blobName = $"{userId}/{sessionId}/{documentId}/{fileName}";
                var blobClient = containerClient.GetBlobClient(blobName);
                
                // Reset stream position
                documentStream.Position = 0;
                await blobClient.UploadAsync(documentStream, overwrite: true);
                blobUrl = blobClient.Uri.ToString();
                
                _logger.LogInformation("Document uploaded to blob storage: {BlobUrl}", blobUrl);
            }
            
            // Read document content for processing
            documentStream.Position = 0;
            using var reader = new StreamReader(documentStream);
            var content = await reader.ReadToEndAsync();            // Store document metadata in Cosmos DB
            var sessionDocument = new SessionDocument
            {
                DocumentId = documentId,
                FileName = fileName,
                FileSize = content.Length,
                BlobUrl = blobUrl,
                UploadDate = DateTime.UtcNow,
                Status = (int)DocumentStatus.Uploaded
            };

            _logger.LogInformation("Storing document metadata - ID: {DocumentId}, BlobUrl: {BlobUrl}, Size: {Size}", 
                documentId, blobUrl, content.Length);

            // Save to Cosmos DB session
            await _chatHistoryService.AddDocumentToSessionAsync(userId, sessionId, sessionDocument);
            
            _logger.LogInformation("Document metadata saved to Cosmos DB: {DocumentId}", documentId);

            _logger.LogInformation("Document uploaded successfully: {DocumentId}", documentId);
            return documentId;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error uploading document");
            throw;
        }
    }        public async Task<DocumentProcessingResult> ProcessDocumentAsync(string documentId, string? blobUrl = null)
        {
            try
            {
                // Add retry logic for document lookup to handle eventual consistency
                (SessionDocument? document, string userId, string sessionId)? documentContext = null;
                int retryCount = 0;
                const int maxRetries = 3;
                
                while (documentContext == null && retryCount < maxRetries)
                {
                    if (retryCount > 0)
                    {
                        _logger.LogInformation("Retrying document lookup for {DocumentId}, attempt {Retry}", documentId, retryCount + 1);
                        await Task.Delay(1000 * retryCount); // Progressive delay
                    }
                    
                    documentContext = await _chatHistoryService.FindDocumentWithContextAsync(documentId);
                    retryCount++;
                }
                
                if (documentContext == null)
                {
                    throw new ArgumentException($"Document not found after {maxRetries} attempts: {documentId}");
                }

                var sessionDocument = documentContext.Value.document;
                var userId = documentContext.Value.userId;
                var sessionId = documentContext.Value.sessionId;

                // Use blob URL from stored document metadata instead of parameter
                var actualBlobUrl = sessionDocument?.BlobUrl ?? "";
                _logger.LogInformation("Processing document {DocumentId} with blob URL: {BlobUrl}", documentId, actualBlobUrl);
                
                // Validate that we have a blob URL
                if (string.IsNullOrEmpty(actualBlobUrl))
                {
                    throw new InvalidOperationException($"No blob URL found for document {documentId}");
                }
                  // Log additional details about the document
                _logger.LogInformation("Document details - ID: {DocumentId}, Name: {FileName}, Size: {FileSize}, Container: {Container}", 
                    sessionDocument?.DocumentId, sessionDocument?.FileName, sessionDocument?.FileSize, 
                    sessionDocument?.BlobUrl?.Split('/').Skip(3).FirstOrDefault());

            // Update status to processing
            await _chatHistoryService.UpdateDocumentStatusAsync(userId, documentId, (int)DocumentStatus.Processing);

            string extractedText = "";            // Use Azure Document Intelligence if available
            if (_documentAnalysisClient != null && !string.IsNullOrEmpty(actualBlobUrl))
            {
                try
                {
                    // Validate blob URL format
                    if (!actualBlobUrl.Contains("[") && Uri.TryCreate(actualBlobUrl, UriKind.Absolute, out _))
                    {
                        var operation = await _documentAnalysisClient.AnalyzeDocumentFromUriAsync(
                            WaitUntil.Completed, "prebuilt-document", new Uri(actualBlobUrl));
                    
                        var result = operation.Value;
                        var textBuilder = new StringBuilder();
                        
                        foreach (var page in result.Pages)
                        {
                            foreach (var line in page.Lines)
                            {
                                textBuilder.AppendLine(line.Content);
                            }
                        }
                        
                        extractedText = textBuilder.ToString();
                        _logger.LogInformation("Document Intelligence extracted {Length} characters", extractedText.Length);
                    }
                    else
                    {
                        _logger.LogWarning("Invalid blob URL format: {BlobUrl}", actualBlobUrl);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Document Intelligence failed, will try to read from blob");
                }
            }              // If Document Intelligence failed or no text extracted, try to read from blob storage
            if (string.IsNullOrEmpty(extractedText) && _blobServiceClient != null && !string.IsNullOrEmpty(actualBlobUrl))
            {
                try
                {
                    _logger.LogInformation("Attempting to read blob directly from URL: {BlobUrl}", actualBlobUrl);
                    
                    // Validate blob URL format
                    if (!actualBlobUrl.Contains("[") && Uri.TryCreate(actualBlobUrl, UriKind.Absolute, out var blobUri))
                    {
                        _logger.LogInformation("Parsed blob URI - Host: {Host}, Path: {Path}", blobUri.Host, blobUri.AbsolutePath);
                          // Extract container and blob path from URL
                        var segments = blobUri.AbsolutePath.TrimStart('/').Split('/', 2);
                        if (segments.Length >= 2)
                        {
                            var containerName = segments[0];
                            var blobPath = Uri.UnescapeDataString(segments[1]); // URL decode the blob path
                            
                            _logger.LogInformation("Extracted container: {Container}, blob path: {BlobPath}", containerName, blobPath);
                            
                            // Use authenticated blob service client
                            var containerClient = _blobServiceClient.GetBlobContainerClient(containerName);
                            var blobClient = containerClient.GetBlobClient(blobPath);
                            
                            // Check if blob exists first
                            var existsResponse = await blobClient.ExistsAsync();
                            _logger.LogInformation("Blob exists check - Container: {Container}, Path: {Path}, Exists: {Exists}", 
                                containerName, blobPath, existsResponse.Value);
                            
                            if (!existsResponse.Value)
                            {
                                _logger.LogError("Blob does not exist at path: {Container}/{BlobPath}", containerName, blobPath);
                                throw new FileNotFoundException($"Blob not found: {containerName}/{blobPath}");
                            }
                            
                            var response = await blobClient.DownloadContentAsync();
                            extractedText = response.Value.Content.ToString();
                            _logger.LogInformation("Read {Length} characters from blob storage", extractedText.Length);
                        }
                        else
                        {
                            _logger.LogWarning("Could not parse blob path from URL: {BlobUrl}", actualBlobUrl);
                        }
                    }
                    else
                    {
                        _logger.LogWarning("Invalid blob URL format for blob read: {BlobUrl}", actualBlobUrl);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to read content from blob");
                }
            }// Create metadata object for chunking
            var metadata = new DocumentMetadata
            {
                DocumentId = documentId,
                FileName = sessionDocument?.FileName ?? "unknown",
                UserId = userId,
                SessionId = sessionId,
                UploadDate = sessionDocument?.UploadDate ?? DateTime.UtcNow,
                FileSize = sessionDocument?.FileSize ?? 0,
                Status = DocumentStatus.Processing,
                BlobUrl = sessionDocument?.BlobUrl ?? ""
            };            // Chunk the text
            var chunks = ChunkText(extractedText, documentId, metadata);
            
            _logger.LogInformation("Document processing - ExtractedText length: {Length}, Chunks generated: {ChunkCount}", 
                extractedText.Length, chunks.Count);
            
            // Generate embeddings and index in Azure Search if available
            if (_openAIClient != null && _searchClient != null)
            {
                await IndexChunksAsync(chunks);
            }
            else
            {
                _logger.LogWarning("Azure Search or OpenAI not configured, chunks will not be indexed for vector search");
            }// Update status to processed
            await _chatHistoryService.UpdateDocumentStatusAsync(userId, documentId, (int)DocumentStatus.Processed);

            _logger.LogInformation("Document processed successfully: {DocumentId}, Chunks: {ChunkCount}", 
                documentId, chunks.Count);

            return new DocumentProcessingResult
            {
                DocumentId = documentId,
                Success = true,
                ChunkCount = chunks.Count,
                ExtractedText = extractedText
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing document {DocumentId}", documentId);
              // Try to update status to failed if we can find the document
            try
            {
                var documentContext = await _chatHistoryService.FindDocumentWithContextAsync(documentId);
                if (documentContext != null)
                {
                    await _chatHistoryService.UpdateDocumentStatusAsync(documentContext.Value.userId, documentId, (int)DocumentStatus.Failed);
                }
            }
            catch (Exception updateEx)
            {
                _logger.LogWarning(updateEx, "Failed to update document status to failed");
            }

            return new DocumentProcessingResult
            {
                DocumentId = documentId,
                Success = false,
                ErrorMessage = ex.Message
            };
        }
    }

    public async Task<List<DocumentChunk>> SearchDocumentsAsync(string query, string userId, string? sessionId = null, int maxResults = 5)
    {
        try
        {
            var results = new List<DocumentChunk>();
            
            _logger.LogInformation("Starting search - Query: {Query}, UserId: {UserId}, SessionId: {SessionId}", 
                query, userId, sessionId);

            // Try Azure AI Search first
            if (_searchClient != null && _openAIClient != null)
            {
                try
                {                    // Generate embedding for the query
                    var embeddingModel = _configuration["AzureOpenAI:EmbeddingModel"] ?? "text-embedding-ada-002";
                    var embeddingClient = _openAIClient.GetEmbeddingClient(embeddingModel);
                    _logger.LogInformation("Generating embedding for query using model: {Model}", embeddingModel);
                    var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(query);
                    var queryVector = embeddingResponse.Value.ToFloats().ToArray();
                    _logger.LogInformation("Generated query vector with {Dimensions} dimensions", queryVector.Length);                    // Build search options
                    var searchOptions = new SearchOptions
                    {
                        Filter = $"userId eq '{userId}'",
                        Size = maxResults,
                        IncludeTotalCount = true
                    };

                    if (!string.IsNullOrEmpty(sessionId))
                    {
                        searchOptions.Filter += $" and sessionId eq '{sessionId}'";
                    }
                    
                    _logger.LogInformation("Search filter: {Filter}", searchOptions.Filter);
                    _logger.LogInformation("Search size: {Size}", searchOptions.Size);// Perform vector search
                    var vectorQuery = new VectorizedQuery(queryVector)
                    {
                        KNearestNeighborsCount = maxResults,
                        Fields = { "contentVector" }
                    };

                    searchOptions.VectorSearch = new VectorSearchOptions();
                    searchOptions.VectorSearch.Queries.Add(vectorQuery);

                    var searchResults = await _searchClient.SearchAsync<dynamic>(query, searchOptions);
                    
                    _logger.LogInformation("Search completed - Total count: {TotalCount}", searchResults.Value.TotalCount);
                    
                    // Also try a simple search without filters to see if any documents exist at all
                    var simpleSearchOptions = new SearchOptions
                    {
                        Size = 1,
                        IncludeTotalCount = true
                    };
                    var simpleResults = await _searchClient.SearchAsync<dynamic>("*", simpleSearchOptions);
                    _logger.LogInformation("Total documents in index: {TotalDocs}", simpleResults.Value.TotalCount);                    await foreach (var result in searchResults.Value.GetResultsAsync())
                    {
                        // Log what Azure Search is actually returning
                        Console.WriteLine($"Raw search result: {System.Text.Json.JsonSerializer.Serialize(result.Document)}");
                        
                        // Convert JsonElement result to DocumentChunk
                        var document = (System.Text.Json.JsonElement)result.Document;
                        var chunk = new DocumentChunk
                        {
                            ChunkId = GetJsonElementValue(document, "chunkId"),
                            DocumentId = GetJsonElementValue(document, "documentId"),
                            UserId = GetJsonElementValue(document, "userId"),
                            SessionId = GetJsonElementValue(document, "sessionId"),
                            FileName = GetJsonElementValue(document, "fileName"),
                            Content = GetJsonElementValue(document, "content"),
                            ChunkIndex = int.TryParse(GetJsonElementValue(document, "chunkIndex"), out int idx) ? idx : 0,
                            UploadedAt = DateTime.TryParse(GetJsonElementValue(document, "uploadedAt"), out DateTime date) ? date : DateTime.MinValue,
                            Score = (float)(result.Score ?? 0)
                        };
                        
                        _logger.LogInformation("Converted chunk - ChunkId: {ChunkId}, Content length: {ContentLength}", 
                            chunk.ChunkId, chunk.Content?.Length ?? 0);
                        
                        results.Add(chunk);
                    }

                    _logger.LogInformation("Azure Search returned {Count} results", results.Count);
                    
                    if (results.Any())
                    {
                        return results;
                    }
                }
                catch (Exception ex)                {
                    _logger.LogWarning(ex, "Azure Search failed, document search unavailable");
                    return new List<DocumentChunk>();
                }
            }

            // Without Azure Search configured, we cannot perform vector search
            _logger.LogWarning("Azure Search not configured, cannot perform document search");
            return new List<DocumentChunk>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error searching documents");
            return new List<DocumentChunk>();
        }
    }    public async Task DeleteDocumentAsync(string documentId, string userId)
    {
        try
        {
            // Find document in Cosmos DB
            var sessionDocument = await _chatHistoryService.FindDocumentAsync(userId, documentId);
            if (sessionDocument == null)
            {
                throw new ArgumentException($"Document not found or access denied: {documentId}");
            }            // Delete from Azure Blob Storage if available
            if (_blobServiceClient != null && !string.IsNullOrEmpty(sessionDocument.BlobUrl))
            {
                try
                {
                    // Extract container and blob path from URL
                    if (Uri.TryCreate(sessionDocument.BlobUrl, UriKind.Absolute, out var blobUri))
                    {
                        var segments = blobUri.AbsolutePath.TrimStart('/').Split('/', 2);
                        if (segments.Length >= 2)
                        {
                            var containerName = segments[0];
                            var blobPath = segments[1];
                            
                            // Use authenticated blob service client
                            var containerClient = _blobServiceClient.GetBlobContainerClient(containerName);
                            var blobClient = containerClient.GetBlobClient(blobPath);
                            
                            await blobClient.DeleteIfExistsAsync();
                            _logger.LogInformation("Deleted blob: {BlobUrl}", sessionDocument.BlobUrl);
                        }
                        else
                        {
                            _logger.LogWarning("Could not parse blob path for deletion from URL: {BlobUrl}", sessionDocument.BlobUrl);
                        }
                    }
                    else
                    {
                        _logger.LogWarning("Invalid blob URL format for deletion: {BlobUrl}", sessionDocument.BlobUrl);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to delete blob: {BlobUrl}", sessionDocument.BlobUrl);
                }
            }

            // Delete from Azure Search if available
            if (_searchClient != null)
            {
                try
                {
                    // Search for chunks by documentId filter
                    var searchOptions = new SearchOptions
                    {
                        Filter = $"documentId eq '{documentId}'",
                        Size = 1000
                    };

                    var searchResponse = await _searchClient.SearchAsync<SearchDocument>("*", searchOptions);
                    var documentsToDelete = new List<string>();

                    await foreach (var result in searchResponse.Value.GetResultsAsync())
                    {
                        if (result.Document.TryGetValue("chunkId", out var chunkIdValue))
                        {
                            documentsToDelete.Add(chunkIdValue.ToString() ?? "");
                        }
                    }

                    if (documentsToDelete.Any())
                    {
                        await _searchClient.DeleteDocumentsAsync("chunkId", documentsToDelete);
                        _logger.LogInformation("Deleted {Count} chunks from search index", documentsToDelete.Count);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to delete from search index");
                }
            }            // Remove document from Cosmos DB session
            await _chatHistoryService.RemoveDocumentFromSessionAsync(userId, documentId);

            _logger.LogInformation("Document deleted successfully: {DocumentId}", documentId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting document {DocumentId}", documentId);
            throw;
        }
    }public async Task<List<DocumentMetadata>> GetUserDocumentsAsync(string userId, string? sessionId = null)
    {
        try
        {
            var documents = new List<DocumentMetadata>();
            
            if (!string.IsNullOrEmpty(sessionId))
            {
                // Get documents for specific session from Cosmos DB
                var sessionDocuments = await _chatHistoryService.GetSessionDocumentsAsync(userId, sessionId);
                
                documents = sessionDocuments.Select(doc => new DocumentMetadata
                {
                    DocumentId = doc.DocumentId,
                    FileName = doc.FileName,
                    UserId = userId,
                    SessionId = sessionId,
                    UploadDate = doc.UploadDate,
                    FileSize = doc.FileSize,
                    Status = (DocumentStatus)doc.Status,
                    BlobUrl = doc.BlobUrl
                }).ToList();
                
                _logger.LogInformation("Retrieved {Count} documents from Cosmos DB for session {SessionId}", documents.Count, sessionId);
            }
            else
            {
                // For all user documents, we need to query all sessions
                // This is more complex and might require additional methods in IChatHistoryService
                // For now, let's return empty list for all-user queries
                _logger.LogWarning("Getting all user documents not yet implemented with Cosmos DB");
                documents = new List<DocumentMetadata>();
            }

            return documents;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting user documents from Cosmos DB for user {UserId}", userId);
            return new List<DocumentMetadata>();
        }
    }    private async Task IndexChunksAsync(List<DocumentChunk> chunks)
    {
        try
        {
            if (_openAIClient == null || _searchClient == null) 
            {
                _logger.LogWarning("Azure OpenAI or Search client not available, skipping indexing");
                return;
            }

            if (chunks == null || chunks.Count == 0)
            {
                _logger.LogWarning("No chunks to index");
                return;
            }

            var indexDocuments = new List<object>();

            foreach (var chunk in chunks)
            {
                // Skip empty chunks
                if (string.IsNullOrWhiteSpace(chunk.Content))
                {
                    _logger.LogWarning("Skipping empty chunk: {ChunkId}", chunk.ChunkId);
                    continue;
                }

                try
                {
                    // Generate embedding for the chunk
                    var embeddingClient = _openAIClient.GetEmbeddingClient("text-embedding-ada-002");
                    var embeddingResponse = await embeddingClient.GenerateEmbeddingAsync(chunk.Content);
                    var embedding = embeddingResponse.Value.ToFloats().ToArray();

                    var indexDocument = new
                    {
                        chunkId = chunk.ChunkId,
                        documentId = chunk.DocumentId,
                        userId = chunk.UserId,
                        sessionId = chunk.SessionId,
                        fileName = chunk.FileName,
                        content = chunk.Content,
                        chunkIndex = chunk.ChunkIndex,
                        uploadedAt = chunk.UploadedAt,
                        contentVector = embedding
                    };

                    indexDocuments.Add(indexDocument);
                }
                catch (Exception chunkEx)
                {
                    _logger.LogWarning(chunkEx, "Failed to generate embedding for chunk {ChunkId}", chunk.ChunkId);
                }
            }

            if (indexDocuments.Count == 0)
            {
                _logger.LogWarning("No valid chunks to index after processing");
                return;
            }

            // Index documents in batches
            await _searchClient.IndexDocumentsAsync(IndexDocumentsBatch.Upload(indexDocuments));
            _logger.LogInformation("Indexed {Count} chunks in Azure Search", indexDocuments.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error indexing chunks in Azure Search");
            throw;
        }
    }    private List<DocumentChunk> ChunkText(string text, string documentId, DocumentMetadata metadata)
    {
        var chunks = new List<DocumentChunk>();
        var maxChunkSize = 1000;
        var overlapSize = 200;

        _logger.LogInformation("ChunkText - Input text length: {Length} for document {DocumentId}", 
            text?.Length ?? 0, documentId);

        if (string.IsNullOrWhiteSpace(text))
        {
            _logger.LogWarning("ChunkText - Input text is null or empty for document {DocumentId}", documentId);
            return chunks;
        }

        var paragraphs = text.Split(new[] { "\n\n", "\r\n\r\n" }, StringSplitOptions.RemoveEmptyEntries);
        var currentChunk = new StringBuilder();
        var chunkIndex = 0;

        _logger.LogInformation("ChunkText - Split into {ParagraphCount} paragraphs", paragraphs.Length);

        foreach (var paragraph in paragraphs)
        {
            var trimmedParagraph = paragraph.Trim();
            if (string.IsNullOrEmpty(trimmedParagraph)) continue;

            // If adding this paragraph would exceed chunk size, finalize current chunk
            if (currentChunk.Length > 0 && currentChunk.Length + trimmedParagraph.Length > maxChunkSize)
            {
                var chunkContent = currentChunk.ToString().Trim();
                if (!string.IsNullOrEmpty(chunkContent))
                {
                    chunks.Add(new DocumentChunk
                    {
                        ChunkId = $"{documentId}_chunk_{chunkIndex}",
                        DocumentId = documentId,
                        UserId = metadata.UserId,
                        SessionId = metadata.SessionId,
                        FileName = metadata.FileName,
                        Content = chunkContent,
                        ChunkIndex = chunkIndex,
                        UploadedAt = metadata.UploadDate
                    });
                    chunkIndex++;
                }

                // Start new chunk with overlap
                currentChunk.Clear();
                if (chunkContent.Length > overlapSize)
                {
                    var lastWords = chunkContent.Split(' ').TakeLast(overlapSize / 10).ToArray();
                    currentChunk.AppendLine(string.Join(" ", lastWords));
                }
            }
            
            currentChunk.AppendLine(trimmedParagraph);
        }
        
        // Add the last chunk
        if (currentChunk.Length > 0)
        {
            var chunkContent = currentChunk.ToString().Trim();
            if (!string.IsNullOrEmpty(chunkContent))
            {
                chunks.Add(new DocumentChunk
                {
                    ChunkId = $"{documentId}_chunk_{chunkIndex}",
                    DocumentId = documentId,
                    UserId = metadata.UserId,
                    SessionId = metadata.SessionId,
                    FileName = metadata.FileName,
                    Content = chunkContent,
                    ChunkIndex = chunkIndex,
                    UploadedAt = metadata.UploadDate
                });
            }        }
        
        _logger.LogInformation("ChunkText - Generated {ChunkCount} chunks for document {DocumentId}", 
            chunks.Count, documentId);
        
        return chunks;
    }

    private double CalculateRelevanceScore(string content, List<string> queryWords)
    {
        if (string.IsNullOrEmpty(content) || !queryWords.Any())
            return 0;

        var contentLower = content.ToLowerInvariant();
        var score = 0.0;

        foreach (var word in queryWords)
        {
            var wordCount = CountOccurrences(contentLower, word);
            score += wordCount * (1.0 + Math.Log(word.Length)); // Longer words get higher weight
        }

        // Normalize by content length
        return score / Math.Max(1, content.Length / 100.0);
    }

    private int CountOccurrences(string text, string word)
    {
        var count = 0;
        var index = 0;
        
        while ((index = text.IndexOf(word, index, StringComparison.Ordinal)) != -1)
        {
            count++;
            index += word.Length;
        }
          return count;
    }

    private string GetJsonElementValue(System.Text.Json.JsonElement element, string propertyName)
    {
        if (element.TryGetProperty(propertyName, out var property))
        {
            return property.ValueKind == System.Text.Json.JsonValueKind.String 
                ? property.GetString() ?? ""
                : property.ToString();
        }        return "";
    }    public async Task<(Stream content, string fileName, string contentType)> DownloadDocumentAsync(string documentId, string userId)
    {
        try
        {
            // Find document across all sessions
            var documentContext = await _chatHistoryService.FindDocumentWithContextAsync(documentId);
            if (documentContext == null)
            {
                throw new ArgumentException($"Document not found: {documentId}");
            }            var sessionDocument = documentContext.Value.document;
            var documentUserId = documentContext.Value.userId;
            
            // Verify document and user access
            if (sessionDocument == null)
            {
                throw new ArgumentException($"Document not found: {documentId}");
            }
            
            if (documentUserId != userId)
            {
                _logger.LogWarning("Access denied for document {DocumentId}. Document belongs to user {DocumentUserId}, requested by {RequestUserId}", 
                    documentId, documentUserId, userId);
                throw new ArgumentException($"Document not found or access denied: {documentId}");
            }            // Try to download from Azure Blob Storage
            if (_blobServiceClient != null && sessionDocument != null && !string.IsNullOrEmpty(sessionDocument.BlobUrl))
            {
                try
                {
                    _logger.LogInformation("Attempting to download document {DocumentId} from blob URL: {BlobUrl}", 
                        documentId, sessionDocument.BlobUrl);
                    
                    // Extract the blob path from the URL and use the authenticated blob service client
                    var blobName = ExtractBlobNameFromUrl(sessionDocument.BlobUrl);
                    var containerName = "documents"; // Use the configured container name
                    var containerClient = _blobServiceClient.GetBlobContainerClient(containerName);
                    var blobClient = containerClient.GetBlobClient(blobName);
                    
                    _logger.LogInformation("Downloading from container: {Container}, blob: {BlobName}", 
                        containerName, blobName);
                    
                    // Check if blob exists first
                    var existsResponse = await blobClient.ExistsAsync();
                    if (!existsResponse.Value)
                    {
                        _logger.LogError("Blob does not exist: {Container}/{BlobName}", containerName, blobName);
                        throw new FileNotFoundException($"Blob not found: {containerName}/{blobName}");
                    }
                    
                    var response = await blobClient.DownloadStreamingAsync();
                    
                    // Determine content type based on file extension
                    var contentType = GetContentType(sessionDocument.FileName);
                    
                    _logger.LogInformation("Successfully downloaded document from blob storage: {DocumentId}", documentId);
                    return (response.Value.Content, sessionDocument.FileName, contentType);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to download from blob storage: {BlobUrl}", sessionDocument.BlobUrl);
                    throw new FileNotFoundException($"Document content not found in blob storage: {documentId}");
                }
            }

            throw new FileNotFoundException($"Document content not found: {documentId}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error downloading document: {DocumentId}", documentId);
            throw;
        }
    }    private string ExtractBlobNameFromUrl(string blobUrl)
    {
        try
        {
            // Extract the blob path from a URL like:
            // https://account.blob.core.usgovcloudapi.net/container/userId/sessionId/documentId/filename
            var uri = new Uri(blobUrl);
            var pathParts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            
            _logger.LogInformation("Extracting blob name from URL: {BlobUrl}", blobUrl);
            _logger.LogInformation("URL path parts: {PathParts}", string.Join(", ", pathParts));
              // Skip the container name (first part) and return the rest as the blob name
            if (pathParts.Length > 1)
            {
                var blobName = string.Join("/", pathParts.Skip(1));
                
                // URL decode the blob name to handle spaces and special characters
                blobName = Uri.UnescapeDataString(blobName);
                
                _logger.LogInformation("Extracted blob name: {BlobName}", blobName);
                return blobName;
            }
            
            throw new ArgumentException($"Invalid blob URL format - insufficient path parts: {blobUrl}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error extracting blob name from URL: {BlobUrl}", blobUrl);
            throw new ArgumentException($"Invalid blob URL format: {blobUrl}", ex);
        }
    }

    private string GetContentType(string fileName)
    {
        var extension = Path.GetExtension(fileName).ToLowerInvariant();
        return extension switch
        {
            ".pdf" => "application/pdf",
            ".txt" => "text/plain",
            ".doc" => "application/msword",
            ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xls" => "application/vnd.ms-excel",
            ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".ppt" => "application/vnd.ms-powerpoint",
            ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",            ".gif" => "image/gif",
            ".csv" => "text/csv",
            ".json" => "application/json",
            ".xml" => "application/xml",
            _ => "application/octet-stream"
        };
    }    public async Task<string> GetDocumentContentAsync(string documentId, string userId)
    {
        try
        {
            _logger.LogInformation("Getting document content for DocumentId: {DocumentId}, UserId: {UserId}", documentId, userId);

            // Get all chunks for this document from Azure Search
            if (_searchClient != null)
            {                var searchOptions = new SearchOptions
                {
                    Filter = $"documentId eq '{documentId}' and userId eq '{userId}'",
                    Size = 1000 // Get all chunks (will sort manually after retrieval)
                };

                var searchResponse = await _searchClient.SearchAsync<dynamic>("*", searchOptions);
                var chunks = new List<(int chunkIndex, string content)>();

                await foreach (var result in searchResponse.Value.GetResultsAsync())
                {
                    var document = (System.Text.Json.JsonElement)result.Document;
                    var content = GetJsonElementValue(document, "content");
                    var chunkIndex = int.TryParse(GetJsonElementValue(document, "chunkIndex"), out int idx) ? idx : 0;
                    
                    if (!string.IsNullOrEmpty(content))
                    {
                        chunks.Add((chunkIndex, content));
                    }
                }

                if (!chunks.Any())
                {
                    _logger.LogWarning("No chunks found for DocumentId: {DocumentId}, UserId: {UserId}", documentId, userId);
                    return string.Empty;
                }

                // Sort by chunk index and concatenate content
                var sortedChunks = chunks.OrderBy(c => c.chunkIndex).ToList();
                var fullContent = string.Join("\n", sortedChunks.Select(c => c.content));
                
                _logger.LogInformation("Retrieved document content: {ContentLength} characters from {ChunkCount} chunks", 
                    fullContent.Length, sortedChunks.Count);
                    
                return fullContent;
            }
            else
            {
                _logger.LogError("Search client is not configured for GetDocumentContentAsync");
                throw new InvalidOperationException("Azure AI Search is not configured");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting document content for DocumentId: {DocumentId}, UserId: {UserId}", documentId, userId);
            throw;
        }
    }
}
