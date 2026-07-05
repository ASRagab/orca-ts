## Why

Orca's CLI currently exposes sparse command diagnostics and low-level monitor
lines while agents are working, so users cannot quickly understand what the run
is doing, what has changed, or why it stopped. Because Orca orchestrates coding
agents, the live output should synthesize execution facts into useful progress
without becoming noisy logging or compromising machine-readable outputs.

## What Changes

- Introduce a shared run-output event model for execution facts such as run
  start, preflight, stage progress, agent activity, loop cycles, artifacts, and
  final outcome.
- Add a deterministic presenter that renders concise human CLI output from the
  shared events, with TTY-friendly formatting and plain output for CI.
- Adapt loop execution and legacy flow scripts to the shared reporter so output
  behavior is consistent without duplicated formatting logic.
- Preserve stdout for flow/sink payloads and route progress/status output to the
  CLI diagnostic channel.
- Keep structured monitor/log data available for automation and debugging.
- Leave lightweight LLM narration as an optional extension over event batches,
  not as the default renderer or the sole source of truth.

## Capabilities

### New Capabilities

- `cli-run-output`: Defines user-facing CLI progress and summary output for
  Orca runs, including formatting, aggregation, stream separation, and optional
  narration behavior.

### Modified Capabilities

- `execution-observability`: Reuse structured execution facts as the source for
  human progress output while preserving monitor log semantics.
- `flow-runtime`: Allow legacy flow scripts to report structured progress
  through the same reporting abstraction used by loops.

## Impact

- Affected code: `src/cli/main.ts`, `src/monitor/index.ts`,
  `src/tools/terminal.ts`, `src/flow/context.ts`, loop firing/execution paths,
  and flow templates that currently instantiate `WorkflowMonitor` directly.
- Affected behavior: interactive CLI output becomes more informative during
  both loop and flow runs; final diagnostics become concise summaries instead of
  isolated stop lines.
- Compatibility: stdout remains reserved for explicit flow/sink output; progress
  output remains suppressible or plain in non-TTY/CI contexts.
- Dependencies: no required new runtime dependency for the first deterministic
  renderer; optional LLM narration may be added later behind explicit opt-in.
