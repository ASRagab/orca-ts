# Polish Execution Behavior

## Why

The dogfood cleanup workflow now exercises real backends long enough that a silent CLI hang, stalled HTTP startup, or validation command stall can consume the whole run without attribution. We need bounded execution and per-stage wall-time evidence before optimizing the validation loop, otherwise we risk hiding correctness failures while trying to reduce runtime.

## What Changes

- Add timing and failure attribution around workflow stages: baseline checks, per-file cleanup, agent turn, targeted validation, repair, commits, final verify, and publish/no-publish.
- Add command duration reporting and configurable timeout handling so validation-command hangs fail explicitly instead of looking like backend stalls.
- Harden backend turn execution with inactivity and absolute timeout behavior for subprocess backends, and abortable OpenCode startup/HTTP/SSE paths.
- Keep the safe full validation gates while collecting baseline data; only remove duplicated per-file checks when telemetry proves correctness remains covered.
- Extend deterministic tests, live backend smoke, and dogfood-monitoring instructions so before/after behavior is comparable across backends.
- Update stale docs after behavior is verified so README/backend support statements match the implemented drivers.

## Capabilities

### New Capabilities

- `execution-observability`: Workflow runs expose structured stage timing, command duration, backend turn duration, failure attribution, repair count, verdict, touched paths, and backend usage when emitted.

### Modified Capabilities

- `conversation-backends`: Backend turns gain bounded execution and cancellation/timeout semantics across subprocess transports and OpenCode server/HTTP/SSE phases.
- `flow-runtime`: Runtime command execution gains timeout-aware failures and duration telemetry usable by workflows and monitors.
- `parity-harness`: Deterministic fixtures and live smoke validation cover timeout, abortability, telemetry shape, and real-backend execution behavior.

## Impact

- `src/backends/subprocess-run.ts`, `src/backends/*-run.ts`, `src/backends/opencode-run.ts` — bounded backend turn execution, timeout failures, and abort propagation.
- `src/tools/process.ts`, `src/flow/context.ts` — command timeout options and duration reporting through runtime tools.
- `src/monitor/index.ts`, `workflows/ai-slop-cleanup.ts`, `scripts/summarize-run.ts` — stage timing, failure attribution, usage, repair count, and dogfood run summaries.
- `tests/*backend*.test.ts`, `tests/tools.test.ts`, `tests/workflow-harness.test.ts`, `tests/integration/real-backend-smoke.test.ts` — fake hangs, timeout branches, monitor schema checks, and live backend smoke matrix.
- `.orca/execution-polish-validation-plan.md`, README/backend docs — source validation ladder and cleanup-phase docs alignment.
