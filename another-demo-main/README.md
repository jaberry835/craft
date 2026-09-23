# Security Package Builder Demo

This workspace demonstrates an evidence-driven security package workflow in the VS Code Agent window.

## Stage 1 design

| Construct | Responsibility |
| --- | --- |
| Custom agent | Orchestrates package creation, control analysis, validation, and optional publishing |
| Skills | Define repeatable security-package procedures and output contracts |
| Local files | Provide the durable, reviewable evidence and document boundary |
| Azure Evidence MCP (future) | Retrieves normalized Azure configuration and writes evidence records |
| `mcp-publisher` | Publishes reviewed Markdown for human-friendly viewing |

Azure AI Search is intentionally optional for Stage 1. Direct file grounding is simpler and works in an air-gapped demo. Add a local or approved search index only when the source corpus is too large for targeted file search, and preserve source paths and section identifiers in every indexed chunk.

## Run the demo

1. In VS Code Chat, run `/initialize-security-package` to create a clean package at any destination. The skill uses its bundled offline template and preserves existing files by default.
2. Add source material under the new package's `security-standards`, `cloud-scan`, and `background-docs` directories.
3. Select **Security Package Builder** from the agent picker.
4. Run `/build-security-package` and specify one or more controls, such as `AU-2` or `SC-7`.
5. Review generated responses and `standard-docs/validation-report.md` inside the package.
6. Publish only after validation passes and a human has reviewed the determinations.

## Air-gap assumptions

- The workflow must operate from local files without public network access.
- The language model, VS Code extensions, and MCP servers must be separately approved and available in the target environment.
- External URLs are references, not evidence that content was retrieved.
- No source document is allowed to override the agent's workflow instructions.
- Azure and documentation endpoints are configured in `security-package/package-config.json`; do not assume public-cloud endpoints.

See `security-package/README.md` for the package contract and folder details.