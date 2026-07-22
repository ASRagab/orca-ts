# workflow-skill-setup Specification

## Purpose

Define the behavior of the `orcats-setup` skill: install the `orcats` binary and
verify that at least one user-chosen backend is authenticated, configured, and
usable, or explicitly marked `unverified` when that backend has no safe
non-spending auth probe, troubleshooting install/auth/config failures along the
way. The skill is host-agnostic and stack-agnostic - it works on any machine and
in any repository.

## Requirements

### Requirement: Skill is exposed under the Orcats name

The setup skill SHALL be exposed as `orcats-setup` and SHALL NOT require an `orca-ts-setup` compatibility alias.

#### Scenario: User lists bundled skills

- **WHEN** a user lists the bundled skills from the `ASRagab/orca-ts` repository
- **THEN** the setup skill appears as `orcats-setup`

### Requirement: Skill installs the Orcats binary

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

### Requirement: Skill verifies at least one chosen backend is functional

The skill SHALL ask the user which of the supported backends (`claude`,
`codex`, `opencode`, `pi`) to enable, then verify each chosen backend's CLI is on
`PATH` and passes the cheapest safe readiness probe available for that backend.
It SHALL NOT report success until at least one chosen backend is `ready` or
`unverified`; `unverified` is allowed only for backends whose authentication
cannot be proven without a live smoke.

#### Scenario: User selects a backend to enable

- **WHEN** the skill starts backend verification
- **THEN** it asks the user which supported backend(s) to enable before probing

#### Scenario: A chosen backend is functional

- **WHEN** a chosen backend's CLI is on `PATH`, passes a readiness probe, and is authenticated
- **THEN** the skill marks that backend ready and records the backend tag

#### Scenario: Auth cannot be cheaply proven

- **WHEN** a chosen backend's CLI is on `PATH` and passes `--version`, but the backend has no safe non-spending auth-status probe
- **THEN** the skill marks that backend `unverified`, explains the limitation, and points to the gated live smoke for definitive proof

#### Scenario: No chosen backend is functional

- **WHEN** every chosen backend is `missing`, `unauth`, or `misconfig`
- **THEN** the skill reports failure with the per-backend reason and does not declare setup complete

#### Scenario: Optional live smoke is gated

- **WHEN** the user opts into a live readiness smoke
- **THEN** the skill runs it only under an explicit environment gate and otherwise relies on a non-spending probe

### Requirement: Skill troubleshoots install, authentication, and configuration failures

On any install or backend-verification failure, the skill SHALL classify the
failure (missing CLI, unauthenticated, misconfigured, network/checksum) and
present the user a concrete next step rather than a raw error.

#### Scenario: Backend CLI is missing

- **WHEN** a chosen backend's CLI is absent from `PATH`
- **THEN** the skill identifies the missing CLI and tells the user how to install it

#### Scenario: Backend is unauthenticated

- **WHEN** a chosen backend's CLI is present but not authenticated
- **THEN** the skill reports the auth gap and gives the backend-specific login step

#### Scenario: Installer checksum or network fails

- **WHEN** the installer fails on checksum or network
- **THEN** the skill reports the cause and offers the manual download/verify fallback

### Requirement: Skill verification is re-runnable as a doctor

The skill SHALL be safely re-runnable to re-verify the environment without
re-installing when the binary and a backend are already healthy.

#### Scenario: Re-run on a healthy environment

- **WHEN** the skill is run again with Orcats installed and a backend already verified
- **THEN** it re-confirms readiness without reinstalling and reports the current state
