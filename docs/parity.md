# Parity Harness

The canonical model lives in `src/model` and exports JSON Schema fixtures under `fixtures/canonical/schemas`.

Tier 1 backend fixtures belong under `fixtures/tier1/<backend>` and compare scripted transport input to normalized conversation events and final results.

Tier 2 flow fixtures belong under `fixtures/tier2` and compare user-visible behavior: commits, persisted plan files, terminal output, and runtime events.

Tier 3 real-agent eval runs the cleanup flow against live backend CLIs and scores each file by an objective gate oracle: the targeted checks must stay green or the change is reverted. It is opt-in and excluded from default CI. `scripts/eval-backends.ts` runs each backend in its own `git worktree` off one pinned base commit (sequential, so OpenCode's shared server port is not contended), writes verdict logs to a central directory via `ORCA_MONITOR_DIR`, then `summarize-run` aggregates them into a cross-backend convergence-cost matrix (clean / repaired-avg-iters / regressed-by-reason / declined / tokens-per-file / wall-per-file). Per-file cleanup verdicts are `clean`, `repaired` (carries iteration count), `regressed` (`stuck` / `timeout` / `ceiling`), `guard-reject`, `declined`, and `precondition-skip` (excluded from the denominator). Repair depth is bounded by convergence guards — the no-progress signature, a wall-clock backstop, and a high iteration ceiling — not by a fixed retry count.

The Scala repository is a local oracle for fixture creation only. CI runs TypeScript checks without the JVM.

Runtime parity is tracked in `fixtures/adr/matrix.json`. Revived Scala control surfaces are backend config, sessions/resume, structured output, interactive `ask_user`, read-only mode, self-managed git, and normalized tool/result events.

Live backend smoke tests are opt-in and gated by environment variables.
