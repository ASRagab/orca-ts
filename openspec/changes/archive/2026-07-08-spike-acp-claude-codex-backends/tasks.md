## 1. ACP Surface Discovery

- [x] 1.1 Read the current official ACP docs for initialization, session setup, prompt turns, cancellation, transports, tool calls, and TypeScript SDK usage.
- [x] 1.2 Read the current official Claude and Codex ACP integration docs or command help, and record the exact ACP entry point for each tool.
- [x] 1.3 Verify local prerequisite commands for Claude and Codex without running a live prompt.
- [x] 1.4 Decide whether the spike can use direct JSON-RPC plumbing or should add `@agentclientprotocol/sdk`; if adding the SDK, use the package manager and document why.

## 2. Transcript And Fixture Capture

- [x] 2.1 Capture sanitized current-transport baseline transcripts for Claude and Codex read-only success, failure, cancellation, and structured-output validation.
- [x] 2.2 Capture sanitized ACP transcripts for Claude and Codex initialize, session creation, prompt updates, terminal result, cancellation, failure, and shutdown.
- [x] 2.3 Store deterministic fixtures for ACP JSON-RPC messages and current transport output under the existing backend fixture style.
- [x] 2.4 Record tool versions, models, auth mode, OS, repository fixture, and prompt text used for every captured transcript.

## 3. Experimental ACP Driver

- [x] 3.1 Add a narrow internal ACP client seam that can spawn an agent process, send JSON-RPC requests, route responses by id, consume notifications, and close the process.
- [x] 3.2 Add tests for ACP initialize, session creation, prompt completion, streaming updates, cancellation, request errors, malformed messages, and process exit.
- [x] 3.3 Prototype Claude ACP transport behind the existing `claude` backend tag without changing the public API.
- [x] 3.4 Prototype Codex ACP transport behind the existing `codex` backend tag without changing the public API.
- [x] 3.5 Preserve existing subprocess transports while the benchmark decision is pending.
- [x] 3.6 Ensure ACP cancellation sends `session/cancel`, resolves the Orca conversation as cancelled, and force-kills the process if the agent does not stop within the configured timeout.

## 4. Flow And Loop Benchmark Harness

- [x] 4.1 Add a gated direct-prompt benchmark that compares current and ACP transports for Claude and Codex in a disposable git repository.
- [x] 4.2 Add a gated flow benchmark that runs the same backend-neutral flow through current and ACP transports for Claude and Codex.
- [x] 4.3 Add a gated loop benchmark that runs the same backend-neutral loop through current and ACP transports for Claude and Codex.
- [x] 4.4 Record wall time, time to first event, event count, backend prompt count, process count, session reuse, cancellation latency, final outcome, and cleanup status for each run.
- [x] 4.5 Keep all live benchmark commands opt-in so default CI never requires Claude, Codex, credentials, network, or live token spend.

## 5. Performance Claim And Replacement Decision

- [x] 5.1 Write `openspec/changes/spike-acp-claude-codex-backends/acp-performance-report.md` with raw measurements, medians, environment details, prompt definitions, and conclusion.
- [x] 5.2 Decide whether ACP meets the replacement threshold for Claude: at least 15% faster median wall time on selected flow and loop workloads, no worse time to first event, compatible event contract, and clean cancellation.
- [x] 5.3 Decide whether ACP meets the replacement threshold for Codex using the same criteria.
- [x] 5.4 If ACP passes for a backend, replace that backend's existing transport internals while preserving the public backend tag and authoring API.
- [x] 5.5 If ACP fails for a backend, keep the existing subprocess transport and document the no-go evidence in the report.
- [x] 5.6 Update `AGENTS.md` and backend docs only for replacement decisions that actually ship.

## 6. Verification

- [x] 6.1 Run focused ACP client and fixture tests.
- [x] 6.2 Run existing Claude and Codex backend tests to prove current behavior is preserved or intentionally replaced.
- [x] 6.3 Run focused flow tests.
- [x] 6.4 Run focused loop tests.
- [x] 6.5 Run `bun run typecheck`.
- [x] 6.6 Run `bun run docs:check` and `bun run docs:symbols` if docs changed.
- [x] 6.7 Run `bun run verify`.
- [x] 6.8 Run the gated live direct-prompt, flow, and loop benchmark commands for Claude and Codex and attach the results to the performance report.
