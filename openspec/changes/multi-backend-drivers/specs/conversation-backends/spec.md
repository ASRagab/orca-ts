## ADDED Requirements

### Requirement: Claude backend executes autonomous conversations live
The system SHALL expose a live `LlmBackend<"claude">` accessor that launches the real `claude` process in stream-json mode, feeds its read-path parser into the shared conversation stream, and returns a Claude-branded `LlmResult`. The accessor MUST NOT return an unsupported-backend error. It SHALL support model selection, structured output validated against a supplied schema, and cancellation.

#### Scenario: Claude autonomous run returns a branded result
- **WHEN** a flow starts an autonomous conversation with the `claude` backend and the process emits a valid stream-json response
- **THEN** the runtime drives the process to completion and `awaitResult()` returns a successful `LlmResult` branded for Claude

#### Scenario: Claude structured output is validated
- **WHEN** an autonomous Claude conversation requests a structured output schema and the model returns matching JSON
- **THEN** the conversation returns the typed structured result, and on non-matching output returns a typed validation error carrying the raw output

#### Scenario: Claude conversation is cancelled
- **WHEN** a caller cancels an active Claude conversation
- **THEN** the `claude` process is signalled and the conversation completes with a cancelled outcome

### Requirement: OpenCode backend executes autonomous conversations live
The system SHALL expose a live `LlmBackend<"opencode">` accessor that drives conversations through the managed OpenCode server (HTTP/SSE) and returns an OpenCode-branded `LlmResult`. The accessor MUST NOT return an unsupported-backend error. It SHALL lazily start and reuse one server across conversations, tear the server down on runtime shutdown, support model selection and structured output, and support cancellation.

#### Scenario: OpenCode autonomous run returns a branded result
- **WHEN** a flow starts an autonomous conversation with the `opencode` backend and the server emits a completed SSE result stream
- **THEN** the runtime returns a successful `LlmResult` branded for OpenCode

#### Scenario: OpenCode server is reused then torn down
- **WHEN** multiple OpenCode conversations run in one runtime and the runtime then shuts down
- **THEN** the driver reuses a single managed server process across the conversations and stops it on shutdown

#### Scenario: OpenCode conversation is cancelled
- **WHEN** a caller cancels an active OpenCode conversation
- **THEN** the SSE stream is closed, the conversation completes with a cancelled outcome, and the shared server remains available for later conversations

### Requirement: Pi backend executes autonomous conversations live
The system SHALL expose a live `LlmBackend<"pi">` accessor that launches `pi --mode rpc`, feeds its RPC parser into the shared conversation stream, and returns a Pi-branded `LlmResult`. The accessor MUST NOT return an unsupported-backend error. It SHALL support model selection and cancellation, and structured output where the RPC transport allows.

#### Scenario: Pi autonomous run returns a branded result
- **WHEN** a flow starts an autonomous conversation with the `pi` backend and the process emits valid RPC conversation messages
- **THEN** the runtime returns a successful `LlmResult` branded for Pi

#### Scenario: Pi conversation is cancelled
- **WHEN** a caller cancels an active Pi conversation
- **THEN** the `pi` process is signalled and the conversation completes with a cancelled outcome

### Requirement: Live drivers share one subprocess-stream execution path
The system SHALL drive subprocess-stream backends (codex, claude, pi) through one shared execution helper that maps a command/args builder and a per-line parser onto the conversation convergence engine, so that process spawn, stdout streaming, stderr capture, non-zero-exit failure, and cancellation behave identically across these backends.

#### Scenario: A subprocess backend fails on non-zero exit
- **WHEN** a subprocess-stream backend process exits non-zero before producing a final result
- **THEN** the conversation completes with a failed outcome carrying the backend name and captured stderr

#### Scenario: Codex behavior is preserved after extraction
- **WHEN** the existing codex backend tests run against the shared execution helper
- **THEN** all codex stream, result, structured-output, session, and cancellation tests pass unchanged
