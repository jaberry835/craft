import { DefaultAzureCredential } from '@azure/identity';
import { AzureKeyCredential, SearchClient } from '@azure/search-documents';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, AgentConnection, AzureAiSearchConnectionDefinition, AzureAiSearchGroundingSource, GroundingSnippet, SourceReference, WorkspaceIndexGroundingSource } from '../types.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';

export class GroundingService {
  constructor(
    private readonly workspaceIndexer: WorkspaceIndexer,
    private readonly searchConnectionResolver?: (connectionId: string) => AzureAiSearchConnectionDefinition,
    private readonly apiKeyResolver?: (connection: AgentConnection) => string | undefined
  ) {}

  async ground(agent: AgentDefinition, query: string): Promise<GroundingSnippet[]> {
    const snippets = await Promise.all(agent.groundingSources
      .filter((source) => source.enabled)
      .map((source) => {
        if (source.type === 'workspace-index') {
          return Promise.resolve(this.fromWorkspace(source, query));
        }

        return this.fromAzureAiSearch(source, query);
      }));

    return snippets.flat();
  }

  private fromWorkspace(source: WorkspaceIndexGroundingSource, query: string): GroundingSnippet[] {
    return this.workspaceIndexer.search(query, source.top ?? 5).map((result) => {
      const sourceReference: SourceReference = {
        label: result.path,
        sourceType: 'workspace-file',
        retrievalKind: 'workspace-index',
        attribution: 'strong',
        sourceSystem: 'Workspace',
        path: result.path,
        workspacePath: result.path,
        previewPath: result.path
      };

      return {
        id: randomUUID(),
        sourceId: source.id,
        sourceLabel: source.label,
        sourceType: source.type,
        sourceReference,
        title: result.path,
        content: result.preview,
        path: result.path,
        score: result.score
      };
    });
  }

