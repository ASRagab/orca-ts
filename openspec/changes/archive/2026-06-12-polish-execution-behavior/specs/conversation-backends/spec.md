## ADDED Requirements

### Requirement: Backend turn execution is bounded
The system SHALL bound autonomous backend turns with explicit inactivity and wall-clock timeouts. Timeout settlement SHALL fail the conversation with a backend-branded error and SHALL NOT call the backend consumer's successful finish path.

#### Scenario: Subprocess backend stalls without output
- **WHEN** a subprocess backend turn emits no stdout line before the configured inactivity timeout
- **THEN** the conversation completes with a failed outcome naming the backend and inactivity threshold
- **THEN** the subprocess is killed

#### Scenario: Subprocess backend remains active past wall-clock limit
- **WHEN** a subprocess backend keeps emitting non-terminal output past the configured wall-clock timeout
- **THEN** the conversation completes with a failed outcome naming the backend and wall-clock threshold
- **THEN** the subprocess is killed

#### Scenario: Subprocess backend completes before timeout
- **WHEN** a subprocess backend emits a terminal event before the inactivity or wall-clock timeout
- **THEN** the conversation returns the normal success or modeled failure outcome
- **THEN** timeout handling does not overwrite that outcome

### Requirement: OpenCode transport phases are abortable
The system SHALL abort OpenCode startup, session creation, prompt submission, event streaming, and server-side turn execution when a conversation is cancelled or times out.

#### Scenario: OpenCode startup never reports a listening URL
- **WHEN** the OpenCode server process starts but does not report a listening URL before the startup timeout
- **THEN** startup fails with an OpenCode backend error
- **THEN** the spawned server process is killed

#### Scenario: OpenCode POST never resolves
- **WHEN** an OpenCode session or prompt POST does not resolve before cancellation or wall-clock timeout
- **THEN** the pending request observes the abort signal
- **THEN** the conversation completes with a cancelled or failed outcome matching the trigger

#### Scenario: OpenCode cancellation aborts only the active turn
- **WHEN** an OpenCode conversation is cancelled after a server session is known
- **THEN** the SSE stream is closed
- **THEN** the system sends a best-effort server-side abort for that session
- **THEN** the shared server remains available for later conversations

### Requirement: Timeout settings are configurable by backend
The system SHALL expose timeout options through backend configuration seams without changing the backend-neutral `Conversation` contract.

#### Scenario: Backend uses explicit timeout option
- **WHEN** a backend is constructed with an explicit inactivity or wall-clock timeout
- **THEN** the backend uses that value for turn timeout decisions

#### Scenario: Backend uses default timeout option
- **WHEN** a backend is constructed without explicit timeout values
- **THEN** the backend uses conservative defaults documented by the driver
