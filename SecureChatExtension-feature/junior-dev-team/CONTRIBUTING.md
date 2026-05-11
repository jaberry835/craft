# Contributing to Junior

Thanks for your interest in contributing.

## Reporting Issues

- **Security vulnerabilities:** see [SECURITY.md](SECURITY.md). Do **not** open
  a public issue.
- **Bugs and feature requests:** open an issue and include the Junior version,
  VS Code version, OS, and steps to reproduce. Logs from the **Junior** output
  channel are usually the most useful attachment.

## Development Setup

```pwsh
git clone https://github.com/adamruderman/junior.git
cd junior
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host with Junior
loaded. See [docs/developer-getstarted.md](docs/developer-getstarted.md) for a
fuller walkthrough.

## Building and Testing

| Task | Command |
|---|---|
| Type-check + bundle | `npm run compile` |
| Watch mode | `npm run watch` |
| Run unit tests | `npx vitest run` |
| Build a VSIX | `.\deploy.ps1 build` |

All pull requests should:

- Pass `npx vitest run` with zero failures.
- Add or update tests when changing behavior of a tested module.
- Keep `npm run compile` clean (no new TypeScript errors or warnings).

## Code Style

- TypeScript, strict mode (see [tsconfig.json](tsconfig.json)).
- Prefer small, focused modules over large monoliths. Recent refactors split
  `chatViewProvider` into `providerRouter`, `sessionRestore`, etc. — keep that
  trend going.
- Match the existing formatting (4-space indent, single quotes, semicolons).
- No new top-level dependencies without discussion in an issue first. The
  bundle size matters for an offline-capable extension.

## Pull Requests

1. Open an issue first for non-trivial changes so we can agree on the approach.
2. Keep PRs focused — one logical change per PR.
3. Update [CHANGELOG.md](CHANGELOG.md) under an "Unreleased" heading.
4. Reference the issue number in the PR description.
5. Be patient with review — this is a small project.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you agree to abide by it.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License (see [LICENSE](LICENSE)).
