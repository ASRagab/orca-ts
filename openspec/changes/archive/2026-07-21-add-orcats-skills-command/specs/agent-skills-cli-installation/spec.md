## ADDED Requirements

### Requirement: Orcats exposes bundled Agent Skills installation
The system SHALL expose `orcats skills` as the entry point for discovering and
installing the skills published by `ASRagab/orca-ts` through the delegated
`skills` CLI.

#### Scenario: User starts interactive installation
- **WHEN** a user runs `orcats skills` without selection options
- **THEN** Orcats starts the delegated installer with inherited terminal streams
  so that the installer owns skill and scope selection

#### Scenario: User lists available skills
- **WHEN** a user runs `orcats skills --list`
- **THEN** Orcats delegates the repository discovery/list operation without
  installing a skill

#### Scenario: User selects skills and destination
- **WHEN** a user runs `orcats skills` with supported `--skill`, `--all`,
  `--agent`, `--global`, or `--yes` options
- **THEN** Orcats maps the selected options to the delegated install command
  and preserves their requested scope and interaction mode

### Requirement: Delegated installation is safe and observable
The system SHALL use a fixed delegated source and an argument-array process
spawn, forward child standard streams, and return the delegated process exit
status.

#### Scenario: Delegated installer fails
- **WHEN** the delegated installer exits non-zero
- **THEN** Orcats preserves its diagnostics and exits with the same non-zero
  status

#### Scenario: User supplies an invalid selection
- **WHEN** a user combines `--all` with `--skill`, omits a required option
  value, or supplies unsupported input
- **THEN** Orcats reports the usage error and does not start the delegated
  installer

#### Scenario: npx is unavailable
- **WHEN** a user invokes the skills command and `npx` is not on `PATH`
- **THEN** Orcats exits non-zero with a diagnostic that identifies Node/npm as
  the prerequisite for Agent Skills installation

### Requirement: Skills installation bypasses flow runtime setup
The skills command SHALL not run flow typecheck, configure a backend, or load
the embedded runtime fallback.

#### Scenario: User installs from a directory without a project setup
- **WHEN** a user runs `orcats skills` in a directory without a TypeScript
  project or Orcats runtime dependency
- **THEN** the delegated installer starts without typecheck or embedded fallback
  activity
