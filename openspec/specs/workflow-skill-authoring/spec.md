# workflow-skill-authoring Specification

## Purpose

Define the behavior of the `orca-ts-author` skill: read the target repository to
detect its stack and real verification commands, interview the user adaptively to
fix the workflow shape, generate a flow that typechecks, enforce verification
gates so a "vibe" becomes a productized workflow, and save a re-runnable workflow
in a stack-agnostic location. The skill works in any git-backed repository, not
only TypeScript projects.

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

### Requirement: Skill generates a flow that typechecks

The skill SHALL generate the workflow from a bundled template for the chosen
archetype, fill its slots from the interview, and apply codegen rules so the flow
typechecks. When a TypeScript toolchain is reachable it SHALL typecheck-gate the
generated flow before handing it back; otherwise it SHALL rely on the CI-gated
templates plus a codegen self-audit and note in the runbook that the runtime
typecheck guard will be skipped.

#### Scenario: Typecheck gate available

- **WHEN** a TypeScript toolchain is reachable at author time
- **THEN** the skill typechecks the generated flow and does not hand back a flow that fails typecheck

#### Scenario: Typecheck gate unavailable

- **WHEN** no TypeScript toolchain is reachable (for example a Python target repo)
- **THEN** the skill generates from a CI-gated template, runs the self-audit, and records the skipped-typecheck note in the runbook

### Requirement: Skill enforces verification gates

The skill SHALL ensure every authored workflow carries verification gates - at a
minimum the target repo's tests and linters - wired into the per-task loop. It
SHALL refuse to emit a workflow with no verification gate.

#### Scenario: Gates wired into the workflow

- **WHEN** the skill generates a workflow
- **THEN** the workflow runs the confirmed test and lint commands as gates and treats their failure as a failure to repair or report

#### Scenario: Refuses an ungated workflow

- **WHEN** the user declines to provide any verification command and none was detected
- **THEN** the skill refuses to emit the workflow and explains why a gate is required

### Requirement: Skill saves a re-runnable, stack-agnostic workflow

The skill SHALL save the generated flow to the target repo's
`.orca/workflows/<name>.ts`, emit a `<name>.run.md` runbook with the exact
trigger command and prerequisites, and provide a stack-agnostic trigger (the
`orca` binary invocation, optionally a thin POSIX shell wrapper) that does not
depend on the target repo's package manager. It SHALL confirm the target
directory before writing.

#### Scenario: Workflow saved with runbook

- **WHEN** authoring completes
- **THEN** the skill writes `.orca/workflows/<name>.ts` and `<name>.run.md` and reports the trigger command

#### Scenario: Stack-agnostic trigger

- **WHEN** the target repo has no Node/TS package manager
- **THEN** the provided trigger invokes the `orca` binary directly and does not rely on a `package.json` script

#### Scenario: Target directory confirmed before writing

- **WHEN** the skill is about to write the workflow files
- **THEN** it confirms the target repository/directory with the user first