  private async fromAzureAiSearch(source: AzureAiSearchGroundingSource, query: string): Promise<GroundingSnippet[]> {
    const connection = source.connectorId ? this.searchConnectionResolver?.(source.connectorId) : undefined;
    const endpoint = source.endpoint ?? connection?.endpoint ?? (source.endpointEnv ? process.env[source.endpointEnv] : undefined) ?? (connection?.endpointEnv ? process.env[connection.endpointEnv] : undefined);
    const indexName = source.indexName ?? (source.indexNameEnv ? process.env[source.indexNameEnv] : undefined);

    if (!endpoint || !indexName) {
      return [];
    }

    const apiKey = connection ? this.apiKeyResolver?.(connection) : source.keyEnv ? process.env[source.keyEnv] : undefined;
    const credential = apiKey
      ? new AzureKeyCredential(apiKey)
      : new DefaultAzureCredential();
    const client = new SearchClient<Record<string, unknown>>(endpoint, indexName, credential);
    const commonOptions = {
      top: source.top ?? connection?.top ?? 5,
      filter: source.filter,
      select: source.selectFields
    };
    const queryType = source.queryType ?? connection?.queryType ?? 'semantic';
    const searchOptions: Parameters<typeof client.search>[1] = queryType === 'semantic'
      ? {
        ...commonOptions,
        queryType: 'semantic',
        semanticSearchOptions: {
          configurationName: source.semanticConfiguration ?? connection?.semanticConfigurations?.[0] ?? 'default'
        }
      }
      : {
        ...commonOptions,
        queryType: queryType === 'full' ? 'full' : 'simple'
      };
    const results = await client.search(query || '*', searchOptions);

    const snippets: GroundingSnippet[] = [];
    for await (const result of results.results) {
      const title = this.readStringField(result.document, source.titleField)
        ?? this.readStringField(result.document, source.pathField)
        ?? source.label;
      const path = this.readStringField(result.document, source.pathField)
        ?? this.readKnownStringField(result.document, ['path', 'sourcePath', 'filePath']);
      const canonicalUrl = this.readStringField(result.document, source.canonicalUrlField)
        ?? this.readKnownStringField(result.document, ['canonicalUrl', 'sourceUrl', 'sourceUri', 'url', 'uri']);
      const documentId = this.readStringField(result.document, source.documentIdField)
        ?? this.readKnownStringField(result.document, ['documentId', 'parentDocumentId', 'sourceDocumentId']);
      const chunkId = this.readStringField(result.document, source.chunkIdField)
        ?? this.readKnownStringField(result.document, ['chunkId', 'chunkKey', 'id']);
      const repositoryId = this.readStringField(result.document, source.repositoryIdField)
        ?? this.readKnownStringField(result.document, ['repositoryId', 'repoId', 'container']);
      const sourceSystem = this.readStringField(result.document, source.sourceSystemField)
        ?? this.readKnownStringField(result.document, ['sourceSystem', 'sourceName', 'system'])
        ?? connection?.name
        ?? source.label;
      const mediaType = this.readStringField(result.document, source.mediaTypeField)
        ?? this.readKnownStringField(result.document, ['mediaType', 'mimeType', 'contentType', 'fileType']);
      const sectionLabel = this.readStringField(result.document, source.sectionField)
        ?? this.readKnownStringField(result.document, ['section', 'sectionLabel', 'heading']);
      const pageNumber = this.readNumberField(result.document, source.pageNumberField)
        ?? this.readKnownNumberField(result.document, ['pageNumber', 'page']);
      const chunkOrdinal = this.readNumberField(result.document, source.chunkOrdinalField)
        ?? this.readKnownNumberField(result.document, ['chunkOrdinal', 'chunkIndex']);
      const lastIndexedAt = this.readStringField(result.document, source.lastIndexedAtField)
        ?? this.readKnownStringField(result.document, ['lastIndexedAt', 'indexedAt']);
      const sourceVersion = this.readStringField(result.document, source.sourceVersionField)
        ?? this.readKnownStringField(result.document, ['sourceVersion', 'version', 'etag']);
      const sourceReference: SourceReference = {
        label: title,
        sourceType: repositoryId || path ? 'repository-file' : 'search-indexed-chunk',
        retrievalKind: 'azure-ai-search',
        attribution: canonicalUrl || documentId || path ? 'strong' : 'weak',
        sourceSystem,
        documentId,
        chunkId,
        repositoryId,
        path,
        canonicalUrl,
        externalUrl: canonicalUrl,
        mediaType,
        sectionLabel,
        pageNumber,
        chunkOrdinal,
        lastIndexedAt,
        sourceVersion,
        versionId: sourceVersion
      };

      snippets.push({
        id: randomUUID(),
        sourceId: source.id,
        sourceLabel: source.label,
        sourceType: source.type,
        sourceReference,
        title,
        content: this.readFirstContentField(result.document, source.contentFields) ?? JSON.stringify(result.document),
        path,
        score: result.score
      });
    }

    return snippets;
  }

  private readFirstContentField(document: Record<string, unknown>, fields = ['content', 'chunk', 'text', 'description']): string | undefined {
    for (const field of fields) {
      const value = this.readStringField(document, field);
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  private readKnownStringField(document: Record<string, unknown>, fields: string[]): string | undefined {
    for (const field of fields) {
      const value = this.readStringField(document, field);
      if (value) {
        return value;
      }
    }

    return undefined;
  }

  private readNumberField(document: Record<string, unknown>, field?: string): number | undefined {
    if (!field) {
      return undefined;
    }

    const value = document[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private readKnownNumberField(document: Record<string, unknown>, fields: string[]): number | undefined {
    for (const field of fields) {
      const value = this.readNumberField(document, field);
      if (value !== undefined) {
        return value;
      }
    }

    return undefined;
  }

  private readStringField(document: Record<string, unknown>, field?: string): string | undefined {
    if (!field) {
      return undefined;
    }

    const value = document[field];
    return typeof value === 'string' ? value : undefined;
  }
}
