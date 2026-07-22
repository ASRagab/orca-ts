## MODIFIED Requirements

### Requirement: Claude backend executes autonomous conversations live
The system SHALL expose a live `LlmBackend<"claude">` accessor that launches Claude through the ACP transport by default, feeds ACP session updates into the shared conversation stream, and returns a Claude-branded `LlmResult`. The accessor MUST NOT return an unsupported-backend error. It SHALL support model selection where the ACP adapter exposes it, structured output validated against a supplied schema, cancellation, bounded lifecycle, backend-branded failures, and an explicit fallback to the previous stream-json subprocess transport.

#### Scenario: Claude autonomous run returns a branded result
- **WHEN** a flow starts an autonomous conversation with the `claude` backend and the ACP adapter emits a valid prompt response
- **THEN** the runtime drives the ACP session to completion and `awaitResult()` returns a successful `LlmResult` branded for Claude

#### Scenario: Claude structured output is validated
- **WHEN** an autonomous Claude conversation requests a structured output schema and the ACP-backed model returns matching JSON
- **THEN** the conversation returns the typed structured result, and on non-matching output returns a typed validation error carrying the raw output

#### Scenario: Claude conversation is cancelled
- **WHEN** a caller cancels an active Claude ACP conversation
- **THEN** the driver sends `session/cancel`, waits for ACP prompt cancellation, and force-closes the owned process if the agent does not stop within the configured timeout
- **THEN** the conversation completes with a cancelled outcome

#### Scenario: Claude stream-json fallback is explicit
- **WHEN** the operator selects the Claude stream-json fallback
- **THEN** the `claude` backend uses the previous stream-json subprocess transport without changing the public backend tag or authoring API

#### Scenario: Claude ACP setup failure is backend-branded
- **WHEN** Claude ACP initialization, session creation, prompt execution, or shutdown fails
- **THEN** the conversation completes with a `BackendFailed` error naming the failed Claude ACP phase

### Requirement: Codex and Pi backends are supported
The system SHALL support Codex exec JSONL and Pi RPC transports by mapping their native message tables into the same conversation event model. Codex SHALL use the existing `codex exec --json` subprocess transport by default. Subprocess-based backends (Codex, Pi) drive a `SubprocessConsumer` that signals completion via an `AbortSignal`. The consumer's `signal` property SHALL be an `AbortSignal` that becomes aborted when the consumer has settled the conversation on a terminal event. The subprocess read loop SHALL treat `consumer.signal.aborted` as the stop condition, kill the child process, and break — identical semantics to the prior `completed` poll flag but expressed as `AbortSignal` for consistency with `conversation.signal`.

#### Scenario: Codex JSONL stream completes
- **WHEN** Codex emits thread, item, and turn completion messages through the default subprocess transport
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

#### Scenario: Codex ACP remains non-default
- **WHEN** a caller constructs the `codex` backend without an explicit experimental transport override
- **THEN** the backend uses the subprocess JSONL transport rather than ACP
