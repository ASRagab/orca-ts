## Why

The shared CLI run-output change is covered by focused tests, but the remaining
risk is operator-facing behavior across real processes: stdout capture,
stderr progress, child lifecycle, and useful loop output in an actual repo. We
need a repeatable validation path that dogfoods Orca as a user would run it,
without relying on live agents or mutating someone else's worktree.

## What Changes

- Add an end-to-end validation harness for Orca CLI run output that launches
  `orca run` and `orca serve` as child processes with stdout and stderr captured
  separately.
- Add a generated, read-only productive loop fixture that can run against a
  real local repo and emit a concise health report to stdout.
- Validate operational lifecycle behavior: startup progress, per-run progress,
  child completion, timeout handling, graceful shutdown, and kill fallback.
- Validate stream discipline: progress and lifecycle diagnostics stay on stderr,
  while sink/report payloads remain on stdout.
- Document the manual dogfood path and the expected monitoring signals.

## Capabilities

### New Capabilities

- `cli-run-output-validation`: Defines black-box validation of Orca CLI run
  output, stream separation, real-repo productive loop execution, and process
  lifecycle monitoring.

### Modified Capabilities

- None.

## Impact

- Affected tests: new integration coverage for CLI child-process capture,
  stdout/stderr separation, and `orca serve` lifecycle behavior.
- Affected examples/fixtures: a deterministic read-only loop fixture or test
  generated loop that can inspect a target repo and produce a useful health
  report.
- Affected docs: a short dogfood validation guide for running and interpreting
  the harness.
- Dependencies: no required live backend or new runtime UI dependency.
