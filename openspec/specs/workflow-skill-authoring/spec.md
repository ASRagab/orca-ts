# workflow-skill-authoring Specification

## Purpose

Define the behavior of the `orca-ts-author` skill: read the target repository to
detect its stack and real verification commands, interview the user adaptively to
fix the artifact shape, generate a workflow script or loop module that
typechecks when the target environment can check it, enforce verification gates
so a "vibe" becomes a productized artifact, and save a re-runnable artifact in a
stack-agnostic location. The skill works in any git-backed repository, not only
TypeScript projects.

## Requirements

### Requirement: Skill discovers the target repository's stack and verification commands

The skill SHALL read the target repository to detect its stack and its real test,
lint, format, and build commands by probing common markers (for example
`package.json` scripts, `Makefile`/`justfile` targets, `pyproject.toml`/pytest,
`Cargo.toml`, `go.mod`, `build.sbt`, `.pre-commit-config.yaml`, and CI workflow
files). It SHALL confirm the detected commands with the user before using them.

#### Scenario: Commands detected from repository markers

- **WHEN** the target repo exposes test and lint commands through recognizable markers
- **THEN** the skill proposes those commands and asks the user to confirm or correct them

#### Scenario: Non-TypeScript repository

- **WHEN** the target repo is not a TypeScript/Node project
- **THEN** the skill still detects that repo's native commands and does not assume a Node/TS toolchain

#### Scenario: No verification commands detected

- **WHEN** no test or lint command can be detected
- **THEN** the skill prompts the user to supply them rather than guessing

### Requirement: Skill interviews the user adaptively and host-agnostically

The skill SHALL fix the workflow shape through an adaptive interview that asks the
archetype first and then only that archetype's sub-decisions, offering a default
for every question. On a host with structured prompts it SHALL use them; on other
hosts it SHALL ask one question at a time and accept a bare answer.

#### Scenario: Adaptive drill-down

- **WHEN** the user picks an archetype
- **THEN** the skill asks only the sub-decisions that archetype requires, each with a default

#### Scenario: Defaults fast-path

- **WHEN** the user answers "defaults"
- **THEN** the skill proceeds with the canonical persistent-plan archetype and the detected verification gates

#### Scenario: Host without structured prompts

- **WHEN** the running host has no structured question tool
- **THEN** the skill asks one question at a time, shows the default, and accepts a bare answer

### Requirement: Skill generates an artifact that typechecks

The skill SHALL generate the workflow script or loop module from a bundled
template for the chosen archetype, fill its slots from the interview, and apply
codegen rules so the artifact typechecks. Loop modules SHALL export an
import-safe `defineLoop()` definition and SHALL NOT start a source, run a
backend, emit to a sink, or mutate the repository at import time. When a
TypeScript toolchain is reachable it SHALL typecheck-gate the generated artifact
before handing it back; otherwise it SHALL rely on the CI-gated templates plus a
codegen self-audit and note in the runbook that the runtime typecheck guard will
be skipped.

#### Scenario: Typecheck gate available

- **WHEN** a TypeScript toolchain is reachable at author time
- **THEN** the skill typechecks the generated artifact and does not hand back an artifact that fails typecheck

#### Scenario: Typecheck gate unavailable

- **WHEN** no TypeScript toolchain is reachable (for example a Python target repo)
- **THEN** the skill generates from a CI-gated template, runs the self-audit, and records the skipped-typecheck note in the runbook

#### Scenario: Loop module is import-safe

- **WHEN** the user chooses a reusable loop module artifact
- **THEN** the skill generates `.orca/loops/<name>.ts` with an import-safe `defineLoop()` export

### Requirement: Skill enforces verification gates

The skill SHALL ensure every authored mutating workflow script or loop module
carries verification gates - at a minimum the target repo's tests and linters -
wired into the per-task loop. It SHALL refuse to emit a mutating artifact with no
verification gate.

#### Scenario: Gates wired into the artifact

- **WHEN** the skill generates a mutating artifact
- **THEN** the artifact runs the confirmed test and lint commands as gates and treats their failure as a failure to repair or report

#### Scenario: Refuses an ungated artifact

- **WHEN** the user declines to provide any verification command and none was detected
- **THEN** the skill refuses to emit the mutating artifact and explains why a gate is required

### Requirement: Skill saves a re-runnable, stack-agnostic artifact

The skill SHALL save a generated workflow script to the target repo's
`.orca/workflows/<name>.ts` or a generated loop module to
`.orca/loops/<name>.ts`, emit a sibling `<name>.run.md` runbook with the exact
trigger command and prerequisites, and provide stack-agnostic triggers through
the `orca` binary that do not depend on the target repo's package manager. It
SHALL confirm the target directory before writing.

#### Scenario: Workflow saved with runbook

- **WHEN** authoring completes
- **THEN** the skill writes `.orca/workflows/<name>.ts` and `<name>.run.md` and reports the trigger command

#### Scenario: Loop module saved with runbook

- **WHEN** loop-module authoring completes
- **THEN** the skill writes `.orca/loops/<name>.ts` and `<name>.run.md` and reports `orca loops`, `orca run`, and `orca serve` commands

#### Scenario: Stack-agnostic trigger

- **WHEN** the target repo has no Node/TS package manager
- **THEN** the provided trigger invokes the `orca` binary or loop CLI directly and does not rely on a `package.json` script

#### Scenario: Target directory confirmed before writing

- **WHEN** the skill is about to write the workflow files
- **THEN** it confirms the target repository/directory with the user first

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
