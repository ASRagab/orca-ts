## ADDED Requirements

### Requirement: Claude and Codex ACP transports are performance-gated
The system SHALL evaluate ACP-backed Claude and Codex transports against the existing Claude and Codex subprocess transports before replacing either implementation. The evaluation SHALL use backend-neutral conversations and SHALL include direct prompt, flow, and loop workloads. ACP SHALL NOT replace an existing transport unless the measured flow and loop runs are faster according to the documented threshold and preserve the existing conversation contract.

#### Scenario: ACP baseline captures direct prompt performance
- **WHEN** the spike runs a direct read-only prompt against current and ACP transports for Claude and Codex
- **THEN** the report records wall time, time to first event, event count, process count, session identity presence, final outcome, and cleanup status for each run

#### Scenario: ACP baseline captures flow performance
- **WHEN** the spike runs the selected flow workload against current and ACP transports for Claude and Codex
- **THEN** the report records total wall time, backend prompt count, time to first backend event per prompt, final result status, and cleanup status for each run

#### Scenario: ACP baseline captures loop performance
- **WHEN** the spike runs the selected loop workload against current and ACP transports for Claude and Codex
- **THEN** the report records convergence outcome, stop reason, iteration count, backend prompt count, total wall time, per-cycle backend timing, and cleanup status for each run

#### Scenario: ACP replacement requires faster flow and loop runs
- **WHEN** the ACP transport does not meet the documented replacement threshold for both selected flow and loop workloads
- **THEN** the system keeps the existing Claude and Codex subprocess transports as the supported implementations

#### Scenario: ACP replacement preserves conversation contract
- **WHEN** ACP meets the performance threshold for a backend
- **THEN** deterministic tests prove ordered events, terminal result settlement, structured output validation, backend-branded result typing, timeout behavior, and cancellation behavior remain compatible with that backend's existing `Conversation` contract

### Requirement: ACP process lifecycle is explicit and bounded
The system SHALL treat each ACP agent as an owned persistent child process with explicit startup, initialization, session creation or resume, prompt execution, cancellation, and shutdown. The ACP driver SHALL NOT rely on hidden global processes, and it SHALL clean up owned sessions and processes when a conversation or runtime ends.

#### Scenario: ACP process is reused within one runtime
- **WHEN** one flow or loop runtime performs multiple Claude or Codex backend calls through the ACP prototype
- **THEN** the backend can reuse one initialized ACP process instead of spawning a new process for each prompt

#### Scenario: ACP runtime shutdown stops owned process
- **WHEN** the runtime shuts down after ACP-backed conversations
- **THEN** all owned ACP sessions are closed or cancelled where supported and the child process exits

#### Scenario: ACP cancellation stops active turn
- **WHEN** a caller cancels an active ACP-backed conversation
- **THEN** the driver sends the protocol cancellation request for the active session, reports a cancelled Orca outcome, and kills the child process if the agent does not stop within the configured timeout

#### Scenario: ACP failure remains backend-branded
- **WHEN** ACP initialization, session creation, prompt execution, or shutdown fails
- **THEN** the conversation completes with a backend-branded runtime error naming the failed ACP phase
