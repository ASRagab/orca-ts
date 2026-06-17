## ADDED Requirements

### Requirement: Triggers are pluggable Sources
The system SHALL define a `Source` interface that subscribes a handler to trigger events and returns a stop handle, and SHALL provide bundled implementations: `manual`, `cron`, `watch`, `webhook`, and `queue`. A custom trigger SHALL require implementing only the `Source` interface.

#### Scenario: Bundled source fires the loop
- **WHEN** a loop is bound to `cron(expr)` and the schedule elapses under `orca serve`
- **THEN** the supervisor receives a trigger event and starts a loop run

#### Scenario: Custom source integrates without engine changes
- **WHEN** a user supplies an object implementing the `Source` interface
- **THEN** the loop accepts it as a trigger with no change to the loop engine

### Requirement: Outputs are pluggable Sinks
The system SHALL define a `Sink` interface that emits a typed output and returns a `Result`, and SHALL provide bundled implementations: `pr`, `file`, `slack`, `queue`, and `stdout`. A custom output SHALL require implementing only the `Sink` interface.

#### Scenario: Bundled sink receives loop output
- **WHEN** a loop converges and its `Sink` is `pr({branch})`
- **THEN** the runtime emits the result to a pull request and returns an `ok` result, or `err` on failure

#### Scenario: Sink failure is a typed result
- **WHEN** a sink emit fails
- **THEN** the failure surfaces as an `err(RuntimeError)`, not a thrown exception

### Requirement: Sources and Sinks are the trigger and output seams
The system SHALL make `Source` and `Sink` the only loop-level trigger and output boundaries. Step bodies MAY still use flow runtime accessors (`fs`/`git`/`llm`/`command`/...) for work inside the loop, and tests that require no real side effects SHALL inject fake `Source`, fake `Sink`, and fake `FlowContext` services.

#### Scenario: Whole loop runs against fakes
- **WHEN** a test injects a fake `Source`, fake `Sink`, and fake flow runtime services
- **THEN** the loop runs end to end without performing real trigger, output, backend, filesystem, git, or command IO, and the fake sink captures the emitted output
