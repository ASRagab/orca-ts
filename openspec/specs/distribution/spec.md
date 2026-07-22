## Purpose

Define how Orcats is built, packaged, documented, and attributed for distribution.
## Requirements
### Requirement: Standalone CLI binary is built with Bun
The system SHALL produce a standalone Orcats CLI binary named `orcats` with `bun build --compile` so users can run flows without installing Node or the JVM.

#### Scenario: CLI binary is built
- **WHEN** the release build runs
- **THEN** it produces an executable Orcats binary named `orcats` for the target platform

#### Scenario: CLI binary runs a flow
- **WHEN** a user invokes the compiled `orcats` binary with a valid flow script
- **THEN** the binary performs the typecheck pre-flight and runs the flow

### Requirement: Npm package supports authoring
The system SHALL publish a scoped public npm package named `@twelvehart/orcats` that exposes the public TypeScript API, type declarations, package metadata, and `bunx` execution path for authoring workflows.

#### Scenario: Package exposes public types
- **WHEN** a TypeScript project imports `@twelvehart/orcats`
- **THEN** the compiler resolves the public flow, backend, schema, event, and tool types

#### Scenario: Package runs through bunx
- **WHEN** a user invokes Orcats through `bunx -p @twelvehart/orcats orcats`
- **THEN** the package starts the CLI entry point with the same behavior as the local script runtime

#### Scenario: Package installs for typed authoring
- **WHEN** a user adds `@twelvehart/orcats` and `typescript` to a project
- **THEN** versioned flow files can import the public package surface and pass the CLI typecheck pre-flight when the project has a `tsconfig.json`

### Requirement: Package and binary delegate Agent Skills installation
The npm package and standalone Orcats binary SHALL expose the same delegated
`orcats skills` command while keeping skill payloads outside their curated
distribution artifacts.

#### Scenario: Installed package runs the skills command
- **WHEN** a user invokes `orcats skills` through an installed
  `@twelvehart/orcats` package
- **THEN** the CLI delegates the command to the canonical skills repository
  without requiring `skills/` to be present in the npm package

#### Scenario: Standalone binary runs the skills command
- **WHEN** a user invokes `orcats skills` through a standalone Orcats binary
- **THEN** the command delegates to the canonical skills repository without
  initializing the embedded runtime fallback

#### Scenario: Package artifact remains curated
- **WHEN** package artifact validation inspects a release tarball after this
  change
- **THEN** the existing runtime-only package allowlist remains unchanged and
  does not include bundled skill directories

### Requirement: Npm release uses Trusted Publishing
The system SHALL publish `@twelvehart/orcats` to npm from the tag-driven GitHub Actions release workflow using npm Trusted Publishing/OIDC, without long-lived npm publish tokens.

#### Scenario: Trusted publisher is configured before release
- **WHEN** a maintainer prepares the first renamed npm release
- **THEN** npm trust is configured for package `@twelvehart/orcats`, repository `ASRagab/orca-ts`, workflow file `release.yml`, and the `npm publish` action

#### Scenario: Release workflow publishes scoped package
- **WHEN** a `vX.Y.Z` tag runs the release workflow and verification passes
- **THEN** the workflow publishes npm package `@twelvehart/orcats@X.Y.Z` with public access

#### Scenario: Release workflow avoids publish tokens
- **WHEN** the npm publish job runs
- **THEN** it uses OIDC permission `id-token: write` and does not require `NPM_TOKEN` or another long-lived npm publish token

### Requirement: Npm package artifact is curated and verified
The system SHALL define and verify the npm package contents before publish so the tarball contains only the public runtime, declarations, executable, metadata, README, license, and notice files needed for package consumers.

#### Scenario: Package contents are allowlisted
- **WHEN** package validation inspects the npm tarball file list
- **THEN** the tarball includes `package.json`, `README.md`, `LICENSE`, `NOTICE`, `bin/orcats`, `src/**`, and generated declaration files under `dist/**`

#### Scenario: Internal files are excluded
- **WHEN** package validation inspects the npm tarball file list
- **THEN** the tarball excludes tests, fixtures, website source/build output, OpenSpec archives, `.github`, local workflow files, ignored build caches, and release tarballs

