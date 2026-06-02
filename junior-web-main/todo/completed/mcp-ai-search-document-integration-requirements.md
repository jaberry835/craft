# MCP, Azure AI Search, And Document Integration Completed Foundation

## Status

This note records the completed foundation work that was originally tracked in `todo/mcp-ai-search-document-integration-requirements.md`.

The completed slice is the provenance and source-reference foundation for Azure AI Search and workspace grounding.

## Completed Scope

The following work is complete:

1. A shared source-reference model now exists across server and client contracts.
2. `GroundingSnippet` now carries structured provenance instead of only title, path, and snippet text.
3. Workspace-index grounding now maps to strong workspace-file source references.
4. Azure AI Search grounding now maps richer source metadata into structured source references.
5. Agent editor save behavior now preserves richer Azure AI Search field mappings.
6. Focused executable coverage now validates the grounding provenance mapping.

## Implemented Outcome

The completed implementation introduced:

- a shared `SourceReference` shape for grounded evidence
- explicit attribution strength for strong versus weak provenance
- support for document ID, chunk ID, repository ID, canonical URL, media type, section label, page number, chunk ordinal, last indexed timestamp, and source version
- parity between server and client workbench contracts for the new provenance fields
- a preserved Azure AI Search mapping surface in agent grounding configuration

## Owning Files

The completed slice landed in these existing files:

- `server/types.ts`
- `src/types/workbench.ts`
- `server/services/groundingService.ts`
- `src/App.tsx`
- `config/agents.json`
- `server/test/groundingService.test.ts`

## Validation Completed

The completed slice was validated with:

- `npx tsx --test server/test/groundingService.test.ts`
- `npm run build`

## Deconfliction

This completed slice intentionally stopped at the source-reference and grounding contract boundary.

The following concerns are not owned by this archive note and should continue to live elsewhere:

- loop retrieval preparation and token-bounded grounding packs
- planner memory and plan-step tracking
- staged review ergonomics for multi-file document runs
- publish-readiness and document validation driven by the agent loop

Those workflow concerns belong in `todo/agent-loop-document-workflow-plan.md`.

## Remaining Work Handoff

The active remaining work stays in `todo/mcp-ai-search-document-integration-requirements.md` and covers:

- MCP diagnostics and structured MCP result metadata
- Azure AI Search index-shape guidance and evidence review UX
- linked repository and external content-source integration modes
- PDF and Word preview architecture
- document extraction and normalization pipeline
- linked-document security boundaries and broader validation coverage