# workflow-skill-execution Specification

## Purpose

Define the behavior of the `orcats-flow` skill: execute a saved or just-authored
workflow script or loop module, monitor it for real progress (detecting stalls
and stuck loops), and diagnose, resolve, and where safe self-heal runtime
failures. The skill is host-agnostic and operates against any git-backed
repository.

## Requirements

### Requirement: Skill executes a saved or just-authored artifact

The skill SHALL run a workflow script through the `orcats` binary or a loop module
through the loop CLI (`orcats loops`, `orcats run`, or `orcats serve`) against the
target repository, selecting the backend per the artifact or the user's
override. The skill SHALL surface monitoring output when the artifact emits it
and otherwise monitor progress through loop state, the persistent plan, and git
history. It SHALL NOT assume a `--monitor` CLI flag exists.

#### Scenario: Run a saved workflow

- **WHEN** the user triggers a saved `.orca/workflows/<name>.ts`
- **THEN** the skill runs it via the `orcats` binary against the confirmed target repo and reports any new monitor log emitted by the workflow

#### Scenario: Run a loop module

- **WHEN** the user triggers a saved `.orca/loops/<name>.ts`
- **THEN** the skill uses `orcats loops`, `orcats run`, or `orcats serve` as appropriate instead of the legacy `orcats <flow.ts>` command shape

#### Scenario: Backend override

- **WHEN** the user overrides the backend at run time
- **THEN** the skill passes the override to the runner and the selected backend is used

### Requirement: Skill monitors progress and detects stalls

The skill SHALL judge run-level progress from the run's monitoring output when
present, loop state history, the persistent plan's checkbox state, and `git`
history. It SHALL flag a stall only when no stage, file, task, loop-state, or
commit progress occurs across a tunable window beyond the runtime's inactivity
watchdog - not on backend slowness alone.

#### Scenario: Healthy slow run is not flagged

- **WHEN** a backend turn is slow but the plan, loop state, monitoring, or git history shows continued progress
- **THEN** the skill does not flag a stall

#### Scenario: Stuck run is flagged

- **WHEN** no stage/file/task/commit progress occurs within the configured window beyond the inactivity watchdog
- **THEN** the skill flags a stall and surfaces what the run was last doing

### Requirement: Skill diagnoses runtime failures

On failure the skill SHALL classify the cause (backend crash, expired or missing
authentication, validation/gate failure, non-convergence, stall, or served-child
failure) using the runtime's failure signals and available monitoring output,
and report the classification with the relevant evidence.

#### Scenario: Backend/auth failure classified

- **WHEN** a run fails because a backend crashed or its authentication is missing/expired
- **THEN** the skill classifies it as an environment failure and identifies the affected backend

#### Scenario: Non-convergence classified

- **WHEN** a task's fix-loop hits its convergence guard or ceiling
- **THEN** the skill classifies it as non-convergence and surfaces the recorded failure category

### Requirement: Skill resolves and heals failures within safety bounds

The skill SHALL attempt bounded, safety-gated recovery: for environment failures
run the backend doctor and guide re-authentication, then resume via the
persistent plan or loop state; for non-convergence retry with an adjusted prompt
or backend a bounded number of times before escalating; for a crash resume from
the persistent plan or loop state. The skill SHALL NOT auto-perform destructive
or irreversible repository actions (for example force-push, history rewrite, or
destructive resets) and SHALL escalate those to the user.

#### Scenario: Heal expired authentication and resume

- **WHEN** a run fails on expired backend authentication
- **THEN** the skill runs the doctor, guides re-auth, and resumes the artifact from the persistent plan or loop state

#### Scenario: Bounded non-convergence retry

- **WHEN** a task fails to converge
- **THEN** the skill retries within a bounded limit and escalates to the user when the limit is reached

#### Scenario: Destructive recovery escalates

- **WHEN** recovery would require a destructive or irreversible repository action
- **THEN** the skill does not perform it automatically and asks the user how to proceed

### Requirement: Skill surfaces outcome and owns backend lifecycle

At the end of a run the skill SHALL surface the exit status and the per-agent
cost/usage summary, and SHALL ensure any managed backend process is shut down
(for example calling OpenCode's shutdown) so no server is left running.

#### Scenario: Outcome surfaced

- **WHEN** a run completes
- **THEN** the skill reports the exit status and the per-agent cost/usage summary

#### Scenario: Managed backend shut down

- **WHEN** a run used the OpenCode backend
- **THEN** the skill ensures the managed `opencode serve` process is shut down after the run

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
