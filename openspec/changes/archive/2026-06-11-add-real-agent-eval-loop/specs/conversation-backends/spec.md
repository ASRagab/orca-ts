## REMOVED Requirements

### Requirement: Codex, Gemini, and Pi backends are supported
**Reason**: Gemini is cut. The Gemini CLI is being deprecated by Google in favor of the Antigravity CLI (`agy`), and Gemini only ever shipped as an `unsupportedBackend` stub — its JSONL parser never implemented a streaming `SubprocessConsumer`, so no live Gemini path existed. This bundled requirement is re-scoped to Codex and Pi (see the ADDED "Codex and Pi backends are supported" requirement), which preserves all Codex and Pi behavior unchanged. The cut and its rationale are recorded in the ADR matrix.

**Migration**: No live Gemini path existed, so no caller migration is required. Codex and Pi behavior is preserved verbatim under the re-scoped requirement. Future Google-agent support will be added as a new `agy` backend tag (additive, out of scope for this change), not as a revived Gemini backend.

## ADDED Requirements

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
