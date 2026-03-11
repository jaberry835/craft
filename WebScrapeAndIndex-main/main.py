"""
WebScrapeAndIndex — CLI tool that crawls a website with Scrapy, chunks the
content, generates embeddings, and pushes everything into Azure AI Search.

Usage:
    python main.py --url https://example.com [options]
"""

import argparse
import json
import os
import sys
import tempfile

from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from dotenv import load_dotenv
from openai import AzureOpenAI
from scrapy.crawler import CrawlerProcess
from scrapy.utils.project import get_project_settings

from indexer import ensure_index, index_pages
from webscraper.spiders.site_spider import SiteSpider


def _run_spider(url: str, max_pages: int) -> list:
    """Run the Scrapy spider and collect results via a JSON feed."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False
    ) as tmp:
        feed_path = tmp.name

    settings = get_project_settings()
    settings.set("FEEDS", {feed_path: {"format": "json", "overwrite": True}})
    settings.set("LOG_LEVEL", "WARNING")

    process = CrawlerProcess(settings)
    process.crawl(SiteSpider, url=url, max_pages=max_pages)
    process.start()

    with open(feed_path, "r", encoding="utf-8") as f:
        pages = json.load(f)

    os.unlink(feed_path)
    return pages


def main():
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="Scrape a website and index its content into Azure AI Search."
    )
    parser.add_argument("--url", required=True, help="The URL to start crawling from.")
    parser.add_argument("--max-pages", type=int, default=50, help="Max pages to crawl (default: 50). Use 0 for no limit.")
    parser.add_argument("--agent-id", default=os.getenv("AGENT_ID", "default-agent"), help="Agent ID to tag documents with.")
    parser.add_argument("--source-name", default=os.getenv("SOURCE_NAME", "web-scrape"), help="Source name for the documents.")
    parser.add_argument("--index-name", default=os.getenv("AZURE_SEARCH_INDEX_NAME"), help="Azure Search index name.")
    parser.add_argument("--create-index", action="store_true", help="Create the index if it doesn't exist.")
    args = parser.parse_args()

    # Validate required env vars
    search_endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
    search_key = os.getenv("AZURE_SEARCH_API_KEY")
    openai_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    openai_key = os.getenv("AZURE_OPENAI_API_KEY")
    embedding_deployment = os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-ada-002")
    index_name = args.index_name

    missing = []
    if not search_endpoint:
        missing.append("AZURE_SEARCH_ENDPOINT")
    if not openai_endpoint:
        missing.append("AZURE_OPENAI_ENDPOINT")
    if not index_name:
        missing.append("AZURE_SEARCH_INDEX_NAME (env or --index-name)")

    if missing:
        print(f"ERROR: Missing required configuration: {', '.join(missing)}", file=sys.stderr)
        print("Copy .env.example to .env and fill in your values.", file=sys.stderr)
        sys.exit(1)

    # --- Search auth: API key preferred; falls back to DefaultAzureCredential + audience ---
    search_audience = os.getenv("AZURE_SEARCH_AUDIENCE")  # e.g. https://search.azure.us
    search_credential = None
    if not search_key:
        print("AZURE_SEARCH_API_KEY not set — using DefaultAzureCredential for Search")
        if search_audience:
            print(f"  audience = {search_audience}")
        else:
            print("  WARNING: AZURE_SEARCH_AUDIENCE not set — token may target wrong resource")
        search_credential = DefaultAzureCredential()

    # --- OpenAI auth: API key preferred; falls back to DefaultAzureCredential ---
    azure_credential = None
    if not openai_key:
        print("AZURE_OPENAI_API_KEY not set — using DefaultAzureCredential for OpenAI")
        azure_credential = search_credential or DefaultAzureCredential()

    # Optionally create the index
    if args.create_index:
        print(f"Ensuring index '{index_name}' exists...")
        ensure_index(
            search_endpoint,
            index_name,
            api_key=search_key,
            credential=search_credential,
            audience=search_audience,
        )

    # Step 1: Crawl the website
    print(f"Crawling {args.url} (max {args.max_pages} pages)...")
    pages = _run_spider(args.url, args.max_pages)
    print(f"Scraped {len(pages)} pages.")

    if not pages:
        print("No content found. Exiting.")
        sys.exit(0)

    # Step 2: Index into Azure AI Search
    if openai_key:
        openai_client = AzureOpenAI(
            azure_endpoint=openai_endpoint,
            api_key=openai_key,
            api_version="2024-02-01",
        )
    else:
        token_scope = os.getenv(
            "AZURE_OPENAI_TOKEN_SCOPE",
            "https://cognitiveservices.azure.com/.default",
        )
        token_provider = get_bearer_token_provider(
            azure_credential, token_scope
        )
        openai_client = AzureOpenAI(
            azure_endpoint=openai_endpoint,
            azure_ad_token_provider=token_provider,
            api_version="2024-02-01",
        )

    print("Chunking, embedding, and indexing...")
    count = index_pages(
        pages,
        endpoint=search_endpoint,
        api_key=search_key,
        credential=search_credential,
        audience=search_audience,
        index_name=index_name,
        openai_client=openai_client,
        embedding_deployment=embedding_deployment,
        agent_id=args.agent_id,
        source_name=args.source_name,
    )

    print(f"Done! Indexed {count} document chunks into '{index_name}'.")


if __name__ == "__main__":
    main()
