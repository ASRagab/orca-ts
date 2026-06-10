## MODIFIED Requirements

### Requirement: Codex, Gemini, and Pi backends are supported
Subprocess-based backends (Codex, Pi) drive a `SubprocessConsumer` that signals completion via an `AbortSignal`. The consumer's `signal` property SHALL be an `AbortSignal` that becomes aborted when the consumer has settled the conversation on a terminal event. The subprocess read loop SHALL treat `consumer.signal.aborted` as the stop condition, kill the child process, and break — identical semantics to the prior `completed` poll flag but expressed as `AbortSignal` for consistency with `conversation.signal`.

#### Scenario: Codex JSONL stream completes
- **WHEN** the Codex backend processes a JSONL stream to a terminal `turn.completed` event
- **THEN** `consumer.signal` becomes aborted
- **THEN** the subprocess read loop kills the child process and stops consuming lines
- **THEN** the conversation result is available via `awaitResult()`

#### Scenario: Gemini JSONL stream completes
- **WHEN** the Gemini backend processes a JSONL stream to a terminal event
- **THEN** `consumer.signal` becomes aborted
- **THEN** the subprocess read loop stops

#### Scenario: Pi RPC stream completes
- **WHEN** the Pi backend receives a terminal RPC response
- **THEN** `consumer.signal` becomes aborted
- **THEN** the subprocess read loop kills the persistent Pi process and stops
