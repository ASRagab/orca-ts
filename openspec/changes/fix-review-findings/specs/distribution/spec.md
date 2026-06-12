## ADDED Requirements

### Requirement: CLI documentation distinguishes package and binary names
The system SHALL document one-shot CLI usage with the npm package name `orca-ts` and the executable command name `orca` as separate names.

#### Scenario: User runs the current package through bunx
- **WHEN** a user reads one-shot CLI documentation
- **THEN** the documented command uses `bunx -p orca-ts orca ...`

#### Scenario: User runs a pinned package version through bunx
- **WHEN** a user reads release verification documentation for a specific version
- **THEN** the documented command uses `bunx -p orca-ts@X.Y.Z orca --version`

### Requirement: Runtime and testing entry points are separated
The package SHALL keep runtime imports free of test-only helpers while exposing test helpers through the explicit `orca-ts/testing` entry point.

#### Scenario: User imports the root package
- **WHEN** a flow imports from `orca-ts`
- **THEN** the import exposes runtime-safe flow, backend, model, monitor, plan, review, runner, tool, and `zod` exports without exporting test helpers

#### Scenario: User imports testing helpers
- **WHEN** a test imports from `orca-ts/testing`
- **THEN** the import exposes test helper APIs without requiring those APIs to be exported from the root package

### Requirement: Standalone embedded fallback is runtime-only
The standalone CLI fallback SHALL embed only modules needed by runtime flow execution and SHALL NOT embed the testing entry point.

#### Scenario: Standalone flow imports runtime package
- **WHEN** a standalone binary runs a flow that imports `orca-ts` without a local project dependency
- **THEN** the embedded fallback resolves the runtime root package

#### Scenario: Standalone flow imports model package
- **WHEN** a standalone binary runs a flow that imports `orca-ts/model` without a local project dependency
- **THEN** the embedded fallback resolves the model package

#### Scenario: Standalone flow imports testing package
- **WHEN** a standalone binary runs a flow that imports `orca-ts/testing` without a local project dependency
- **THEN** the embedded fallback does not provide that testing package

### Requirement: Cheap CLI paths avoid runtime fallback setup
The CLI SHALL handle cheap informational paths before evaluating the embedded runtime fallback graph.

#### Scenario: User requests version
- **WHEN** a user runs `orca --version`
- **THEN** the CLI prints the version without registering the embedded fallback package

#### Scenario: User requests help
- **WHEN** a user runs `orca --help`
- **THEN** the CLI prints usage without registering the embedded fallback package

## MODIFIED Requirements

### Requirement: Typecheck pre-flight is default-on
The runner MUST execute `tsc --noEmit` before running a flow by default when project typecheck prerequisites are available. Project typechecking requires `typescript`, `tsconfig.json`, and resolvable local project dependencies including `orca-ts`. When no typecheckable project setup is available, the runner SHALL skip the pre-flight, warn the user, and mark the run metadata as typecheck-skipped. The runner MAY expose an explicit opt-out flag for local iteration, but the default behavior SHALL preserve author-time type feedback for configured projects.

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
