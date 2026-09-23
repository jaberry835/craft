# MCP Site Builder repository instructions

- Use strict TypeScript and ESM with explicit `.js` suffixes in relative imports.
- Keep REST and MCP as adapters over `SiteBuilderApplication`; do not duplicate publishing rules.
- Publishing must never invoke npm, execute caller code, accept arbitrary CSS/JavaScript, or trust input paths.
- Use managed identity in Azure and local developer credentials or Azurite connection strings locally. Never add storage account keys to source.
- Every generated page must include the site classification bar; omission resolves to `UNCLASSIFIED`.
- Preserve immutable-version-first publication before updating stable pointers or the catalog.
- Run build, lint, formatting checks, and tests after changes.

Current MCP TypeScript SDK references:

- https://github.com/modelcontextprotocol/typescript-sdk
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://modelcontextprotocol.io/specification/2026-07-28
