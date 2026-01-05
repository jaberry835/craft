namespace MCPServer.Models;

public class DocumentMetadata
{
    public string DocumentId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public DateTime UploadDate { get; set; }
    public long FileSize { get; set; }
    public DocumentStatus Status { get; set; }
    public string BlobUrl { get; set; } = string.Empty;
}

public class DocumentChunk
{
    public string ChunkId { get; set; } = string.Empty;
    public string DocumentId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public int ChunkIndex { get; set; }
    public DateTime UploadedAt { get; set; }
    public float Score { get; set; }
    public float[]? Embedding { get; set; }
}

public class DocumentProcessingResult
{
    public string DocumentId { get; set; } = string.Empty;
    public bool Success { get; set; }
    public int ChunksCreated { get; set; }
    public int ChunkCount { get; set; }
    public string ExtractedText { get; set; } = string.Empty;
    public TimeSpan ProcessingTime { get; set; }
    public string? ErrorMessage { get; set; }
}

public enum DocumentStatus
{
    Uploaded,
    Processing,
    Processed,
    Indexing,    // Azure AI Search is indexing
    Indexed,     // Available for vector search
    Failed
}

public class UploadedDocument
{
    public string Id { get; set; } = string.Empty;
    public string Filename { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public DateTime UploadDate { get; set; }
    public DocumentStatus Status { get; set; }
}
