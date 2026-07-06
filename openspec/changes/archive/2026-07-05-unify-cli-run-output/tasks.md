## 1. Shared Reporter And Presenter

- [x] 1.1 Add tests for a shared `RunEvent` / `RunReporter` model covering run lifecycle, preflight, stage, agent activity, cycle progress, artifact, and final outcome events.
- [x] 1.2 Implement the core reporter module with injectable writers and no required new runtime dependency.
- [x] 1.3 Add deterministic presenter tests for TTY output, non-TTY/CI plain output, disabled color, and stdout/stderr separation.
- [x] 1.4 Implement the deterministic presenter so every rendered line is derived from a structured run event.
- [x] 1.5 Add tests for optional narrator behavior: disabled by default and narrator failure falling back to deterministic output.
- [x] 1.6 Implement the optional narrator seam as an opt-in, non-fatal reducer over recent run events.

## 2. Monitor And Loop Integration

- [x] 2.1 Add regression tests proving `WorkflowMonitor.toJson()` remains unchanged while live status is routed through the shared presenter.
- [x] 2.2 Update `WorkflowMonitor` to emit shared run events for stages, outcomes, failures, cycle progress, heartbeats, and monitor-log artifacts.
- [x] 2.3 Add loop CLI tests for `orca run <loop>` progress and final summary, including stop reason, iteration count, and monitor log path when available.
- [x] 2.4 Wire loop firing and loop cycle progress into the shared reporter without changing stop reasons, exit-code mapping, or sink emission semantics.
- [x] 2.5 Add tests proving `stdout` sinks are not polluted by progress output.

## 3. Flow Runtime Integration

- [x] 3.1 Add flow-runtime tests showing legacy flow scripts can report stages through the active shared reporter.
- [x] 3.2 Add or adapt a flow-context reporting service so default flows and test overrides can capture structured progress events.
- [x] 3.3 Preserve existing `terminal()` behavior for simple event collection while delegating compatible events into the shared reporting path.
- [x] 3.4 Add CLI coverage for `orca <flow.ts>` showing preflight, stage progress, failure summary, and stdout separation.

## 4. Templates And Documentation

- [x] 4.1 Update bundled workflow templates that instantiate `WorkflowMonitor` or use `terminal()` so they follow the shared reporting path.
- [x] 4.2 Update `docs/` references for CLI run output, monitoring, loops, and flow authoring.
- [x] 4.3 Update `website/src/content/docs/` reference pages for any public reporting types, env vars, or CLI behavior changes.
- [x] 4.4 Update doc-symbol or facade gates if new public types, literal sets, or env vars are introduced.

## 5. Verification

- [x] 5.1 Run focused unit tests for reporter, presenter, monitor, loop CLI, and flow runtime behavior.
- [x] 5.2 Run `bun run docs:check` and `bun run docs:symbols` after documentation updates.
- [x] 5.3 Run `bun run verify` as the deterministic final gate.
