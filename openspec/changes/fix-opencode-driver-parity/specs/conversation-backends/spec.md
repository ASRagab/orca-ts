## MODIFIED Requirements

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
