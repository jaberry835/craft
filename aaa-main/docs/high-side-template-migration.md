# High-Side Template Migration

## Purpose

Moving a newer AAA release from the low side to the high side must not replace the high-side
project template wholesale. The high-side template may contain environment-specific knowledge,
refined skills, approved instructions, MCP configuration, and operating procedures that do not
exist on the low side.

Use this process to rebuild the high-side template by integrating upstream changes into the
existing high-side version. The process is intentionally reviewable and reversible. It is not a
folder-copy or "take incoming" operation.

## What is being migrated

The reusable project template is normally `templates/default-project/` or the directory configured
by `AAA_PROJECT_TEMPLATE`.

Template-managed customizations include:

| Surface | Typical path | Migration rule |
| --- | --- | --- |
| Agents | `.github/agents/*.agent.md` | Merge instructions and frontmatter semantically; retain approved high-side operating knowledge. |
| Skills | `.github/skills/<id>/SKILL.md` | Merge procedures step by step and reconcile every referenced asset. |
| Skill assets | `.github/skills/<id>/assets/**` | Preserve high-side templates and examples unless the incoming version deliberately replaces them. |
| Prompts | `.github/prompts/*.prompt.md` | Merge command behavior, agent selection, argument hints, and instructions. |
| Standing instructions | `.github/copilot-instructions.md`, `.github/instructions/**` | Preserve high-side policies and add compatible incoming guidance. |
| MCP configuration | `.vscode/mcp.json` | Preserve high-side server names, URLs, auth modes, and environment-variable references. Never insert literal secrets. |
| Evidence guidance | `evidence/**` | Merge provenance and storage guidance without deleting high-side conventions. |
| Package seed content | skill assets under `initialize-security-package` | Merge structure and document templates; do not use an active project's generated package as the reusable seed. |

AAA built-in tools such as `read_file`, `write_file`, and `browser_capture` are implemented in
application code, not in `templates/default-project/`. Upgrade those through the normal application
code migration. The template migration covers references to built-in tools and any MCP tools
configured in `.vscode/mcp.json`.

Existing project workspaces are not automatically changed when the reusable template changes.
Migrate the reusable template first. Upgrade individual existing projects separately, with their
own backup and review, only when requested.

## Required inputs

A safe migration uses three versions:

1. **Previous baseline**: the exact low-side template version from which the current high-side
   template was originally built. Prefer a Git commit, tag, release bundle, or retained clean copy.
2. **High-side current**: the working high-side template containing local knowledge and approvals.
3. **Incoming baseline**: the template from the newly transferred low-side release.

This is a three-way merge:

```text
previous baseline ──► incoming baseline   = upstream changes
        │
        └──────────► high-side current    = high-side changes
```

If the previous baseline is unavailable, perform a conservative two-way migration. Treat every
high-side difference as intentional, do not delete high-side-only content, and require human
decisions for overlapping changes.

Record the following before editing:

- previous baseline commit/tag or bundle identifier;
- incoming release commit/tag or bundle identifier;
- absolute path to the high-side current template;
- absolute path to the incoming baseline;
- backup location;
- migration report location;
- known high-side-only requirements and protected files.

## Migration procedure

### 1. Freeze and back up

1. Stop template edits for the duration of the migration.
2. Copy the complete high-side current template to a timestamped, read-only backup outside the
   destination tree.
3. Record checksums or a file inventory for the backup.
4. Confirm that the backup contains hidden directories such as `.github` and `.vscode`.
5. Do not proceed until the backup can be read.

Suggested layout:

```text
migration/
  previous-baseline/
  incoming-baseline/
  high-side-backup/
  work/
```

Perform edits only in `work/`, then replace the high-side template through the environment's
approved deployment process after validation.

### 2. Inventory all three versions

Create a table containing every relative path and classify each path:

- unchanged from the previous baseline;
- changed only upstream;
- changed only on the high side;
- changed in both;
- added only upstream;
- added only on the high side;
- deleted upstream;
- deleted on the high side.

Do not rely only on filenames. For Markdown customizations, compare frontmatter and body
instructions separately. For skills, also inventory assets and every path referenced by `SKILL.md`.
For MCP configuration, compare each server object by server name.

### 3. Apply non-conflicting changes

- **Upstream-only change**: apply it to `work/`.
- **High-side-only change**: preserve it.
- **Upstream-only addition**: add it, including all required assets and references.
- **High-side-only addition**: preserve it.
- **Unchanged file**: leave it unchanged.

An upstream deletion is not permission to delete a high-side file. Determine why it was removed and
whether the high-side behavior still depends on it.

### 4. Reconcile files changed on both sides

Merge behavior, not lines:

1. State the purpose of the previous, high-side, and incoming versions.
2. List the behavior added or changed on each side.
3. Preserve high-side policy, environment knowledge, terminology, evidence rules, and approved
   workflow constraints.
4. Incorporate incoming bug fixes, safer procedures, new capabilities, and compatible schema
   changes.
5. Remove high-side behavior only with an explicit recorded decision.
6. Update references when files, skill IDs, prompt IDs, agent IDs, or asset paths changed.
7. Mark unresolved conflicts in the migration report; do not leave conflict markers in template
   files.

Do not solve a conflict by concatenating two instruction bodies. Produce one coherent procedure
with duplicate and contradictory steps removed.

### 5. Apply surface-specific rules

#### Agents

- Preserve high-side mission context, boundaries, escalation rules, and environment terminology.
- Reconcile `name`, `description`, `argument-hint`, `tools`, and optional `foundry-*` frontmatter.
- Environment-specific endpoints and credentials must remain environment-variable references.
- Confirm referenced skills, prompts, and MCP servers exist after the merge.

