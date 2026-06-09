# Finish Plan for Tasks 9.6 and 9.8

## Purpose

Close the last two open apply tasks for `port-orca-to-typescript` without weakening the approved OpenSpec scope.

- `9.6`: Add a gated real-repo integration smoke that runs one autonomous flow against a real backend when credentials are available.
- `9.8`: Run full verification: typecheck, unit tests, Tier 1 fixtures, Tier 2 golden flows, prompt parity, ADR matrix, build smoke, and docs/example checks.

The current implementation has parser, fixture, and argument-mapping coverage for the target backends, but the public backend constructors still route through `unsupportedBackend`. Therefore `9.6` must not be marked complete until at least one public backend constructor can run a live autonomous conversation end to end.

## Finish Spec

### Requirement: Public live backend path exists before the integration smoke

The system MUST expose at least one public backend constructor that starts a real backend process or transport and returns the shared read-only `Conversation` contract.

Acceptance criteria:

- `claude()`, `codex()`, `gemini()`, `pi()`, or `opencode()` no longer returns `unsupportedBackend` for the backend selected by the smoke.
- The selected backend uses the existing normalized parser path for its transport.
- `Conversation.canAskUser` remains `false`.
- `cancel()` signals the real transport and resolves the conversation as cancelled.
- Backend process stderr, startup failures, and malformed transport output surface as typed backend failures.

### Requirement: Gated real-repo smoke is safe by default

The integration smoke MUST be skipped unless explicitly enabled by environment. It MUST run in a disposable real git repository, not in the developer's working tree.

Acceptance criteria:

- Add a test such as `tests/integration/real-backend-smoke.test.ts`.
- The test runs only when `ORCA_REAL_BACKEND_SMOKE=1`.
- The selected backend is controlled by `ORCA_REAL_BACKEND`, defaulting to the first implemented live backend.
- The test creates a temporary git repository with minimal files and restores process state after execution.
- The prompt is bounded and non-destructive, for example: inspect the repository and return a small structured JSON result.
- The test fails when enabled but the backend command, credentials, or final result are unavailable.
- The test is skipped, not failed, during normal local and CI verification when the gate is absent.

### Requirement: Full verification is a single reproducible release gate

The release gate MUST cover deterministic checks and the optional live smoke separately.

Acceptance criteria:

- `bun run verify` passes without requiring external backend credentials.
- `bun run verify` includes typecheck, unit tests, Tier 1 fixtures, Tier 2 golden flows, prompt parity, ADR matrix, release metadata, declarations, and binary smoke.
- Add or document an explicit live check command, for example `ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts`.
- Task `9.8` is marked complete only after the deterministic gate passes after the `9.6` implementation.
- The final apply status reports `56/56` complete and `openspec validate "port-orca-to-typescript"` passes.

## Execution Plan

### 1. Wire the smallest real backend first

Use Codex as the preferred first smoke backend because the current TypeScript port already has JSONL argument mapping and JSONL stream translation.

Implementation steps:

- Add a shared subprocess adapter helper for line-oriented backend streams.
- Replace the selected public constructor with a live implementation.
- Feed stdout into the existing collector or consumer.
- Write the prompt to stdin or pass it through CLI arguments according to the backend command contract.
- Preserve cancellation through `AbortController` and child-process termination.
- Keep `unsupportedBackend` available for explicit unsupported-behavior tests only.

### 2. Add focused constructor tests

Add unit tests that exercise the live constructor through fake subprocess plumbing before adding the real smoke.

Coverage:

- success path returns normalized events and a branded result.
- process startup failure returns a backend failure.
- stderr-only or malformed output fails with a backend failure.
- cancellation terminates the fake process and completes as cancelled.

### 3. Add the gated real-repo smoke

Add an integration test that:

- checks `ORCA_REAL_BACKEND_SMOKE=1`.
- resolves the backend command from `ORCA_REAL_BACKEND`.
- creates a temporary git repository.
- writes a minimal package and flow input file.
- runs one autonomous conversation against the selected real backend.
- asserts a successful result, matching backend tag, non-empty session id, and no user-interaction support.

Keep the prompt short and read-only unless a later backend/tool contract requires a write.

### 4. Update docs and scripts

Document:

- required environment variables.
- backend command prerequisites.
- how to run the live smoke.
- why the live smoke is excluded from default verification.

Script updates:

- keep `bun run verify` deterministic.
- add a named script such as `test:integration:real` if it improves discoverability.
- ensure the binary smoke still runs through the compiled CLI.

### 5. Run completion verification

Run, in order:

1. `bun run typecheck`
2. `bun test`
3. `bun run validate:fixtures`
4. `bun run validate:release`
5. `bun run build`
6. `bun run build:types`
7. `bun run smoke:binary`
8. `bun run verify`
9. `openspec validate "port-orca-to-typescript"`
10. `openspec instructions apply --change "port-orca-to-typescript" --json`

When credentials are available, also run:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```

## Task Closure Rules

Mark `9.6` complete only after the gated smoke exists and passes when explicitly enabled in an environment with a real backend.

Mark `9.8` complete only after deterministic verification passes after the final implementation changes.

If live backend credentials are unavailable in the current environment, leave `9.6` open and record the exact command needed to finish it.
