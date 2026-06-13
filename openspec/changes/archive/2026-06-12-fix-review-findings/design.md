## Context

The published package is named `orca-ts`, while the executable command remains `orca`. Current one-shot docs do not consistently express that split. The standalone binary also creates an embedded `orca-ts` package fallback for flows without a local install, but that fallback currently includes the testing entry point and can therefore drag `bun:test` into the runtime graph.

The intended v1 shape stays unchanged: project installs use `orca-ts` for typed authoring, the binary command is `orca`, runtime-only standalone flows can run without a local dependency, and tests import helpers through an explicit testing entry point.

## Goals / Non-Goals

**Goals:**
- Make docs distinguish package install name from executable command name.
- Document the exact default typecheck behavior for project installs and zero-project standalone flows.
- Keep the root `orca-ts` import runtime-safe by removing test-only exports.
- Keep `orca-ts/testing` available for repository tests and consumers that intentionally need test helpers.
- Keep compiled binary smoke coverage for a temp flow importing `orca-ts`.
- Keep cheap CLI paths cheap: `--help` and `--version` should not evaluate the embedded runtime fallback.

**Non-Goals:**
- Do not rename the package from `orca-ts`.
- Do not rename the executable from `orca`.
- Do not add an `orca-ts` binary alias or compatibility shim.
- Do not redesign backend selection.
- Do not support `orca-ts/testing` from the standalone embedded fallback.

## Decisions

1. Keep the package/bin split explicit in docs.
   - Decision: use `bunx -p orca-ts orca ...` and version-pinned `bunx -p orca-ts@X.Y.Z orca --version` examples.
   - Alternative considered: add an `orca-ts` executable alias. Rejected because it expands the public surface to paper over documentation confusion.

2. Treat standalone typecheck skip as a documented runtime mode, not an error.
   - Decision: document that binary flows without `tsconfig.json` skip typecheck, while project typechecking needs `typescript`, `tsconfig.json`, and a local `orca-ts` dependency.
   - Alternative considered: require standalone users to create a project before any run. Rejected because runtime-only standalone flows are an explicit supported path.

3. Keep the root barrel runtime-only.
   - Decision: remove test helpers from `src/index.ts`; consumers that need helpers import `orca-ts/testing`.
   - Alternative considered: keep root re-exports for convenience. Rejected because it makes runtime imports pull test-only code and risks `bun:test` in binary execution.

4. Embed only runtime-safe modules in the standalone fallback.
   - Decision: register embedded modules for `orca-ts` and `orca-ts/model` only. Do not emit an embedded `testing.cjs` fallback.
   - Alternative considered: keep embedding `orca-ts/testing`. Rejected because the binary fallback is for flow execution, not test authoring.

5. Lazy-load embedded fallback setup from the CLI.
   - Decision: import `ensureOrcaResolvable` after parsing, `--help`/`--version`, typecheck, and backend env setup.
   - Alternative considered: keep the top-level import. Rejected because cheap CLI paths should not evaluate the embedded runtime graph.

## Risks / Trade-offs

- Root test helper removal is a public API cutover → acceptable before stable release; docs and tests must point to `orca-ts/testing`.
- Flows that import `orca-ts/testing` through the standalone binary fallback will fail → acceptable because the fallback is runtime-only and avoids shipping test code in the binary graph.
- Published `bunx -p` commands cannot be fully network-tested before publish → mitigate with release metadata validation and local binary smoke.
- Typecheck skip messaging can become too broad → keep tests around missing-project setup and explicit skip behavior.

## Migration Plan

1. Update docs and release notes first so users see the correct public contract.
2. Cut root test helper exports and migrate internal tests/fixtures to the explicit testing entry point.
3. Restrict embedded fallback modules and lazy-load fallback setup in the CLI.
4. Add focused tests for root/testing import boundaries, cheap CLI paths, typecheck skip messaging, and binary smoke.
5. Run focused checks, then the full deterministic release gate.

Rollback is a normal revert of the change set before publish. No data migration or external service rollback is involved.

## Open Questions

- None.
