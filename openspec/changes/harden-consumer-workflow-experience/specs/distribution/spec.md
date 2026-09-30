## MODIFIED Requirements

### Requirement: Typecheck pre-flight is default-on
The CLI MUST typecheck a workflow or loop module before starting a backend by default. `orcats check` and execution preflight SHALL use the same self-contained checker, which SHALL work without a target-repository `tsconfig.json`, TypeScript installation, package dependency, or network access and SHALL resolve the bundled public Orcats declarations. The CLI MAY additionally honor compatible target-project type information when available and MAY expose an explicit opt-out for local iteration, but missing target-project prerequisites MUST NOT cause the self-contained check to be skipped.

#### Scenario: Typecheck passes
- **WHEN** a user runs `orcats check` for a valid workflow in a non-TypeScript repository with network access disabled and no target-repository dependencies installed
- **THEN** the checker resolves the bundled Orcats declarations and reports success

#### Scenario: Self-contained loop check passes offline
- **WHEN** a user runs `orcats check` for a valid import-safe loop module in a non-TypeScript repository with network access disabled and no target-repository dependencies installed
- **THEN** the checker resolves the bundled Orcats declarations and reports success without firing the loop

#### Scenario: Typecheck fails
- **WHEN** the self-contained checker finds a type error in the selected workflow or loop module
- **THEN** the runner exits with compiler diagnostics and does not start the selected backend

#### Scenario: Execution preflight reuses the check contract
- **WHEN** a user runs a valid workflow or loop without disabling typechecking
- **THEN** execution applies the same self-contained artifact check exposed by `orcats check` before starting the selected backend

#### Scenario: Project setup is missing
- **WHEN** the target repository has no TypeScript project or local compiler installation
- **THEN** the runner uses the bundled offline checker and does not skip preflight

#### Scenario: User explicitly skips typecheck
- **WHEN** a user passes the documented no-typecheck escape hatch
- **THEN** the runner skips the preflight and marks the run metadata as typecheck-skipped

#### Scenario: Public authoring types remain stable
- **WHEN** the self-contained checker validates imports from the documented `@twelvehart/orcats` public entry points
- **THEN** it uses the packaged public declarations without requiring or exposing an alternate authoring API

### Requirement: Npm package artifact is curated and verified
The system SHALL define and verify npm package contents before publish so the
tarball contains only the public runtime, declarations, executable, metadata,
README, license, notice, and self-contained checker inputs needed by consumers.

#### Scenario: Package contents are allowlisted
- **WHEN** package validation inspects the npm tarball file list
- **THEN** the tarball includes `package.json`, `README.md`, `LICENSE`, `NOTICE`, `bin/orcats`, `src/**`, generated declarations under `dist/**`, and the compiler runtime, required standard-library files, and public Orcats declarations under `dist/checker/**`

#### Scenario: Internal files are excluded
- **WHEN** package validation inspects the npm tarball file list
- **THEN** the tarball excludes tests, fixtures, website source/build output, OpenSpec archives, `.github`, local workflow files, ignored build caches, and release tarballs

#### Scenario: Packed package installs in a temporary project
- **WHEN** package smoke installs the packed tarball into a temporary TypeScript project
- **THEN** imports from `@twelvehart/orcats`, `@twelvehart/orcats/loop`, `@twelvehart/orcats/model`, and `@twelvehart/orcats/testing` typecheck

#### Scenario: Packed package exposes the CLI binary
- **WHEN** package smoke invokes the installed package's `orcats --version` binary
- **THEN** it reports the same version as `package.json`

## ADDED Requirements

### Requirement: Supported launchers isolate Orcats from ambient Bun preloads
Source-checkout, npm-package, and release-binary launchers SHALL remove
`BUN_OPTIONS` from the environment immediately before entering the compiled or
Bun runtime and before launching workflow or repository child processes. They
SHALL preserve unrelated environment variables.

#### Scenario: Release binary ignores poisoned Bun options
- **WHEN** the packaged release binary launches a valid artifact while `BUN_OPTIONS` names a missing or crashing preload
- **THEN** Orcats removes `BUN_OPTIONS`, completes preflight, and runs the artifact without loading the ambient preload

#### Scenario: Npm launcher ignores poisoned Bun options
- **WHEN** the packed npm `orcats` executable launches a valid artifact while `BUN_OPTIONS` names a missing or crashing preload
- **THEN** the launcher removes `BUN_OPTIONS` before entering Bun and the artifact runs without loading the ambient preload

#### Scenario: Source-checkout launcher ignores poisoned Bun options
- **WHEN** a user invokes the source checkout's public `bin/orcats` launcher with a valid artifact while `BUN_OPTIONS` names a missing or crashing preload
- **THEN** the launcher removes `BUN_OPTIONS` before entering Bun and the artifact runs without loading the ambient preload

#### Scenario: Repository child receives an isolated environment
- **WHEN** a workflow launches a repository child after Orcats started with `BUN_OPTIONS` set
- **THEN** the child environment does not contain `BUN_OPTIONS` and retains unrelated environment variables

#### Scenario: Supported launcher smoke covers poisoned environment
- **WHEN** deterministic launcher smoke tests run
- **THEN** they exercise source-checkout, release, and npm launch paths with a deliberately poisoned `BUN_OPTIONS` value and require successful artifact preflight and execution

### Requirement: Distribution size growth is explicitly budgeted
The system SHALL record compressed and installed baselines and fixed numeric
maxima in `scripts/release-size-baselines.json`. Each maximum SHALL be no more
than 110 percent of its measured baseline, rounded up to the next KiB. Every
entry SHALL include artifact identity, baseline bytes, maximum bytes, measured
version, and non-empty rationale. Validation SHALL fail malformed budgets or an
artifact larger than its maximum.

#### Scenario: Distribution artifact stays within budget
- **WHEN** release or package validation measures a tracked artifact
- **THEN** its size is at or below the committed numeric maximum

#### Scenario: Budget allowance is excessive
- **WHEN** a committed maximum exceeds 110 percent of baseline rounded up to the next KiB
- **THEN** deterministic validation fails and names the invalid budget

#### Scenario: Baseline evidence is incomplete
- **WHEN** a budget lacks artifact identity, baseline bytes, maximum bytes, measured version, or rationale
- **THEN** deterministic validation fails and names the missing field
