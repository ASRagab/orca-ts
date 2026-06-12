## ADDED Requirements

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
