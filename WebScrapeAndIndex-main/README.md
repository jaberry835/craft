# WebScrapeAndIndex

Scrapes a website using [Scrapy](https://scrapy.org/) and indexes the content into [Azure AI Search](https://learn.microsoft.com/azure/search/) with vector embeddings. Works with both Azure Commercial and Azure Government (GCC-High).

## Prerequisites

- **Python 3.10+**
- **Azure AI Search** resource
- **Azure OpenAI** resource with a `text-embedding-ada-002` (or compatible) deployment

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Azure credentials (see Environment Variables below)
```

## Authentication

The tool supports two authentication methods for each service. If an API key is provided it is used; otherwise it falls back to [`DefaultAzureCredential`](https://learn.microsoft.com/python/api/azure-identity/azure.identity.defaultazurecredential) (e.g. `az login`, managed identity, etc.).

| Service | API Key Env Var | Credential Fallback |
|---|---|---|
| Azure AI Search | `AZURE_SEARCH_API_KEY` | `DefaultAzureCredential` + `AZURE_SEARCH_AUDIENCE` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | `DefaultAzureCredential` + `AZURE_OPENAI_TOKEN_SCOPE` |

### Keyless (DefaultAzureCredential) setup

1. Log in: `az login` (or `az login --cloud AzureUSGovernment` for Gov)
2. **Enable RBAC on the Search data plane**: Azure Portal → your Search resource → **Settings → Keys** → set to **"Both"** (API keys + Role-based access control)
3. Assign the required roles on your Search resource:
   - **Search Service Contributor** — needed for index creation (`--create-index`)
   - **Search Index Data Contributor** — needed for uploading documents
4. Set `AZURE_SEARCH_AUDIENCE` in `.env` (see table below)

### Azure Government vs Commercial

| Env Var | Commercial | Azure Gov (GCC-High) |
|---|---|---|
| `AZURE_SEARCH_ENDPOINT` | `https://<name>.search.windows.net` | `https://<name>.search.windows.us` |
| `AZURE_SEARCH_AUDIENCE` | `https://search.azure.com` | `https://search.azure.us` |
| `AZURE_OPENAI_ENDPOINT` | `https://<name>.openai.azure.com` | `https://<name>.openai.azure.us` |
| `AZURE_OPENAI_TOKEN_SCOPE` | `https://cognitiveservices.azure.com/.default` | `https://cognitiveservices.azure.us/.default` |

## Environment Variables

Configured in `.env` (see `.env.example` for a full template):

| Variable | Required | Description |
|---|---|---|
| `AZURE_SEARCH_ENDPOINT` | Yes | Search service URL |
| `AZURE_SEARCH_INDEX_NAME` | Yes* | Default index name (*can also use `--index-name`) |
| `AZURE_SEARCH_API_KEY` | No | Omit to use DefaultAzureCredential |
| `AZURE_SEARCH_AUDIENCE` | No | Required for credential auth; set per cloud (see above) |
| `AZURE_OPENAI_ENDPOINT` | Yes | Azure OpenAI resource URL |
| `AZURE_OPENAI_API_KEY` | No | Omit to use DefaultAzureCredential |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | No | Deployment name (default: `text-embedding-ada-002`) |
| `AZURE_OPENAI_TOKEN_SCOPE` | No | Token scope for credential auth (default: commercial scope) |
| `AGENT_ID` | No | Default agent ID tag (default: `default-agent`) |
| `SOURCE_NAME` | No | Default source name (default: `web-scrape`) |

## Usage

```bash
# Create the index and scrape a site
python main.py --url https://example.com --create-index

# Scrape with custom options
python main.py --url https://docs.example.com \
    --max-pages 100 \
    --agent-id my-agent \
    --source-name docs-site \
    --index-name my-index

# Crawl an entire site (no page limit)
python main.py --url https://small-site.com --max-pages 0 --create-index
```

### Arguments

| Argument | Default | Description |
|---|---|---|
| `--url` | *(required)* | Starting URL to crawl |
| `--max-pages` | 50 | Maximum pages to scrape. Use `0` for no limit (crawl entire site). |
| `--agent-id` | `default-agent` | Agent ID tag for documents |
| `--source-name` | `web-scrape` | Source name for documents |
| `--index-name` | from `.env` | Azure Search index name |
| `--create-index` | `false` | Create the index if it doesn't exist |

## Index Schema

Matches the grounding index schema used by the consuming app. Includes HNSW vector search and a semantic search configuration.

| Field | Type | Notes |
|---|---|---|
| `id` | String | SHA-256 hash of URL + chunk index |
| `agentId` | String | Filterable |
| `sourceUrl` | String | Filterable |
| `sourceName` | String | |
| `ssToken` | String | Reserved for security trimming (TODO) |
| `fileName` | String | Searchable, Standard analyzer |
| `content` | String | Searchable, Standard analyzer |
| `chunkIndex` | Int32 | Sortable |
| `indexedAt` | DateTimeOffset | Sortable |
| `contentVector` | Collection(Single) | 1536-dim HNSW |

**Semantic search**: The index is created with a default semantic configuration that uses `fileName` as the title field, `content` as the content field, and `sourceName` as a keyword field.
