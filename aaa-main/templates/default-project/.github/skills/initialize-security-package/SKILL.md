---
name: initialize-security-package
description: "Create a repeatable security package from the bundled offline template, or add control families without overwriting existing work. Use when starting a new package, cloning the package structure, adding AU/SC/AC families, or repairing missing starter files."
argument-hint: "Destination and optional families, for example: packages/demo AU SC AC"
---

# Initialize Security Package

Create a package by copying the bundled offline template with the `copy_path` tool. Do not hand-write the template files, and do not run scripts.

## Procedure

1. Ask for a destination only when it cannot be inferred. Default to `security-package`.
2. Ask which control families to create when they are not provided. For the demo, default to `AU` and `SC`.
3. Copy the clean template into the destination. `copy_path` never overwrites existing files, so this is safe to repeat and also repairs missing starter files:

   - source: `.github/skills/initialize-security-package/assets/security-package-template`
   - destination: `security-package` (or the chosen destination)

4. Normalize each control family to uppercase and validate it against `^[A-Z][A-Z0-9-]{1,15}$`. Reject invalid names.
5. Update `<destination>/package-config.json` with `edit_file`:
   - merge the families into `controlFamilies` (sorted, no duplicates);
   - set `packageName`, `systemName`, `portalBaseUrl`, or `documentationBaseUrl` only when the user supplied them.
6. For each family, create `<destination>/control-responses/<FAMILY>/README.md` with `write_file` only if it does not already exist:

   ```markdown
   # <FAMILY> Control Responses

   Generated <FAMILY> control responses belong in this directory. Use one Markdown file per control.
   ```

7. Verify the destination contains `cloud-scan`, `background-docs`, `security-standards`, `standard-docs`, and `control-responses/<FAMILY>`.
8. Report created and preserved items from the `copy_path` result. Do not fabricate source documents.

## Constraints

- Existing files are always preserved. Never replace a user file with template content unless the user explicitly asks for that specific file to be refreshed.
- Do not rename or delete user files.
- Do not place generated responses in a source directory.
- Keep all paths relative so the package remains portable across disconnected environments.
- The bundled template is the source for new packages; the active `security-package/` directory is never used as a template.
