## 1. Documentation and Typecheck Contract

- [x] 1.1 Update README.md, docs/distribution.md, and docs/release.md one-shot commands to use `bunx -p orca-ts orca ...` and `bunx -p orca-ts@X.Y.Z orca --version`.
- [x] 1.2 Clarify in README.md and docs/distribution.md that zero-project standalone binary flows skip typecheck when no `tsconfig.json` exists.
- [x] 1.3 Document that project typechecking requires `typescript`, `tsconfig.json`, and a local `orca-ts` dependency.
- [x] 1.4 Tighten skipped-typecheck CLI warning text in src/runner/typecheck.ts or src/cli/main.ts when it implies `typescript` alone is enough.

## 2. Runtime and Testing Entry Boundaries

- [x] 2.1 Remove test helper re-exports from the root runtime barrel in src/index.ts.
- [x] 2.2 Keep test helpers available through the explicit `orca-ts/testing` entry point and repository test-utils path.
- [x] 2.3 Update internal tests and fixtures that depended on root-exported test helpers to import from ../src/test-utils/index.ts or `orca-ts/testing`.
- [x] 2.4 Refactor src/cli/embedded.ts so the standalone fallback embeds only `orca-ts` and `orca-ts/model` runtime-safe entry points.
- [x] 2.5 Lazy-load `ensureOrcaResolvable` in src/cli/main.ts after `--help`, `--version`, typecheck, and backend env setup.

## 3. Targeted Verification

- [x] 3.1 Add or update tests proving root imports stay runtime-safe and no longer expose test helpers.
- [x] 3.2 Add or update tests proving `orca-ts/testing` remains available for test helper imports.
- [x] 3.3 Add or update tests proving `orca --version` and `orca --help` do not evaluate the embedded runtime fallback.
- [x] 3.4 Keep compiled binary smoke coverage for a temp flow importing `orca-ts`.
- [x] 3.5 Run focused checks: `bun test tests/cli.test.ts tests/typecheck.test.ts` plus any changed import-boundary tests.
- [x] 3.6 Run release gates: `bun run validate:release`, `bun run smoke:binary`, `bun run verify`, and `bun run lint`.
