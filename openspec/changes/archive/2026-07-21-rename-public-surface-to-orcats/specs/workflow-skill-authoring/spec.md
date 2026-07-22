## ADDED Requirements

### Requirement: Authoring skill is exposed under the Orcats name

The authoring skill SHALL be exposed as `orcats-author` and SHALL NOT require an `orca-ts-author` compatibility alias.

#### Scenario: User lists bundled skills

- **WHEN** a user lists the bundled skills from the `ASRagab/orca-ts` repository
- **THEN** the authoring skill appears as `orcats-author`

## MODIFIED Requirements

### Requirement: Skill generates an artifact that typechecks

The skill SHALL generate the workflow script or loop module from a bundled
template for the chosen archetype, fill its slots from the interview, and apply
codegen rules so the artifact typechecks. Generated artifacts SHALL import from
`@twelvehart/orcats` and its supported subpaths. Loop modules SHALL export an
import-safe `defineLoop()` definition and SHALL NOT start a source, run a
backend, emit to a sink, or mutate the repository at import time. When a
TypeScript toolchain is reachable it SHALL typecheck-gate the generated artifact
before handing it back; otherwise it SHALL rely on the CI-gated templates plus a
codegen self-audit and note in the runbook that the runtime typecheck guard will
be skipped.

#### Scenario: Typecheck gate available

- **WHEN** a TypeScript toolchain is reachable at author time
- **THEN** the skill typechecks the generated artifact against `@twelvehart/orcats` and does not hand back an artifact that fails typecheck

#### Scenario: Typecheck gate unavailable

- **WHEN** no TypeScript toolchain is reachable (for example a Python target repo)
- **THEN** the skill generates from a CI-gated template, runs the self-audit, and records the skipped-typecheck note in the runbook

#### Scenario: Loop module is import-safe

- **WHEN** the user chooses a reusable loop module artifact
- **THEN** the skill generates `.orca/loops/<name>.ts` with an import-safe `defineLoop()` export

#### Scenario: Old package imports are not generated

- **WHEN** the skill emits any workflow script or loop module
- **THEN** the generated artifact does not import from `@twelvehart/orca-ts` or `orca-ts`

### Requirement: Skill saves a re-runnable, stack-agnostic artifact

The skill SHALL save a generated workflow script to the target repo's
`.orca/workflows/<name>.ts` or a generated loop module to
`.orca/loops/<name>.ts`, emit a sibling `<name>.run.md` runbook with the exact
trigger command and prerequisites, and provide stack-agnostic triggers through
the `orcats` binary that do not depend on the target repo's package manager. It
SHALL confirm the target directory before writing.

#### Scenario: Workflow saved with runbook

- **WHEN** authoring completes
- **THEN** the skill writes `.orca/workflows/<name>.ts` and `<name>.run.md` and reports the `orcats <flow.ts>` trigger command

#### Scenario: Loop module saved with runbook

- **WHEN** loop-module authoring completes
- **THEN** the skill writes `.orca/loops/<name>.ts` and `<name>.run.md` and reports `orcats loops`, `orcats run`, and `orcats serve` commands

#### Scenario: Stack-agnostic trigger

- **WHEN** the target repo has no Node/TS package manager
- **THEN** the provided trigger invokes the `orcats` binary or loop CLI directly and does not rely on a `package.json` script

#### Scenario: Target directory confirmed before writing

- **WHEN** the skill is about to write the workflow files
- **THEN** it confirms the target repository/directory with the user first
