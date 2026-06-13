## Why

Recent review found release/documentation and runtime boundary issues that would make the `orca-ts` package harder to use safely: `bunx` examples conflate package and binary names, standalone typecheck behavior is underspecified, and runtime entry points can pull test-only code into the compiled binary graph.

This change keeps the intended product shape intact while making the package boundary, CLI behavior, and verification gate match what users and maintainers rely on.

## What Changes

- Correct one-shot CLI documentation to use the package/bin split: `bunx -p orca-ts orca ...`.
- Clarify standalone binary typecheck behavior: zero-project flows skip typecheck when no `tsconfig.json` exists; project typechecking requires `typescript`, `tsconfig.json`, and a local `orca-ts` dependency.
- Tighten skipped-typecheck warning text so it points at missing project setup, not only missing `typescript`.
- **BREAKING** Remove test helpers from the root runtime barrel; keep them available through the explicit `orca-ts/testing` entry point.
- Keep the standalone CLI fallback runtime-safe by embedding only flow execution entry points and excluding `bun:test` imports.
- Lazy-load runtime fallback resolution after cheap CLI paths such as `--help` and `--version`.
- Add targeted tests and release checks for docs metadata, root/testing export boundaries, cheap CLI paths, and compiled binary smoke.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `distribution`: Clarifies supported CLI invocation, typecheck prerequisites, public runtime/testing entry-point boundaries, and release verification expectations.

## Impact

- `README.md`, `docs/distribution.md`, and `docs/release.md` documentation.
- CLI/typecheck code in `src/cli/main.ts`, `src/cli/embedded.ts`, and `src/runner/typecheck.ts`.
- Public export boundaries in `src/index.ts` and the explicit testing entry point.
- Tests and fixtures that import test utilities or verify binary/CLI behavior.
- Release validation and binary smoke checks.
