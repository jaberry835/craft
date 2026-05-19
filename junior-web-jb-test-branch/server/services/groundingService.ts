import { DefaultAzureCredential } from '@azure/identity';
import { AzureKeyCredential, SearchClient } from '@azure/search-documents';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, AgentConnection, AzureAiSearchConnectionDefinition, AzureAiSearchGroundingSource, GroundingSnippet, WorkspaceIndexGroundingSource } from '../types.js';
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
    return this.workspaceIndexer.search(query, source.top ?? 5).map((result) => ({
      id: randomUUID(),
      sourceId: source.id,
      sourceLabel: source.label,
      sourceType: source.type,
      title: result.path,
      content: result.preview,
      path: result.path,
      score: result.score
    }));
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
      snippets.push({
        id: randomUUID(),
        sourceId: source.id,
        sourceLabel: source.label,
        sourceType: source.type,
        title: this.readStringField(result.document, source.titleField) ?? this.readStringField(result.document, source.pathField) ?? source.label,
        content: this.readFirstContentField(result.document, source.contentFields) ?? JSON.stringify(result.document),
        path: this.readStringField(result.document, source.pathField),
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

  private readStringField(document: Record<string, unknown>, field?: string): string | undefined {
    if (!field) {
      return undefined;
    }

    const value = document[field];
    return typeof value === 'string' ? value : undefined;
  }
}
