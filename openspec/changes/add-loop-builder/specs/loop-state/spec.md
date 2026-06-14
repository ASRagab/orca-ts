## ADDED Requirements

### Requirement: State is accessed through a pluggable StateStore port
The system SHALL access loop state through a `StateStore` port exposing `load`, `checkpoint`, `branch`, `merge`, and `history` operations, with `branch`/`merge`/`history` as first-class operations (fan-out = branch, fan-in = merge, monitoring = history). The default adapter SHALL be `snapshot`; the system SHALL also provide a `sqlite` adapter. `dbos` and `dolt` adapters are deferred, but the port shape SHALL keep them expressible.

#### Scenario: Default adapter is zero-config and readable
- **WHEN** a loop runs with no state configuration
- **THEN** the `snapshot` adapter persists the manifest as JSON to `.orca/state-<hash>.json` per cycle, and the file is human-readable and git-diffable

#### Scenario: Adapter is swapped without changing loop code
- **WHEN** the user selects the `sqlite` adapter
- **THEN** the same loop runs against per-step `bun:sqlite` checkpointing with no change to the loop definition

#### Scenario: Branch and merge are port operations
- **WHEN** a fan-out occurs
- **THEN** the store `branch`es per branch and the fan-in `merge`s them through the reducer, regardless of which adapter is active

### Requirement: State is a typed manifest projected for progress, variant, and monitoring
The system SHALL represent loop runtime state as a zod-typed task manifest, and SHALL derive progress, the termination variant, and the per-cycle monitor signal as projections over the same manifest. The loop manifest SHALL NOT replace the existing `.orca/plan-<hash>.md` persistent plan artifact; strategies that operate on plans MAY mirror plan task status into the loop manifest, while plan recovery remains governed by the existing plans-and-review capability.

#### Scenario: Variant and progress share one projection
- **WHEN** the manifest's pending-task count decreases between cycles
- **THEN** the termination variant, the reported progress, and the monitor's `measure` reflect the same decreased value

#### Scenario: Manifest is schema-validated each cycle
- **WHEN** a cycle writes the manifest
- **THEN** it is validated against its zod schema and a validation failure surfaces as an `err(RuntimeError)`

#### Scenario: Persistent plan remains the human plan artifact
- **WHEN** a sequential-task loop is driven from an existing persistent plan
- **THEN** `.orca/plan-<hash>.md` remains recoverable by the existing plan APIs, while the loop manifest stores runtime progress projections used by the loop engine

### Requirement: Loops support stateful-conversation and stateless-respawn topologies
The system SHALL support two execution topologies sharing the manifest spine: stateful-conversation (context persists in-process across cycles) and stateless-respawn (a fresh agent reads the externalized manifest each cycle). Fan-out branches SHALL receive isolated state copies, and the fan-in reducer SHALL be the only place branch state merges.

#### Scenario: Stateless respawn reconstructs from the manifest
- **WHEN** a loop in stateless-respawn topology starts a new cycle
- **THEN** a fresh agent context is constructed solely from the externalized manifest, with no in-process carryover

#### Scenario: Concurrent branches do not share mutable state
- **WHEN** N fan-out branches mutate state concurrently
- **THEN** each writes only its isolated copy and no branch observes another's uncommitted writes; merging happens only at fan-in
