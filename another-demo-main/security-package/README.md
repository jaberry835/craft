# Security Package Contract

This directory is the portable boundary for one assessment package.

| Directory | Contents | Authority |
| --- | --- | --- |
| `cloud-scan/` | Exported Azure configuration and scan results | Technical evidence, subject to collection metadata |
| `background-docs/` | Correspondence, architecture context, and inherited information | Supporting context |
| `security-standards/` | Applicable controls, overlays, and security requirements | Requirement source |
| `standard-docs/` | Templates, evidence register, artifact index, and validation reports | Generated package-wide records |
| `control-responses/` | One Markdown response per control, grouped by family | Generated assessment drafts |

## Source precedence

1. Explicitly identified governing security standard
2. System-specific approved documentation
3. Collected technical evidence
4. Background correspondence
5. Analyst inference, clearly labeled

Conflicts must be disclosed. Lower-precedence material never silently overrides a governing requirement.

## Naming

- Control response: `control-responses/<FAMILY>/<CONTROL-ID>.md`
- Evidence ID: `EV-NNNN`
- Local evidence files should use stable, descriptive names and must not contain secrets.

Do not place credentials, tokens, passwords, private keys, or unredacted sensitive exports in this package.