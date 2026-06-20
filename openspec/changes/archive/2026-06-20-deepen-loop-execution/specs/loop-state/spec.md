## MODIFIED Requirements

### Requirement: State is accessed through a pluggable StateStore port
The system SHALL access loop state through a `StateStore` port exposing `load`, `checkpoint`, `branch`, `merge`, and `history` operations, with `branch`/`merge`/`history` as first-class operations (fan-out = branch, fan-in = merge, monitoring = history). Store-backed loop execution SHALL use these operations for branch isolation and recombination rather than reimplementing state branching with direct cloning, and MAY require the narrower `BranchWritableStateStore` capability to persist branch results without appending to cycle history. The default adapter SHALL be `snapshot`; the system SHALL also provide a `sqlite` adapter. `dbos` and `dolt` adapters are deferred, but the port shape SHALL keep them expressible.

#### Scenario: Default adapter is zero-config and readable
- **WHEN** a loop runs with no state configuration
- **THEN** the `snapshot` adapter persists the manifest as JSON to `.orca/state-<hash>.json` per cycle, and the file is human-readable and git-diffable

#### Scenario: Adapter is swapped without changing loop code
- **WHEN** the user selects the `sqlite` adapter
- **THEN** the same loop runs against per-step `bun:sqlite` checkpointing with no change to the loop definition

#### Scenario: Branch and merge are port operations
- **WHEN** a store-backed fan-out occurs
- **THEN** the store `branch`es per branch and the fan-in `merge`s selected branch snapshots through the reducer, regardless of which adapter is active

#### Scenario: Branch result persistence is an additive capability
- **WHEN** existing code implements only the base `StateStore` operations
- **THEN** it remains source-compatible, while store-backed fan-out requires a `BranchWritableStateStore` to save isolated branch results

#### Scenario: Summary-only fan-out can remain in memory
- **WHEN** a loop uses pure summary-only fan-out without a state store
- **THEN** the bounded concurrency and join policy behavior remains available without requiring a durable adapter
