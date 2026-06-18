---
title: Loop API
description: LoopBuilder, stop reasons, exit codes, distribution, sources, and sinks — the full loop reference.
---

A loop runs cycles until a termination condition is met or a seatbelt trips. This page is the reference for the builder, its types, and the distribution surface. For the conceptual walkthrough, see the [Loops guide](../../guides/loops/). Signatures are transcribed from `src/loop/` and verified by `bun run docs:symbols`.

## `LoopBuilder<S>`

`loop<S>(name)` returns a `LoopBuilder<S>` (defined in `src/loop/builder/types.ts`). Every method returns the builder for chaining; `.run()` executes.

```ts
interface LoopBuilder<S = unknown> {
  reason<B extends BackendTag, Output = unknown>(
    backend: LlmBackend<B>,
    request: AutonomousRequest<Output, B>,
  ): LoopBuilder<S>;
  step(name: string, body: (state: S) => Promise<S> | S): LoopBuilder<S>;
  measure(fn: (state: S) => Promise<number> | number): LoopBuilder<S>;
  until(termination: TerminationPreset<S> | LoopVariant<S>): LoopBuilder<S>;
  guard(opts: LoopGuards): LoopBuilder<S>;
  run(initial?: S, options?: LoopRunOptions): Promise<Result<LoopOutcome<S>, LoopRunError>>;
}
```

| Method | Purpose |
| --- | --- |
| `.reason(backend, request)` | Adds an autonomous backend turn to each cycle. See [Backend Matrix](../backends/) and [Errors and Results](../errors-and-results/). |
| `.step(name, body)` | A deterministic state transition; `body` receives and returns `S`. |
| `.measure(fn)` | Overrides the preset's measure with a custom `number`. |
| `.until(preset)` | Sets the termination condition (a preset or custom `LoopVariant<S>`). |
| `.guard(opts)` | Adds seatbelts: `maxIterations`, `wallClockMs`, `tokenBudget`. |
| `.run(initial?, options?)` | Executes; resolves to `Result<LoopOutcome<S>, LoopRunError>`. **Never rejects** — failures arrive as `Err(LoopRunError)`. |

### Run options and cycle reports

```ts
interface LoopRunOptions {
  readonly args?: readonly string[];
  readonly overrides?: FlowOverrides;
  readonly onCycle?: (cycle: LoopCycleReport) => void;
}

interface LoopCycleReport {
  readonly iteration: number;
  readonly measure: number;
  readonly usage?: Usage;
}

type LoopRunError = RuntimeError | TerminationContractError;
```

`onCycle` fires after each cycle with the iteration index, the current measure, and optional token usage. `LoopRunError` is either a `RuntimeError` (see [Runtime Errors](../runtime-errors/)) or a `TerminationContractError` (a violated termination contract).

### Outcome

```ts
interface LoopOutcome<S = unknown> {
  readonly state: S;
  readonly stopReason: LoopStopReason;
  readonly iterations: number;
}
```

## Stop reasons and exit codes

```ts
type LoopStopReason =
  | "converged"
  | "unfixable"
  | "stuck"
  | "timeout"
  | "ceiling"
  | "budget-exhausted"
  | "cancelled";
```

`orca run` and `orca serve` map each stop reason to a process exit code via `exitCodeForStop(reason)` (defined in `src/loop/serve.ts`). A build/runtime error exits `70`.

| Stop reason | Exit code | Meaning |
| --- | --- | --- |
| `converged` | `0` | Termination condition met. |
| `unfixable` | `1` | The loop concluded the issue cannot be fixed. |
| `stuck` | `2` | No progress across cycles. |
| `timeout` | `3` | Wall-clock guard expired. |
| `ceiling` | `4` | Iteration ceiling reached without convergence. |
| `budget-exhausted` | `5` | Token budget guard exhausted. |
| `cancelled` | `6` | Cancelled via signal or `cancel()`. |
| (build/runtime error) | `70` | The loop failed to run at all. |

## Presets

| Preset | Stops when |
| --- | --- |
| `untilGatesGreen()` | failing gates reach `0` |
| `untilManifestComplete()` | pending tasks reach `0` |
| `untilNoIssues()` | open issues reach `0` |
| `untilConfident(threshold)` | confidence reaches the threshold |
| `times(n)` | `n` cycles have run |

`.measure(fn)` overrides a preset measure. `.guard()` adds or overrides seatbelts such as `maxIterations`, `wallClockMs`, and `tokenBudget`.

## Distribution

`defineLoop({ name, source, sink, onTrigger })` packages a loop module. Put it under `.orca/loops/`, export it, then use `orca loops`, `orca run`, or `orca serve`. See the [Served Loops guide](../../guides/served-loops/) for the supervisor isolation contract and `ORCA_LOOP_EVENT` payload.

Built-in source kinds: `manual`, `cron`, `watch`, `webhook`, `queue`, `linear-issue`, `linear-agent`.

Built-in sink kinds: `pr`, `file`, `slack`, `queue`, `stdout`, `linear-issue`, `linear-agent`.

The `linear-issue` and `linear-agent` kinds are provided by `linearIssueSource` / `linearAgentSource` / `linearIssueSink` / `linearAgentSink` in `src/loop/io/linear.ts`. See the [Linear guide](../../guides/linear/) for env vars, webhook verification, and Slack composition.

### State

Loops checkpoint state through a `StateStore<S>` port — see [State Stores](../state-stores/). Every store method is `Result`-typed over `RuntimeError`; `createSqliteStore` returns `Result` and can fail at construction.
