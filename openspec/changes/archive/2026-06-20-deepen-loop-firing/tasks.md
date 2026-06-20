## 1. Firing Contract Tests

- [x] 1.1 Add tests for event envelope encoding and decoding, including missing event and raw-string fallback.
- [x] 1.2 Add tests for child spawn spec construction from a loop target and trigger event.
- [x] 1.3 Add tests for one-shot loop firing success, loop failure, sink failure, diagnostics, and exit-code mapping.
- [x] 1.4 Add import-side-effect tests proving loop listing still does not start sources, run backends, or emit sinks.

## 2. Firing Module

- [x] 2.1 Introduce a loop firing module for event transfer, spawn spec construction, one-shot execution, diagnostics, and exit-code mapping.
- [x] 2.2 Move `ORCA_LOOP_EVENT` decoding into the firing module while preserving current compatibility behavior.
- [x] 2.3 Keep any new testing helpers internal or under `orca-ts/testing` only if required by deterministic tests.

## 3. Serve Refactor

- [x] 3.1 Refactor `serve()` to delegate child spawn spec construction to the firing module.
- [x] 3.2 Preserve supervisor ownership of source subscription, child handle tracking, child cleanup, and forced stop behavior.
- [x] 3.3 Add regression tests proving a served child receives the original trigger event.

## 4. CLI Refactor

- [x] 4.1 Refactor `orca run <loop>` to use the shared one-shot firing runner.
- [x] 4.2 Preserve legacy `orca <flow.ts>` execution, typecheck preflight, and `flowArgs()` behavior.
- [x] 4.3 Preserve `orca loops` import-only discovery behavior.
- [x] 4.4 Preserve existing CLI diagnostics and exit codes unless tests document an intentional additive change.

## 5. Documentation And Verification

- [x] 5.1 Update loop distribution docs if the shared firing contract affects user-facing wording.
- [x] 5.2 Run targeted distribution and CLI tests.
- [x] 5.3 Run `bun run typecheck` and docs checks.
- [x] 5.4 Run `bun run verify`.
