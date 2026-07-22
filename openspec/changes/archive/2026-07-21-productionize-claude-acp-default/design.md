## Context

The archived ACP spike added a direct JSON-RPC ACP client seam, env-gated Claude and Codex ACP prototypes, transcript capture, and a live direct/flow/loop benchmark matrix. The benchmark result was asymmetric: Claude ACP was faster than Claude stream-json on every measured workload, while Codex ACP was slower than Codex subprocess execution on every measured workload.

Current production behavior still treats both Claude and Codex as subprocess-stream backends by default. The productionization work should change only the Claude default, keep Codex unchanged by default, and preserve the public `claude` / `codex` backend tags and authoring APIs.

## Goals / Non-Goals

**Goals:**

- Make Claude ACP the default transport for `claude()` and `selectBackend("claude")`.
- Keep Codex's current subprocess JSONL transport as the default.
- Preserve an explicit Claude stream-json fallback during rollout.
- Preserve or improve the existing `Conversation` contract: ordered events, terminal result, cancellation, structured output, backend-branded errors, and bounded lifecycle.
- Add enough validation to make the PR reviewable: deterministic tests, live smoke, benchmark confirmation, sub-agent validation, comprehensive code review, and ready-for-review PR.

**Non-Goals:**

- Do not expose new public backend tags such as `claude-acp` or `codex-acp`.
- Do not make Codex ACP the default.
- Do not require live credentials or network in default CI.
- Do not add `@agentclientprotocol/sdk` unless the local JSON-RPC client proves insufficient during implementation.
- Do not broaden this change to Cursor, OpenCode, Pi, or a generic ACP platform.

## Decisions

### Decision: Claude ACP becomes the default transport

`claude()` should route to the ACP driver by default. The fallback should be explicit and easy to invoke for rollback, for example with a transport override environment variable or backend option.

Alternative considered: keep Claude ACP behind `ORCA_EXPERIMENTAL_ACP_BACKENDS=claude`. That preserves safety but does not productionize the measured improvement and leaves the faster path undiscoverable to normal flow and loop users.

### Decision: Codex stays on subprocess by default

Codex's current `codex exec --json` path should remain the supported default. The spike's single-run matrix showed Codex ACP slower for direct, flow, and loop workloads, so flipping Codex would violate the replacement gate.

Alternative considered: keep a Codex ACP opt-in path. That is acceptable as an experimental diagnostic path if it stays clearly non-default and does not add public API surface.

### Decision: Keep the ACP client internal and dependency-free

The current local JSON-RPC client is small, deterministic, and covered by fake-process fixtures. Productionization should harden it rather than add an SDK dependency preemptively.

Alternative considered: add `@agentclientprotocol/sdk`. That may become useful later, but it adds dependency and API churn before there is a concrete correctness issue the SDK solves.

### Decision: Treat review and validation as implementation tasks, not runtime features

The user explicitly requested comprehensive code review, sub-agent validation, and a ready-for-review PR. These are required gates for this change, but they should live in the task checklist rather than the runtime spec unless they change user-visible behavior.

## Risks / Trade-offs

- Claude ACP adapter availability → Fail with a clear backend-branded setup error and document the fallback.
- ACP event shape drift → Keep deterministic ACP JSON-RPC fixtures and live smoke coverage.
- Cancellation mismatch between Orca and ACP → Send `session/cancel`, wait for terminal cancellation, then force-close the owned process after a timeout.
- Performance regression after default flip → Run live direct/flow/loop benchmark confirmation before PR readiness.
- Hidden context leakage from persistent sessions → Scope any process/session reuse to an owned backend runtime; do not leak sessions across independent flow runs.
- Codex accidental default flip → Add tests asserting Codex still builds/runs the subprocess path by default.

## Migration Plan

1. Promote the Claude ACP path from experimental opt-in to default.
2. Add an explicit Claude stream-json fallback.
3. Keep Codex subprocess default and test that it stays default.
4. Harden deterministic ACP tests for success, structured output, cancellation, failures, malformed JSON, and process exit.
5. Run focused Claude/Codex backend tests, flow tests, loop tests, typecheck, docs checks if docs change, and `bun run verify`.
6. Run gated live smoke and benchmark confirmation for Claude ACP default and Codex subprocess default.
7. Run a sub-agent validation gate and a comprehensive code review.
8. Create a ready-for-review PR.

Rollback is the fallback transport: set Claude back to stream-json default or use the explicit fallback override until the issue is fixed.

## Open Questions

- What exact fallback spelling should ship: `ORCA_CLAUDE_TRANSPORT=stream-json`, `ORCA_DISABLE_CLAUDE_ACP=1`, or an internal backend option?
- Should Codex ACP remain as an experimental opt-in path after this change, or should the productionization remove it until a future spike improves performance?
- Should docs mention the Claude ACP implementation detail in user-facing backend docs, or keep it in maintainer notes because the public authoring API is unchanged?
