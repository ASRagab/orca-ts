## MODIFIED Requirements

### Requirement: Declarative loop builder lowers to the existing engine
The system SHALL provide a declarative `loop()` builder as the authoring front door that lowers to `flow()` plus the loop execution module. Loop execution SHALL own recurrence, cycle body execution, guards, stop evaluation, and per-cycle progress. `fixLoop` SHALL remain a public generic convergence primitive with the existing issue-list overload preserved for current callers, but the builder SHALL NOT depend on the review module as its recurrence root. A single-cycle loop SHALL be authorable without graph, fan-out, or Effect knowledge.

#### Scenario: Minimal loop is authorable and runs
- **WHEN** an author writes `loop(name).reason(backend, request).until(pred).guard(opts)` and runs it
- **THEN** the builder produces a `flow()` invocation whose convergence is driven by loop execution, and the run returns a `Result` value with a stop reason

#### Scenario: Existing fixLoop callers keep working
- **WHEN** existing review or plan code calls `fixLoop(evaluateIssues, fixIssues, options)`
- **THEN** the call compiles and preserves the previous issue-list behavior and stop reasons, except for additive stop values

#### Scenario: Builder output is readable without engine internals
- **WHEN** a reader inspects a flow file authored with `loop()`
- **THEN** no Effect type, queue, or conversation-machinery symbol appears in the authored source
