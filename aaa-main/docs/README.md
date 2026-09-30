# AAA documentation

AAA (A&A Accelerator) is a local-first workbench for building, reviewing, and publishing authorization and assessment (A&A) packages. It combines a project file workspace, AI-assisted workflows, evidence collection, and human review controls in one application.

## Documentation map

- [Application purpose](purpose.md) explains the problem AAA addresses, its users, its core workflow, and its boundaries.
- [Feature status](feature-status.md) records what is complete, partially complete, not complete, or intentionally out of scope.
- [High-side template migration](high-side-template-migration.md) defines the non-destructive
  Copilot-assisted process for integrating a new low-side template without overwriting high-side
  skills, instructions, MCP configuration, or local knowledge.
- [Office document automation](office-document-automation.md) records the decision to keep
  Word/Excel manipulation in a separate high-side MCP service, with canonical Markdown/structured
  data, provenance manifests, safe binary handoff, and controlled round-tripping.
- The repository [README](../README.md) remains the operational reference for installation, configuration, environment variables, and validation commands.

## At a glance

AAA is intended to help security and authorization teams:

1. Create or register a project workspace.
2. Collect source material and evidence without giving an AI agent unrestricted machine access.
3. Run project-defined agents, prompts, skills, instructions, and approved tools.
4. Draft and validate security-package artifacts.
5. Review generated Markdown before it can be rendered as a publishable document.
6. Publish through a configured HTTP MCP integration when one is available.

The application is currently version `0.1.0`. It is a working application with automated server and browser coverage, but it still has known incomplete governance features. In particular, lifecycle hooks and approval gates for higher-impact actions are not implemented.

## Status convention

The feature inventory uses these labels:

- **Complete**: implemented in the application and represented by code, API routes, or automated tests.
- **Partial**: usable, but a documented part of the intended capability or its validation is still missing.
- **Not complete**: explicitly presented as coming soon or remaining work.
- **Out of scope**: deliberately unsupported by the current product design; it should not be mistaken for unfinished functionality.

Feature status is a repository checkpoint, not a production-readiness or security certification. See [Feature status](feature-status.md) for the checkpoint date and evidence.
