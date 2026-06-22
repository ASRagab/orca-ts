## ADDED Requirements

### Requirement: Mutating artifacts repair red baseline gates by default

The authoring skill SHALL generate every mutating workflow script or loop module
with a default baseline policy of `repair`. Under the `repair` policy, the
artifact SHALL require a clean worktree, run the confirmed baseline verification
gates, and attempt bounded repair of any failing baseline gate before starting
the artifact's main mutating stages. The artifact SHALL NOT weaken tests, lint,
docs checks, release checks, smoke checks, or verification coverage as part of
baseline repair.

#### Scenario: Red baseline gate enters repair before main work

- **WHEN** a generated mutating artifact starts with a clean worktree and a failing baseline test, lint, or verify command
- **THEN** the artifact attempts bounded baseline repair before planning, editing, committing, publishing, or running its main workflow stage
- **THEN** the artifact continues to main work only after the baseline gates pass

#### Scenario: Baseline repair does not converge

- **WHEN** baseline gate repair reaches its iteration, stall, wall-clock, or budget guard without passing the baseline gates
- **THEN** the artifact fails before main work begins
- **THEN** the failure reports the latest validation output and convergence reason

#### Scenario: Strict policy remains available

- **WHEN** the operator selects the `strict` baseline policy for a generated mutating artifact
- **THEN** the artifact requires a clean worktree and green baseline gates before any backend repair turn starts
- **THEN** a red baseline gate fails the run immediately with validation output

### Requirement: Dirty baseline acceptance is explicit and snapshot-backed

The authoring skill SHALL make dirty-worktree acceptance opt-in through an
explicit `accept-dirty` baseline policy. Under `accept-dirty`, the generated
artifact SHALL persist an auditable baseline snapshot before any backend turn or
file edit, then repair failing baseline gates before main workflow stages. The
artifact SHALL NOT run in dirty-baseline mode by default.

#### Scenario: Dirty worktree rejected by default repair policy

- **WHEN** a generated mutating artifact starts under the default `repair` policy and `git status --porcelain=v1` is non-empty
- **THEN** the artifact fails before any backend turn starts
- **THEN** the failure explains that dirty baseline acceptance requires an explicit `accept-dirty` policy

#### Scenario: Dirty worktree accepted with snapshot

- **WHEN** the operator selects `accept-dirty` for a generated mutating artifact and the worktree is dirty
- **THEN** the artifact records status, staged diff, unstaged diff, untracked file list, and initial gate output before any backend turn starts
- **THEN** the artifact attempts bounded baseline gate repair before main work begins

#### Scenario: Runbook documents baseline policy override

- **WHEN** the authoring skill saves a mutating artifact and its runbook
- **THEN** the runbook documents the default `repair` policy and the explicit `strict` and `accept-dirty` override syntax
