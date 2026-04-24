# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you believe you have found a security vulnerability in Junior, please report
it privately so that we can investigate and remediate before public disclosure.

Send a description of the issue, including:

- A clear description of the vulnerability
- Steps to reproduce it
- The version of Junior affected (see `package.json` `version`)
- The version of VS Code, OS, and Node.js you are running
- Any proof-of-concept code or screenshots, if applicable

Send the report to: **[security contact email — TODO replace before publishing]**

You should receive an acknowledgement within a few business days. We will work
with you to understand the issue, develop a fix, and coordinate disclosure.

## Scope

In scope:

- The Junior VS Code extension (everything under this repository)
- Bundled sample settings files
- The build and packaging scripts (`deploy.ps1`, `esbuild.mjs`)

Out of scope:

- Vulnerabilities in upstream dependencies — please report those to the
  respective upstream project. We track and patch dependency CVEs through
  normal release cycles.
- Vulnerabilities in the Azure OpenAI service, GitHub Copilot CLI, or any
  third-party AI provider Junior connects to. Report those to the provider.
- Misconfiguration in user-supplied `settings.json` (for example, leaving an
  API key in source control).

## What We Care About

The highest-risk surfaces in Junior are:

1. **The chat webview** — model output is rendered as HTML. We strictly escape
   all model-supplied content and use a CSP with a per-load nonce. Reports of
   any path that lets model output execute script in the webview are taken
   very seriously.
2. **Tool execution** — agent tools can read/write files and execute terminal
   commands with the user's privileges. Reports of permission-bypass paths or
   prompt-injection that escalates beyond confirmed permission scope are
   high-priority.
3. **Secret handling** — API keys, bearer tokens, and OAuth refresh tokens.
   Reports of these being logged, persisted to disk, or transmitted outside
   the configured provider endpoint are high-priority.

## Supported Versions

Only the latest released version receives security updates.
