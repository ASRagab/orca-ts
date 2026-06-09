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

### Requirement: Derivative-work attribution is included
The system SHALL include Apache 2.0 licensing, `NOTICE`, and VirtusLab attribution appropriate for a derivative TypeScript port of Scala Orca.

#### Scenario: Release metadata is checked
- **WHEN** release validation runs
- **THEN** the package contains license metadata, the Apache 2.0 license text, `NOTICE`, and attribution content

