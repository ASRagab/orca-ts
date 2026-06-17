## MODIFIED Requirements

### Requirement: Triggers are pluggable Sources
The system SHALL define a `Source` interface that subscribes a handler to
trigger events and returns a stop handle, and SHALL provide bundled
implementations: `manual`, `cron`, `watch`, `webhook`, `queue`, Linear issue
events, and Linear Agent Session events. A custom trigger SHALL require
implementing only the `Source` interface.

#### Scenario: Bundled source fires the loop
- **WHEN** a loop is bound to `cron(expr)` and the schedule elapses under `orca serve`
- **THEN** the supervisor receives a trigger event and starts a loop run

#### Scenario: Custom source integrates without engine changes
- **WHEN** a user supplies an object implementing the `Source` interface
- **THEN** the loop accepts it as a trigger with no change to the loop engine

#### Scenario: Linear issue source fires the loop
- **WHEN** a loop is bound to a Linear issue source and a verified matching Linear issue event arrives
- **THEN** the supervisor receives a normalized Linear issue trigger event and starts a loop run

#### Scenario: Linear Agent Session source fires the loop
- **WHEN** a loop is bound to a Linear Agent Session source and a verified matching session event arrives
- **THEN** the supervisor receives a normalized Linear agent trigger event and starts a loop run

### Requirement: Outputs are pluggable Sinks
The system SHALL define a `Sink` interface that emits a typed output and returns
a `Result`, and SHALL provide bundled implementations: `pr`, `file`, `slack`,
`queue`, `stdout`, Linear issue updates, and Linear Agent Session updates. A
custom output SHALL require implementing only the `Sink` interface.

#### Scenario: Bundled sink receives loop output
- **WHEN** a loop converges and its `Sink` is `pr({branch})`
- **THEN** the runtime emits the result to a pull request and returns an `ok` result, or `err` on failure

#### Scenario: Sink failure is a typed result
- **WHEN** a sink emit fails
- **THEN** the failure surfaces as an `err(RuntimeError)`, not a thrown exception

#### Scenario: Linear issue sink receives loop output
- **WHEN** a loop converges and its `Sink` is a Linear issue sink
- **THEN** the runtime emits the configured issue update and returns an `ok` result, or `err` on failure

#### Scenario: Linear Agent Session sink receives loop output
- **WHEN** a loop converges and its `Sink` is a Linear Agent Session sink
- **THEN** the runtime emits the configured Agent Activity or session update and returns an `ok` result, or `err` on failure

