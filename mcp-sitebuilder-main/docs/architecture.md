# Architecture

## Runtime

One Node.js process runs on Linux Azure App Service. It exposes versioned REST routes and a stateless Streamable HTTP MCP endpoint. A bounded single-concurrency worker polls Azure Queue Storage in the same process. The initial App Service plan is fixed to one instance.

## Storage layout

- `sitebuilder-staging`: immutable validated manifests keyed by operation ID.
- `sitebuilder-operations`: durable operation state documents.
- `sitebuilder-jobs`: queue containing only operation IDs.
- `$web/sites/{siteId}/versions/{version}`: immutable generated output.
- `$web/sites/{siteId}/index.html`: stable pointer switched after successful upload.
- `$web/catalog.json` and `$web/index.html`: current machine and human catalogs.

Catalog mutations use conditional ETag writes with bounded retry. A failed build does not change the stable site pointer or catalog.

## Trust boundaries

Markdown and plain text are untrusted. Paths are normalized before staging, raw Markdown HTML is discarded, output HAST is sanitized, plain text is escaped, and caller JavaScript/CSS/packages are not supported. Generated Blob static websites are public and anonymous. Classification bars are markings only, not authorization controls.

`interactive-docs-v1` is a trusted repository-owned template. Publication may copy its prebuilt
browser asset and generated search data, but never compiles or executes publisher content. All
pages are rendered completely on the server first, including the classification bar and navigation;
JavaScript only progressively enhances enabled features.

## Scale boundary

The embedded worker is appropriate for the initial one-instance POC. Before scaling App Service beyond one instance, validate queue visibility renewal, per-site publication locking, poison-message handling, and catalog contention, or move the worker to a separately managed runtime available in the target region.