#### Skills and assets

- Read the entire old, high-side, and incoming skill before editing.
- Preserve high-side procedural knowledge and evidence expectations.
- Integrate incoming safety checks and corrected steps in their logical position.
- Verify every referenced asset exists and that copied template content matches the merged procedure.
- Do not silently replace high-side document templates with generic low-side versions.

#### Prompts and standing instructions

- Preserve high-side governance and reviewer boundaries.
- Keep prompt frontmatter valid and ensure the selected agent still exists.
- Remove duplicated instructions that are already guaranteed by standing instructions only when
  doing so does not make the prompt ambiguous outside that context.

#### MCP servers and tools

- Merge servers by stable server name.
- Preserve high-side URLs, auth modes, scopes, sovereign-cloud settings, and environment-variable
  names unless the incoming release explicitly requires a reviewed schema change.
- Never copy `.env`, tokens, keys, passwords, connection strings, or literal authorization headers.
- Test discovery and schemas for enabled servers; unavailable high-side services must be reported,
  not silently removed.

#### Package seed content

- Compare package structure and document contracts, not just sample text.
- Preserve approved high-side control language, evidence fields, and review gates.
- Integrate incoming schema additions and corrected templates.
- Keep generated project evidence and completed control responses out of the reusable template.

### 6. Validate the rebuilt template

At minimum:

1. Parse every customization file and `.vscode/mcp.json`.
2. Confirm every skill, prompt, agent, instruction, and enabled MCP server is discoverable.
3. Check that all referenced files and assets exist.
4. Search for conflict markers, absolute low-side paths, literal secrets, and stale IDs.
5. Create a disposable project from the rebuilt template.
6. Exercise initialization, one representative skill, one prompt, file creation, validation, and
   MCP discovery where the service is available.
7. Run the repository lint, build, automated tests, and browser workflow tests.
8. Compare the rebuilt template with the high-side backup and explain every deletion.

No deletion is accepted merely because it exists in the incoming diff.

### 7. Produce a migration report

Create a dated report under an approved high-side location, for example
`docs/migrations/YYYY-MM-DD-template-migration.md`, containing:

- input versions and paths;
- backup path and checksum/inventory location;
- files added, changed, preserved, renamed, and deleted;
- high-side knowledge explicitly preserved;
- conflicts and their resolutions;
- unresolved decisions;
- validation commands and results;
- final template commit or package identifier;
- rollback instructions.

Keep the report with the high-side source history. Do not copy sensitive high-side details back to
the low side.

### 8. Promote and retain rollback

1. Commit the rebuilt template and migration report to high-side source control.
2. Review the diff and report with the template owner.
3. Promote the rebuilt template through the approved high-side process.
4. Create a disposable project and repeat the smoke test from the promoted location.
5. Retain the backup and previous baseline until the new template has been accepted.
6. Record the incoming baseline commit/tag so it becomes the previous baseline for the next
   migration.

## GitHub Copilot task

Use the following prompt in GitHub Copilot agent mode after all three inputs are available. Replace
the bracketed values before running it.

```text
Follow docs/high-side-template-migration.md exactly.

Rebuild the high-side AAA project template by performing a non-destructive three-way migration.

Inputs:
- Previous low-side baseline: [PATH OR GIT COMMIT/TAG]
- Current high-side template: [PATH]
- Incoming low-side baseline: [PATH OR GIT COMMIT/TAG]
- Read-only backup destination: [PATH]
- Working-copy destination: [PATH]
- Migration report: [PATH]
- Protected high-side files or requirements: [LIST]

Required behavior:
1. Read the migration guide and inventory all three template versions before editing.
2. Back up the complete current high-side template, including hidden files.
3. Classify every file as unchanged, upstream-only, high-side-only, changed on both sides,
   added, or deleted.
4. Preserve all high-side-only knowledge, policies, environment configuration, skills, assets,
   prompts, instructions, MCP servers, and evidence conventions.
5. Integrate compatible incoming fixes and capabilities semantically. Do not overwrite whole
   directories or resolve conflicts by blindly taking the incoming version.
6. Never copy or expose secrets. Keep credentials as environment-variable references.
7. Do not delete high-side content without an explicit, documented reason. Stop and request a
   decision when intent is ambiguous.
8. Validate references, frontmatter, JSON, skill assets, MCP discovery, a disposable project,
   lint, build, tests, and browser workflows as applicable.
9. Write the migration report with inputs, decisions, preserved knowledge, file-level results,
   validation evidence, unresolved items, and rollback instructions.
10. Present the final diff and report for human approval before replacing the active high-side
    template. Do not deploy, publish, or delete the backup automatically.

Treat the current high-side template as valuable user-authored source, not generated output.
```

## Copilot completion checklist

Before Copilot reports completion, require all of the following:

- [ ] Backup created and verified.
- [ ] Previous and incoming baseline identifiers recorded.
- [ ] Three-way inventory produced.
- [ ] High-side-only files preserved.
- [ ] Every overlapping change has a written resolution.
- [ ] No literal secrets or low-side absolute paths introduced.
- [ ] Agent, prompt, skill, instruction, MCP, and asset references validated.
- [ ] Disposable project created from the rebuilt template.
- [ ] Relevant lint, build, tests, and browser checks passed.
- [ ] Every deletion explained.
- [ ] Migration report written.
- [ ] Final diff awaiting human approval.
- [ ] Rollback remains available.
