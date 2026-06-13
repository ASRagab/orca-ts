## Purpose

Define the behavior of the `orca-ts-setup` skill: install the `orca` binary and
verify that at least one user-chosen backend is authenticated, configured, and
usable, troubleshooting install/auth/config failures along the way. The skill is
host-agnostic and stack-agnostic — it works on any machine and in any repository.

## ADDED Requirements

### Requirement: Skill installs the Orca binary
The skill SHALL install or locate the standalone `orca` binary, preferring an
existing on-`PATH` binary and otherwise running the documented installer. It
SHALL confirm the binary is runnable by invoking `orca --version` and SHALL NOT
require Bun, Node, or the JVM to be present for binary-only use.

#### Scenario: Orca is already installed
- **WHEN** `orca --version` succeeds before any install action
- **THEN** the skill reports the resolved version and skips installation

#### Scenario: Orca is not installed
- **WHEN** no `orca` binary is found on `PATH`
- **THEN** the skill runs the documented installer and re-confirms with `orca --version`

#### Scenario: Install location is honored
- **WHEN** the user specifies an install directory or version
- **THEN** the skill installs to that directory and/or pins that version and reports the resulting path

### Requirement: Skill verifies at least one chosen backend is functional
The skill SHALL ask the user which of the supported backends (`claude`,
`codex`, `opencode`, `pi`) to enable, then verify each chosen backend's CLI is on
`PATH`, authenticated, and usable. It SHALL NOT report success until at least one
chosen backend passes verification.

#### Scenario: User selects a backend to enable
- **WHEN** the skill starts backend verification
- **THEN** it asks the user which supported backend(s) to enable before probing

#### Scenario: A chosen backend is functional
- **WHEN** a chosen backend's CLI is on `PATH`, passes a readiness probe, and is authenticated
- **THEN** the skill marks that backend ready and records the backend tag

#### Scenario: No chosen backend is functional
- **WHEN** every chosen backend fails verification
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
- **WHEN** the skill is run again with Orca installed and a backend already verified
- **THEN** it re-confirms readiness without reinstalling and reports the current state
