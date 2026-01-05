using Microsoft.Azure.Cosmos;
using MCPServer.Models;
using System.Net;

namespace MCPServer.Services.Azure;

public interface IChatHistoryService
{
    Task<string> SaveMessageAsync(ChatMessage message);
    Task<ChatHistoryResponse> GetChatHistoryAsync(ChatHistoryRequest request);
    Task<string> CreateSessionAsync(string userId, string title);
    Task<SessionListResponse> GetUserSessionsAsync(SessionListRequest request);
    Task UpdateSessionAsync(ChatSession session);
    Task UpdateSessionTitleAsync(string userId, string sessionId, string title);
    Task DeleteSessionAsync(string userId, string sessionId);
    Task AddDocumentToSessionAsync(string userId, string sessionId, SessionDocument document);
    Task<List<SessionDocument>> GetSessionDocumentsAsync(string userId, string sessionId);
    Task<SessionDocument?> FindDocumentAsync(string userId, string documentId);
    Task<(SessionDocument? document, string userId, string sessionId)?> FindDocumentWithContextAsync(string documentId);
    Task UpdateDocumentStatusAsync(string userId, string documentId, int status);
    Task RemoveDocumentFromSessionAsync(string userId, string documentId);
}

public class CosmosChatHistoryService : IChatHistoryService
{
    private readonly CosmosClient? _cosmosClient;
    private readonly Container? _messagesContainer;
    private readonly Container? _sessionsContainer;
    private readonly ILogger<CosmosChatHistoryService> _logger;
    private readonly IConfiguration _configuration;

    public CosmosChatHistoryService(
        ILogger<CosmosChatHistoryService> logger,
        IConfiguration configuration)
    {
        _logger = logger;
        _configuration = configuration;        var connectionString = _configuration.GetConnectionString("CosmosDB");
        var databaseName = _configuration["CosmosDB:DatabaseName"] ?? "ChatDatabase";
        var messagesContainer = _configuration["CosmosDB:MessagesContainer"] ?? "Messages";
        var sessionsContainer = _configuration["CosmosDB:SessionsContainer"] ?? "Sessions";
        
        if (!string.IsNullOrEmpty(connectionString) && !connectionString.Contains("["))
        {
            _cosmosClient = new CosmosClient(connectionString);
            
            // Initialize containers
            var database = _cosmosClient.GetDatabase(databaseName);
            _messagesContainer = database.GetContainer(messagesContainer);
            _sessionsContainer = database.GetContainer(sessionsContainer);
            
            _logger.LogInformation("Cosmos DB Chat History Service initialized");
        }
        else
        {
            _logger.LogWarning("Cosmos DB not configured, chat history will not be persisted");
        }
    }

    public async Task<string> SaveMessageAsync(ChatMessage message)
    {
        try
        {
            if (_messagesContainer == null)
            {
                _logger.LogWarning("Cosmos DB not available, message not saved");
                return message.Id;
            }            // Ensure required fields are set
            if (string.IsNullOrEmpty(message.Id))
            {
                message.Id = Guid.NewGuid().ToString();
            }
            
            // Ensure partition key is set
            message.UserId = message.PartitionKey;
            
            var response = await _messagesContainer.CreateItemAsync(
                message, 
                new PartitionKey(message.PartitionKey));

            _logger.LogInformation("Message saved: {MessageId} for session {SessionId}", 
                message.Id, message.SessionId);

            // Update session last message time and count
            await UpdateSessionLastMessageAsync(message.UserId, message.SessionId, message.Timestamp);

            return response.Resource.Id;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error saving message {MessageId}", message.Id);
            throw;
        }
    }

