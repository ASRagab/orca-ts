# Orcats flow DSL — verbs, types, shapes

Everything here is exported from the package root: `import { … } from "@twelvehart/orcats"`.
A flow is a TypeScript file the `orcats` binary imports and runs. Author against
this reference; the templates in `assets/templates/` are the worked examples.

## The flow envelope

Every flow is one call to `flow(...)` wrapping an async body:

```ts
import { flow, flowArgs } from "@twelvehart/orcats";

await flow(flowArgs())(async () => {
  // … flow body …
});
```

- `flow(args?)` returns a runner; call it with your async body. Pass
  `flowArgs()` — the user's task tokens (everything after `--` on the command
  line) — not `process.argv`, which also contains the flow path and CLI flags.
  Inside the body, `currentFlowContext().args` returns the same tokens.
  `flowArgs()` reads them from the CLI; when a flow is run directly
  (`bun flow.ts -- foo`) it parses argv. So `orcats flow.ts --backend codex -- a b`
  gives `["a","b"]`.
- The body runs inside a **flow context** that backs the accessor functions
  (`fs()`, `git()`, `gh()`, `command()`, `llm()`, `plan()`, `review()`,
  `terminal()`). Call accessors **inside** the body, never at module top level.
- `currentFlowContext()` returns the live context (e.g. `.cwd`).

## Backends and conversations

```ts
import { llm, selectBackend, claude, codex, opencode, pi } from "@twelvehart/orcats";
```

Two ways to pick a backend:

- **Pinned**: `claude()`, `codex()`, `opencode()`, `pi()` return a backend and
  ignore `--backend`/`ORCA_BACKEND`. Use when the flow must run on a specific
  backend.
- **Selectable** (preferred for saved workflows): `selectBackend({ default, config?, perBackend? })`
  honors `ORCA_BACKEND` (set by `--backend`) and `ORCA_BACKEND_MODEL`. Returns a
  `SelectedBackend`:

  ```ts
  const selected = selectBackend({
    default: "codex",
    config: { readOnly: false },
    perBackend: { opencode: { model: "openai/gpt-5.5" } },
  });
  // selected.tag      -> "codex" | "claude" | "opencode" | "pi"
  // selected.backend  -> pass to llm().autonomous(...)
  // selected.model    -> resolved model string | undefined
  // selected.shutdown -> () => Promise<void> | undefined  (OpenCode only)
  ```

Run one autonomous turn:

```ts
const conversation = llm().autonomous(selected.backend, {
  prompt: "…",
  schema: MySchema,                 // optional Zod schema for structured output
  config: { model: selected.model } // optional per-call overrides
});
const outcome = await conversation.awaitResult();
```

`awaitResult()` returns a discriminated outcome. **Narrow on `outcome.type`**:

```ts
if (outcome.type !== "success") {
  const detail = outcome.type === "failed" ? JSON.stringify(outcome.error) : (outcome.reason ?? outcome.type);
  throw new Error(`backend failed: ${detail}`);
}
outcome.result.output;      // assistant text
outcome.result.structured;  // parsed schema payload when `schema` was supplied
outcome.result.usage;       // { input: number; output: number } | undefined
```

Non-success types include `cancelled` and failure variants — never read
`.result` without narrowing first. Do not throw only `outcome.type`; failure
outcomes carry the useful backend error in `outcome.error`.

## Loop primitives

### `loop()` — converge a measured state

```ts
import { loop, untilGatesGreen, type GatesState } from "@twelvehart/orcats";

const result = await loop<GatesState>("gate-repair")
  .reason(selected.backend, { prompt: "Fix the next failing gate." })
  .step("refresh-gate-state", async (state) => state)
  .until(untilGatesGreen())
  .guard({ maxIterations: 8, wallClockMs: 10 * 60_000, tokenBudget: 80_000 })
  .run({ failingGates: 1 });
```

- `.reason(backend, request)` runs one autonomous backend turn per cycle.
- `.step(name, fn)` is deterministic state transformation.
- `.until(preset)` or `.measure(fn)` declares what converges. A loop with no
  preset or custom measure is rejected before it runs.
- Presets: `untilGatesGreen()`, `untilManifestComplete()`, `untilNoIssues()`,
  `untilConfident(threshold)`, and `times(n)`.
- `.guard(...)` adds seatbelts; guards stop as `ceiling`, `timeout`, or
  `budget-exhausted`.
- `.run(initial, { context?, onCycle? })` returns `Result<LoopOutcome, LoopRunError>`.
- `context` is opt-in managed context. When supplied, loop execution can compact
  model-visible observations and offload oversized reason/step outputs to
  scratch, reporting `contextPressure` through `onCycle`. Without it, raw
  observations are not captured.

### Fan-out / fan-in

```ts
import { fanOut, fanIn } from "@twelvehart/orcats";
```

Use `fanOut({ state, branches, maxConcurrency })` for bounded parallel branch
work over isolated state copies. Use `fanIn("barrier" | "race" | "quorum" |
"reduce", outcomes, { reducer, onPartialFailure? })` as the only recombination
point. Branch failures are data until the chosen join policy decides whether the
cycle can continue.

### Loop state stores

```ts
import { createSnapshotStore, createSqliteStore } from "@twelvehart/orcats";
```

