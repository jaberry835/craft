import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchClient } from '@azure/search-documents';
import type { AgentDefinition, AzureAiSearchConnectionDefinition, AzureAiSearchGroundingSource } from '../types.js';
import { GroundingService } from '../services/groundingService.js';

test('grounding service maps workspace results to strong workspace source references', async () => {
  const service = new GroundingService({
    search: () => [{ path: 'package/index.md', preview: 'Executive summary preview', score: 0.9 }]
  } as never);
  const agent: AgentDefinition = {
    id: 'grounded-agent',
    name: 'Grounded Agent',
    description: '',
    instructions: '',
    modelConnectionId: 'default-azure-openai',
    tools: [],
    groundingSources: [{ id: 'workspace', type: 'workspace-index', label: 'Workspace index', enabled: true, top: 5 }]
  };

  const [snippet] = await service.ground(agent, 'executive summary');

  assert.equal(snippet?.sourceReference.sourceType, 'workspace-file');
  assert.equal(snippet?.sourceReference.retrievalKind, 'workspace-index');
  assert.equal(snippet?.sourceReference.attribution, 'strong');
  assert.equal(snippet?.sourceReference.workspacePath, 'package/index.md');
  assert.equal(snippet?.sourceReference.previewPath, 'package/index.md');
});

test('grounding service maps azure ai search metadata into structured source references', async () => {
  const originalSearch = SearchClient.prototype.search;
  SearchClient.prototype.search = async function () {
    return {
      results: (async function* () {
        yield {
          score: 3.5,
          document: {
            title: 'Incident handbook',
            content: 'Use the incident workflow and escalation path.',
            path: 'docs/incident-handbook.docx',
            canonicalUrl: 'https://contoso.example/documents/incident-handbook',
            documentId: 'doc-123',
            chunkId: 'doc-123#chunk-4',
            repositoryId: 'repo-456',
            sourceSystem: 'SharePoint',
            mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sectionLabel: 'Escalation',
            pageNumber: 7,
            chunkOrdinal: 4,
            lastIndexedAt: '2026-05-20T18:00:00.000Z',
            sourceVersion: 'etag-9'
          }
        };
      })()
    } as never;
  };

  try {
    const connection: AzureAiSearchConnectionDefinition = {
      id: 'search-1',
      name: 'Enterprise Search',
      type: 'azure-ai-search',
      authMode: 'api-key',
      endpoint: 'https://search.example.test',
      endpointEnv: 'UNUSED_SEARCH_ENDPOINT',
      queryType: 'semantic'
    };
    const source: AzureAiSearchGroundingSource = {
      id: 'enterprise-search',
      type: 'azure-ai-search',
      label: 'Enterprise Search',
      enabled: true,
      connectorId: 'search-1',
      indexName: 'documents',
      titleField: 'title',
      contentFields: ['content'],
      pathField: 'path',
      canonicalUrlField: 'canonicalUrl',
      documentIdField: 'documentId',
      chunkIdField: 'chunkId',
      repositoryIdField: 'repositoryId',
      sourceSystemField: 'sourceSystem',
      mediaTypeField: 'mediaType',
      sectionField: 'sectionLabel',
      pageNumberField: 'pageNumber',
      chunkOrdinalField: 'chunkOrdinal',
      lastIndexedAtField: 'lastIndexedAt',
      sourceVersionField: 'sourceVersion'
    };
    const service = new GroundingService(
      { search: () => [] } as never,
      () => connection,
      () => 'test-key'
    );
    const agent: AgentDefinition = {
      id: 'search-agent',
      name: 'Search Agent',
      description: '',
      instructions: '',
      modelConnectionId: 'default-azure-openai',
      tools: [],
      groundingSources: [source]
    };

    const [snippet] = await service.ground(agent, 'incident workflow');

    assert.equal(snippet?.sourceReference.sourceType, 'repository-file');
    assert.equal(snippet?.sourceReference.retrievalKind, 'azure-ai-search');
    assert.equal(snippet?.sourceReference.attribution, 'strong');
    assert.equal(snippet?.sourceReference.sourceSystem, 'SharePoint');
    assert.equal(snippet?.sourceReference.documentId, 'doc-123');
    assert.equal(snippet?.sourceReference.chunkId, 'doc-123#chunk-4');
    assert.equal(snippet?.sourceReference.repositoryId, 'repo-456');
    assert.equal(snippet?.sourceReference.canonicalUrl, 'https://contoso.example/documents/incident-handbook');
    assert.equal(snippet?.sourceReference.externalUrl, 'https://contoso.example/documents/incident-handbook');
    assert.equal(snippet?.sourceReference.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(snippet?.sourceReference.sectionLabel, 'Escalation');
    assert.equal(snippet?.sourceReference.pageNumber, 7);
    assert.equal(snippet?.sourceReference.chunkOrdinal, 4);
    assert.equal(snippet?.sourceReference.lastIndexedAt, '2026-05-20T18:00:00.000Z');
    assert.equal(snippet?.sourceReference.sourceVersion, 'etag-9');
  } finally {
    SearchClient.prototype.search = originalSearch;
  }
});