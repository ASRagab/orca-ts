## ADDED Requirements

### Requirement: Skill is exposed under the Orcats name

The setup skill SHALL be exposed as `orcats-setup` and SHALL NOT require an `orca-ts-setup` compatibility alias.

#### Scenario: User lists bundled skills

- **WHEN** a user lists the bundled skills from the `ASRagab/orca-ts` repository
- **THEN** the setup skill appears as `orcats-setup`

## MODIFIED Requirements

### Requirement: Skill installs the Orca binary

The skill SHALL install or locate the standalone `orcats` binary, preferring an
existing on-`PATH` binary and otherwise running the documented installer. It
SHALL confirm the binary is runnable by invoking `orcats --version` and SHALL NOT
require Bun, Node, or the JVM to be present for binary-only use.

#### Scenario: Orcats is already installed

- **WHEN** `orcats --version` succeeds before any install action
- **THEN** the skill reports the resolved version and skips installation

#### Scenario: Orcats is not installed

- **WHEN** no `orcats` binary is found on `PATH`
- **THEN** the skill runs the documented installer and re-confirms with `orcats --version`

#### Scenario: Install location is honored

- **WHEN** the user specifies an install directory or version
- **THEN** the skill installs to that directory and/or pins that version and reports the resulting path

#### Scenario: Old command is not treated as setup success

- **WHEN** `orca` exists on `PATH` but `orcats` does not
- **THEN** the skill treats Orcats as not installed and installs or locates the `orcats` binary

### Requirement: Skill verification is re-runnable as a doctor

The skill SHALL be safely re-runnable to re-verify the environment without
re-installing when the `orcats` binary and a backend are already healthy.

#### Scenario: Re-run on a healthy environment

- **WHEN** the skill is run again with Orcats installed and a backend already verified
- **THEN** it re-confirms readiness without reinstalling and reports the current state
