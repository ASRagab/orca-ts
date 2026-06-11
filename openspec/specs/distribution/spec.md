## Purpose

Define how Orca TypeScript is built, packaged, documented, and attributed for distribution.

## Requirements

### Requirement: Standalone CLI binary is built with Bun
The system SHALL produce a standalone Orca CLI binary with `bun build --compile` so users can run flows without installing Node or the JVM.

#### Scenario: CLI binary is built
- **WHEN** the release build runs
- **THEN** it produces an executable Orca binary for the target platform

#### Scenario: CLI binary runs a flow
- **WHEN** a user invokes the compiled binary with a valid flow script
- **THEN** the binary performs the typecheck pre-flight and runs the flow

### Requirement: Npm package supports authoring
The system SHALL publish an npm package that exposes the public TypeScript API, type declarations, package metadata, and `bunx` execution path for authoring workflows.

#### Scenario: Package exposes public types
- **WHEN** a TypeScript project imports the Orca package
- **THEN** the compiler resolves the public flow, backend, schema, event, and tool types

#### Scenario: Package runs through bunx
- **WHEN** a user invokes Orca through `bunx`
- **THEN** the package starts the CLI entry point with the same behavior as the local script runtime

### Requirement: Typecheck pre-flight is default-on
The runner MUST execute `tsc --noEmit` before running a flow by default. The runner MAY expose an explicit opt-out flag for local iteration, but the default behavior SHALL preserve author-time type feedback.

#### Scenario: Typecheck passes
- **WHEN** `tsc --noEmit` succeeds for the target flow
- **THEN** the runner starts the selected backend

#### Scenario: Typecheck fails
- **WHEN** `tsc --noEmit` fails for the target flow
- **THEN** the runner exits with the compiler diagnostics and does not start the selected backend

#### Scenario: User explicitly skips typecheck
- **WHEN** a user passes the documented no-typecheck escape hatch
- **THEN** the runner skips the pre-flight and marks the run metadata as typecheck-skipped

### Requirement: Documentation and examples cover the supported v1 surface
The system SHALL include documentation and examples for the TypeScript runtime, supported autonomous flows, backend setup, persistent plans, review automation, distribution, and known v1 cuts.

#### Scenario: Non-interactive examples are ported
- **WHEN** example parity checks run
- **THEN** all supported Scala examples except the dropped interactive example have TypeScript counterparts

#### Scenario: Interactive example is absent
- **WHEN** users inspect the v1 examples
- **THEN** no example presents `ask_user`, human approval, or `Plan.interactive` as implemented behavior

### Requirement: Canonical GitHub repository is configured
The project SHALL use `ASRagab/orca-ts` as the canonical GitHub repository for source hosting, package metadata, issue links, and user-facing documentation.

#### Scenario: Remote repository exists
- **WHEN** productionization setup is complete
- **THEN** the GitHub repository `ASRagab/orca-ts` exists and is accessible to maintainers

#### Scenario: Local origin points to canonical repository
- **WHEN** a maintainer inspects the local git remotes
- **THEN** `origin` points to the canonical `ASRagab/orca-ts` repository

#### Scenario: Package metadata references canonical repository
- **WHEN** release metadata validation runs
- **THEN** package repository, homepage, and issue metadata reference `ASRagab/orca-ts`

### Requirement: GitHub Actions runs deterministic verification
The project SHALL include a GitHub Actions CI workflow that runs deterministic verification for pushes and pull requests without requiring live backend credentials.

#### Scenario: Pull request CI runs verification
- **WHEN** a pull request targets the default branch
- **THEN** CI installs Bun dependencies and runs the repository verification gate

#### Scenario: Push CI runs verification
- **WHEN** a maintainer pushes to the default branch
- **THEN** CI installs Bun dependencies and runs the repository verification gate

#### Scenario: CI avoids live backend credentials
- **WHEN** the default CI workflow runs
- **THEN** it does not enable the gated real-backend smoke test

### Requirement: README documents installation and usage
The project SHALL provide a production-ready README that guides a new user from prerequisites through installation, first CLI run, TypeScript authoring, backend setup, verification, and known v1 limitations.

#### Scenario: User installs the package locally
- **WHEN** a new user reads the README installation section
- **THEN** they can identify required prerequisites and commands for installing dependencies locally

#### Scenario: User runs the CLI
- **WHEN** a new user reads the README usage section
- **THEN** they can run Orca through the documented CLI or package entry point

#### Scenario: User configures a backend
- **WHEN** a new user reads the README backend section
- **THEN** they can identify supported v1 backends, required local credentials or commands, and the fact that live human interaction is unsupported

#### Scenario: Maintainer verifies the project
- **WHEN** a maintainer reads the README verification section
- **THEN** they can run deterministic verification locally and can identify the separate gated live-backend smoke path

### Requirement: Derivative-work attribution is included
The system SHALL include Apache 2.0 licensing, `NOTICE`, and VirtusLab attribution appropriate for a derivative TypeScript port of Scala Orca.

#### Scenario: Release metadata is checked
- **WHEN** release validation runs
- **THEN** the package contains license metadata, the Apache 2.0 license text, `NOTICE`, and attribution content

