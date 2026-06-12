## Context

`ai-slop-cleanup` (workflows/ai-slop-cleanup.ts) is both the flagship example flow and the project's dogfood. It already does most of what a real-agent eval loop needs:

- **Objective oracle, enforced per file.** `cleanupFile` (line 565) runs the targeted gate before the agent (`fileBaseline`, line 581), reverts out-of-scope edits via `evaluateDiffGuard` (line 627), and re-runs the gate after the edit (line 643). A change is *kept* only if the gate is green; otherwise it is reverted. "Behavior-preserving" has a real oracle: every pre-existing green test stays green.
- **Per-run telemetry.** `WorkflowMonitor` (src/monitor/index.ts) writes `.orca/monitoring/<runId>.json`, and `scripts/summarize-run.ts` already aggregates multiple run logs with a per-backend breakdown.

Three things block this from being a measured, comparable eval:

1. The verdict (`changed | skipped | no-op`, inferred at line 511 from array lengths) measures *activity*, not *correctness* — it cannot distinguish "changed, green first try" from "changed, needed repairs" from "broke the gate, reverted."
2. Repair is a **one-shot** (`repairValidationFailure`, line 648): the agent gets exactly one retry, then the change is abandoned. That is a stingy depth cap on correctness.
3. Runs are not comparable: `assertCleanWorktree` is step 1 and accepted changes advance the branch, so running codex then opencode means opencode starts from codex's output.

Meanwhile a generic, correctly-shaped iteration primitive — `fixLoop` (src/review/loop.ts:13) — already exists but is unused by the cleanup path.

## Goals / Non-Goals

**Goals:**
- Make the cleanup verdict correctness-aware and discriminated, so pass-rate means *safe-improvement rate* and per-backend quality is visible.
- Let the agent burn as many repair iterations as it takes to converge, bounded by convergence guards rather than a fixed count.
- Make per-backend runs comparable by pinning a base SHA and isolating each backend in its own `git worktree`.
- Emit a cross-backend convergence-cost matrix that empirically answers "which backends work and where are the gaps."
- Reconcile the gemini spec/impl drift by cutting gemini.

**Non-Goals:**
- Running the loop against arbitrary external repos. Target is dogfood-self (orca-ts). The repo-coupling seams (`bun run {verify,lint,typecheck,test}` command names, `.orca/` paths beyond the monitor dir, `src/`+`tests/` selection heuristics) are documented for a later config-lift but unchanged here.
- Implementing the `agy` backend.
- Any semantic / LLM-judge oracle. Objective gate-passing is the only oracle added.

## Decisions

### D1 — Verdict is returned at the source, not inferred at the call site
`cleanupFile` knows exactly which branch it took; it returns a discriminated verdict and the monitor records it verbatim. Values:

| Verdict | Branch (current line) | Counts toward |
|---|---|---|
| `precondition-skip` | `fileBaseline` red before the agent (582) | excluded from denominator |
| `clean` | gate green on first post-edit validation (644) | pass |
| `repaired` | green after K≥1 repair iterations (657) | pass (carries `iterations`) |
| `regressed` | never converged; reverted (665/693 + new guards) | fail (carries `reason`) |
| `guard-reject` | touched out-of-scope files; reverted (638) | fail |
| `declined` | agent made no edits / nothing to clean (634) | neutral |

`precondition-skip` is excluded from the backend's denominator — a file whose tests were already red is not the agent's fault, the same way the smoke test skips an absent CLI. **Alternative considered:** keep inferring at the call site and parse the skip-reason string. Rejected — string-parsing is fragile and the branch already carries the truth.

### D2 — Repair depth is bounded by convergence, not by count; consolidate onto `fixLoop`
Delete the one-shot `repairValidationFailure`. Route repair through `fixLoop` with `evaluate = run validationPlan`, `fix = ask the agent to repair feeding back the *new* failure`, `converged = gate green`. Stop conditions, in priority order:

- **converged** → `clean` (0 iters) or `repaired` (K iters).
- **no-progress** (see D3) → `regressed:stuck`.
- **wall-clock** backstop (reuse the cap primitive added for the opencode hang) → `regressed:timeout`.
- **ceiling** (high `maxIterations`, a seatbelt not a policy) → `regressed:ceiling`.

`fixLoop` currently stops on `iterations >= maxIterations` returning `converged:false`; it must be extended to (a) accept a wall-clock budget and a no-progress predicate, and (b) return *why* it stopped so the verdict can carry the reason. **Alternative considered:** keep the one-shot, raise it to a fixed N. Rejected — the user requirement is explicit: do not cap depth cheaply; a fix that does not pass the gate is worthless, so spend the tokens to converge.

This also **consolidates two divergent repair paths** (the bespoke cleanup one-shot and the generic `fixLoop`) onto one engine — a dedup win independent of the eval work.