The base `StateStore` port is `load`, `checkpoint`, `branch`, `merge`, and
`history`. Store-backed fan-out additionally requires
`BranchWritableStateStore.saveBranch()` so branch results can be persisted
without appending to cycle history. `createSnapshotStore({ root })` writes JSON
snapshots under `.orca/` and implements the branch-write capability.
`createSqliteStore({ path })` returns a `Result` because it opens `bun:sqlite`;
use it when the loop needs WAL-backed checkpoint/history and lease-based crash
recovery. DBOS and Dolt are not selectable.

### `defineLoop()` — reusable loop modules

```ts
import { defineLoop, err, loop, ok, stdout, times, watch } from "@twelvehart/orcats";

export default defineLoop({
  name: "refresh-docs",
  source: watch({ paths: ["docs"] }),
  sink: stdout<string>(),
  async onTrigger(event) {
    const outcome = await loop("refresh-docs-cycle").until(times(1)).run({});
    if (outcome.isErr()) return err(outcome.error);
    return ok({ outcome: outcome.value, output: `handled ${event.filename ?? "change"}` });
  },
});
```

Save loop modules to `.orca/loops/<name>.ts`. They must be import-safe: no
top-level `flow(...)`, source start, backend run, sink emit, or repo mutation.
Run with `orcats loops`, `orcats run <name-or-path>`, or `orcats serve <name-or-path>`.
`orcats run` and served children share the firing contract: event decode,
`definition.run(event)`, sink emission, diagnostics, and stop-reason exit codes.
`ORCA_LOOP_EVENT` is that contract's envelope, not a custom adapter API; `Source`
and `Sink` implementations should observe public events/outputs only.

### `fixLoop` — converge a gate

```ts
import { fixLoop } from "@twelvehart/orcats";

const loop = await fixLoop<MyIssue>(
  async () => ok(issues),        // evaluate: Result<readonly Issue[], RuntimeError>; [] === converged
  async (issues) => ok(undefined), // fix: Result<void, RuntimeError>
  { maxIterations: 10, wallClockMs: 600_000, stalled }
);
```

- `Issue` must have `fixable: boolean`. When every issue is unfixable the loop
  stops `unfixable`.
- The third arg is `number` (bare iteration cap) **or** `FixLoopOptions`:
  `maxIterations` (seatbelt, default 10), `wallClockMs`, `tokenBudget`,
  `stalled` (caller-owned no-progress detector), `fingerprint` (shared action
  fingerprint projection), `now` (test clock).
- Returns `Result<FixLoopSummary, RuntimeError>`. On `loop.isOk()`:
  `summary.converged` (bool), `summary.iterations`, `summary.stop`
  (`"converged" | "unfixable" | "stuck" | "timeout" | "ceiling" |
  "budget-exhausted"`).
- Depth is **not** bounded by a stingy count — convergence, the no-progress
  signature, and the wall-clock backstop are the real stops.

### Deprecated task/review wrappers

`implementTaskLoop` and `runReviewAndFixLoop` remain exported for legacy flows
for one release, but each call emits `DeprecationWarning`
`ORCA_DEP_LOOP_COLLAPSE`. Do not generate new artifacts with them. Walk task
lists explicitly and pair each task with `fixLoop`, as shown in
`templates/persistent-multitask.ts`, or use `loop()` with an `.until(...)`
strategy when the state is naturally cyclic.

## Tools (accessors)

Call inside the flow body. All return `Result`s (build/unwrap with `ok`/`err`/
`.isErr()`, re-exported from `"@twelvehart/orcats"`) except `command`/`terminal`.

| Accessor | Key methods | Returns |
|---|---|---|
| `command()` | `.run({ command, args, timeoutMs? })` | `{ type: "success" \| …; stdout; stderr; exitCode; durationMs }` — narrow on `.type` |
| `git()` | `.status()`, `.add(paths)`, `.commit(msg)` | `Result<string \| void, …>` |
| `gh()` | `.createPullRequest({ title, body? \| bodyFile?, base })`, `.readIssue(...)` | `Result<…>` |
| `fs()` | `.writeText(path, content)`, `.readText(path)` | `Result<…>` |
| `terminal()` | streaming process helpers | — |

`command().run` is the workhorse for wiring the target repo's own
test/lint/build commands as verification gates. Treat a `result.type !== "success"`
(or non-zero `exitCode`) as a gate failure.

## Structured output with Zod

```ts
import { z } from "@twelvehart/orcats";

const ReviewSchema = z.object({
  issues: z.array(z.object({ message: z.string(), fixable: z.boolean() })),
});
```

Pass `schema` to `llm().autonomous`. Native-schema backends (claude/codex/pi)
validate server-side; OpenCode and any backend without reliable structured
output for tool-using turns may need post-hoc parsing of `outcome.result.output`
(see `gotchas.md` and the cleanup workflow's `extractJsonObject`).

## Monitoring

```ts
import { WorkflowMonitor } from "@twelvehart/orcats";

const monitor = new WorkflowMonitor(selected.tag);
await monitor.stage("setup", async () => { /* … */ });
monitor.recordOutcome({ file, verdict: "clean", durationMs, smellsRemoved: [] });
await monitor.writeLog(process.env.ORCA_MONITOR_DIR ?? `${cwd}/.orca/monitoring`);
// monitor.runId -> the log file stem: <runId>.json
```

`orcats-flow` tails `.orca/monitoring/<runId>.json` for progress/stall
detection. Wrap a flow's stages in `monitor.stage(...)` so progress is
observable.
