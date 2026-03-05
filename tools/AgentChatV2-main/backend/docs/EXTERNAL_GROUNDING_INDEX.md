# External Grounding Index (Bring Your Own Index)

This document explains how to create an Azure AI Search index externally (e.g., via the Azure Portal, ARM/Bicep templates, or the Azure CLI) and connect it to an AgentChatV2 agent as a grounding source.

## When to Use This

Use an external index when:

- **Large data volumes** — Indexing thousands of documents through the app's built-in indexer is slow and resource-intensive. Azure AI Search's native indexers handle millions of documents with incremental change detection.
- **Existing indexer pipelines** — You already have Azure AI Search indexers running against SQL, Cosmos DB, SharePoint, or Blob Storage with skillsets (OCR, AI enrichment, etc.).
- **Scheduled/automated refreshes** — Azure AI Search indexers can run on a schedule, whereas the app's built-in indexer is manual (reindex button).
- **Shared indices** — Multiple agents or applications need to query the same index.

## How It Works

```
┌────────────────────────┐      ┌──────────────────────────┐
│  Azure Portal / CLI    │      │  AgentChatV2             │
│                        │      │                          │
│  1. Create Index       │      │  3. Admin configures     │
│     (follow schema)    │      │     grounding source     │
│                        │      │     type = "external"    │
│  2. Populate via       │      │     index_name = "..."   │
│     Indexer / Push API │      │                          │
│                        │      │  4. Agent queries the    │
│                        │      │     index at runtime     │
└────────────────────────┘      └──────────────────────────┘
```

The app does **not** manage the index lifecycle for external sources — no create, reindex, or delete. It only reads.

---

## Required Index Schema

The index **must** follow the schema below exactly. The app's search logic depends on these field names, types, and attributes.

### Fields