#### Scenario: Packed package installs in a temporary project
- **WHEN** package smoke installs the packed tarball into a temporary TypeScript project
- **THEN** imports from `@twelvehart/orcats`, `@twelvehart/orcats/loop`, `@twelvehart/orcats/model`, and `@twelvehart/orcats/testing` typecheck

#### Scenario: Packed package exposes the CLI binary
- **WHEN** package smoke invokes the installed package's `orcats --version` binary
- **THEN** it reports the same version as `package.json`

### Requirement: CLI documentation distinguishes package and binary names
The system SHALL document one-shot CLI usage with the npm package name `@twelvehart/orcats` and the executable command name `orcats` as separate names.

#### Scenario: User runs the current package through bunx
- **WHEN** a user reads one-shot CLI documentation
- **THEN** the documented command uses `bunx -p @twelvehart/orcats orcats ...`

#### Scenario: User runs a pinned package version through bunx
- **WHEN** a user reads release verification documentation for a specific version
- **THEN** the documented command uses `bunx -p @twelvehart/orcats@X.Y.Z orcats --version`

### Requirement: Runtime and testing entry points are separated
The package SHALL keep runtime imports free of test-only helpers while exposing test helpers through the explicit `@twelvehart/orcats/testing` entry point.

#### Scenario: User imports the root package
- **WHEN** a flow imports from `@twelvehart/orcats`
- **THEN** the import exposes runtime-safe flow, backend, model, monitor, plan, review, runner, tool, and `zod` exports without exporting test helpers

#### Scenario: User imports testing helpers
- **WHEN** a test imports from `@twelvehart/orcats/testing`
- **THEN** the import exposes test helper APIs without requiring those APIs to be exported from the root package

### Requirement: Standalone embedded fallback is runtime-only
The standalone CLI fallback SHALL embed only modules needed by runtime flow execution under the scoped package name and SHALL NOT embed the testing entry point or legacy package aliases.

#### Scenario: Standalone flow imports runtime package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orcats` without a local project dependency
- **THEN** the embedded fallback resolves the runtime root package

#### Scenario: Standalone flow imports loop package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orcats/loop` without a local project dependency
- **THEN** the embedded fallback resolves the loop package

#### Scenario: Standalone flow imports model package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orcats/model` without a local project dependency
- **THEN** the embedded fallback resolves the model package

#### Scenario: Standalone flow imports testing package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orcats/testing` without a local project dependency
- **THEN** the embedded fallback does not provide that testing package

#### Scenario: Standalone flow imports old package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orca-ts`, `orca-ts`, `orca-ts/loop`, or `orca-ts/model` without a local project dependency
- **THEN** the embedded fallback does not provide the old package alias

### Requirement: Cheap CLI paths avoid runtime fallback setup
The CLI SHALL handle cheap informational paths before evaluating the embedded runtime fallback graph.

#### Scenario: User requests version
- **WHEN** a user runs `orcats --version`
- **THEN** the CLI prints the version without registering the embedded fallback package

#### Scenario: User requests help
- **WHEN** a user runs `orcats --help`
- **THEN** the CLI prints usage without registering the embedded fallback package

### Requirement: Typecheck pre-flight is default-on
The runner MUST execute `tsc --noEmit` before running a flow by default when project typecheck prerequisites are available. Project typechecking requires `typescript`, `tsconfig.json`, and resolvable local project dependencies including `@twelvehart/orcats`. When no typecheckable project setup is available, the runner SHALL skip the pre-flight, warn the user, and mark the run metadata as typecheck-skipped. The runner MAY expose an explicit opt-out flag for local iteration, but the default behavior SHALL preserve author-time type feedback for configured projects.

#### Scenario: Typecheck passes
- **WHEN** `tsc --noEmit` succeeds for the target flow
- **THEN** the runner starts the selected backend

#### Scenario: Typecheck fails
- **WHEN** `tsc --noEmit` fails for the target flow
- **THEN** the runner exits with the compiler diagnostics and does not start the selected backend

#### Scenario: User explicitly skips typecheck
- **WHEN** a user passes the documented no-typecheck escape hatch
- **THEN** the runner skips the pre-flight and marks the run metadata as typecheck-skipped

