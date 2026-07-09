## 1. Cursor Transport Spike

- [ ] 1.1 Capture sanitized `agent -p --output-format stream-json --stream-partial-output --mode=ask --trust --workspace <repo>` output for a successful read-only prompt in a disposable git repository.
- [ ] 1.2 Capture sanitized Cursor streams for tool use, non-zero failure, cancellation, and resume if the CLI exposes a stable chat id.
- [ ] 1.3 Decide whether CLI `stream-json` is sufficient; if it lacks stable terminal result, session, or progress frames, document the blocker and stop instead of switching transports.
- [ ] 1.4 Store parser fixtures and note the exact Cursor CLI version used for the spike.

## 2. Backend Implementation

- [ ] 2.1 Add `cursor` to `BackendTagSchema`, backend config typing, branded session typing, and any literal-set helpers that enumerate backend tags.
- [ ] 2.2 Add `src/backends/cursor-stream-json.ts` to parse Cursor stream frames into normalized assistant, tool, usage, error, and final result state where frames expose those fields.
- [ ] 2.3 Add `src/backends/cursor-run.ts` with a `cursor()` constructor that reuses `runSubprocessConversation()` and defaults to command `agent`.
- [ ] 2.4 Map shared config to Cursor flags: model, read-only/ask mode, sandbox, workspace, trust, resume, timeout options, and composed prompt sections.
- [ ] 2.5 Treat the Cursor command as an external prerequisite: do not add installer, updater, SDK dependency, or vendored binary logic.
- [ ] 2.6 Ensure cancellation kills or aborts the Cursor transport and leaves no owned process/watch handle alive.
- [ ] 2.7 Keep structured output validated by Orca's Zod post-validation unless Cursor CLI exposes a documented native schema flag.
- [ ] 2.8 Export the Cursor backend from `src/backends/index.ts` and the package root through existing export chains.

## 3. Selection, Flow, And Loop Coverage

- [ ] 3.1 Update `selectBackend()` so `ORCA_BACKEND=cursor` constructs the Cursor backend and preserves `ORCA_BACKEND_MODEL` precedence.
- [ ] 3.2 Add selector tests for Cursor defaulting, env override, model override, and unsupported tag messaging.
- [ ] 3.3 Add backend unit tests for successful result, read-only args, model args, resume args, structured-output validation, failure, stall timeout, and cancellation cleanup.
- [ ] 3.4 Add or extend flow tests so an existing backend-neutral flow can run with a fake Cursor backend.
- [ ] 3.5 Add or extend loop tests so an existing backend-neutral loop can run with a fake Cursor backend.

## 4. Documentation And Distribution Surface

- [ ] 4.1 Update `README.md` backend references and setup notes to state that users must install and authenticate Cursor CLI themselves.
- [ ] 4.2 Update `docs/backends.md` with Cursor transport behavior, config mapping, auth prerequisites, live smoke command, and performance gate.
- [ ] 4.3 Update website backend/setup/reference/troubleshooting pages to include Cursor wherever backend tags are listed.
- [ ] 4.4 Update docs symbol checks so backend tag literal sets include `cursor`.
- [ ] 4.5 Update `AGENTS.md` with the Cursor backend decision and any operational caveats learned during implementation.

## 5. Live Validation And Performance Gate

- [ ] 5.1 Extend `tests/integration/real-backend-smoke.test.ts` so `ORCA_REAL_BACKEND=cursor` runs a real Cursor Agent in a disposable git repository and reports a clear prerequisite failure when the command or credentials are unavailable.
- [ ] 5.2 Add a gated live flow validation command that runs an existing flow with `ORCA_BACKEND=cursor`, records wall time, event count, result status, and cleanup status.
- [ ] 5.3 Add a gated live loop validation command that runs an existing loop with `ORCA_BACKEND=cursor`, records convergence outcome, stop reason, wall time, event count, and cleanup status.
- [ ] 5.4 Run comparable live prompts against available existing coding-agent backends and record Cursor's wall time and event metadata beside the baseline.
- [ ] 5.5 Treat the backend as release-ready only if Cursor is on par with or better than existing coding-agent backends for the measured flow and loop prompts; otherwise stop and fix or defer the CLI adapter before documenting it as supported.

## 6. Verification

- [ ] 6.1 Run `bun run typecheck`.
- [ ] 6.2 Run focused backend and selector tests.
- [ ] 6.3 Run focused flow and loop tests.
- [ ] 6.4 Run `bun run docs:check` and `bun run docs:symbols`.
- [ ] 6.5 Run `bun run verify`.
- [ ] 6.6 Run `ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=cursor bun test tests/integration/real-backend-smoke.test.ts` with `CURSOR_API_KEY` configured.
- [ ] 6.7 Run the gated Cursor live flow and loop validation commands and attach their performance summaries to the implementation notes.
