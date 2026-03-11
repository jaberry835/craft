# WebScrapeAndIndex

Scrapes a website using [Scrapy](https://scrapy.org/) and indexes the content into [Azure AI Search](https://learn.microsoft.com/azure/search/) with vector embeddings.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Azure credentials
```

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

Matches the grounding index schema used by the consuming app:

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
