using Microsoft.AspNetCore.Mvc;
using MCPServer.Services.Azure;
using System.ComponentModel.DataAnnotations;

namespace MCPServer.Controllers;

[ApiController]
[Route("api/[controller]")]
public class DocumentController : ControllerBase
{
    private readonly ILogger<DocumentController> _logger;
    private readonly IAzureDocumentService _documentService;

    public DocumentController(
        ILogger<DocumentController> logger,
        IAzureDocumentService documentService)
    {
        _logger = logger;
        _documentService = documentService;
    }    /// <summary>
    /// Upload a document for processing and RAG
    /// </summary>
    [HttpPost("upload")]
    public async Task<IActionResult> UploadDocument(
        [FromForm] IFormFile file,
        [FromForm] string userId,
        [FromForm] string sessionId)
    {
        try
        {
            _logger.LogInformation("Upload request received - File: {FileName}, UserId: {UserId}, SessionId: {SessionId}", 
                file?.FileName ?? "null", userId ?? "null", sessionId ?? "null");

            if (file == null || file.Length == 0)
            {
                _logger.LogWarning("No file provided in upload request");
                return BadRequest("No file provided");
            }

            if (string.IsNullOrEmpty(userId))
            {
                _logger.LogWarning("UserId is missing from upload request");
                return BadRequest("UserId is required");
            }

            if (string.IsNullOrEmpty(sessionId))
            {
                _logger.LogWarning("SessionId is missing from upload request");
                return BadRequest("SessionId is required");
            }

            // Validate file type
            var allowedTypes = new[] { ".pdf", ".doc", ".docx", ".txt", ".md" };
            var fileExtension = Path.GetExtension(file.FileName).ToLowerInvariant();
            
            if (!allowedTypes.Contains(fileExtension))
            {
                return BadRequest($"File type {fileExtension} not supported. Allowed types: {string.Join(", ", allowedTypes)}");
            }

            // Validate file size (max 10MB)
            const long maxFileSize = 10 * 1024 * 1024;
            if (file.Length > maxFileSize)
            {
                return BadRequest("File size exceeds 10MB limit");
            }

            using var stream = file.OpenReadStream();
            var documentId = await _documentService.UploadDocumentAsync(
                stream, file.FileName, userId, sessionId);            // Start async processing with a small delay to allow for Cosmos DB consistency
            _ = Task.Run(async () =>
            {
                try
                {
                    // Add a small delay to allow for Cosmos DB eventual consistency
                    await Task.Delay(2000);
                    await _documentService.ProcessDocumentAsync(documentId);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error processing document: {DocumentId}", documentId);
                }
            });

            return Ok(new { documentId, fileName = file.FileName, status = "uploaded" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error uploading document");
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Get documents for a user/session
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetDocuments(
        [Required] string userId,
        string? sessionId = null)
    {
        try
        {
            var documents = await _documentService.GetUserDocumentsAsync(userId, sessionId);
            return Ok(documents);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving documents for user: {UserId}", userId);
            return StatusCode(500, "Internal server error");
        }
    }    /// <summary>
    /// Search documents using RAG
    /// </summary>
    [HttpPost("search")]
    public async Task<IActionResult> SearchDocuments([FromBody] DocumentSearchRequest request)
    {        try
        {
            _logger.LogInformation("Document search request - Query: {Query}, UserId: {UserId}, SessionId: {SessionId}", 
                request?.Query ?? "null", request?.UserId ?? "null", request?.SessionId ?? "null");

            if (request == null || string.IsNullOrWhiteSpace(request.Query))
            {
                _logger.LogWarning("Search query is empty");
                return BadRequest("Query is required");
            }

            if (string.IsNullOrWhiteSpace(request.UserId))
            {
                _logger.LogWarning("UserId is missing from search request");
                return BadRequest("UserId is required");
            }

            var results = await _documentService.SearchDocumentsAsync(
                request.Query, 
                request.UserId, 
                request.SessionId, 
                request.MaxResults);

            _logger.LogInformation("Search completed - Found {ResultCount} results", results.Count);

            return Ok(new
            {
                query = request.Query,
                results = results.Select(chunk => new
                {
                    chunkId = chunk.ChunkId,
                    documentId = chunk.DocumentId,
                    content = chunk.Content,
                    score = chunk.Score,
                    chunkIndex = chunk.ChunkIndex
                })
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error searching documents");
            return StatusCode(500, "Internal server error");
        }
    }    /// <summary>
    /// Download a document
    /// </summary>
    [HttpGet("{documentId}/download")]
    public async Task<IActionResult> DownloadDocument(
        [Required] string documentId,
        [Required] string userId)
    {
        try
        {
            var (content, fileName, contentType) = await _documentService.DownloadDocumentAsync(documentId, userId);
            
            return File(content, contentType, fileName);
        }        catch (ArgumentException)
        {
            _logger.LogWarning("Access denied or document not found: {DocumentId}, UserId: {UserId}", documentId, userId);
            return NotFound("Document not found or access denied");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error downloading document: {DocumentId}", documentId);
            return StatusCode(500, "Internal server error");
        }
    }

    /// <summary>
    /// Delete a document
    /// </summary>
    [HttpDelete("{documentId}")]
    public async Task<IActionResult> DeleteDocument(
        [Required] string documentId,
        [Required] string userId)
    {
        try
        {
            await _documentService.DeleteDocumentAsync(documentId, userId);
            return Ok(new { message = "Document deleted successfully" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting document: {DocumentId}", documentId);
            return StatusCode(500, "Internal server error");
        }
    }    /// <summary>
    /// Process a document (manual trigger for testing)
    /// </summary>
    [HttpPost("{documentId}/process")]
    public async Task<IActionResult> ProcessDocument([Required] string documentId)
    {
        try
        {
            var result = await _documentService.ProcessDocumentAsync(documentId);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing document: {DocumentId}", documentId);
            return StatusCode(500, "Internal server error");
        }
    }
}

public class DocumentSearchRequest
{
    [Required]
    public string Query { get; set; } = string.Empty;
    
    [Required]
    public string UserId { get; set; } = string.Empty;
    
    public string? SessionId { get; set; }
    
    public int MaxResults { get; set; } = 5;
}