| Field | Type | Key | Searchable | Filterable | Sortable | Required | Description |
|-------|------|-----|------------|------------|----------|----------|-------------|
| `id` | `Edm.String` | Yes | — | — | — | Yes | Unique document ID. Use any unique string (e.g., `{filename}_{chunkIndex}` or a GUID). |
| `agentId` | `Edm.String` | — | — | Yes | — | Yes | The agent's UUID. Every document in the index must have this set to the agent ID that should access it. This is how multi-agent isolation works within a shared search service. |
| `content` | `Edm.String` | — | Yes | — | — | Yes | The text content of the chunk. This is what gets returned to the LLM as grounding context. |
| `contentVector` | `Collection(Edm.Single)` | — | Yes (vector) | — | — | Yes | 1536-dimensional embedding vector. Must be generated with `text-embedding-ada-002`. |
| `fileName` | `Edm.String` | — | Yes | — | — | Yes | Source file or document name. Displayed in citations (e.g., `Contoso_Data.xlsx`, `HR-Policy.pdf`). |
| `sourceName` | `Edm.String` | — | — | Yes | — | Yes | Grounding source label. Must match the source name configured in the agent's grounding sources. |
| `sourceUrl` | `Edm.String` | — | — | Yes | — | No | Original URL of the source document (for reference only). |
| `ssToken` | `Edm.String` | — | — | Yes | — | Yes* | Security token for row-level access control. See [Security Tokens](#security-tokens) below. |
| `chunkIndex` | `Edm.Int32` | — | — | — | Yes | No | Zero-based chunk sequence number within a document. Helps order results from the same file. |
| `indexedAt` | `Edm.DateTimeOffset` | — | — | — | Yes | No | Timestamp when the chunk was indexed. |

> \* If your environment does not use security token filtering, set `ssToken` to an empty string `""` on every document and ensure the user has matching access. See the security section for details.

### Vector Search Configuration

The index must include a vector search configuration with an HNSW algorithm profile:

- **Algorithm**: HNSW (Hierarchical Navigable Small World)
- **Profile name**: `vector-profile` (must match exactly)
- **Dimensions**: 1536
- **Metric**: Cosine (HNSW default)
- **Field**: `contentVector` must reference `vector-profile`

---

## Portal Walkthrough: Creating the Index

### Step 1: Navigate to Your Search Service

1. Go to the [Azure Portal](https://portal.azure.us) (or `portal.azure.com` for commercial)
2. Open your Azure AI Search service (e.g., `agentsearch`)
3. Click **Indexes** → **Add index**

### Step 2: Define Fields

Add each field from the schema table above. For each field:

1. Click **Add field**
2. Enter the **Field name** exactly as shown (case-sensitive)
3. Select the **Type**
4. Check the appropriate attribute boxes (Key, Searchable, Filterable, Sortable)

For the `contentVector` field:
1. Set Type to `Collection(Edm.Single)`
2. Check **Searchable**
3. Set **Dimensions** to `1536`
4. Set **Vector Search Profile** to `vector-profile`

### Step 3: Configure Vector Search

1. In the index definition, go to the **Vector Search** section
2. Add an **Algorithm Configuration**:
   - Name: `hnsw-config`
   - Kind: `hnsw`
   - Leave defaults (m=4, efConstruction=400, efSearch=500, metric=cosine)
3. Add a **Profile**:
   - Name: `vector-profile`
   - Algorithm: `hnsw-config`

### Step 4: Save the Index

Click **Create**. The empty index is now ready to receive documents.

---

## Index JSON Definition

If you prefer to create the index via the REST API, Azure CLI, or ARM template, use this JSON definition. Replace `your-index-name` with your desired name.

```json
{
  "name": "your-index-name",
  "fields": [
    { "name": "id", "type": "Edm.String", "key": true },
    { "name": "agentId", "type": "Edm.String", "filterable": true },
    { "name": "sourceUrl", "type": "Edm.String", "filterable": true },
    { "name": "sourceName", "type": "Edm.String", "filterable": true },
    { "name": "ssToken", "type": "Edm.String", "filterable": true },
    { "name": "fileName", "type": "Edm.String", "searchable": true },
    { "name": "content", "type": "Edm.String", "searchable": true },
    { "name": "chunkIndex", "type": "Edm.Int32", "sortable": true },
    { "name": "indexedAt", "type": "Edm.DateTimeOffset", "sortable": true },
    {
      "name": "contentVector",
      "type": "Collection(Edm.Single)",
      "searchable": true,
      "dimensions": 1536,
      "vectorSearchProfile": "vector-profile"
    }
  ],
  "vectorSearch": {
    "algorithms": [
      {
        "name": "hnsw-config",
        "kind": "hnsw",
        "hnswParameters": {
          "m": 4,
          "efConstruction": 400,
          "efSearch": 500,
          "metric": "cosine"
        }
      }
    ],
    "profiles": [
      {
        "name": "vector-profile",
        "algorithmConfigurationName": "hnsw-config"
      }
    ]
  }
}
```

You can create the index using the Azure CLI:

```bash
az search index create \
  --service-name agentsearch \
  --resource-group your-rg \
  --name your-index-name \
  --fields @index-schema.json
```

Or via the REST API:

```bash
PUT https://agentsearch.search.azure.us/indexes/your-index-name?api-version=2024-05-01-preview
Content-Type: application/json
api-key: <your-admin-key>

{ ... JSON definition above ... }
```

---

## Populating the Index

### Option A: Azure AI Search Indexer (Recommended for Large Data)

Use the portal to create an **Indexer** that pulls from your data source and maps fields to the schema.

1. Go to **Indexers** → **Add indexer**
2. Select your **Data source** (Blob Storage, SQL, Cosmos DB, etc.)
3. Map source fields to the index fields:
   - Map your text content to `content`
   - Map your file/document name to `fileName`
   - Set `agentId` to the target agent's UUID (use a **field mapping** with a constant value or a source field)
   - Set `sourceName` to match the grounding source name in the agent config
4. Add an **Azure OpenAI Embedding Skill** to the skillset to generate `contentVector`:
   - Resource: Your Azure OpenAI endpoint
   - Deployment: `text-embedding-ada-002`
   - Input: `/document/content`
   - Output: `/document/contentVector`
5. Run the indexer

> **Important**: The embedding model **must** be `text-embedding-ada-002` (1536 dimensions). The app uses the same model for query embeddings. Mismatched models will produce poor search results.

### Option B: Push API (Programmatic)

Use the Azure AI Search Push API to upload documents directly:

```python
from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential

client = SearchClient(
    endpoint="https://agentsearch.search.azure.us",
    index_name="your-index-name",
    credential=AzureKeyCredential("your-key")
)

documents = [
    {
        "id": "doc1_chunk0",
        "agentId": "367027e2-322e-42c4-95a7-ff3b97fa9f10",
        "content": "Your text chunk here...",
        "contentVector": [0.0123, -0.0456, ...],  # 1536 floats from ada-002
        "fileName": "quarterly-report.pdf",
        "sourceName": "reports",
        "sourceUrl": "https://storage.blob.core.usgovcloudapi.net/reports/quarterly-report.pdf",
        "ssToken": "",
        "chunkIndex": 0,
        "indexedAt": "2026-02-26T00:00:00Z"
    }
]

result = client.upload_documents(documents)
```

---

## Chunking Guidelines

When preparing your data, follow these guidelines to match the app's search behavior:

### Text Documents (PDF, Word, Markdown)

- **Chunk size**: ~1,000 characters
- **Overlap**: ~200 characters between chunks
- **Break at sentence boundaries** when possible

### Tabular Data (Excel, CSV)

- **Chunk size**: ~20 rows per chunk
- **Repeat column headers** at the top of every chunk so each chunk is self-contained
- **Include sheet name** as a prefix line: `--- Sheet: Customers ---`
- **Use tab-separated values** within the content

Example chunk for tabular data:

```
--- Sheet: Customers ---
CustomerID	Name	Segment	Industry	Region
C001234	Contoso Ltd	Enterprise	Technology	EMEA
C001235	Lync Specialists	SMB	Professional Services	EMEA
C001236	Northwind Traders	Enterprise	Retail	APAC
...
```

### General Rules

- Each chunk becomes one document (one row) in the search index
- Every chunk from the same file shares the same `fileName` and `agentId`
- Use sequential `chunkIndex` values (0, 1, 2, ...) within each file
- Generate a unique `id` per chunk (e.g., `{sanitized_filename}_{chunkIndex}`)

---

## Security Tokens

The app uses `ssToken` for row-level security filtering. Each document in the index has an `ssToken` value, and at query time, the app filters results to only documents whose `ssToken` matches the current user's access tokens.

### If Your Environment Uses Security Tokens

Set `ssToken` on each document to the appropriate token value from your access control system. The app will call the Security Token Service to get the user's allowed tokens and filter with:

```
ssToken eq 'token1' or ssToken eq 'token2' or ...
```

### If You Don't Need Security Filtering

Set `ssToken` to an empty string `""` on every document. The security filter will match as long as the user has at least one token that includes the empty string, or if the Security Token Service is not configured (in which case no filtering is applied).

---

## Connecting the Index to an Agent

Once implemented, the admin UI will allow selecting an external index as a grounding source:

1. Go to **Agent Administration** → select your agent
2. Under **Grounding Sources**, choose source type **External Index**
3. Enter the **Index name** (must match exactly)
4. Enter the **Source name** that matches the `sourceName` field in your documents
5. Save

The agent will query the external index using the same hybrid + keyword dual-search strategy used for managed indices.

> **Note**: The Reindex button is disabled for external grounding sources since the app does not own the index lifecycle.

---

## Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| Index name | Lowercase, hyphens, descriptive | `grounding-hr-policies`, `customer-data-v2` |
| Agent ID | UUID from the agent config | `367027e2-322e-42c4-95a7-ff3b97fa9f10` |
| Source name | Lowercase, no spaces | `spreadsheetdocs`, `hr-documents`, `product-catalog` |
| Document ID | Unique per chunk | `quarterly-report-pdf_chunk_0` |

---

## Troubleshooting

### Search Returns 0 Results

1. **Check `agentId`** — Every document must have `agentId` set to the exact agent UUID. The search always filters on this field.
2. **Check `sourceName`** — Must match the grounding source name configured on the agent.
3. **Check `ssToken`** — If security filtering is active, the user must have a matching token.
4. **Verify the index name** — The external index name in the agent config must match exactly.

### Poor Search Relevance

1. **Wrong embedding model** — `contentVector` must be generated with `text-embedding-ada-002` (1536 dimensions). Using a different model will cause vector similarity scores to be meaningless.
2. **Chunks too large** — If a chunk contains too much text, individual entities (IDs, names) get diluted. Use ~1,000 chars for text or ~20 rows for tabular data.
3. **Missing content** — The `content` field must be searchable so BM25/keyword search works alongside vector search.

### Embedding Dimension Mismatch

If you see errors about vector dimensions, ensure:
- The index definition specifies `"dimensions": 1536`
- Your embeddings are generated with `text-embedding-ada-002` (which produces 1536-dimensional vectors)
- You are **not** using `text-embedding-3-small` (1536 default but different space) or `text-embedding-3-large` (3072 dimensions) unless you adjust the index accordingly

---

## Summary

| Aspect | Managed (Current) | External (BYOI) |
|--------|-------------------|-----------------|
| Index creation | App creates automatically | Admin creates via portal/CLI |
| Document ingestion | App parses blobs, chunks, embeds, uploads | Admin uses indexers or push API |
| Reindex | Via admin UI button | Via portal / indexer schedule |
| Index deletion | App deletes on agent removal | Admin manages independently |
| Schema | Automatic | Must follow documented schema |
| Search behavior | Identical | Identical |
| Security tokens | Populated by app from blob metadata | Admin sets on each document |
