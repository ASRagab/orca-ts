## Why

Claude and Codex currently run through per-turn CLI subprocess transports, which may add meaningful overhead for flows and loops that make repeated short agent calls. ACP offers a persistent, session-oriented JSON-RPC transport over stdio, so Orca should measure whether it improves flow and loop latency enough to justify replacing the existing Claude and Codex transport paths.

## What Changes

- Add a focused spike for ACP-backed Claude and Codex conversations only.
- Compare current CLI subprocess transports against ACP transports for the same flow and loop prompts.
- Establish a measured performance claim using wall time, time to first event, event count, cancellation behavior, cleanup status, and session reuse behavior.
- Decide whether ACP should replace the current Claude and Codex implementations for flow and loop execution.
- Keep the spike out of Cursor scope; Cursor remains covered by the separate `add-cursor-agent-backend` change.
- Do not add a generic ACP abstraction until the Claude/Codex evidence shows it is worth carrying.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `conversation-backends`: Claude and Codex may gain ACP-backed transport implementations when measured flow and loop runs prove ACP is faster and at least as reliable as the existing subprocess transports.

## Impact

- Affected source: Claude and Codex backend transport modules, shared conversation convergence code if needed, backend selection seams, and live validation utilities.
- Affected tests: backend transport tests, cancellation tests, flow tests, loop tests, and gated real-backend performance checks.
- Affected docs: backend implementation notes and release notes only if ACP becomes the replacement transport.
- External dependencies: installed ACP-capable Claude and Codex agent commands, plus optional `@agentclientprotocol/sdk` if the spike proves the SDK is the smallest reliable client implementation.
- Operational constraints: default CI stays deterministic; live ACP validation is opt-in and must use disposable repositories.
