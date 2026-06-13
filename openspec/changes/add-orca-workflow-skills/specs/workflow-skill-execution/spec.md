## Purpose

Define the behavior of the `orca-ts-flow` skill: execute a saved or just-authored
workflow, monitor it for real progress (detecting stalls and stuck loops), and
diagnose, resolve, and where safe self-heal runtime failures. The skill is
host-agnostic and operates against any git-backed repository.

## ADDED Requirements

### Requirement: Skill executes a saved or just-authored workflow
The skill SHALL run a workflow through the `orca` binary against the target
repository, selecting the backend per the workflow or the user's override, and
SHALL enable monitoring output for the run.

#### Scenario: Run a saved workflow
- **WHEN** the user triggers a saved `.orca/workflows/<name>.ts`
- **THEN** the skill runs it via the `orca` binary with monitoring enabled and against the confirmed target repo

#### Scenario: Backend override
- **WHEN** the user overrides the backend at run time
- **THEN** the skill passes the override to the runner and the selected backend is used

### Requirement: Skill monitors progress and detects stalls
The skill SHALL judge flow-level progress from the run's monitoring output, the
persistent plan's checkbox state, and `git` history, and SHALL flag a stall only
when no stage, file, task, or commit progress occurs across a tunable window
beyond the runtime's inactivity watchdog — not on backend slowness alone.

#### Scenario: Healthy slow run is not flagged
- **WHEN** a backend turn is slow but the plan and monitoring show continued progress
- **THEN** the skill does not flag a stall

#### Scenario: Stuck run is flagged
- **WHEN** no stage/file/task/commit progress occurs within the configured window beyond the inactivity watchdog
- **THEN** the skill flags a stall and surfaces what the run was last doing

### Requirement: Skill diagnoses runtime failures
On failure the skill SHALL classify the cause (backend crash, expired or missing
authentication, validation/gate failure, non-convergence, or stall) using the
runtime's failure signals and monitoring output, and report the classification
with the relevant evidence.

#### Scenario: Backend/auth failure classified
- **WHEN** a run fails because a backend crashed or its authentication is missing/expired
- **THEN** the skill classifies it as an environment failure and identifies the affected backend

#### Scenario: Non-convergence classified
- **WHEN** a task's fix-loop hits its convergence guard or ceiling
- **THEN** the skill classifies it as non-convergence and surfaces the recorded failure category

### Requirement: Skill resolves and heals failures within safety bounds
The skill SHALL attempt bounded, safety-gated recovery: for environment failures
run the shared backend doctor and guide re-authentication, then resume via the
persistent plan; for non-convergence retry with an adjusted prompt or backend a
bounded number of times before escalating; for a crash resume from the persistent
plan. The skill SHALL NOT auto-perform destructive or irreversible repository
actions (for example force-push, history rewrite, or destructive resets) and
SHALL escalate those to the user.

#### Scenario: Heal expired authentication and resume
- **WHEN** a run fails on expired backend authentication
- **THEN** the skill runs the doctor, guides re-auth, and resumes the workflow from the persistent plan

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
