# Application purpose

## What AAA is

AAA is a local-first authorization workbench for producing and managing security authorization packages. It provides a React user interface and a local Express API around project files, model-assisted chat, reusable workflow customizations, evidence capture, review controls, and optional publishing integrations.

The application is designed to make AI assistance useful without making the AI the approval authority. Agents can inspect evidence, follow project-defined procedures, draft files, and call enabled tools. A person remains responsible for reviewing generated content and deciding when it is ready to publish.

## Problem it addresses

Authorization work commonly spans control responses, evidence registers, diagrams, validation reports, cloud artifacts, and reviewer feedback. That work can become fragmented across chat transcripts, local folders, web portals, and one-off automation.

AAA brings those activities into a project-centered workflow:

- **Repeatability** through versionable agents, skills, prompts, and instructions.
- **Traceability** through persisted conversations, agent runs, tool events, token usage, changed-file records, and evidence provenance.
- **Constrained automation** through project-root file controls, configurable tool availability, bounded agent runs, and explicit failure reporting.
- **Human review** through draft/review state for Markdown and protected publication metadata.
- **Deployment flexibility** through local JSON storage by default, optional Cosmos DB session storage, optional Microsoft Entra sign-in, and configurable model and MCP connections.

## Intended users

AAA is primarily aimed at:

- Security package authors drafting control responses and supporting documents.
- Assessors and reviewers checking evidence, citations, traceability, and package completeness.
- Platform or cloud teams collecting configuration evidence for an assessment.
- Workflow maintainers who define project agents, skills, prompts, instructions, and integrations.
- Administrators configuring model access, identity, storage, and project access policies.

## Core workflow

### 1. Start a project

A user creates a managed project from the bundled template or registers an existing folder. Managed projects receive reusable security-package workflows and evidence-folder guidance.

### 2. Configure capabilities

Project customizations expose the selected model connection, local agents, Microsoft Foundry agents, skills, prompts, instructions, HTTP MCP servers, and built-in tools. Capabilities can be enabled or disabled for subsequent runs.

### 3. Add source material and evidence

Users can create, edit, rename, delete, or upload supported files. They can also capture screenshots from a project-specific Microsoft Edge profile, attach project files to supported browser forms, and download validated results from enabled MCP servers.

### 4. Run an assisted workflow

The chat harness sends the conversation and applicable project instructions to the selected agent. The agent can load skills, inspect project files, make bounded edits, and call enabled HTTP MCP tools. Streaming responses show reasoning and tool activity, while run records preserve status, usage, errors, and changed files.

### 5. Review outputs

Generated Markdown remains a draft until a user marks its exact content as reviewed. Editing reviewed content returns it to draft. Protected local metadata prevents the project agent from marking its own work reviewed.

### 6. Publish or hand off

Reviewed Markdown can be rendered in the sandboxed Web preview. A project may also publish through an enabled HTTP MCP server, depending on the integration configured for that project.

## Trust and responsibility boundaries

AAA assists with package production; it does not determine that a system is authorized, compliant, or secure.

- Generated content and collected evidence still require qualified human review.
- Review state confirms that a person reviewed a specific file revision; it is not a digital signature or formal authorization decision.
- External model, Microsoft Foundry, Azure, MCP, and web services retain their own security and availability characteristics.
- Browser profiles can contain authenticated state and must be protected according to the target environment's data-handling policy.
- Project access control is unrestricted in local mode. Multi-user access restrictions require Microsoft Entra mode and configured project ACLs.
- AAA does not run arbitrary shell commands or scripts on behalf of an agent.

## Product boundaries

The current design intentionally limits several integration surfaces:

- MCP execution supports Streamable HTTP servers, not local `stdio` servers.
- MCP `${env:NAME}` references are supported; interactive `${input:...}` prompts are not.
- A Microsoft Foundry agent must expose an OpenAI-compatible Responses endpoint.
- Browser assistance does not fill passwords or submit external forms.
- The built-in agent toolset is project-scoped and cannot modify protected `.aaa`, `.git`, `.github`, or `.vscode` areas through destructive operations.

For incomplete capabilities and validation gaps, see [Feature status](feature-status.md).
