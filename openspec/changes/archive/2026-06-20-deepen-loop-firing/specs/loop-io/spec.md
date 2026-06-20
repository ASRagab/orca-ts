## MODIFIED Requirements

### Requirement: Sources and Sinks are the trigger and output seams
The system SHALL make `Source` and `Sink` the only loop-level trigger and output boundaries. Step bodies MAY still use flow runtime accessors (`fs`/`git`/`llm`/`command`/...) for work inside the loop, and tests that require no real side effects SHALL inject fake `Source`, fake `Sink`, and fake `FlowContext` services. Source and Sink adapters SHALL NOT depend on supervisor internals, child process environment variables, or firing-envelope implementation details.

#### Scenario: Whole loop runs against fakes
- **WHEN** a test injects a fake `Source`, fake `Sink`, and fake flow runtime services
- **THEN** the loop runs end to end without performing real trigger, output, backend, filesystem, git, or command IO, and the fake sink captures the emitted output

#### Scenario: Adapter is independent of firing internals
- **WHEN** a loop is run directly with `orca run` or through `orca serve`
- **THEN** its `Source` and `Sink` implementations observe the same public loop event and output contracts without reading child-process environment variables or supervisor internals
