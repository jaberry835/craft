---
name: initialize-security-package
description: "Create a repeatable security package from the bundled offline template, or add control families without overwriting existing work. Use when starting a new package, cloning the package structure, adding AU/SC/AC families, or repairing missing starter files."
argument-hint: "Destination and optional families, for example: packages/demo AU SC AC"
---

# Initialize Security Package

Create a package by running the bundled deterministic initializer. Do not manually recreate the tree when the script is available.

## Procedure

1. Ask for a destination only when it cannot be inferred. Default to `security-package`.
2. Ask which control families to create when they are not provided. For the demo, default to `AU` and `SC`.
3. From the workspace root, run:

   ```powershell
   & ./.github/skills/initialize-security-package/scripts/New-SecurityPackage.ps1 `
     -Destination "security-package" `
     -ControlFamilies AU,SC
   ```

4. Pass package metadata only when the user supplied it:

   ```powershell
   & ./.github/skills/initialize-security-package/scripts/New-SecurityPackage.ps1 `
     -Destination "packages/example" `
     -ControlFamilies AU,SC,AC `
     -PackageName "Example Authorization Package" `
     -SystemName "Example System"
   ```

5. Review the script summary. It copies missing files from [the clean template](./assets/security-package-template/README.md), creates requested family directories, and merges family names into `package-config.json`.
6. Verify the destination contains `cloud-scan`, `background-docs`, `security-standards`, `standard-docs`, and `control-responses/<FAMILY>`.
7. Report created, updated, and preserved items. Do not fabricate source documents.

## Script behavior

- Existing files are preserved by default.
- `-Overwrite` intentionally refreshes template files but never deletes extra user files.
- Control family names are normalized to uppercase and validated.
- The script has no external modules or network dependencies.
- The bundled template is the source for new packages; the active `security-package/` directory is never used as a template.

## Constraints

- Do not rename or delete user files.
- Do not place generated responses in a source directory.
- Keep all paths relative so the package remains portable across disconnected environments.
- Never use `-Overwrite` without explicit user approval.