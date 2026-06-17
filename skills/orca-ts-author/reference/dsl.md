# orca-ts flow DSL — verbs, types, shapes

Everything here is exported from the package root: `import { … } from "orca-ts"`.
A flow is a TypeScript file the `orca` binary imports and runs. Author against
this reference; the templates in `assets/templates/` are the worked examples.

## The flow envelope

Every flow is one call to `flow(...)` wrapping an async body:

```ts
import { flow, flowArgs } from "orca-ts";

await flow(flowArgs())(async () => {
  // … flow body …
});
```

- `flow(args?)` returns a runner; call it with your async body. Pass
  `flowArgs()` — the user's task tokens (everything after `--` on the command
  line) — not `process.argv`, which also contains the flow path and CLI flags.
  Inside the body, `currentFlowContext().args` returns the same tokens.
  `flowArgs()` reads them from the CLI; when a flow is run directly
  (`bun flow.ts -- foo`) it parses argv. So `orca flow.ts --backend codex -- a b`
  gives `["a","b"]`.
- The body runs inside a **flow context** that backs the accessor functions
  (`fs()`, `git()`, `gh()`, `command()`, `llm()`, `plan()`, `review()`,
  `terminal()`). Call accessors **inside** the body, never at module top level.
- `currentFlowContext()` returns the live context (e.g. `.cwd`).

## Backends and conversations

```ts
import { llm, selectBackend, claude, codex, opencode, pi } from "orca-ts";
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
  throw new Error(`backend failed: ${outcome.type}`);
}
outcome.result.output;      // assistant text
outcome.result.structured;  // parsed schema payload when `schema` was supplied
outcome.result.usage;       // { input: number; output: number } | undefined
```

Non-success types include `cancelled` and failure variants — never read
`.result` without narrowing first.

## Loop primitives

### `loop()` — converge a measured state

```ts
import { loop, untilGatesGreen, type GatesState } from "orca-ts";

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
- `.run(initial, { onCycle? })` returns `Result<LoopOutcome, LoopRunError>`.

### Fan-out / fan-in

```ts
import { fanOut, fanIn } from "orca-ts";
```

Use `fanOut({ state, branches, maxConcurrency })` for bounded parallel branch
work over isolated state copies. Use `fanIn("barrier" | "race" | "quorum" |
"reduce", outcomes, { reducer, onPartialFailure? })` as the only recombination
point. Branch failures are data until the chosen join policy decides whether the
cycle can continue.

### Loop state stores

```ts
import { createSnapshotStore, createSqliteStore } from "orca-ts";
```

Both adapters implement the `StateStore` port: `load`, `checkpoint`, `branch`,
`merge`, and `history`. `createSnapshotStore({ root })` writes JSON snapshots
under `.orca/`. `createSqliteStore({ path })` returns a `Result` because it opens
`bun:sqlite`; use it when the loop needs WAL-backed checkpoint/history and
lease-based crash recovery. DBOS and Dolt are not selectable.

### `defineLoop()` — reusable loop modules

```ts
import { defineLoop, err, loop, ok, stdout, times, watch } from "orca-ts";

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
Run with `orca loops`, `orca run <name-or-path>`, or `orca serve <name-or-path>`.

### `fixLoop` — converge a gate

```ts
import { fixLoop } from "orca-ts";

const loop = await fixLoop<MyIssue>(
  async () => ok(issues),        // evaluate: Result<readonly Issue[], RuntimeError>; [] === converged
  async (issues) => ok(undefined), // fix: Result<void, RuntimeError>
  { maxIterations: 10, wallClockMs: 600_000, stalled }
);
```

- `Issue` must have `fixable: boolean`. When every issue is unfixable the loop
  stops `unfixable`.
- The third arg is `number` (bare iteration cap) **or** `FixLoopOptions`:
  `maxIterations` (seatbelt, default 10), `wallClockMs`, `stalled` (a
  caller-owned no-progress detector — see gotchas), `now` (test clock).
- Returns `Result<FixLoopSummary, RuntimeError>`. On `loop.isOk()`:
  `summary.converged` (bool), `summary.iterations`, `summary.stop`
  (`"converged" | "unfixable" | "stuck" | "timeout" | "ceiling"`).
- Depth is **not** bounded by a stingy count — convergence, the no-progress
  signature, and the wall-clock backstop are the real stops.

### `implementTaskLoop` — walk a task list

```ts
import { implementTaskLoop, backendFailed } from "orca-ts";

const result = await implementTaskLoop(tasks, async (task) => {
  // task: { id: string; description: string }
  // … implement task.description …
  return ok(undefined);            // or: err(backendFailed("codex", "…"))
});
// result: Result<{ completed: string[] }, RuntimeError>
```

Stops at the first task that returns `err`. Pair with `fixLoop` per task for a
review/repair inner loop (see `templates/persistent-multitask.ts`).

## Tools (accessors)

Call inside the flow body. All return `Result`s (build/unwrap with `ok`/`err`/
`.isErr()`, re-exported from `"orca-ts"`) except `command`/`terminal`.

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
import { z } from "orca-ts";

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
import { WorkflowMonitor } from "orca-ts";

const monitor = new WorkflowMonitor(selected.tag);
await monitor.stage("setup", async () => { /* … */ });
monitor.recordOutcome({ file, verdict: "clean", durationMs, smellsRemoved: [] });
await monitor.writeLog(process.env.ORCA_MONITOR_DIR ?? `${cwd}/.orca/monitoring`);
// monitor.runId -> the log file stem: <runId>.json
```

`orca-ts-flow` tails `.orca/monitoring/<runId>.json` for progress/stall
detection. Wrap a flow's stages in `monitor.stage(...)` so progress is
observable.
