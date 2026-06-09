## ADDED Requirements

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
