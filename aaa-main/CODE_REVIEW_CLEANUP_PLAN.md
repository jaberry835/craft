# Application Code Review, Cleanup, and Test Plan

## Goals

- Review every production TypeScript and React module in `server/` and `src/`.
- Preserve all existing behavior while improving readability, consistency, and maintainability.
- Remove unused imports, variables, functions, and unreachable or obsolete test code.
- Consolidate meaningful duplicate logic and simplify unnecessarily nested control flow.
- Ensure important behavior has unit and integration coverage.
- Finish with a clean lint, build, full test, and browser integration run.

## Baseline

- The server test suite passes.
- Lint and build are currently blocked by `server/test/zz-repro.test.ts`:
  - unused `loadAppAuthConfig` import;
  - DOM globals embedded in a server-compiled test callback.
- Existing tests cover the primary server services, API routes, authentication, model clients,
  project workflows, storage, and selected client utilities.
- Browser coverage exists, but one regression test is a debugging artifact rather than a stable,
  maintainable end-to-end test.

## Execution Plan

### 1. Inventory and risk mapping

- Map each production module to direct unit, API integration, or browser coverage.
- Identify large modules, duplicated helpers, dead exports, deeply nested paths, and inconsistent naming.
- Prioritize authentication, project boundaries, file operations, persistence, model streaming, and
  browser capture because regressions there have the largest impact.

### 2. Test harness cleanup

- Convert or replace debugging-style tests with deterministic assertions.
- Remove console dumps, screenshots, unused imports, and DOM typing leaks.
- Keep browser tests optional when Edge or a built client is unavailable.

### 3. Server cleanup

- Review all modules under `server/` and `server/services/`.
- Remove dead code and consolidate duplicate parsing, validation, error, and resource-cleanup logic
  only where the shared abstraction is clearer than the repeated code.
- Simplify nested logic and normalize naming without changing public API behavior.

### 4. Client cleanup

- Review all modules under `src/`.
- Extract testable pure logic from large components where it reduces duplication or nesting.
- Remove unused client code, normalize naming, and preserve the current UI and API contract.

### 5. Coverage expansion

- Add focused unit tests for uncovered pure logic and boundary conditions.
- Add API integration coverage for authentication, authorization, validation, and response contracts.
- Add or stabilize browser tests for critical user workflows that cannot be validated below the UI layer.
- Use coverage output as a guide, not as a substitute for meaningful behavioral assertions.

### 6. Final validation and review report

- Run formatting checks through ESLint.
- Run the TypeScript and Vite production build.
- Run the complete server/unit/integration suite.
- Run browser tests against the production build when Edge is available.
- Run coverage and document material remaining gaps or intentional exclusions.
- Review the final diff for accidental behavior changes and summarize findings and fixes.

## Completion Criteria

- Lint and build pass.
- All automated tests pass, with environment-dependent skips explicitly reported.
- Critical server and client workflows have direct behavioral coverage.
- No known unused imports, variables, functions, debug logging, or generated artifacts remain in source.
- Cleanup changes are focused, reviewed, and behavior-preserving.

## Execution Status

- [x] Captured the baseline: tests passed while lint and build failed on a duplicate debug test.
- [x] Removed the superseded debug browser test and restored clean lint/build validation.
- [x] Reviewed all production modules and mapped direct or integration coverage.
- [x] Extracted file-tree and display helpers from the main React component and added unit coverage.
- [x] Made access-policy persistence recover after a failed queued write and added a regression test.
- [x] Serialized local session mutations to prevent concurrent updates from overwriting each other.
- [x] Added client API coverage for authentication refresh, structured errors, streaming, and incomplete streams.
- [x] Added token-usage aggregation and context-compaction unit coverage.
- [x] Consolidated repeated browser-test startup and teardown code.
- [x] Added browser coverage for chat rendering, file/folder operations, large-file previews, authentication,
  and the complete create/initialize/build/publish workflow.
- [x] Completed final full-suite, coverage, lint, build, browser, and diff validation.

## Final Validation

- Full automated suite: 150 tests, 149 passed, 1 environment-dependent live MCP test skipped.
- Browser integration: 4 tests passed against the production build using Microsoft Edge.
- Measured loaded-module coverage: 86.31% lines, 80.01% branches, and 86.38% functions.
- Core server modules generally exceed 85% line coverage; authentication, MCP authorization,
  compaction, file operations, access control, and persistence have direct regression coverage.
- Client pure logic loaded by the Node test harness now has direct unit coverage. React interaction
  paths are covered through production-build browser tests rather than DOM emulation.
- ESLint, TypeScript compilation, Vite production build, and `git diff --check` pass.