### D3 — No-progress signature = normalized failed-command + failing-test-id set, equal across two consecutive rounds
This is the one subtle piece standing between "burn tokens to win" and "burn tokens forever." The signature per round is the set of `{ normalized failed command, failing test ids }` extracted from `validation.runs`. If round N's signature equals round N−1's, the agent is stuck (same failure, no movement); if signatures cycle (A→B→A), oscillation. Two consecutive equal signatures → `stuck`. **Alternatives considered:** exact-string match on raw failure output (too brittle — line numbers, timing, ordering churn), or issue-count-only (misses oscillation where count is stable but the *set* swaps). Normalized set equality across consecutive rounds is the balance. Marked as the primary thing to validate empirically — see Open Questions.

### D4 — Comparability via worktree-per-backend off a pinned, tagged base SHA
A new outer eval-runner (a script, not flow internals) drives the matrix:

```
base = git rev-parse <eval-base-tag>           # tagged → reproducible across machines/time
for backend in [codex, claude, opencode, pi]:
  wt = git worktree add ../orca-eval-$backend $base
  ORCA_BACKEND=$backend ORCA_MONITOR_DIR=<central> orca run ai-slop-cleanup --max-files N --eval   (cwd=wt)
  git worktree remove --force $wt              # discard diff, keep the JSON
summarize-run <central>                          # existing aggregator → the matrix
```

Eval mode's only behavioral difference from production mode is the **sink**: throwaway worktree + verdict log, instead of commit + PR. Keeping it an *outer harness that shells out per worktree* (rather than threading `cwd` through the whole flow) is also the first piece of the eventual "point at any repo" config-lift. **Alternative considered:** serial `git stash` / `reset --hard` between backends on one tree. Rejected for the default — worktrees isolate cleanly and allow parallelism; stash/reset is more error-prone and serializes everything.

### D5 — Tokens and wall-clock are scored columns, not caps
Convergence-cost is itself a backend-quality axis ("codex lands it in 1 iter / 40k tok; pi needs 5 iters / 300k tok for the same file"). The matrix columns: `clean`, `repaired` (avg iters), `regressed` (by reason), `declined`, tokens-per-file, wall-per-file. Wall-clock appears as a *guard* (D2) only as a non-convergence backstop, never as a per-run budget cap.

### D6 — Central monitor dir via `ORCA_MONITOR_DIR`
The log dir is hardcoded to `join(process.cwd(), ".orca", "monitoring")` (line 449). In a worktree that scatters logs into each worktree's `.orca/`. Introduce an `ORCA_MONITOR_DIR` env override (default preserves current behavior) so all eval run logs land in one directory for aggregation.

### D7 — gemini is cut
Remove the live Gemini requirement from `conversation-backends`. gemini ships as `unsupportedBackend("gemini")` and `gemini-jsonl.ts` never implemented a streaming `SubprocessConsumer`; the gemini CLI is being deprecated by Google for the Antigravity CLI (`agy`). Record the cut + rationale in the ADR matrix. `agy` as a future additive `BackendTag` is noted but out of scope. (orca-ts differs from the parallel-code Electron app, which keeps gemini for enterprise.)

## Risks / Trade-offs

- **Oscillation (fix X breaks Y, fix Y breaks X)** → the no-progress signature (D3) stops it; the wall-clock + ceiling guards backstop a mis-tuned signature.
- **Unbounded spend per file** → intended, but bounded by the convergence guards and the breadth cap (`--max-files`). The matrix surfaces a runaway backend as high tokens/iters rather than letting it hide.
- **opencode shared `opencode serve` port contention under parallel worktrees** → run opencode serially by default while subprocess backends (codex/claude/pi) may parallelize, or assign a unique port per worktree. Real money + rate limits argue for serial-by-default regardless.
- **Eval cost / flake** → bound *breadth* with `--max-files` on a fixed slice, and pin a tagged base so the slice is stable; depth stays uncapped-by-count.
- **`fixLoop` API change touches the review-and-fix path** → extend `fixLoop` additively (optional wall-clock + no-progress params with current behavior as the default) so `runReviewAndFixLoop` is unaffected; its codex regression tests must pass unchanged.

## Migration Plan

1. Land the verdict taxonomy + `ORCA_MONITOR_DIR` (additive, backward-compatible defaults).
2. Extend `fixLoop` additively; route `cleanupFile` repair through it; delete `repairValidationFailure`. Production cleanup behavior is unchanged except that it now converges over multiple iterations instead of one.
3. Add the eval-runner script + `--eval` sink + `summarize-run` matrix columns.
4. Cut gemini in the spec + ADR matrix.

No data migration. Rollback is reverting the change set; `.orca/monitoring/` logs from older runs remain readable (additive fields).

## Open Questions

- **No-progress signature tuning (D3):** is normalized-failed-command + failing-test-id set equality across two consecutive rounds the right threshold, or should `stuck` require three rounds / detect longer cycles? Resolve empirically against real backend runs once the loop exists.
- **`agy` transport:** subprocess+JSONL (reuses `runSubprocessConversation`) vs HTTP/SSE (new transport like opencode)? Needs `agy` docs; out of scope here but determines the future backend's shape.
- **Eval-base cadence:** is the tagged base re-cut every N merges, and does a stale base (already-clean files → all `declined`) usefully signal "nothing left to clean" or just produce an empty matrix?