#### Scenario: Project setup is missing
- **WHEN** a user runs a flow where typecheck prerequisites are unavailable
- **THEN** the runner skips the pre-flight, warns that project typecheck setup is missing, and marks the run metadata as typecheck-skipped

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
- **THEN** they can identify required prerequisites and commands for installing `@twelvehart/orcats`

#### Scenario: User runs the CLI
- **WHEN** a new user reads the README usage section
- **THEN** they can run Orcats through the documented `orcats` CLI or package entry point

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

### Requirement: CLI runs, serves, and lists loops
The system SHALL provide CLI verbs for loops: `orcats run <loop>` (single one-shot execution), `orcats serve <loop>` (long-lived host honoring the loop's `Source`), and `orcats loops` (list defined loops with their source and sink). `orcats run <loop>` and served child execution SHALL use the same firing contract for event decoding, definition execution, sink emission, diagnostics, and exit-code mapping. The existing `--backend` override, `--no-typecheck`, and post-`--` flow-argument behavior SHALL continue to apply. Existing `orcats <flow.ts>` usage SHALL remain supported as the legacy flow-script path.

#### Scenario: Run executes a loop once
- **WHEN** a user runs `orcats run <loop>`
- **THEN** the loop executes a single time through the shared firing contract and exits with a status reflecting its stop reason

#### Scenario: Legacy flow execution still works
- **WHEN** a user runs `orcats <flow.ts> -- task args`
- **THEN** the CLI typechecks and imports the flow script with the same behavior as before this change, and the post-`--` tokens are still available through `flowArgs()`

#### Scenario: Loops are listable
- **WHEN** a user runs `orcats loops`
- **THEN** the CLI lists each defined loop with its configured source and sink

#### Scenario: Loop discovery has no side effects
- **WHEN** `orcats loops` inspects loop metadata
- **THEN** it reads registered loop definitions without firing a `Source`, invoking a backend, or emitting to a `Sink`

### Requirement: Serve is a thin supervisor spawning an ephemeral child per firing
The system SHALL implement `orcats serve` as a thin long-lived supervisor that owns only the triggers (`cron`/`watch`/`webhook`/`queue`) and spawns an ephemeral child process per trigger firing to run the loop and exit. Each child SHALL be independently terminable, including OS-level kill of a runaway loop. Cross-loop coordination (e.g. a shared token budget) SHALL be mediated through the shared manifest store rather than shared process memory. Parent-to-child event transfer, spawn arguments, child one-shot execution, diagnostics, and exit-code mapping SHALL be owned by the shared firing contract rather than duplicated across supervisor and CLI code.

#### Scenario: Trigger firing spawns an isolated child
- **WHEN** a bound trigger fires under `orcats serve`
- **THEN** the supervisor spawns a child process through the shared firing contract that runs the loop and exits, without executing the loop inside the supervisor process

#### Scenario: One loop crash does not take down others
- **WHEN** a child loop crashes
- **THEN** the supervisor survives, other loops are unaffected, and the supervisor may restart only the failed loop

#### Scenario: Runaway child is killable at the OS level
- **WHEN** a loop must be force-stopped
- **THEN** its child process can be terminated by the supervisor independently of all other loops

#### Scenario: Served child receives the original trigger event
- **WHEN** a `Source` fires a JSON-serializable trigger event under `orcats serve`
- **THEN** the child loop receives the same event value through the shared firing contract

### Requirement: Durable DBOS mode is deferred
The system SHALL NOT expose `--durable`, `--postgres-url`, or a selectable `dbos` state adapter in this change. Multi-process DBOS durability SHALL remain a follow-up design note behind the `StateStore` port until a Bun compatibility spike is completed. With no durable mode, the system SHALL run the default `snapshot` or selected `sqlite` adapter with no external service.

#### Scenario: Default run needs no service
- **WHEN** a loop runs without `--durable`
- **THEN** it uses the service-free default adapter and requires no Postgres

#### Scenario: DBOS is not selectable yet
- **WHEN** a user tries to select `dbos` or pass `--durable`
- **THEN** the CLI fails with a clear unsupported-feature error that points to the deferred DBOS design note
