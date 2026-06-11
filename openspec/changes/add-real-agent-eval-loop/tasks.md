## 1. Verdict taxonomy (measurement)

- [x] 1.1 Replace `OutcomeVerdict` in `src/monitor/index.ts` with the discriminated set `clean | repaired | regressed | guard-reject | declined | precondition-skip`; add fields for `iterations`, `regressedReason` (`stuck | timeout | ceiling`), and `tokens` to `OutcomeLog` (per-file wall is the existing `durationMs`).
- [x] 1.2 Update `WorkflowMonitor.toJson` so `summary.pass` counts `clean + repaired`, `fail` counts `regressed + guard-reject`, and `precondition-skip` is tracked separately and excluded from the denominator.
- [x] 1.3 Change `cleanupFile` to return the verdict at the branch it takes instead of the call site inferring it from array lengths.
- [x] 1.4 Update the inner loop's `monitor.recordOutcome` call to pass the returned verdict verbatim plus `iterations`, `regressedReason`, and `tokens`.
- [x] 1.5 Add monitor unit tests asserting verdict counting and `precondition-skip` exclusion (`tests/eval-verdict.test.ts`).

## 2. Convergence-guarded repair (uncap depth, consolidate onto fixLoop)

- [x] 2.1 Extend `fixLoop` additively: optional `wallClockMs`, `stalled` predicate, injectable `now`; return a `stop` reason; backward-compatible numeric 3rd arg. Default behavior unchanged.
- [x] 2.2 Route `cleanupFile` post-edit repair through `fixLoop` and delete the bespoke one-shot `repairValidationFailure`.
- [x] 2.3 Map the `fixLoop` stop reason onto the verdict: converged 0 iters → `clean`, converged K>0 → `repaired(K)`, otherwise revert and return `regressed` with the matching reason.
- [x] 2.4 Confirm the existing `runReviewAndFixLoop` / fixLoop / codex tests pass unchanged after the extension.

## 3. No-progress signature

- [x] 3.1 Implement `validationSignature` from `validation.runs` = set of normalized failed commands + failure lines (line numbers/paths/whitespace stripped).
- [x] 3.2 Wire `makeStallDetector` into the repair loop so a repeated or cycling signature stops with `regressed:stuck`.
- [x] 3.3 Add unit tests for the signature: stability, identical-failure stop, oscillation stop, making-progress no-stop (`tests/eval-verdict.test.ts`).

## 4. Non-converging revert contract

- [x] 4.1 Ensure `cleanupFile` restores all affected files when the repair loop exhausts its guards, leaving no dirty `git status`, and returns `regressed` with the guard reason.
- [x] 4.2 Add an integration test: an agent that leaves the gate red without throwing produces a clean worktree and `regressed:stuck` (`tests/cleanup-regressed.test.ts`).

## 5. Eval mode (worktree-per-backend, pinned base, central logs, matrix)

- [x] 5.1 Add an `ORCA_MONITOR_DIR` env override for the monitor log directory (default preserves `.orca/monitoring`) — in both the workflow and `summarize-run`.
- [x] 5.2 Add an `--eval` sink (`evalMode`) to the cleanup flow: force monitoring on, skip the aggregate verify/PR/publish, record the verdict log; the runner discards the worktree.
- [x] 5.3 Add `scripts/eval-backends.ts`: resolves a base SHA, `git worktree add --detach` per backend, runs the current checkout's flow with `cwd` = worktree and `ORCA_MONITOR_DIR` = central dir, then `git worktree remove --force`, then prints the matrix.
- [x] 5.4 Run backends sequentially by default (documented) so opencode's shared `opencode serve` port is not contended and real-agent spend stays predictable.
- [x] 5.5 Extend `scripts/summarize-run.ts` with `buildBackendMatrix`: per-backend `clean`, `repaired` (avg iters), `regressed` by reason, `declined`, tokens-per-file, wall-per-file; unrun backends are absent (guarded behind `import.meta.main`).
- [x] 5.6 Add `tests/eval-matrix.test.ts` asserting per-backend aggregation, `precondition-skip` exclusion from per-file denominators, and absent-backend handling.

## 6. Cut gemini

- [x] 6.1 Remove `gemini` from the `BackendTag` enum, the `gemini` unsupported accessor, and the `gemini-jsonl.ts` export; delete `gemini-jsonl.ts`. Regenerate canonical schemas (BackendTag/LlmResult/RuntimeError).
- [x] 6.2 Set ADR 0015 disposition to `cut` in `fixtures/adr/matrix.json` with the deprecated-CLI rationale and the future-`agy` note.
- [x] 6.3 Remove gemini from `jsonl-backends.test.ts`, `codex-backend.test.ts`, `conversation.test.ts`, and delete the `fixtures/tier1/gemini` fixtures.

## 7. Verification

- [x] 7.1 `bun run typecheck` and `bun run lint` clean.
- [x] 7.2 `bun test` green (169 pass, 1 gated skip) — full `bun run verify` gate passes (typecheck, test, fixtures, release, build:types, smoke:binary).
- [x] 7.3 `openspec validate add-real-agent-eval-loop --strict` passes.
- [x] 7.4 Ran live: `bun scripts/eval-backends.ts --base HEAD --max-files 3` across `{codex, claude, opencode, pi}`. Matrix populated — codex/claude/opencode each 3/3 `clean` (gate-verified, real edits applied and kept); pi was auth-blocked on the first run, and after re-auth gave 2/3 `clean` + 1 `regressed` (a `StructuredOutputValidationFailed` — pi has no native schema enforcement, so the model's `risk:"Low"`/array `validationHint` failed the Zod parse). Pre-flight fixed two runner gaps now in `scripts/eval-backends.ts`: per-worktree `bun install` (baseline `tsc` needs `node_modules`) and a named throwaway branch (the flow rejects detached HEAD). Three follow-ups surfaced (not blocking): claude backend has no token accounting (`tok/file 0`), backend-crash regressions bucket as `stuck` in the matrix, and the cleanup result schema is brittle for non-native-schema backends (case-sensitive `risk`, string-only `validationHint`).
- [x] 7.5 Update docs to note the verdict taxonomy, eval mode, and the gemini cut (`README.md`, `docs/backends.md`, `docs/parity.md`). No `CHANGELOG.md` exists in this 0.0.0 project; docs are the canonical surface.