    public async Task<ChatHistoryResponse> GetChatHistoryAsync(ChatHistoryRequest request)
    {
        try
        {
            if (_messagesContainer == null)
            {
                return new ChatHistoryResponse();
            }

            var queryDefinition = new QueryDefinition(
                "SELECT * FROM c WHERE c.userId = @userId AND c.sessionId = @sessionId ORDER BY c.timestamp DESC")
                .WithParameter("@userId", request.UserId)
                .WithParameter("@sessionId", request.SessionId);

            var queryRequestOptions = new QueryRequestOptions
            {
                PartitionKey = new PartitionKey(request.UserId),
                MaxItemCount = request.PageSize
            };

            var iterator = _messagesContainer.GetItemQueryIterator<ChatMessage>(
                queryDefinition, 
                request.ContinuationToken, 
                queryRequestOptions);

            var messages = new List<ChatMessage>();
            string? continuationToken = null;

            if (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                messages.AddRange(response.Resource);
                continuationToken = response.ContinuationToken;
            }

            // Reverse to get chronological order (oldest first) for chat display
            messages.Reverse();

            _logger.LogInformation("Retrieved {MessageCount} messages for session {SessionId}", 
                messages.Count, request.SessionId);

            return new ChatHistoryResponse
            {
                Messages = messages,
                ContinuationToken = continuationToken,
                HasMore = !string.IsNullOrEmpty(continuationToken),
                TotalCount = messages.Count // Note: This is page count, not total count
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving chat history for session {SessionId}", request.SessionId);
            return new ChatHistoryResponse();
        }
    }

    public async Task<string> CreateSessionAsync(string userId, string title)
    {
        try
        {
            if (_sessionsContainer == null)
            {
                _logger.LogWarning("Cosmos DB not available, session not created");
                return Guid.NewGuid().ToString();
            }            var sessionId = Guid.NewGuid().ToString();
            var session = new ChatSession
            {
                Id = sessionId,
                UserId = userId,
                Title = string.IsNullOrEmpty(title) ? $"Chat {DateTime.Now:yyyy-MM-dd HH:mm}" : title
            };

            // Debug logging to see what we're sending to Cosmos
            _logger.LogInformation("Creating session with Id: '{SessionId}', UserId: '{UserId}', Title: '{Title}', PartitionKey: '{PartitionKey}'", 
                session.Id, session.UserId, session.Title, session.PartitionKey);

            var response = await _sessionsContainer.CreateItemAsync(
                session, 
                new PartitionKey(session.PartitionKey));

            _logger.LogInformation("Session created: {SessionId} for user {UserId}", 
                session.Id, userId);

            return response.Resource.Id;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating session for user {UserId}", userId);
            throw;
        }
    }

    public async Task<SessionListResponse> GetUserSessionsAsync(SessionListRequest request)
    {
        try
        {
            if (_sessionsContainer == null)
            {
                return new SessionListResponse();
            }

            var whereClause = request.IncludeArchived 
                ? "c.userId = @userId" 
                : "c.userId = @userId AND c.isArchived = false";

            var queryDefinition = new QueryDefinition(
                $"SELECT * FROM c WHERE {whereClause} ORDER BY c.lastMessageAt DESC")
                .WithParameter("@userId", request.UserId);

            var queryRequestOptions = new QueryRequestOptions
            {
                PartitionKey = new PartitionKey(request.UserId),
                MaxItemCount = request.PageSize
            };

            var iterator = _sessionsContainer.GetItemQueryIterator<ChatSession>(
                queryDefinition, 
                request.ContinuationToken, 
                queryRequestOptions);

            var sessions = new List<ChatSession>();
            string? continuationToken = null;

            if (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                sessions.AddRange(response.Resource);
                continuationToken = response.ContinuationToken;
            }

            _logger.LogInformation("Retrieved {SessionCount} sessions for user {UserId}", 
                sessions.Count, request.UserId);

            return new SessionListResponse
            {
                Sessions = sessions,
                ContinuationToken = continuationToken,
                HasMore = !string.IsNullOrEmpty(continuationToken)
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving sessions for user {UserId}", request.UserId);
            return new SessionListResponse();
        }
    }    public async Task UpdateSessionAsync(ChatSession session)
    {
        // Deprecated method - use targeted update methods instead
        await UpdateSessionTitleAsync(session.UserId, session.Id, session.Title);
    }

    public async Task UpdateSessionTitleAsync(string userId, string sessionId, string title)
    {
        try
        {
            if (_sessionsContainer == null)
            {
                _logger.LogWarning("Cosmos DB not available, session title not updated");
                return;
            }

            var patchOperations = new List<PatchOperation>
            {
                PatchOperation.Set("/title", title)
            };

            await _sessionsContainer.PatchItemAsync<ChatSession>(
                sessionId,
                new PartitionKey(userId),
                patchOperations);

            _logger.LogInformation("Session title updated via patch: {SessionId} -> {Title}", sessionId, title);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            _logger.LogWarning("Session not found for title update: {SessionId}", sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating session title {SessionId}", sessionId);
            throw;
        }
    }

    public async Task DeleteSessionAsync(string userId, string sessionId)
    {
        try
        {
            if (_messagesContainer == null || _sessionsContainer == null)
            {
                _logger.LogWarning("Cosmos DB not available, session not deleted");
                return;
            }

            // Delete all messages in the session
            var deleteMessagesQuery = new QueryDefinition(
                "SELECT c.id FROM c WHERE c.userId = @userId AND c.sessionId = @sessionId")
                .WithParameter("@userId", userId)
                .WithParameter("@sessionId", sessionId);

            var iterator = _messagesContainer.GetItemQueryIterator<dynamic>(
                deleteMessagesQuery, 
                requestOptions: new QueryRequestOptions 
                { 
                    PartitionKey = new PartitionKey(userId) 
                });

            while (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                foreach (var item in response.Resource)
                {
                    await _messagesContainer.DeleteItemAsync<ChatMessage>(
                        item.id.ToString(), 
                        new PartitionKey(userId));
                }
            }

            // Delete the session
            await _sessionsContainer.DeleteItemAsync<ChatSession>(
                sessionId, 
                new PartitionKey(userId));

            _logger.LogInformation("Session deleted: {SessionId}", sessionId);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            _logger.LogWarning("Session not found for deletion: {SessionId}", sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting session {SessionId}", sessionId);
            throw;
        }
    }    private async Task UpdateSessionLastMessageAsync(string userId, string sessionId, DateTime timestamp)
    {
        try
        {
            if (_sessionsContainer == null) return;

            // Use patch operations to update only specific fields without overwriting the entire document
            var patchOperations = new List<PatchOperation>
            {
                PatchOperation.Set("/lastMessageAt", timestamp),
                PatchOperation.Increment("/messageCount", 1)
            };

            await _sessionsContainer.PatchItemAsync<ChatSession>(
                sessionId,
                new PartitionKey(userId),
                patchOperations);

            _logger.LogInformation("Session last message updated via patch: {SessionId}", sessionId);
        }        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            // Session doesn't exist, create it
            if (_sessionsContainer != null)
            {
                var newSession = new ChatSession
                {
                    Id = sessionId,
                    UserId = userId,
                    Title = $"Chat {timestamp:yyyy-MM-dd HH:mm}",
                    CreatedAt = timestamp,
                    LastMessageAt = timestamp,
                    MessageCount = 1,
                    Documents = new List<SessionDocument>() // Initialize empty documents list
                };

                await _sessionsContainer.CreateItemAsync(newSession, new PartitionKey(userId));
                _logger.LogInformation("New session created with empty documents list: {SessionId}", sessionId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating session last message time: {SessionId}", sessionId);
        }
    }

    public async Task AddDocumentToSessionAsync(string userId, string sessionId, SessionDocument document)
    {
        if (_sessionsContainer == null)
        {
            _logger.LogWarning("Cosmos DB not available, cannot add document to session");
            return;
        }

        try
        {
            // Get the existing session
            var response = await _sessionsContainer.ReadItemAsync<ChatSession>(sessionId, new PartitionKey(userId));
            var session = response.Resource;
            
            // Add the document to the session's documents list
            session.Documents.Add(document);
            
            // Update the session
            await _sessionsContainer.ReplaceItemAsync(session, sessionId, new PartitionKey(userId));
            
            _logger.LogInformation("Added document {DocumentId} to session {SessionId}", document.DocumentId, sessionId);
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            _logger.LogWarning("Session {SessionId} not found for user {UserId}", sessionId, userId);
            throw new ArgumentException($"Session not found: {sessionId}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error adding document to session: {SessionId}", sessionId);
            throw;
        }
    }

    public async Task<List<SessionDocument>> GetSessionDocumentsAsync(string userId, string sessionId)
    {
        if (_sessionsContainer == null)
        {
            _logger.LogWarning("Cosmos DB not available, cannot get session documents");
            return new List<SessionDocument>();
        }

        try
        {
            var response = await _sessionsContainer.ReadItemAsync<ChatSession>(sessionId, new PartitionKey(userId));
            return response.Resource.Documents;
        }
        catch (CosmosException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            _logger.LogWarning("Session {SessionId} not found for user {UserId}", sessionId, userId);
            return new List<SessionDocument>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting session documents: {SessionId}", sessionId);            return new List<SessionDocument>();
        }
    }

    public async Task<SessionDocument?> FindDocumentAsync(string userId, string documentId)
    {
        if (_sessionsContainer == null)
        {
            _logger.LogWarning("Cosmos DB not available, cannot find document");
            return null;
        }

        try
        {
            // Query all sessions for the user to find the document
            var query = new QueryDefinition("SELECT * FROM c WHERE c.userId = @userId AND c._partitionKey = @userId")
                .WithParameter("@userId", userId);

            var iterator = _sessionsContainer.GetItemQueryIterator<ChatSession>(query);
            
            while (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                foreach (var session in response)
                {
                    var document = session.Documents.FirstOrDefault(d => d.DocumentId == documentId);
                    if (document != null)
                    {
                        _logger.LogInformation("Found document {DocumentId} in session {SessionId}", documentId, session.Id);
                        return document;
                    }
                }
            }

            _logger.LogWarning("Document {DocumentId} not found for user {UserId}", documentId, userId);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error finding document {DocumentId} for user {UserId}", documentId, userId);
            return null;
        }
    }

    public async Task<(SessionDocument? document, string userId, string sessionId)?> FindDocumentWithContextAsync(string documentId)
    {
        if (_sessionsContainer == null)
        {
            _logger.LogWarning("Cosmos DB not available, cannot find document");
            return null;
        }        try
        {
            _logger.LogInformation("Searching for document {DocumentId} across all sessions", documentId);
            
            // Query all sessions to find the document (cross-partition query)
            var query = new QueryDefinition("SELECT * FROM c");
            var queryRequestOptions = new QueryRequestOptions
            {
                MaxItemCount = -1 // Allow unlimited items per page
            };
            var iterator = _sessionsContainer.GetItemQueryIterator<ChatSession>(query, requestOptions: queryRequestOptions);
            
            int sessionCount = 0;
            int totalDocuments = 0;
              while (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                foreach (var session in response)
                {
                    sessionCount++;
                    totalDocuments += session.Documents.Count;
                    
                    _logger.LogDebug("Checking session {SessionId} for user {UserId} with {DocumentCount} documents", 
                        session.Id, session.UserId, session.Documents.Count);
                        
                    var document = session.Documents.FirstOrDefault(d => d.DocumentId == documentId);
                    if (document != null)
                    {
                        _logger.LogInformation("Found document {DocumentId} in session {SessionId} for user {UserId}", 
                            documentId, session.Id, session.UserId);
                        return (document, session.UserId, session.Id);
                    }
                }
            }

            _logger.LogWarning("Document {DocumentId} not found in any session. Searched {SessionCount} sessions with {TotalDocuments} total documents", 
                documentId, sessionCount, totalDocuments);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error finding document {DocumentId}", documentId);
            return null;
        }
    }    public async Task UpdateDocumentStatusAsync(string userId, string documentId, int status)
    {
        if (_sessionsContainer == null)
        {
            _logger.LogWarning("Cosmos DB not available, cannot update document status");
            return;
        }

        try
        {
            // Query all sessions for the user to find the document
            var query = new QueryDefinition("SELECT * FROM c WHERE c.userId = @userId AND c._partitionKey = @userId")
                .WithParameter("@userId", userId);

            var iterator = _sessionsContainer.GetItemQueryIterator<ChatSession>(query);
            
            while (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                foreach (var session in response)
                {
                    var documentIndex = session.Documents.FindIndex(d => d.DocumentId == documentId);
                    if (documentIndex >= 0)
                    {
                        // Use patch operation to update only the specific document status
                        var patchOperations = new List<PatchOperation>
                        {
                            PatchOperation.Set($"/documents/{documentIndex}/status", status)
                        };

                        await _sessionsContainer.PatchItemAsync<ChatSession>(
                            session.Id,
                            new PartitionKey(userId),
                            patchOperations);

                        _logger.LogInformation("Updated document {DocumentId} status to {Status} in session {SessionId} via patch", 
                            documentId, status, session.Id);
                        return;
                    }
                }
            }            _logger.LogWarning("Document {DocumentId} not found for status update for user {UserId}", documentId, userId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating document {DocumentId} status for user {UserId}", documentId, userId);
            throw;
        }
    }

    public async Task RemoveDocumentFromSessionAsync(string userId, string documentId)
    {
        if (_sessionsContainer == null)
        {
            _logger.LogWarning("Cosmos DB not available, cannot remove document");
            return;
        }

        try
        {
            // Query all sessions for the user to find the document
            var query = new QueryDefinition("SELECT * FROM c WHERE c.userId = @userId AND c._partitionKey = @userId")
                .WithParameter("@userId", userId);

            var iterator = _sessionsContainer.GetItemQueryIterator<ChatSession>(query);
            
            while (iterator.HasMoreResults)
            {
                var response = await iterator.ReadNextAsync();
                foreach (var session in response)
                {
                    var documentIndex = session.Documents.FindIndex(d => d.DocumentId == documentId);
                    if (documentIndex >= 0)
                    {
                        session.Documents.RemoveAt(documentIndex);
                        await UpdateSessionAsync(session);
                        _logger.LogInformation("Removed document {DocumentId} from session {SessionId}", 
                            documentId, session.Id);
                        return;
                    }
                }
            }

            _logger.LogWarning("Document {DocumentId} not found for removal for user {UserId}", documentId, userId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error removing document {DocumentId} for user {UserId}", documentId, userId);
            throw;
        }
    }
}
