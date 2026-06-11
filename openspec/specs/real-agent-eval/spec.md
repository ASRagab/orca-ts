## Purpose

Define the Tier 3 real-agent eval loop: a discriminated cleanup verdict, convergence-guarded repair, and an isolated-worktree eval runner that produces a per-backend convergence-cost matrix from a single pinned base commit.

## Requirements

### Requirement: Cleanup outcomes use a discriminated verdict
`cleanupFile` SHALL return a discriminated verdict naming the branch it took, and `WorkflowMonitor` SHALL record that verdict verbatim rather than inferring it from changed/skipped array lengths. The verdict set SHALL be: `clean` (gate green on first post-edit validation), `repaired` (gate green after one or more repair iterations, carrying the iteration count), `regressed` (the change could not be made to pass the gate and was reverted, carrying a reason of `stuck`, `timeout`, or `ceiling`), `guard-reject` (the agent touched out-of-scope files and the change was reverted), `declined` (the agent made no edits), and `precondition-skip` (the targeted baseline gate was already red before the agent ran). The monitor SHALL also record, per file, the repair iteration count, token usage, and wall-clock duration.

#### Scenario: Clean change is recorded as clean
- **WHEN** the agent edits a file and the targeted gate passes on the first post-edit validation
- **THEN** `cleanupFile` returns a `clean` verdict and the monitor records it with `iterations` of 0

#### Scenario: Repaired change carries its iteration count
- **WHEN** the post-edit gate fails and the agent converges to green after K repair iterations
- **THEN** `cleanupFile` returns a `repaired` verdict carrying `iterations` equal to K

#### Scenario: Precondition-skip is excluded from the backend denominator
- **WHEN** the targeted baseline gate for a file is already red before the agent runs
- **THEN** `cleanupFile` returns a `precondition-skip` verdict
- **THEN** the file is excluded from the backend's pass-rate denominator

#### Scenario: Pass-rate means safe-improvement rate
- **WHEN** the monitor summarizes a run
- **THEN** the pass count is the number of `clean` plus `repaired` verdicts and excludes `precondition-skip` files from the denominator

### Requirement: Repair iterates until convergence or a guard fires
`cleanupFile` SHALL drive post-edit repair through the shared `fixLoop` primitive — evaluating the validation plan, asking the agent to repair against the new failure, and converging when the gate is green. Repair depth SHALL NOT be bounded by a fixed attempt count. Repair SHALL stop when the gate converges (verdict `clean` or `repaired`), or when a convergence guard fires: a no-progress signature (`regressed:stuck`), a wall-clock backstop (`regressed:timeout`), or a high sanity ceiling on iterations (`regressed:ceiling`). The bespoke one-shot repair path SHALL be removed.

#### Scenario: Agent converges over multiple iterations
- **WHEN** the post-edit gate fails and each repair iteration makes progress toward green
- **THEN** repair continues across iterations without a fixed attempt cap until the gate is green

#### Scenario: Wall-clock backstop reverts a slow non-convergence
- **WHEN** repair exceeds the wall-clock budget without converging
- **THEN** the change is reverted and the verdict is `regressed` with reason `timeout`

#### Scenario: Ceiling is a seatbelt, not the binding constraint
- **WHEN** repair reaches the high iteration ceiling without converging or triggering no-progress
- **THEN** the change is reverted and the verdict is `regressed` with reason `ceiling`

### Requirement: No-progress signature detects a stuck or oscillating agent
The repair loop SHALL compute a per-round failure signature from the validation result — the set of normalized failed commands and failing test identifiers. When two consecutive rounds produce an equal signature, the loop SHALL stop with `regressed:stuck`. The signature SHALL be resilient to incidental churn (line numbers, timing, ordering) by normalizing before comparison.

#### Scenario: Repeated identical failure stops as stuck
- **WHEN** two consecutive repair rounds produce the same normalized failed-command and failing-test-id set
- **THEN** the loop stops and the verdict is `regressed` with reason `stuck`

#### Scenario: Oscillating failures stop as stuck
- **WHEN** repair rounds cycle between two distinct failure signatures without converging
- **THEN** the loop stops with `regressed:stuck` rather than iterating indefinitely

### Requirement: Eval mode runs each backend in an isolated worktree off a pinned base
The system SHALL provide an eval-runner that, for each selected backend, checks out a fixed tagged base commit into its own `git worktree`, runs the cleanup flow there in an eval sink that produces no commit and no pull request and discards the working diff after recording the verdict log, and removes the worktree afterward. The monitor log directory SHALL be overridable via `ORCA_MONITOR_DIR` so that all eval run logs aggregate in one directory. The default monitor log directory SHALL be unchanged when the override is absent.

#### Scenario: Each backend starts from the identical pinned base
- **WHEN** the eval-runner runs more than one backend
- **THEN** each backend runs in its own worktree checked out at the same tagged base commit

#### Scenario: Eval sink discards the diff but keeps the verdict log
- **WHEN** a backend completes its eval run
- **THEN** no commit or pull request is created, the worktree is removed, and the run's verdict log remains in the central monitor directory

#### Scenario: Monitor directory override centralizes logs
- **WHEN** `ORCA_MONITOR_DIR` is set
- **THEN** the run log is written under that directory instead of the per-worktree default

### Requirement: Eval-runner emits a cross-backend convergence-cost matrix
`summarize-run` SHALL aggregate the central eval logs into a per-backend matrix whose columns include `clean`, `repaired` with average iterations, `regressed` broken down by reason (`stuck`, `timeout`, `ceiling`), `declined`, tokens-per-file, and wall-clock-per-file. A backend that is not run or whose CLI is absent SHALL be representable as absent rather than as a failure.

#### Scenario: Matrix surfaces convergence cost per backend
- **WHEN** the eval-runner has run multiple backends from the same base
- **THEN** `summarize-run` prints a matrix with per-backend clean / repaired-avg-iters / regressed-by-reason / declined / tokens-per-file / wall-per-file

#### Scenario: Absent backend is not a failure
- **WHEN** a backend's CLI is not present on the machine
- **THEN** the matrix marks that backend absent rather than counting it as regressed
