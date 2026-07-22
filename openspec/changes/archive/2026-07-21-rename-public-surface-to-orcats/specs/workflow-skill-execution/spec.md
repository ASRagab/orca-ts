## ADDED Requirements

### Requirement: Execution skill is exposed under the Orcats name

The execution skill SHALL be exposed as `orcats-flow` and SHALL NOT require an `orca-ts-flow` compatibility alias.

#### Scenario: User lists bundled skills

- **WHEN** a user lists the bundled skills from the `ASRagab/orca-ts` repository
- **THEN** the execution skill appears as `orcats-flow`

## MODIFIED Requirements

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
