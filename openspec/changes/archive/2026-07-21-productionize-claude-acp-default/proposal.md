## Why

The ACP spike showed Claude ACP materially faster than the current Claude subprocess stream for direct, flow, and loop workloads, while Codex ACP was slower across the same matrix. Orca should turn that evidence into a production-ready backend decision: Claude uses ACP by default, Codex stays on its existing subprocess transport.

## What Changes

- Make Claude's live backend use the ACP transport by default.
- Keep Codex's existing `codex exec --json` subprocess transport as the default implementation.
- Retain an explicit fallback or escape hatch for Claude's previous stream-json transport during rollout.
- Harden the Claude ACP driver for production use: bounded lifecycle, cancellation, backend-branded failures, structured output, and stable event mapping.
- Add a review and validation gate before PR readiness, including deterministic tests, live smoke, benchmark confirmation, and sub-agent review.
- Leave the public backend tag and authoring API unchanged.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `conversation-backends`: Claude's supported live backend transport changes from default stream-json subprocess execution to default ACP execution, while Codex remains subprocess-backed by default.

## Impact

- Affected source: Claude backend selection and ACP driver internals, shared ACP tests, live backend smoke paths, benchmark scripts, backend docs if they describe transport defaults.
- Affected tests: Claude backend tests, ACP client tests, focused flow and loop tests, real backend smoke for Claude and Codex, full verification gate.
- Affected docs/specs: `conversation-backends` requirements and any user-facing backend transport notes.
- External dependencies: installed `claude-agent-acp` or a configured Claude ACP command; no new runtime SDK dependency unless implementation proves the local JSON-RPC client is insufficient.
- Operational constraint: default CI remains deterministic and must not require live Claude, Codex, credentials, network, or token spend.
