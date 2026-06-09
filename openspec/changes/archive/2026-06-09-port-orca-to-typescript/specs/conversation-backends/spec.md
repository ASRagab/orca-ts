## ADDED Requirements

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
The system SHALL manage the OpenCode server lifecycle lazily, consume HTTP/SSE events, and map OpenCode messages into the normalized conversation event model.

#### Scenario: OpenCode server is reused across conversations
- **WHEN** multiple OpenCode conversations run in the same runtime
- **THEN** the backend reuses the managed server process and tears it down on runtime shutdown

#### Scenario: OpenCode structured result arrives through SSE
- **WHEN** OpenCode emits a schema-formatted result event
- **THEN** the conversation returns the normalized structured result

### Requirement: Codex, Gemini, and Pi backends are supported
The system SHALL support Codex exec JSONL, Gemini stream-json JSONL, and Pi RPC transports by mapping their native message tables into the same conversation event model.

#### Scenario: Codex JSONL stream completes
- **WHEN** Codex emits thread, item, and turn completion messages
- **THEN** the runtime emits normalized events and synthesizes the expected final result

#### Scenario: Gemini JSONL stream completes
- **WHEN** Gemini emits init, message, tool-use, tool-result, and result messages
- **THEN** the runtime emits normalized events and returns the expected final result without mutating settings for ask-user wiring

#### Scenario: Pi RPC stream completes
- **WHEN** Pi emits RPC conversation messages
- **THEN** the runtime emits normalized events and returns an `LlmResult` branded for Pi

### Requirement: Human interaction seams are reserved but unimplemented
The event model SHALL include reserved `UserQuestion` and `ApproveTool` variants, but v1 backends MUST NOT implement MCP ask-user bridges, live human approval prompts, or backend settings mutation for those features.

#### Scenario: Backend emits a reserved user-question event
- **WHEN** a v1 backend adapter encounters a user-question transport message
- **THEN** the conversation fails with an explicit unsupported-feature error

#### Scenario: Flow requests live tool approval
- **WHEN** a v1 flow requests human approval for a tool call
- **THEN** the runtime rejects the request as unsupported before invoking the backend
