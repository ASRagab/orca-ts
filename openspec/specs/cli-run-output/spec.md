## Purpose

Define the shared event model and human presentation rules for Orcats CLI run
output.

## Requirements

### Requirement: Runs expose a shared output event stream
The system SHALL represent CLI progress as structured run-output events rather
than as independently formatted log strings. The event stream SHALL cover run
lifecycle, preflight, stage progress, agent activity, loop cycle progress,
artifact writes, and final outcome.

#### Scenario: Loop run emits shared progress events
- **WHEN** a user runs `orcats run <loop>`
- **THEN** the CLI output layer receives structured events for the run start,
  typecheck preflight, loop cycle progress, sink emission or failure, and final
  stop outcome

#### Scenario: Legacy flow emits shared progress events
- **WHEN** a user runs `orcats <flow.ts>`
- **THEN** the CLI output layer receives structured events from the flow runtime
  instead of relying on a separate flow-only formatter

### Requirement: Human progress output is concise and synthesized
The CLI presenter SHALL render concise human-readable progress from run-output
events. Rendered lines SHALL communicate current phase, meaningful progress,
important agent activity, failures, artifact paths, or final outcome; the
presenter SHALL NOT dump every raw backend delta, tool argument, or internal
event by default.

#### Scenario: Stage heartbeat is summarized
- **WHEN** a stage remains active long enough to emit a heartbeat
- **THEN** the presenter prints a compact status line naming the active stage
  and elapsed duration

#### Scenario: Agent activity is aggregated
- **WHEN** backend conversation events include multiple assistant deltas and tool
  events during one work interval
- **THEN** the presenter emits at most a concise activity summary for the
  interval by default

### Requirement: Output stream separation is preserved
The system SHALL keep progress/status output separate from explicit flow and
sink payload output. CLI progress SHALL be written to the diagnostic stream, and
stdout SHALL remain available for authored flow output and `stdout` sinks.

#### Scenario: Stdout sink is not polluted by progress
- **WHEN** a loop uses a `stdout` sink and the CLI emits progress
- **THEN** progress appears on the diagnostic stream and the sink payload remains
  the only content written to stdout by the sink

#### Scenario: Non-TTY output remains automation-friendly
- **WHEN** CLI output is redirected or running under CI
- **THEN** the presenter emits plain line-oriented progress without carriage
  returns, animation-only state, or required ANSI color

### Requirement: Final summaries explain run outcome
At completion, the presenter SHALL render a concise final summary that includes
the run verdict or stop reason, elapsed duration when known, iteration count
when applicable, failure reason when present, and relevant artifact paths such
as monitor logs.

#### Scenario: Converged loop summary
- **WHEN** a loop converges after multiple iterations and writes a monitor log
- **THEN** the final summary includes the `converged` stop reason, iteration
  count, and monitor log path

#### Scenario: Failed flow summary
- **WHEN** a legacy flow fails with a typed runtime error
- **THEN** the final summary includes the failure category or message without
  hiding the underlying typed error from programmatic handling

### Requirement: LLM narration is optional and bounded
Any LLM-based narration of CLI output SHALL be explicit opt-in and additive to
the deterministic presenter. The system SHALL preserve deterministic progress
facts when narration is disabled, unavailable, or running in CI.

#### Scenario: Narration disabled by default
- **WHEN** a run starts without an explicit narration option
- **THEN** the CLI uses only deterministic event formatting

#### Scenario: Narration failure does not fail the run
- **WHEN** optional narration is enabled but the narrator backend fails
- **THEN** the run continues with deterministic progress output and records the
  narration failure as non-fatal output evidence
