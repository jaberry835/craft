---
name: validate-security-package
description: "Validate security control responses for traceability, unsupported claims, missing evidence, broken local references, status consistency, and human-review boundaries. Use after generating responses or before publishing a security package."
argument-hint: "Optionally provide a control ID; otherwise validate all generated responses"
---

# Validate Security Package

Evaluate package quality without changing assessment facts.

## Checks

1. Every response uses the standard headings and one allowed determination.
2. Every material implementation or assessment claim cites an evidence ID.
3. Every cited evidence ID exists exactly once in `standard-docs/evidence-register.md`.
4. Every evidence entry has a source path, locator, collection method, and limitation statement.
5. Every local source path exists. URL reachability is not required in the air-gapped demo.
6. `Satisfied` responses have evidence for every decomposed requirement statement.
7. Missing requirements or indispensable evidence result in `Not Assessed`, not `Not Satisfied`.
8. Contradictory evidence is disclosed rather than silently reconciled.
9. Navigation links are not presented as evidence unless a capture is locally registered.
10. Human determination fields remain unapproved.

## Output

Write `security-package/standard-docs/validation-report.md` with:

- timestamp supplied by the environment, or `Not recorded` if unavailable;
- scope;
- `Pass`, `Warning`, and `Fail` findings;
- affected control and evidence IDs;
- exact remediation needed;
- overall result of `Ready for human review` or `Not ready for human review`.

Do not publish when any `Fail` remains.