## 1. Transport Selection

- [x] 1.1 Replace the experimental Claude ACP opt-in with Claude ACP as the default `claude()` transport.
- [x] 1.2 Add an explicit Claude stream-json fallback transport selector for rollback.
- [x] 1.3 Keep Codex on the existing subprocess JSONL transport by default.
- [x] 1.4 Decide whether Codex ACP remains experimental or is removed from production code, and document the decision in `AGENTS.md` if retained.
- [x] 1.5 Add tests proving `claude()` defaults to ACP and uses stream-json only when fallback is selected.
- [x] 1.6 Add tests proving `codex()` still defaults to subprocess JSONL without an explicit experimental override.

## 2. Claude ACP Hardening

- [x] 2.1 Ensure Claude ACP initialization, session creation, prompt execution, cancellation, and shutdown failures produce Claude-branded `BackendFailed` errors naming the failed phase.
- [x] 2.2 Ensure Claude ACP structured output validation matches current Claude stream-json behavior for valid JSON, invalid JSON, and schema mismatch.
- [x] 2.3 Ensure Claude ACP cancellation sends `session/cancel`, waits for terminal cancellation, and force-closes the owned process on timeout.
- [x] 2.4 Ensure Claude ACP closes or cancels owned sessions/processes after success, failure, validation failure, cancellation, and timeout.
- [x] 2.5 Confirm Claude ACP model selection behavior and either wire supported model configuration or explicitly document the unsupported gap.

## 3. Docs And Specs

- [x] 3.1 Update backend documentation if it describes Claude or Codex transport defaults.
- [x] 3.2 Update `AGENTS.md` with the production transport decision: Claude ACP default, Codex subprocess default, fallback/rollback command.
- [x] 3.3 Confirm no README update is needed, or update README if user-facing backend setup changes.
- [x] 3.4 Run `openspec validate productionize-claude-acp-default --strict`.

## 4. Deterministic Validation

- [x] 4.1 Run focused ACP client tests.
- [x] 4.2 Run Claude backend tests.
- [x] 4.3 Run Codex backend tests.
- [x] 4.4 Run focused flow tests.
- [x] 4.5 Run focused loop tests.
- [x] 4.6 Run `bun run typecheck`.
- [x] 4.7 Run `bun run docs:check` and `bun run docs:symbols` if docs changed.
- [x] 4.8 Run `bun run verify`.

## 5. Live Validation And Benchmark Confirmation

- [x] 5.1 Run gated live Claude backend smoke with the new default ACP transport.
- [x] 5.2 Run gated live Claude backend smoke with the stream-json fallback transport.
- [x] 5.3 Run gated live Codex backend smoke and confirm it uses the subprocess transport by default.
- [x] 5.4 Run the gated direct/flow/loop benchmark confirmation for Claude current fallback versus Claude ACP default.
- [x] 5.5 Attach benchmark results and smoke summaries to the change notes or PR body.

## 6. Review Gates

- [x] 6.1 Run a comprehensive code review pass focused on regressions, lifecycle leaks, cancellation behavior, and missing tests.
- [x] 6.2 Run a sub-agent validation gate against the implementation and benchmark evidence.
- [x] 6.3 Resolve all actionable review findings or document why they are not applicable.
- [x] 6.4 Re-run focused tests after review fixes.

## 7. PR Readiness

- [x] 7.1 Confirm git diff contains only scoped productionization changes and related artifacts.
- [x] 7.2 Push a branch for the change.
- [x] 7.3 Create a ready-for-review PR with summary, test plan, benchmark evidence, and rollback note.
- [x] 7.4 Confirm PR is not left as draft.
