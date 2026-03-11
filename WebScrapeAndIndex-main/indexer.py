"""
Azure AI Search indexer — pushes scraped page content into an index that
matches the grounding schema used by other agents in the app.

Index schema (from Azure portal):
  id              String          key
  agentId         String          filterable
  sourceUrl       String          filterable
  sourceName      String
  ssToken         String          (reserved, see TODO below)
  fileName        String          searchable  (Standard analyzer)
  content         String          searchable  (Standard analyzer)
  chunkIndex      Int32           sortable
  indexedAt        DateTimeOffset  sortable
  contentVector   Collection(Single)  searchable, 1536-dim
"""

import hashlib
import re
import textwrap
from datetime import datetime, timezone
from typing import List

from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchField,
    SearchFieldDataType,
    SearchIndex,
    SimpleField,
    SearchableField,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
    SemanticConfiguration,
    SemanticField,
    SemanticPrioritizedFields,
    SemanticSearch,
)
from openai import AzureOpenAI


# ---------------------------------------------------------------------------
# Chunking helpers
# ---------------------------------------------------------------------------

_MAX_CHUNK_CHARS = 2000  # ~500 tokens per chunk


def _chunk_text(text: str, max_chars: int = _MAX_CHUNK_CHARS) -> List[str]:
    """Split text into roughly equal sized chunks on sentence boundaries."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0

    for sentence in sentences:
        if current_len + len(sentence) > max_chars and current:
            chunks.append(" ".join(current))
            current = []
            current_len = 0
        current.append(sentence)
        current_len += len(sentence) + 1

    if current:
        chunks.append(" ".join(current))

    return chunks if chunks else [text]


# ---------------------------------------------------------------------------
# Embedding helper
# ---------------------------------------------------------------------------


def _get_embeddings(
    texts: List[str],
    openai_client: AzureOpenAI,
    deployment: str,
) -> List[List[float]]:
    """Get embeddings for a batch of texts via Azure OpenAI."""
    response = openai_client.embeddings.create(input=texts, model=deployment)
    return [item.embedding for item in response.data]


# ---------------------------------------------------------------------------
# Index management
# ---------------------------------------------------------------------------


def ensure_index(
    endpoint: str,
    index_name: str,
    *,
    api_key: str | None = None,
    credential=None,
    audience: str | None = None,
) -> None:
    """Create the search index if it doesn't already exist."""
    if api_key:
        client = SearchIndexClient(endpoint=endpoint, credential=AzureKeyCredential(api_key))
    elif credential:
        kwargs = {}
        if audience:
            kwargs["audience"] = audience
        client = SearchIndexClient(endpoint=endpoint, credential=credential, **kwargs)
    else:
        raise ValueError("Either api_key or credential must be provided for Search.")

    fields = [
        SimpleField(name="id", type=SearchFieldDataType.String, key=True, retrievable=True),
        SimpleField(name="agentId", type=SearchFieldDataType.String, retrievable=True, filterable=True),
        SimpleField(name="sourceUrl", type=SearchFieldDataType.String, retrievable=True, filterable=True),
        SimpleField(name="sourceName", type=SearchFieldDataType.String, retrievable=True),
        # TODO: ssToken is reserved for per-user / per-group access control.
        # When security trimming is needed, populate this field with a token
        # that represents which users/groups are allowed to see each document.
        # At query time, pass matching tokens in the search filter so that
        # users only see documents they are authorized to access.
        # See: https://learn.microsoft.com/azure/search/search-security-trimming-for-azure-search
        SimpleField(name="ssToken", type=SearchFieldDataType.String, retrievable=True),
        SearchableField(name="fileName", type=SearchFieldDataType.String, retrievable=True, searchable=True, analyzer_name="standard.lucene"),
        SearchableField(name="content", type=SearchFieldDataType.String, retrievable=True, searchable=True, analyzer_name="standard.lucene"),
        SimpleField(name="chunkIndex", type=SearchFieldDataType.Int32, retrievable=True, sortable=True),
        SimpleField(name="indexedAt", type=SearchFieldDataType.DateTimeOffset, retrievable=True, sortable=True),
        SearchField(
            name="contentVector",
            type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
            searchable=True,
            vector_search_dimensions=1536,
            vector_search_profile_name="default-vector-profile",
        ),
    ]

    vector_search = VectorSearch(
        algorithms=[HnswAlgorithmConfiguration(name="default-hnsw")],
        profiles=[VectorSearchProfile(name="default-vector-profile", algorithm_configuration_name="default-hnsw")],
    )

    semantic_config = SemanticConfiguration(
        name="default",
        prioritized_fields=SemanticPrioritizedFields(
            title_field=SemanticField(field_name="fileName"),
            content_fields=[SemanticField(field_name="content")],
            keywords_fields=[SemanticField(field_name="sourceName")],
        ),
    )
    semantic_search = SemanticSearch(
        default_configuration_name="default",
        configurations=[semantic_config],
    )

    index = SearchIndex(
        name=index_name,
        fields=fields,
        vector_search=vector_search,
        semantic_search=semantic_search,
    )

    # create_or_update is idempotent
    client.create_or_update_index(index)


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------


def _make_doc_id(source_url: str, chunk_index: int) -> str:
    """Deterministic document id from URL + chunk index."""
    raw = f"{source_url}||{chunk_index}"
    return hashlib.sha256(raw.encode()).hexdigest()[:64]


def index_pages(
    pages: list,
    *,
    endpoint: str,
    api_key: str | None = None,
    credential=None,
    audience: str | None = None,
    index_name: str,
    openai_client: AzureOpenAI,
    embedding_deployment: str,
    agent_id: str,
    source_name: str,
) -> int:
    """
    Chunk scraped pages and upload them to Azure AI Search.

    Returns the total number of documents indexed.
    """
    if api_key:
        search_cred = AzureKeyCredential(api_key)
        search_kwargs = {}
    elif credential:
        search_cred = credential
        search_kwargs = {"audience": audience} if audience else {}
    else:
        raise ValueError("Either api_key or credential must be provided for Search.")

    search_client = SearchClient(
        endpoint=endpoint,
        index_name=index_name,
        credential=search_cred,
        **search_kwargs,
    )

    now = datetime.now(timezone.utc).isoformat()
    documents = []

    for page in pages:
        url = page["url"]
        title = page.get("title", "")
        content = page["content"]
        chunks = _chunk_text(content)

        # Generate embeddings for all chunks of this page
        embeddings = _get_embeddings(chunks, openai_client, embedding_deployment)

        for i, (chunk, vector) in enumerate(zip(chunks, embeddings)):
            doc = {
                "id": _make_doc_id(url, i),
                "agentId": agent_id,
                "sourceUrl": url,
                "sourceName": source_name,
                # TODO: ssToken — leave empty for now. Populate when security
                # trimming is implemented (see ensure_index comments above).
                "ssToken": "",
                "fileName": title or url,
                "content": chunk,
                "chunkIndex": i,
                "indexedAt": now,
                "contentVector": vector,
            }
            documents.append(doc)

    # Upload in batches of 100 (service limit is 1000, but stay conservative)
    batch_size = 100
    total = 0
    for start in range(0, len(documents), batch_size):
        batch = documents[start : start + batch_size]
        result = search_client.upload_documents(documents=batch)
        total += sum(1 for r in result if r.succeeded)

    return total
