## MODIFIED Requirements

### Requirement: Skill generates an artifact that typechecks

The skill SHALL generate the workflow script or loop module from a bundled
template for the chosen archetype, fill its slots from the interview, and apply
codegen rules so the artifact typechecks. Generated artifacts SHALL import from
`@twelvehart/orcats` and its supported subpaths. Loop modules SHALL export an
import-safe `defineLoop()` definition and SHALL NOT start a source, run a
backend, emit to a sink, or mutate the repository at import time. Before
handing back any generated artifact, the skill SHALL run the standalone
`orcats check` command against it. That check SHALL be self-contained, work in
TypeScript and non-TypeScript target repositories, and require neither a target
`tsconfig.json`, a target package dependency, nor network access. The skill
SHALL fix a failed check or report failure; it SHALL NOT skip typechecking.

#### Scenario: Typecheck gate available

- **WHEN** the target repository has its own TypeScript project and dependencies
- **THEN** the skill runs `orcats check` against the generated artifact
- **THEN** it does not hand back an artifact that fails the check

#### Scenario: Typecheck gate unavailable

- **WHEN** the target repository has no `tsconfig.json`, package manager, or installed `@twelvehart/orcats` dependency
- **THEN** `orcats check` typechecks the generated artifact using its bundled offline inputs
- **THEN** the skill does not record or accept a skipped typecheck

#### Scenario: Offline artifact check

- **WHEN** network access is unavailable during authoring
- **THEN** `orcats check` completes without downloading a compiler, declarations, or packages

#### Scenario: Loop module is import-safe

- **WHEN** the user chooses a reusable loop module artifact
- **THEN** the skill generates `.orca/loops/<name>.ts` with an import-safe `defineLoop()` export

#### Scenario: Old package imports are not generated

- **WHEN** the skill fills a bundled template
- **THEN** the artifact imports from `@twelvehart/orcats` and not a legacy package alias

## ADDED Requirements

### Requirement: Generated repository mutations keep runtime scratch out of commits

The skill SHALL keep `.orca/workflows/` and `.orca/loops/` available for
committable authored artifacts while excluding Orcats runtime scratch through
the repository-local exclude file resolved by
`git rev-parse --git-path info/exclude`. It SHALL NOT require or generate a
tracked `.gitignore` change for runtime scratch. Any generated commit or pull
request workflow SHALL stage explicit intended paths and SHALL exclude runtime
monitoring, plan, state, snapshot, and other scratch artifacts.

#### Scenario: Runtime exclusions use the repository-local git path

- **WHEN** the skill prepares a git-backed target repository for an authored artifact
- **THEN** it resolves the local exclude file with `git rev-parse --git-path info/exclude`
- **THEN** it adds only runtime scratch patterns without ignoring `.orca/workflows/` or `.orca/loops/`

#### Scenario: Target repository ignore file remains unchanged

- **WHEN** runtime scratch exclusions are installed
- **THEN** the target repository's tracked `.gitignore` is not changed for those exclusions

#### Scenario: Generated commit excludes runtime scratch

- **WHEN** a generated workflow stages changes for a commit or pull request
- **THEN** it stages only intended authored or task output paths
- **THEN** monitoring, plan, state, snapshot, and other runtime scratch files are absent from the staged diff
