# Creating an Azure AI Search index for security trimming

This guide walks you through creating an Azure AI Search index that reads a security tag from Azure Blob Storage metadata (allowedprincipals) and projects it into the index so queries can be trimmed at runtime using the caller's access principals.

The Rude MCP Server RAG tools will call your USER_ACCESS_CHECK_URL with the user's bearer token and build a filter like:
- search.in(<field>, 'principal', ',') OR'd for each principal

You can configure which index field to use via RAG_ALLOWED_PRINCIPALS_FIELD.

## Prerequisites
- Azure AI Search service with vector/semantic capabilities
- Azure Blob Storage container holding source documents
- Each blob tagged with metadata key allowedprincipals, e.g.:
  - allowedprincipals="group_id1" (single)
  - allowedprincipals="group_id1,group_id2" (CSV)

## High-level flow
1) Tag blobs with allowedprincipals metadata
2) Use Import and vectorize data to create data source + skillset + index + indexer
3) Add fields to the index for security + file name
4) Update skillset outputs and/or output field mappings
5) Add indexer field mappings from blob metadata to index fields
6) Run indexer and validate

This doc uses a CSV string field pattern named allowedprincipals. You can alternatively use a Collection(Edm.String) field and change the filter pattern to any().

---

## Step-by-step (Azure Portal)

### 1) Tag your blobs
For each blob in your container, set metadata:
- Key: allowedprincipals
- Value: securitytagvalue (single) or comma-delimited values (e.g. group_id1,group_id2)

### 2) Import and vectorize data
In your Azure AI Search service:
- Choose Import and vectorize data
- Select your Blob data source (create if needed)
- Complete the wizard to create:
  - Data source (to your container)
  - Skillset (text extraction + vectorization)
  - Index (content + vector fields)
  - Indexer (runs the pipeline)
Let it finish first so you have a working baseline.

### 3) Add fields to the index
Go to Search service → Indexes → your index → Fields and add:
- allowedprincipals: Edm.String, Filterable: ✓, Retrievable: ✓
- metaName: Edm.String, Retrievable: ✓

If you prefer the collection pattern instead:
- allowedprincipals: Collection(Edm.String), Filterable: ✓ (Retrievable optional)

Save schema.

### 4) Update the skillset outputs / projections
Go to Search service → Skillsets → your skillset.
Ensure the following outputs exist so you can map them into fields:

- allowedprincipals from the document:
  - name: allowedprincipals
  - source: /document/allowedprincipals
- metaName from the blob name:
  - name: metaName
  - source: /document/metadata_storage_name

In the portal, wire them using Output field mappings (or projections) so they’re available to the index fields.

### 5) Add indexer field mappings
Search service → Indexers → your indexer → Field mappings:
- Source: metadata/allowedprincipals → Target: allowedprincipals
- Source: metadata_storage_name → Target: metaName

**Under Vector Profiles, Vectorizer, point it at your AOAI model. Ensure your System Identity for AI Search has Cognitive Services OpenAI User role on AOAI.

If you use a collection field (allowedPrincipals), ensure a skill or mapping splits the CSV into an array of strings.

### 6) Run the indexer and validate
- Run the indexer
- Use Search Explorer to confirm new fields appear on documents
  - CSV: allowedprincipals contains your CSV string
  - Collection: allowedPrincipals contains an array

---

## Using this with Rude MCP Server
Set the following in your environment (e.g., .env):
- USER_ACCESS_CHECK_URL=https://<your-service>/api/user-access
- RAG_ALLOWED_PRINCIPALS_FIELD=allowedprincipals (or allowedPrincipals if you choose the collection pattern and update the filter code)

The server logs include a preview of what USER_ACCESS_CHECK_URL returns and the parsed principal list.

Current filter behavior (CSV pattern):
- For each principal gid, the server builds: search.in(allowedprincipals, 'gid', ',') and ORs them together

Collection pattern alternative (recommended by Azure docs):
- allowedPrincipals/any(g: search.in(g, 'gid1,gid2,...', ','))

---

## Optional REST skeletons
Index (CSV field example):
{
  "name": "your-index",
  "fields": [
    {"name": "id", "type": "Edm.String", "key": true, "searchable": false},
    {"name": "content", "type": "Edm.String", "searchable": true},
    {"name": "contentVector", "type": "Collection(Edm.Single)"},
    {"name": "allowedprincipals", "type": "Edm.String", "filterable": true, "retrievable": true},
    {"name": "metaName", "type": "Edm.String", "retrievable": true}
  ]
}

Indexer field mappings (CSV):
"fieldMappings": [
  { "sourceFieldName": "metadata/allowedprincipals", "targetFieldName": "allowedprincipals" },
  { "sourceFieldName": "metadata_storage_name", "targetFieldName": "metaName" }
]

Skillset output mappings (excerpt):
"outputFieldMappings": [
  { "sourceFieldName": "/document/allowedprincipals", "targetFieldName": "allowedprincipals" },
  { "sourceFieldName": "/document/metadata_storage_name", "targetFieldName": "metaName" }
]

---

## Troubleshooting
- No results with trimming:
  - Verify USER_ACCESS_CHECK_URL returns principals (logs show a preview)
  - Confirm allowedprincipals (or allowedPrincipals) is populated on documents
- Filter errors:
  - Ensure the target field is Filterable: ✓
  - Avoid special characters in IDs; sanitize as needed
- Performance:
  - For many principals, prefer the collection + any(search.in(...)) pattern

## Next steps
- Decide on CSV vs collection approach
- If using collection, update the filter to any(search.in(...)) and set RAG_ALLOWED_PRINCIPALS_FIELD accordingly
- Add CI checks to validate presence/format of allowedprincipals metadata
