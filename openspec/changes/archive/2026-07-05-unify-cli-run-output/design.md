## Context

The CLI currently has several independent output surfaces:

- `src/cli/main.ts` writes command help, errors, and final loop diagnostics.
- `WorkflowMonitor` records structured run data but renders live status as raw
  `orca:` lines.
- `terminal()` lets authored flows collect simple rendered event lines, but it
  is not a shared CLI presenter.
- Backend conversations expose rich events such as assistant text, tool calls,
  tool results, and usage, but the CLI does not synthesize them into a stable
  human progress stream.

The change should improve both `orca run` / `orca serve` loop paths and legacy
`orca <flow.ts>` scripts without duplicating formatting logic. The repository
also has strong deterministic verification expectations, so the default output
path must not require live model calls or non-deterministic summarization.

## Goals / Non-Goals

**Goals:**

- Define one shared reporting abstraction for run facts.
- Keep loop and flow code as producers of structured facts, not owners of
  display strings.
- Render concise, useful progress for humans while preserving stdout for actual
  flow and sink payloads.
- Preserve existing structured monitor logs and make them the durable evidence
  behind human summaries.
- Support TTY-friendly output, plain CI output, and test-injectable writers.
- Leave a clean extension point for optional LLM narration over event batches.

**Non-Goals:**

- Do not add a required runtime UI dependency for the first renderer.
- Do not stream every backend token, raw tool argument, or log line by default.
- Do not make LLM narration the default output path.
- Do not change loop stop reasons, exit-code mapping, or sink semantics.
- Do not require legacy flows to adopt loop APIs.

## Decisions

### D1. Introduce a fact-based run reporter

Create a shared `RunReporter` abstraction that accepts structured `RunEvent`
values. Candidate event categories:

- run lifecycle: started, heartbeat, finished, failed
- preflight: typecheck skipped, passed, failed
- stage lifecycle: started, running, completed, failed
- agent activity: backend started, tool use, tool result, assistant summary,
  usage update
- loop progress: cycle completed, measure, delta, stop status, context pressure
- artifacts: monitor log written, plan path, generated output path

Alternative considered: keep adding formatted strings to `WorkflowMonitor` and
CLI commands. That would improve one surface quickly but duplicate logic across
loops and flows.

### D2. Split reporting from presentation

`RunReporter` stores or forwards facts. `RunPresenter` renders them. The default
presenter should be deterministic and small:

- stderr/diagnostic stream for progress
- stdout left untouched for explicit flow/sink output
- color and carriage-return behavior only when TTY and color is allowed
- plain line-oriented output for CI and redirected streams
- injected writers for tests

Alternative considered: adopt a spinner/status library. The current dependency
surface is intentionally small, and most value comes from aggregation and final
summaries rather than animation.

### D3. Make adapters thin

Loop execution should map existing `LoopCycleReport`, firing diagnostics, and
source/sink metadata into `RunEvent`s. Legacy flow execution should provide the
same reporter through the flow context, and the existing terminal tool can
either become an adapter or delegate to the reporter while retaining compatible
behavior.

Alternative considered: build separate `LoopPresenter` and `FlowPresenter`
implementations. That would make output drift likely and force every future
formatting change through two paths.

### D4. Keep monitor logs as durable evidence

`WorkflowMonitor` should continue to produce structured JSON logs for automation
and post-run analysis. Live human output should be rendered from the same facts
or from a reporter event emitted at the same boundary, not from a separate
hand-written log stream.

Alternative considered: replace monitor logs with the new event stream. That is
unnecessary churn and risks breaking existing eval and summary tooling.

### D5. Treat LLM narration as an optional reducer

The deterministic presenter should be the default. A future narrator may batch
recent events and ask a configured model for a one-line synthesis such as
"Codex inspected failing tests and is validating the patch." That narrator must
be explicit opt-in, bounded, suppressible in CI, and paired with deterministic
facts so users and tests are never dependent on model prose.

Alternative considered: route all output through an LLM from the start. That
would undermine deterministic CI, increase latency and cost, and make failures
harder to debug.

## Risks / Trade-offs

- Event model grows too broad -> Start with only facts needed by current loop,
  flow, monitor, and CLI paths; add new variants only with tests.
- Output becomes attractive but less useful -> Require every rendered line to
  trace to a run fact and include state, progress, action, or outcome.
- Duplicate output appears during migration -> Centralize CLI progress writers
  and keep stdout/sink output separate from diagnostic progress.
- Public API churn leaks internal naming -> Expose the smallest stable flow
  reporting surface and keep presenter internals private unless needed.
- Narration hides important details -> Make narration additive and keep exact
  deterministic cycle/stage/final facts visible.

## Migration Plan

1. Add `RunEvent`, `RunReporter`, and deterministic presenter tests without
   changing runtime behavior.
2. Route `WorkflowMonitor` live status through the shared presenter while
   preserving `toJson()` output.
3. Wire loop firing and loop cycle progress into the reporter.
4. Add a flow-context reporter/terminal adapter for legacy flow scripts.
5. Update templates and docs to use the shared reporting path.
6. Add optional narration only after the deterministic path is complete.
