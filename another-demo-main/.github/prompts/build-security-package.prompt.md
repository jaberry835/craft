---
name: "Build Security Package"
description: "Run the local evidence-driven workflow for selected controls and prepare the package for human review."
argument-hint: "Controls or families to build, such as AU-2 SC-7"
agent: "Security Package Builder"
---

Build and evaluate the requested controls using only the local `security-package/` sources and already-configured MCP tools.

For each control, identify the authoritative requirement, map available evidence, write a cited response, record gaps, collect locally derivable artifact links, and validate the result. Do not publish unless I explicitly request it. If a required source or environment configuration is absent, preserve the gap and use `Not Assessed` rather than guessing.