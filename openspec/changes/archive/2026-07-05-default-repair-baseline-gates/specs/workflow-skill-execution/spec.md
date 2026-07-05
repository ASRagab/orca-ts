## ADDED Requirements

### Requirement: Red baseline gate failures are repair-stage failures

The execution skill SHALL treat a red baseline test, lint, or verification gate
in a generated mutating artifact as an in-flow baseline repair stage by default,
not as an environment failure or an operator-only precondition. The skill SHALL
let the artifact's bounded repair loop run and SHALL intervene only when the run
stalls, crashes, or reports non-convergence.

#### Scenario: Baseline repair is allowed to run

- **WHEN** a generated mutating artifact reports a failing baseline gate under the default `repair` policy
- **THEN** the execution skill classifies the run as healthy while the baseline repair stage is making progress
- **THEN** the execution skill does not stop or reroute the run solely because the initial gate was red

#### Scenario: Baseline non-convergence is surfaced

- **WHEN** the baseline repair stage exits because it did not converge
- **THEN** the execution skill classifies the failure as non-convergence
- **THEN** the report includes the failing command, latest validation output, convergence guard, and monitor log path when available

### Requirement: Dirty baseline mode requires explicit operator intent

The execution skill SHALL NOT encourage or infer dirty-baseline acceptance from a
dirty worktree alone. If a generated mutating artifact refuses to start because
the worktree is dirty, the skill SHALL explain the explicit `accept-dirty`
policy and the snapshot behavior instead of automatically retrying with dirty
acceptance.

#### Scenario: Dirty baseline rejected without opt-in

- **WHEN** a generated mutating artifact fails before backend work because the worktree is dirty under `repair` or `strict`
- **THEN** the execution skill reports that dirty baseline acceptance is opt-in
- **THEN** the execution skill does not rerun with `accept-dirty` unless the operator explicitly asks for it

#### Scenario: Dirty baseline snapshot is reported

- **WHEN** a generated mutating artifact runs under `accept-dirty`
- **THEN** the execution skill reports the baseline snapshot path alongside the monitor log and validation outcome when available
