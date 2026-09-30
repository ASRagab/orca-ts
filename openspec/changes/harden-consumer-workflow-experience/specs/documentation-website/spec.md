## MODIFIED Requirements

### Requirement: Website content covers Orca's supported user surface

The documentation website SHALL cover the supported Orcats user surface:
motivation, core concepts, installation, Agent Skills, first flow, saved
workflows, backend configuration and transports, offline artifact checking,
loops, live and terminal monitoring signals, CLI usage, troubleshooting,
examples, and reference.

#### Scenario: User installs Orcats

- **WHEN** a user reads installation content
- **THEN** the website documents the standalone `orcats` binary path, typed `@twelvehart/orcats` npm package authoring path, source checkout path, and Agent Skills installation path

#### Scenario: User writes a flow

- **WHEN** a user follows the first-flow guide
- **THEN** the website shows a copyable flow using the `@twelvehart/orcats` public package surface and the supported backend-selection pattern

#### Scenario: User checks an artifact in any repository

- **WHEN** a user authors a workflow or loop module in a repository without a TypeScript project or package dependency
- **THEN** the website documents the offline self-contained `orcats check` command and its failure behavior

#### Scenario: User adopts skills

- **WHEN** a user reads Agent Skills documentation
- **THEN** the website explains the setup -> author -> flow sequence and the role of each bundled skill

#### Scenario: User configures Claude

- **WHEN** a user reads backend setup or troubleshooting content
- **THEN** the website explains the default and opt-in Claude transports, how readiness is proven for the selected transport, and transport-specific recovery

#### Scenario: User monitors a run

- **WHEN** a user reads workflow monitoring guidance
- **THEN** the website distinguishes live stderr, heartbeat, plan, state, and git progress signals from terminal monitoring JSON
- **THEN** it directs the user to trust the terminal summary's final status over wrapper echo text

#### Scenario: User builds a loop

- **WHEN** a user reads loop documentation
- **THEN** the website explains when to use loops, termination presets, guards, state stores, fan-out/fan-in, loop modules, and `orcats run`/`orcats serve`/`orcats loops`

### Requirement: Documentation verification is deterministic

The system SHALL provide deterministic verification for the documentation
website and the supported environment-setting reference. The environment
checker SHALL derive the supported `ORCA_*` inventory from runtime and CLI
source rather than maintain a second handwritten allowlist.

#### Scenario: Verification runs in CI

- **WHEN** CI runs for a pull request or push
- **THEN** documentation verification fails if the website cannot build or internal documentation links are broken

#### Scenario: Environment inventory diverges

- **WHEN** runtime or CLI source supports an `ORCA_*` environment variable that is absent from the canonical published reference
- **THEN** deterministic documentation verification fails and names the missing variable

#### Scenario: Verification runs without live services

- **WHEN** documentation verification runs
- **THEN** it does not require live backend credentials, external API calls, or publishing permissions

## ADDED Requirements

### Requirement: Supported environment settings have a canonical public reference

The documentation website SHALL provide the canonical public reference for
every supported `ORCA_*` environment variable, including its purpose, accepted
values or format, default or activation condition, precedence where relevant,
and security or spending implications. README and in-repo guides SHALL link to
that canonical reference and SHALL keep their setup and troubleshooting
guidance aligned with it.

#### Scenario: User looks up a supported environment variable

- **WHEN** a user follows environment-setting guidance from README, an in-repo guide, or the website
- **THEN** the canonical published reference contains that supported variable and its operational contract

#### Scenario: Variable controls credentials or live spending

- **WHEN** a supported environment variable enables credentials, authentication, or a live backend smoke
- **THEN** the reference states the security or spending implication and the required explicit gate

#### Scenario: README and in-repo guides reference environment configuration

- **WHEN** README or an in-repo guide documents an `ORCA_*` setting
- **THEN** it links to or agrees with the canonical website reference rather than defining a conflicting contract
