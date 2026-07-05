## ADDED Requirements

### Requirement: Flow runtime exposes shared run reporting
The flow runtime SHALL provide legacy flow scripts with access to the active
shared run reporter through the flow context or a compatible terminal adapter.
Flow progress reporting SHALL feed the same event model and presenter used by
loop execution.

#### Scenario: Flow reports a stage through shared reporter
- **WHEN** a flow script reports that a semantic step has started, completed, or
  failed
- **THEN** the active run reporter receives a structured stage event that the
  shared presenter can render

#### Scenario: Flow reporting can be overridden in tests
- **WHEN** a test starts a flow with an overridden reporting or terminal service
- **THEN** flow progress events are captured by the override without writing to
  the real process streams

#### Scenario: Existing terminal flow calls remain compatible
- **WHEN** an existing flow calls the terminal tool to emit simple step or
  assistant-message events
- **THEN** the flow can continue to compile while the runtime adapts those calls
  into the shared reporting path where possible
