# documentation-website Specification

## Purpose

Define the public documentation website for Orcats, including its
deployment path, user-journey information architecture, supported content
surface, and deterministic verification requirements.

## Requirements

### Requirement: Public documentation website

The system SHALL provide a public static documentation website for Orca
TypeScript that can be deployed to GitHub Pages.

#### Scenario: Website builds locally

- **WHEN** a maintainer runs the documented docs-site build command
- **THEN** the command produces a static site without requiring live backend
  credentials

#### Scenario: Website deploys from GitHub Actions

- **WHEN** changes are pushed to the default branch
- **THEN** GitHub Actions can build and deploy the static documentation site to
  GitHub Pages

### Requirement: Documentation site has a user-journey information architecture

The documentation website SHALL organize content around user goals rather than
repository file layout.

#### Scenario: New user starts from zero

- **WHEN** a new user opens the website
- **THEN** they can find motivation, concepts, installation, and a quickstart
  path before needing reference material

#### Scenario: Advanced user needs a detail

- **WHEN** an advanced user needs exact command, API, backend, loop, state, or
  skills behavior
- **THEN** they can navigate directly to reference pages for that topic

#### Scenario: User is blocked

- **WHEN** a user hits an install, typecheck, backend auth, loop, or workflow
  failure
- **THEN** they can find troubleshooting guidance for that failure class

### Requirement: Website content covers Orca's supported user surface

The documentation website SHALL cover the supported Orcats user
surface: motivation, core concepts, installation, Agent Skills, first flow,
saved workflows, backend configuration, loops, monitoring, CLI usage,
troubleshooting, examples, and reference.

#### Scenario: User installs Orcats

- **WHEN** a user reads installation content
- **THEN** the website documents the standalone `orcats` binary path, typed
  `@twelvehart/orcats` npm package authoring path, source checkout path, and
  Agent Skills installation path

#### Scenario: User writes a flow

- **WHEN** a user follows the first-flow guide
- **THEN** the website shows a copyable flow using the `@twelvehart/orcats`
  public package surface and the supported backend-selection pattern

#### Scenario: User adopts skills

- **WHEN** a user reads Agent Skills documentation
- **THEN** the website explains the setup -> author -> flow sequence and the
  role of each bundled skill

#### Scenario: User builds a loop

- **WHEN** a user reads loop documentation
- **THEN** the website explains when to use loops, termination presets, guards,
  state stores, fan-out/fan-in, loop modules, and `orcats run`/`orcats serve`/`orcats
  loops`

### Requirement: Website content preserves release and support boundaries

The documentation website SHALL document only supported release behavior and
SHALL keep deferred or unsupported paths explicit.

#### Scenario: User chooses an install path

- **WHEN** a user reads install documentation
- **THEN** the website presents `@twelvehart/orcats` as the typed authoring
  package and GitHub Release binaries as the zero-dependency execution path

#### Scenario: User chooses a backend

- **WHEN** a user reads backend documentation
- **THEN** the website lists only supported backend tags and constructors:
  `claude`, `codex`, `opencode`, and `pi`

#### Scenario: User chooses durable loop state

- **WHEN** a user reads loop state documentation
- **THEN** the website documents snapshot and sqlite stores and identifies DBOS
  and Dolt as deferred, not selectable adapters

### Requirement: Website source boundaries are maintainable

The documentation website SHALL keep public user documentation separate from
agent-facing implementation notes while linking to canonical source material
when useful.

#### Scenario: Website content is authored

- **WHEN** content is migrated from README, `docs/`, `skills/`, examples,
  `CONTEXT.md`, `AGENTS.md`, or OpenSpec archives
- **THEN** the website includes user-facing material and omits implementation
  history that is only useful to coding agents or maintainers

#### Scenario: README remains useful

- **WHEN** a user reads the README on GitHub
- **THEN** it remains a concise entry point and links to the documentation
  website for deeper guides and reference

### Requirement: Documentation verification is deterministic

The system SHALL provide deterministic verification for the documentation
website.

#### Scenario: Verification runs in CI

- **WHEN** CI runs for a pull request or push
- **THEN** documentation verification fails if the website cannot build or
  internal documentation links are broken

#### Scenario: Verification runs without live services

- **WHEN** documentation verification runs
- **THEN** it does not require live backend credentials, external API calls, or
  publishing permissions

### Requirement: Website implementation is subagent-friendly

The implementation plan SHALL split the documentation website work into
independent workstreams suitable for subagents and a final integration pass.

#### Scenario: Subagents implement in parallel

- **WHEN** implementation begins
- **THEN** infrastructure, content architecture, technical accuracy, and visual
  QA work can be assigned as separate workstreams with clear done conditions

#### Scenario: Main implementer integrates outputs

- **WHEN** subagent workstreams complete
- **THEN** the main implementer reconciles outputs, runs verification, and owns
  the final user-facing docs quality
