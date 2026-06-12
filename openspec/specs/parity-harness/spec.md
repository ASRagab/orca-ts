## Purpose

Define the fixture and parity harness used to lock backend parsing, flow behavior, and Scala oracle disposition.

## Requirements

### Requirement: Shared event and result model is frozen as JSON
The system SHALL define a canonical language-neutral JSON contract for normalized conversation events, Orca runtime events, LLM results, usage accounting, and backend tags before backend implementation begins.

#### Scenario: Model schema exports canonical JSON
- **WHEN** the model package is built
- **THEN** it exports JSON Schema for every canonical event and result type used by fixtures

#### Scenario: Model change is intentional
- **WHEN** a canonical event or result shape changes
- **THEN** the affected fixtures and specs must be updated in the same change

### Requirement: Tier 1 fixtures verify stream-to-event parity
For each backend, the system SHALL include scripted transport input fixtures, expected normalized event fixtures, and expected result or error fixtures. TypeScript backend tests SHALL feed scripted inputs through fake processes or fake transports and assert exact JSON equality.

#### Scenario: Backend fixture passes
- **WHEN** a backend test consumes `input.jsonl` or equivalent scripted stream data
- **THEN** the emitted events and final result match the corresponding golden JSON fixtures exactly

#### Scenario: Backend parser drifts
- **WHEN** a backend adapter emits a normalized event that differs from the golden fixture
- **THEN** the Tier 1 test fails with a diff that identifies the mismatched event or result

### Requirement: Tier 2 fixtures verify flow behavior
The system SHALL include native TypeScript e2e fixtures against fake agents for user-visible flow behavior not covered by stream parsing. Tier 2 SHALL assert git commits, persisted plan files, and terminal/event-log output.

#### Scenario: Plan flow golden run passes
- **WHEN** a fake-agent flow implements a persisted plan
- **THEN** the commits, `.orca/plan-<hash>.md` content, and event log match the golden fixture

#### Scenario: Review flow golden run passes
- **WHEN** a fake-agent flow runs review and fix automation
- **THEN** reviewer selection, fix-loop events, commits, and terminal output match the golden fixture

### Requirement: Scala oracle is local-only and retired per slice
The system SHALL use the Scala implementation as a local author-time oracle while creating fixtures for a slice. Once the TypeScript fixtures for that slice are frozen, CI SHALL run only TypeScript checks for that slice.

#### Scenario: Slice fixture is created from Scala behavior
- **WHEN** a new slice ports Scala behavior
- **THEN** the implementer compares TypeScript output against the local Scala oracle before freezing the JSON fixture

#### Scenario: CI runs after fixture freeze
- **WHEN** CI validates a completed slice
- **THEN** CI runs TypeScript tests without requiring the Scala repository or JVM toolchain

### Requirement: ADR disposition is tracked as acceptance criteria
The system SHALL maintain a matrix that maps each referenced Scala ADR to a port disposition and at least one acceptance test or explicit cut/deferred marker.

#### Scenario: ADR behavior is ported
- **WHEN** an ADR behavior is marked ported
- **THEN** at least one TypeScript test or fixture demonstrates the accepted behavior

#### Scenario: ADR behavior is cut or deferred
- **WHEN** an ADR behavior is marked cut or deferred
- **THEN** the matrix records the rationale and any reserved compatibility seam


### Requirement: Timeout behavior is covered by deterministic fixtures
The system SHALL include deterministic tests for backend, command, and monitor timeout behavior before relying on live backend smoke.

#### Scenario: Fake subprocess hang fails deterministically
- **WHEN** a fake subprocess backend stdout stream never emits a terminal event
- **THEN** the focused backend test observes a timeout failure outcome
- **THEN** the fake process records that it was killed

#### Scenario: Fake OpenCode transport hang fails deterministically
- **WHEN** a fake OpenCode startup or POST path never resolves
- **THEN** the focused OpenCode backend test observes the configured timeout or cancellation behavior
- **THEN** the fake transport observes the abort or kill action expected for that phase

#### Scenario: Fake command hang fails deterministically
- **WHEN** a fake command process never closes before its configured timeout
- **THEN** the tools test observes a failed command result with null exit code and timeout message
- **THEN** the fake process records that it was killed

### Requirement: Monitor schema is validated by tests
The system SHALL validate monitor log shape and summarization behavior with deterministic tests.

#### Scenario: Monitor log contains required execution fields
- **WHEN** a monitored fake workflow records stages, outcomes, and failures
- **THEN** the test asserts required stage, outcome, failure, summary, duration, command, and optional usage fields

#### Scenario: Summarizer reads monitor logs
- **WHEN** a fixture monitor log contains multiple stages, outcomes, failures, and backends
- **THEN** the summarizer reports backend totals, slowest stages, slowest files, and failure categories without schema errors

### Requirement: Live smoke matrix captures execution metadata
The system SHALL keep live backend smoke gated by environment variables and SHALL make successful smoke runs record comparable execution metadata.

#### Scenario: Live backend smoke remains opt-in
- **WHEN** `ORCA_REAL_BACKEND_SMOKE` is not enabled
- **THEN** live backend smoke tests do not contact real backends

#### Scenario: Live backend smoke records comparable metadata
- **WHEN** live backend smoke runs for a configured backend
- **THEN** the smoke result records wall time, outcome type, event count, session identifier presence, and usage metadata when the backend emits it

### Requirement: Tier 3 real-agent eval validates live backend parity
The system SHALL define a Tier 3 real-agent eval that complements Tier 1 (stream-to-event fixtures) and Tier 2 (fake-agent flow goldens) by running the cleanup flow against real backend CLIs and scoring the result against an objective gate oracle. Tier 3 SHALL be opt-in and gated: it SHALL NOT run in the default deterministic CI gate, which must not require live backend credentials. The objective oracle is behavior-preserving regression safety — every pre-existing green check stays green — not a SWE-bench-style red-to-green task. Tier 3 SHALL produce a per-backend convergence-cost matrix from runs that share one pinned base commit.

#### Scenario: Tier 3 is excluded from default CI
- **WHEN** the default deterministic verification gate runs
- **THEN** the Tier 3 real-agent eval does not run and no live backend credentials are required

#### Scenario: Tier 3 uses the objective gate oracle
- **WHEN** a Tier 3 eval run scores a backend's change to a file
- **THEN** the verdict is determined by whether the targeted gate stays green, with the change reverted if it cannot be made to pass

#### Scenario: Tier 3 runs are comparable across backends
- **WHEN** Tier 3 evaluates more than one backend
- **THEN** each backend runs from the same pinned base commit so the resulting matrix compares like with like
