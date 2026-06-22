## ADDED Requirements

### Requirement: Npm release uses Trusted Publishing
The system SHALL publish `@twelvehart/orca-ts` to npm from the tag-driven GitHub Actions release workflow using npm Trusted Publishing/OIDC, without long-lived npm publish tokens.

#### Scenario: Trusted publisher is configured before release
- **WHEN** a maintainer prepares the first npm release
- **THEN** npm trust is configured for package `@twelvehart/orca-ts`, repository `ASRagab/orca-ts`, workflow file `release.yml`, and the `npm publish` action

#### Scenario: Release workflow publishes scoped package
- **WHEN** a `vX.Y.Z` tag runs the release workflow and verification passes
- **THEN** the workflow publishes npm package `@twelvehart/orca-ts@X.Y.Z` with public access

#### Scenario: Release workflow avoids publish tokens
- **WHEN** the npm publish job runs
- **THEN** it uses OIDC permission `id-token: write` and does not require `NPM_TOKEN` or another long-lived npm publish token

### Requirement: Npm package artifact is curated and verified
The system SHALL define and verify the npm package contents before publish so the tarball contains only the public runtime, declarations, executable, metadata, README, license, and notice files needed for package consumers.

#### Scenario: Package contents are allowlisted
- **WHEN** package validation inspects the npm tarball file list
- **THEN** the tarball includes `package.json`, `README.md`, `LICENSE`, `NOTICE`, `bin/orca`, `src/**`, and generated declaration files under `dist/**`

#### Scenario: Internal files are excluded
- **WHEN** package validation inspects the npm tarball file list
- **THEN** the tarball excludes tests, fixtures, website source/build output, OpenSpec archives, `.github`, local workflow files, ignored build caches, and release tarballs

#### Scenario: Packed package installs in a temporary project
- **WHEN** package smoke installs the packed tarball into a temporary TypeScript project
- **THEN** imports from `@twelvehart/orca-ts`, `@twelvehart/orca-ts/loop`, `@twelvehart/orca-ts/model`, and `@twelvehart/orca-ts/testing` typecheck

#### Scenario: Packed package exposes the CLI binary
- **WHEN** package smoke invokes the installed package's `orca --version` binary
- **THEN** it reports the same version as `package.json`

## MODIFIED Requirements

### Requirement: Npm package supports authoring
The system SHALL publish a scoped public npm package named `@twelvehart/orca-ts` that exposes the public TypeScript API, type declarations, package metadata, and `bunx` execution path for authoring workflows.

#### Scenario: Package exposes public types
- **WHEN** a TypeScript project imports `@twelvehart/orca-ts`
- **THEN** the compiler resolves the public flow, backend, schema, event, and tool types

#### Scenario: Package runs through bunx
- **WHEN** a user invokes Orca through `bunx -p @twelvehart/orca-ts orca`
- **THEN** the package starts the CLI entry point with the same behavior as the local script runtime

#### Scenario: Package installs for typed authoring
- **WHEN** a user adds `@twelvehart/orca-ts` and `typescript` to a project
- **THEN** versioned flow files can import the public package surface and pass the CLI typecheck pre-flight when the project has a `tsconfig.json`

### Requirement: CLI documentation distinguishes package and binary names
The system SHALL document one-shot CLI usage with the npm package name `@twelvehart/orca-ts` and the executable command name `orca` as separate names.

#### Scenario: User runs the current package through bunx
- **WHEN** a user reads one-shot CLI documentation
- **THEN** the documented command uses `bunx -p @twelvehart/orca-ts orca ...`

#### Scenario: User runs a pinned package version through bunx
- **WHEN** a user reads release verification documentation for a specific version
- **THEN** the documented command uses `bunx -p @twelvehart/orca-ts@X.Y.Z orca --version`

### Requirement: Runtime and testing entry points are separated
The package SHALL keep runtime imports free of test-only helpers while exposing test helpers through the explicit `@twelvehart/orca-ts/testing` entry point.

#### Scenario: User imports the root package
- **WHEN** a flow imports from `@twelvehart/orca-ts`
- **THEN** the import exposes runtime-safe flow, backend, model, monitor, plan, review, runner, tool, and `zod` exports without exporting test helpers

#### Scenario: User imports testing helpers
- **WHEN** a test imports from `@twelvehart/orca-ts/testing`
- **THEN** the import exposes test helper APIs without requiring those APIs to be exported from the root package

### Requirement: Standalone embedded fallback is runtime-only
The standalone CLI fallback SHALL embed only modules needed by runtime flow execution under the scoped package name and SHALL NOT embed the testing entry point.

#### Scenario: Standalone flow imports runtime package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orca-ts` without a local project dependency
- **THEN** the embedded fallback resolves the runtime root package

#### Scenario: Standalone flow imports loop package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orca-ts/loop` without a local project dependency
- **THEN** the embedded fallback resolves the loop package

#### Scenario: Standalone flow imports model package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orca-ts/model` without a local project dependency
- **THEN** the embedded fallback resolves the model package

#### Scenario: Standalone flow imports testing package
- **WHEN** a standalone binary runs a flow that imports `@twelvehart/orca-ts/testing` without a local project dependency
- **THEN** the embedded fallback does not provide that testing package

### Requirement: Typecheck pre-flight is default-on
The runner MUST execute `tsc --noEmit` before running a flow by default when project typecheck prerequisites are available. Project typechecking requires `typescript`, `tsconfig.json`, and resolvable local project dependencies including `@twelvehart/orca-ts`. When no typecheckable project setup is available, the runner SHALL skip the pre-flight, warn the user, and mark the run metadata as typecheck-skipped. The runner MAY expose an explicit opt-out flag for local iteration, but the default behavior SHALL preserve author-time type feedback for configured projects.

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
