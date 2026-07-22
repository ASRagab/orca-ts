## MODIFIED Requirements

### Requirement: Website content covers Orca's supported user surface

The documentation website SHALL cover the supported Orca TypeScript user
surface: motivation, core concepts, installation, Agent Skills, first flow,
saved workflows, backend configuration, loops, monitoring, CLI usage,
troubleshooting, examples, and reference.

#### Scenario: User installs Orcats

- **WHEN** a user reads installation content
- **THEN** the website documents the standalone `orcats` binary path, typed `@twelvehart/orcats` npm package authoring path, source checkout path, and Agent Skills installation path

#### Scenario: User writes a flow

- **WHEN** a user follows the first-flow guide
- **THEN** the website shows a copyable flow using the `@twelvehart/orcats` public package surface and the supported backend-selection pattern

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

#### Scenario: User follows source repository links

- **WHEN** a user follows repository, edit, release, installer, or source checkout links
- **THEN** the website keeps pointing to `ASRagab/orca-ts` and the GitHub Pages base remains tied to the `orca-ts` repository
