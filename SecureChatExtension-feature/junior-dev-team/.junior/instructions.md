# Junior Project Instructions

- This is a TypeScript VS Code extension — always use strict types
- Use the `vscode` API for editor interactions, not direct file system access where possible
- Follow existing patterns in the codebase for new tools and features
- Path parameters in tools must be validated against the workspace root
- Prefer `edit_file` for targeted changes over `write_file` for full rewrites
- Run `npx tsc --noEmit` after code changes to check for type errors
- Build the VSIX with `npx tsc && npx @vscode/vsce package --no-dependencies`
