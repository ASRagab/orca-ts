## Purpose

Define the backend-neutral conversation contract and supported v1 backend transports for Orcats.
## Requirements
### Requirement: Conversation contract is backend-neutral
The system SHALL expose one read-only `Conversation` contract for all supported backends. The contract SHALL provide an async event stream, `awaitResult()`, `cancel()`, and a capability flag indicating whether the backend can ask the user.

#### Scenario: Flow consumes backend events through one contract
- **WHEN** a flow starts a conversation with any supported backend
- **THEN** the flow can consume normalized conversation events without transport-specific code

#### Scenario: Conversation reports user-question support
- **WHEN** a v1 backend conversation is created
- **THEN** `canAskUser` is `false`

### Requirement: Stream convergence preserves event order and completion
The system SHALL converge backend transport streams through a shared bounded async queue. The queue SHALL preserve event order, provide backpressure to producers, and complete with a success, cancelled, or failed outcome.

#### Scenario: Scripted backend stream produces ordered events
- **WHEN** a fake backend process emits a scripted stream of messages
- **THEN** the conversation event iterator yields the expected normalized events in order

#### Scenario: Backend stream fails before result completion
- **WHEN** a backend stream terminates with an error before a final result
- **THEN** `awaitResult()` resolves to a failed outcome containing the backend error

#### Scenario: Conversation is cancelled
- **WHEN** a caller cancels an active conversation
- **THEN** the backend process is signalled and the conversation completes with a cancelled outcome

### Requirement: Claude stream-json backend is supported
The system SHALL support Claude autonomous conversations through the existing stream-json read path and SHALL map Claude inbound messages into the normalized conversation event model.

#### Scenario: Claude autonomous stream completes
- **WHEN** Claude emits a valid stream-json autonomous response
- **THEN** the runtime emits normalized assistant/tool/usage events and returns an `LlmResult` branded for Claude

### Requirement: OpenCode HTTP/SSE backend is supported
The system SHALL manage the OpenCode server lifecycle lazily, consume HTTP/SSE events, and map OpenCode messages into the normalized conversation event model. The consumer SHALL scope event handling to the conversation's session: non-terminal events carrying a different session ID SHALL be ignored, and terminal events (`session.idle`, `session.error`) SHALL be ignored only when they carry a session ID that differs from the conversation's session — a terminal event with a missing session ID SHALL settle the turn. Only assistant-role `message.updated` events SHALL update conversation state. At `session.idle` the conversation SHALL fail when the captured assistant message carries an error or when no assistant message and no text were received, and SHALL succeed otherwise. Error messages SHALL be extracted from both the bare `{message}` and wrapped `{name, data: {message}}` envelope shapes, falling back to the raw JSON. Tool parts with error status SHALL surface as error tool results. Cancelling a conversation SHALL best-effort abort the server-side session.

#### Scenario: OpenCode server is reused across conversations
- **WHEN** multiple OpenCode conversations run in the same runtime
- **THEN** the backend reuses the managed server process and tears it down on runtime shutdown

#### Scenario: OpenCode structured result arrives through SSE
- **WHEN** OpenCode emits a schema-formatted result event
- **THEN** the conversation returns the normalized structured result

#### Scenario: Foreign-session events do not settle or pollute the turn
- **WHEN** the SSE stream carries `session.idle`, `session.error`, or `message.updated` events whose session ID differs from the conversation's session
- **THEN** the conversation ignores them and continues awaiting its own session's events

#### Scenario: Terminal event without a session ID settles the turn
- **WHEN** a `session.idle` or `session.error` event arrives with no session ID
- **THEN** the conversation settles instead of hanging

#### Scenario: Non-assistant message update does not clobber assistant state
- **WHEN** a user-echo `message.updated` arrives after the assistant's update populated structured output and usage
- **THEN** the structured output and usage from the assistant message are preserved

#### Scenario: Assistant error surfaces as a failed turn at idle
- **WHEN** the assistant `message.updated` carries an error payload and `session.idle` follows
- **THEN** the conversation fails with the extracted error message instead of succeeding with empty output

#### Scenario: Idle without an assistant message fails
- **WHEN** `session.idle` arrives and no assistant message and no text were received
- **THEN** the conversation fails with a message stating the session went idle without an assistant message

#### Scenario: Wrapped error envelope yields the real message
- **WHEN** `session.error` carries an error shaped `{name, data: {message: "boom"}}`
- **THEN** the failure message is "boom" rather than a generic fallback

#### Scenario: Tool error frame surfaces as an error tool result
- **WHEN** a `message.part.updated` tool part reports error status with output
- **THEN** the conversation emits a tool result event marked as an error carrying that output

#### Scenario: Cancel aborts the server-side turn
- **WHEN** a caller cancels an active OpenCode conversation
- **THEN** the driver issues a best-effort abort request for the session to the server before tearing down the stream

### Requirement: Codex and Pi backends are supported
The system SHALL support Codex exec JSONL and Pi RPC transports by mapping their native message tables into the same conversation event model. Subprocess-based backends (Codex, Pi) drive a `SubprocessConsumer` that signals completion via an `AbortSignal`. The consumer's `signal` property SHALL be an `AbortSignal` that becomes aborted when the consumer has settled the conversation on a terminal event. The subprocess read loop SHALL treat `consumer.signal.aborted` as the stop condition, kill the child process, and break — identical semantics to the prior `completed` poll flag but expressed as `AbortSignal` for consistency with `conversation.signal`.

#### Scenario: Codex JSONL stream completes
- **WHEN** Codex emits thread, item, and turn completion messages
- **THEN** the runtime emits normalized events and synthesizes the expected final result

#### Scenario: Pi RPC stream completes
- **WHEN** Pi emits RPC conversation messages
- **THEN** the runtime emits normalized events and returns an `LlmResult` branded for Pi

#### Scenario: Codex JSONL stream completes (AbortSignal)
- **WHEN** the Codex backend processes a JSONL stream to a terminal `turn.completed` event
- **THEN** `consumer.signal` becomes aborted
- **THEN** the subprocess read loop kills the child process and stops consuming lines
- **THEN** the conversation result is available via `awaitResult()`

#### Scenario: Pi RPC stream completes (AbortSignal)
- **WHEN** the Pi backend receives a terminal RPC response
- **THEN** `consumer.signal` becomes aborted
- **THEN** the subprocess read loop kills the persistent Pi process and stops

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

### Requirement: Human interaction seams are reserved but unimplemented
The event model SHALL include reserved `UserQuestion` and `ApproveTool` variants, but v1 backends MUST NOT implement MCP ask-user bridges, live human approval prompts, or backend settings mutation for those features.

#### Scenario: Backend emits a reserved user-question event
- **WHEN** a v1 backend adapter encounters a user-question transport message
- **THEN** the conversation fails with an explicit unsupported-feature error

#### Scenario: Flow requests live tool approval
- **WHEN** a v1 flow requests human approval for a tool call
- **THEN** the runtime rejects the request as unsupported before invoking the backend

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
