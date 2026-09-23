---
name: collect-artifact-links
description: "Build an offline artifact-link index from Azure resource IDs, locally configured portal endpoints, and approved high-side documentation references. Use for Azure portal links, evidence navigation, document links, or screenshot capture queues."
argument-hint: "Name a control, evidence ID, or source file whose links should be indexed"
---

# Collect Artifact Links

Create navigation references without claiming that a target was reached or captured.

## Procedure

1. Read endpoint values from `security-package/package-config.json`.
2. Inspect only the requested control response and its registered evidence.
3. Extract exact Azure resource IDs and exact document paths from local sources.
4. If an approved portal base URL is configured, append an encoded resource ID using that environment's documented URL convention. If the convention is unknown, record the resource ID and mark the URL `Needs configuration`.
5. Resolve documentation paths only against the configured documentation base URL. Do not guess page slugs.
6. Add or update rows in `standard-docs/artifact-index.md`.
7. Mark each item with one state: `Reference only`, `Capture requested`, `Captured`, or `Unavailable`.
8. Mark screenshot artifacts `Captured` only when an actual local file or MCP result exists and is registered as evidence.

## Constraints

- Do not access public endpoints.
- Do not infer tenant names, portal hosts, subscriptions, or document paths.
- A generated link is a convenience pointer, not authoritative evidence.