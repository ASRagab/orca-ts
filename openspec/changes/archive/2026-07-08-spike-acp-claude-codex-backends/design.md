## Context

Orca currently runs Claude and Codex through one-shot CLI transports. Each `autonomous()` call builds a command, spawns a subprocess, consumes stdout until a terminal event, then tears the process down. This keeps the implementation simple and deterministic, but it may impose repeated startup and session setup overhead in flows and loops.

ACP is not a network socket. The official protocol is JSON-RPC 2.0 over a persistent stdio subprocess. A client initializes the process once, creates or resumes a session, sends repeated `session/prompt` requests, receives `session/update` notifications, and cancels with `session/cancel`. That model is closer to Orca's managed OpenCode runtime than to `runSubprocessConversation()`.

The spike is intentionally limited to Claude and Codex. Cursor remains covered by `add-cursor-agent-backend`, and this change should not expand into a generic ACP platform until the two existing subprocess backends prove the value.

## Goals / Non-Goals

**Goals:**

- Prove whether ACP materially reduces flow and loop runtime for Claude and Codex.
- Compare current CLI transports and ACP transports with the same prompts, repositories, models where possible, timeout settings, and cleanup rules.
- Validate that ACP preserves the existing backend-neutral `Conversation` contract: ordered events, terminal result, cancellation, failures, session identity, and structured output validation.
- Produce a written performance claim with enough evidence to decide whether ACP should replace the existing Claude and Codex transports.
- Keep default CI deterministic; all live ACP runs remain explicitly gated.

**Non-Goals:**

- Do not add ACP support for Cursor, OpenCode, Pi, or a new backend tag in this spike.
- Do not expose ACP concepts in the public authoring API.
- Do not replace Claude or Codex transports unless the benchmark shows faster flow and loop execution with equal or better reliability.
- Do not support interactive human questions or live approval prompts beyond the existing autonomous policy.
- Do not guarantee provider/model speed; measure Orca-observable transport and end-to-end behavior.

## Decisions

### Decision: Treat ACP as a replacement candidate, not an additive mode

The spike should answer one question: should Claude and Codex use ACP instead of their current one-shot CLI transports? If ACP is faster for both selected flow and loop workloads and preserves reliability, the implementation path becomes replacement. If not, the result is a documented no-go or follow-up.

Alternative considered: add ACP as a user-selectable variant, such as `claude-acp` or config-driven transport selection. That would expand public surface before the value is proven and would make docs, tests, and support more complex.

### Decision: Measure flow and loop workloads, not only raw prompts

Raw prompt timing can show process startup cost, but the user-facing claim is about Orca flows and loops. The spike should include:

- a direct single-turn prompt to isolate transport overhead;
- an existing or minimal flow that performs repeated backend calls;
- an existing or minimal loop that performs multiple cycles;
- cancellation and timeout probes for each ACP backend.

The performance claim should report wall time, time to first event, event count, prompt count, process count, session reuse, cancellation latency, and cleanup status.

### Decision: Require a clear replacement threshold

ACP qualifies as the replacement only when the measured flow and loop runs satisfy all of these:

- ACP median wall time is at least 15% faster than the current transport for both Claude and Codex, or the measured per-turn startup overhead removed by ACP is large enough to dominate short-loop execution.
- ACP time to first event is no worse than the current transport for the same workload.
- ACP cancellation completes without leaving an active agent turn or owned process.
- ACP emits enough structured progress and terminal state to preserve or improve existing normalized events.
- Existing deterministic tests remain equivalent or become simpler; no new default-CI live dependency is introduced.

The 15% bar avoids replacing a stable transport for measurement noise. If long single-turn prompts show no improvement but repeated loops do, the replacement decision should be scoped to workloads where session reuse matters.

### Decision: Implement the smallest ACP client that can be tested

The spike should first capture live protocol transcripts for Claude and Codex ACP startup, prompt, completion, cancellation, and failure. If direct JSON-RPC plumbing is small and stable, implement it locally with a narrow test seam. If the protocol bookkeeping becomes larger than the backend logic, use `@agentclientprotocol/sdk` as an internal dependency after verifying its version and API.

Alternative considered: start with the SDK unconditionally. That may be correct, but it should not be assumed before seeing the minimal client surface Orca needs.

### Decision: Keep backend lifecycle explicit

An ACP backend instance should own one persistent child process per backend runtime, with explicit shutdown like OpenCode. Each conversation should map to a known ACP session and close or cancel it when the Orca conversation completes. The driver must not keep hidden global processes alive.

For loops, the same backend instance should reuse the ACP process and session when the flow context intentionally reuses the backend. For independent flow runs, a fresh runtime should avoid leaking state across user tasks.

## Risks / Trade-offs

- ACP reduces spawn overhead but may retain more session context than intended -> Scope session reuse to one backend runtime and document when new sessions are created.
- Claude and Codex ACP surfaces may differ in supported capabilities -> Capture separate transcripts and avoid assuming one parser covers both until proven.
- Persistent processes can keep editing after cancellation -> Implement `session/cancel`, wait for terminal cancellation, then kill the process if the turn does not stop.
- Performance may be dominated by provider latency -> Report time to first event, prompt count, and process count alongside wall time so the conclusion is honest.
- A generic ACP layer can over-abstract too early -> Keep the spike backend-specific until both implementations share enough code naturally.
- Adding the ACP SDK may increase dependency surface -> Prefer a small local client unless the SDK clearly reduces correctness risk.

## Migration Plan

1. Capture Claude and Codex ACP transcripts and current CLI baseline transcripts.
2. Build deterministic fixtures for initialize, session creation, prompt updates, terminal result, cancellation, and failure.
3. Implement a narrow experimental ACP client seam behind tests.
4. Add Claude and Codex ACP prototype backends without changing public tags.
5. Run direct prompt, flow, and loop benchmarks against current and ACP transports in disposable repositories.
6. Record the performance claim and decision in implementation notes.
7. If ACP passes the replacement gate, replace the existing Claude and Codex transport internals while preserving public tags and API.
8. If ACP fails, remove or keep only non-shipped spike code and document the no-go evidence.

Rollback before release is straightforward: keep the existing Claude and Codex subprocess transports and remove the experimental ACP files, fixtures, dependency, and docs.

## Open Questions

- Which installed Claude and Codex commands expose stable ACP entry points in this environment?
- Do both ACP implementations emit usage and session identifiers needed for Orca's result model?
- Should loop execution deliberately reuse one ACP session across cycles, or create one session per backend call while only reusing the process?
- Is the SDK worth the dependency, or is a local JSON-RPC client smaller and easier to audit?
- What flow and loop prompts best represent the performance claim without spending excessive live tokens?
