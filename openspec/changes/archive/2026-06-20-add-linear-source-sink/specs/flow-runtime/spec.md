## ADDED Requirements

### Requirement: Linear runtime accessor is available inside flows
The system SHALL expose a public `linear()` runtime accessor that resolves the
active `FlowContext` Linear tool. The default flow context SHALL provide a
`LinearTool`, and tests SHALL be able to replace it with an override.

#### Scenario: Flow uses default Linear accessor
- **WHEN** a flow starts with default runtime services and calls `linear()`
- **THEN** the accessor returns the active flow context's Linear tool

#### Scenario: Flow overrides Linear accessor
- **WHEN** a flow starts with a Linear tool override
- **THEN** calls to `linear()` inside the flow use the override instead of the default Linear tool

### Requirement: Linear progress updates can occur before final sink emission
The system SHALL allow flow and loop bodies to use `linear()` for intermediate
Linear updates before a final `Sink.emit()` call. Intermediate update failures
SHALL return typed results from `LinearTool` methods so authored flows can
decide whether to continue, retry, or fail.

#### Scenario: Loop emits an early Agent Activity
- **WHEN** a loop body receives a Linear Agent Session event and calls `linear()` before convergence
- **THEN** the loop can create an early Agent Activity without waiting for final sink emission

#### Scenario: Intermediate Linear update fails
- **WHEN** an intermediate Linear update fails
- **THEN** the `LinearTool` method returns an `err(RuntimeError)` that the authored flow can handle

