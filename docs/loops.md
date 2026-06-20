# Loops

Loops are Orca's repeated-work authoring model. Use them when one pass is not
enough and the next pass should stop only when state says it is done.

This page is the canonical user guide for loops. The archived
`add-loop-builder` notes explain the design rationale, but this page is the
working reference for day-to-day use.

## Loops vs Flows

| Use a flow when | Use a loop when |
| --- | --- |
| the work is one pass | the work should repeat until a measured condition is met |
| you are writing a saved script in `.orca/workflows/` | you want a discoverable module in `.orca/loops/` |
| the input is simple task args | the input should be projected into state and checked across cycles |
| you do not need branch isolation or replayable checkpoints | you need branch/merge, checkpoints, or a long-lived trigger host |

Keep using flows for one-shot automation. Use loops when the state itself tells
you when to stop.

## The Two Loop APIs

- `loop()` builds the repeated cycle.
- `defineLoop()` packages a loop for discovery, `orca run`, and `orca serve`.

Use `loop()` inside another flow, test, or loop module. Use `defineLoop()` when
you want a loop module that Orca can find and launch.

Loop execution owns recurrence, cycle progress, guard evaluation, token budgets,
and optional context pressure. `fixLoop` is still the public generic convergence
primitive, but direct `executeLoop` is internal and not part of authored flows.

## Your First Loop Module

Save this as `.orca/loops/countdown.ts`:

```ts
import { defineLoop, loop, manual, ok, stdout, times } from "orca-ts";

interface Countdown {
  remaining: number;
}

export default defineLoop({
  name: "countdown",
  source: manual<void>(),
  sink: stdout<Countdown>(),
  onTrigger: async () => {
    const result = await loop<Countdown>("countdown")
      .step("decrement", (state) => ({ remaining: state.remaining - 1 }))
      .until(times(3))
      .run({ remaining: 3 });

    if (result.isErr()) {
      return result;
    }

    return ok({
      outcome: result.value,
      output: result.value.state,
    });
  },
});
```

Run it with the CLI:

```bash
orca run countdown
```

If you are still iterating on the file path, you can also run it directly:

```bash
orca run .orca/loops/countdown.ts
```

List it without firing the source or sink:

```bash
orca loops
```

This tiny loop is intentionally boring. Replace `times(3)` with a real
termination preset when the loop represents actual work.

## How Loops Stop

Every loop needs a stop rule. The stop rule comes from either a preset or a
custom measure.

| Preset | Use it for | Stops when |
| --- | --- | --- |
| `untilGatesGreen()` | test or gate repair loops | failing gates reach `0` |
| `untilManifestComplete()` | task-manifest loops | pending tasks reach `0` |
| `untilNoIssues()` | review and fix loops | open issues reach `0` |
| `untilConfident(threshold)` | confidence-driven loops | confidence reaches the threshold |
| `times(n)` | bounded repeats or smoke loops | `n` cycles have run |

Rules to keep in mind:

- `.measure(fn)` overrides the preset measure if you provide both.
- `.guard({ maxIterations, wallClockMs, tokenBudget })` adds seatbelts under
  the stop rule.
- Presets can contribute default guards. An explicit `.guard()` wins.
- A loop with a back-edge and no preset or custom measure is rejected before it
  runs.

### Stop Reasons

The loop result includes a `stopReason`.

| Stop reason | Meaning |
| --- | --- |
| `converged` | the measure reached its floor |
| `ceiling` | `maxIterations` stopped the loop first |
| `timeout` | `wallClockMs` stopped the loop first |
| `stuck` | the loop kept repeating the same work without progress |
| `unfixable` | the current repair path could not continue |
| `budget-exhausted` | known token usage exceeded `tokenBudget` |
| `cancelled` | the caller or supervisor stopped the run |

`orca run` exits with a status that reflects the stop reason. Treat a non-zero
exit as "read the stop reason first."

### Token Budgets

Token budgets only count usage that the backend reports.

- If usage is reported, the budget guard can stop the loop.
- If usage is not reported, the loop can still complete, but the budget guard
  cannot fire for that cycle.

### Stuck Detection

If a loop keeps repeating the same action and inputs in a small window, Orca
stops it as `stuck`.

Fixes are usually simple:

- change the state transition so the loop makes real progress;
- reduce redundant retries;
- add a better measure or guard;
- switch from a generic retry to a purpose-built preset.

## State And Resume

Loop state is a manifest, not the human plan file. The manifest is the runtime
state your loop checkpoints and replays. It stays separate from
`.orca/plan-<hash>.md`.

The base state seam is `StateStore`, which exposes:

- `load`
- `checkpoint`
- `branch`
- `merge`
- `history`

Use the store when you need readable checkpoints, replay, or resume.

| Store | Use it when | Behavior |
| --- | --- | --- |
| `createSnapshotStore({ root })` | you want the simplest default | writes one human-readable JSON snapshot per cycle at `.orca/state-<hash>.json` |
| `createSqliteStore({ path })` | you need crash recovery or a longer-lived run | writes a local WAL database and can resume from committed history |

Notes:

- `history()` returns the ordered checkpoint hashes.
- `branch(from)` makes an isolated copy of one checkpoint.
- `merge(branches, reducer)` folds branch snapshots through your reducer.
- Store-backed fan-out additionally requires `BranchWritableStateStore`,
  whose `saveBranch(branch, state)` writes a branch result without adding a
  cycle history entry.
- `branch`/`merge` are the base seam fan-out and fan-in use for state
  recombination; `saveBranch` is the extra branch-write capability.
- The snapshot store is simplest to inspect, but it is not the right choice if
  you need automatic resume after a crash.
- `dbos` and `dolt` are deferred and are not selectable in this release.

## Fan-Out And Fan-In

Use fan-out when one cycle needs to inspect or transform a batch in parallel.
Each branch gets an isolated copy of the state, and the branch summaries are
folded back through a reducer at fan-in.

| Piece | What it does |
| --- | --- |
| `fanOut({ state, branches, maxConcurrency })` | runs each branch with a bounded concurrency cap |
| `fanIn(policy, outcomes, { reducer, ... })` | chooses which successful summaries count, then merges them |
| `storeBackedFanOut({ store, from, branches, maxConcurrency })` | branches a checkpoint through `StateStore.branch()` and saves each branch result through `BranchWritableStateStore.saveBranch()` without changing cycle history |
| `storeBackedFanIn(policy, outcomes, { store, reducer, ... })` | selects successful branch snapshots and recombines them through `StateStore.merge()` |

Join policies:

| Policy | Best for | Failure behavior |
| --- | --- | --- |
| `barrier` | all branches must succeed | fail fast if any branch fails |
| `race` | first good answer wins | tolerate later failures |
| `quorum` | enough branches must agree | continue once the quorum agrees |
| `reduce` | fold all successful branches | tolerate failures as long as at least one branch succeeds |

Use pure `fanOut`/`fanIn` for summary-only work that can stay in memory. Use
the store-backed pair when branch state must be durable or adapter-agnostic:
fan-out starts from a checkpoint hash, each branch receives an isolated store
copy, and fan-in is the single reducer-backed merge point.

Keep branch summaries short. Branch work should return a concise summary and
only the structured data the reducer really needs. When loop context management
is explicitly enabled, oversized cycle observations are offloaded and compacted
by loop execution before they enter the model-visible context; durable state
snapshots are not compacted.

See [`examples/loop-fanout.ts`](../examples/loop-fanout.ts) for a checked
fan-out/fan-in example.

## Distribution

Use `defineLoop()` when a loop should be discoverable and runnable by the CLI.
Put the module under `.orca/loops/` and export the loop definition.

| Piece | What it does |
| --- | --- |
| `defineLoop({ name, source, sink, onTrigger })` | packages the trigger, sink, and one-shot runner into a loop definition |
| `.orca/loops/<name>.ts` | the import-only location for loop modules |
| `orca loops` | lists discovered loops without firing a source or sink |
| `orca run <loop>` | runs one loop firing; the target can be a module path or a registered loop name |
| `orca serve <loop>` | keeps the trigger open and starts one child process per firing |

Built-in source kinds:

- `manual`
- `cron`
- `watch`
- `webhook`
- `queue`
- `linear-issue` — via `linearIssueSource()`
- `linear-agent` — via `linearAgentSource()`

Built-in sink kinds:

- `pr`
- `file`
- `slack`
- `queue`
- `stdout`
- `linear-issue` — via `linearIssueSink()`
- `linear-agent` — via `linearAgentSink()`

The queue adapters are split into `queueSource()` and `queueSink()` because the
source and sink share the same `queue` kind.
Linear adapters are covered in the focused [Linear integration](linear.md)
guide.

`orca serve` owns the trigger and isolates each firing in its own child
process. One child crash does not take down the supervisor, and stopping the
supervisor stops the children.

`orca run` and served children share one firing contract: trigger-event decoding,
`defineLoop().run(event)`, sink emission, diagnostics, and stop-reason exit-code
mapping. Custom `Source` and `Sink` adapters should depend only on the public
event/output contracts, not on `ORCA_LOOP_EVENT` or supervisor internals.

## Recipes

### Minimal Preset Loop

Use a preset when the stop condition is simple and the loop body is small.
The toy countdown in the first tutorial is the smallest runnable example.
For a task-manifest loop, see
[`examples/loop-single-cycle.ts`](../examples/loop-single-cycle.ts).

### Gated Task Loop

Use `untilGatesGreen()` when the loop is repairing failing checks. See
[`examples/loop-gated-task.ts`](../examples/loop-gated-task.ts) for a checked
minimal gate loop.

Use `untilManifestComplete()` when task progress is tracked by a manifest.

- Start with [`examples/loop-single-cycle.ts`](../examples/loop-single-cycle.ts)
- Swap the manifest shape and step body to match your work
- Keep the guard so the loop cannot run away if the measure is wrong

### Fan-Out / Fan-In Loop

Use fan-out/fan-in when one cycle needs to inspect several items in parallel.
See [`examples/loop-fanout.ts`](../examples/loop-fanout.ts) for a checked
batch example.

### Persisted-State Loop

Use `createSnapshotStore()` when you want simple, human-readable checkpoints.
Use `createSqliteStore()` when you want restartable checkpoints.
See [`examples/loop-persisted-state.ts`](../examples/loop-persisted-state.ts)
for a checked snapshot-store branch/merge example.

```ts
import { createSqliteStore, type TaskManifest } from "orca-ts";

const store = createSqliteStore({ path: "./.orca/state.db" });
if (store.isErr()) throw store.error;

const manifest: TaskManifest = {
  tasks: [{ id: "scaffold-module", passes: false }],
};

const stateStore = store.value;
const first = await stateStore.checkpoint(manifest);
if (first.isErr()) throw first.error;

const latest = await stateStore.load();
if (latest.isErr()) throw latest.error;
```

Call `stateStore.close()` when you are done with the sqlite store.

### Served Trigger Loop

Use `orca serve` when a trigger should stay alive and own repeated firings.
The loop module should live under `.orca/loops/` and export a `defineLoop()`
result.
See [`examples/loop-served-trigger.ts`](../examples/loop-served-trigger.ts) for
an import-safe module example.

```ts
import { defineLoop, ok, stdout, watch } from "orca-ts";

export default defineLoop({
  name: "watch-src",
  source: watch({ paths: ["src"] }),
  sink: stdout<string>(),
  onTrigger: async (event) =>
    ok({
      outcome: { state: event.path, stopReason: "converged", iterations: 0 },
      output: `${event.eventType}:${event.path}`,
    }),
});
```

### Linear Ticket Triage

Use Linear sources when tickets or Agent Sessions should trigger served loop
runs, and Linear sinks when final summaries, errors, or PR links should land
back in Linear. See the focused [Linear integration](linear.md) guide and the
checked [`examples/linear-ticket-triage.ts`](../examples/linear-ticket-triage.ts)
example.

## Troubleshooting

- `TerminationContractViolated`: you built a back-edge without a preset or a
  custom measure. Add one before the loop can run.
- `ceiling` or `timeout`: the guard stopped the loop before the stop rule
  converged. Raise the guard or fix the state transition.
- `stuck`: the loop is repeating the same action. Change the action or the
  measure so the next cycle can make real progress.
- `budget-exhausted` never appears: the backend is not reporting usage for the
  cycles you are watching.
- `createSnapshotStore()` loses progress after a crash: use `createSqliteStore()`
  when you need restartable history.
- `orca loops` prints nothing: make sure the module exports a loop definition
  from `.orca/loops/` and that importing the module has no side effects.
- `orca serve` reports a child failure: the child loop crashed or exited
  non-zero. Inspect the loop run, not the supervisor.

## Migration Notes

- Keep one-shot scripts in `.orca/workflows/` when you want the legacy flow
  path. Move to `.orca/loops/` when you want discovery, `orca run`, or
  `orca serve`.
- If you are replacing `implementTaskLoop` or `runReviewAndFixLoop`, switch to
  `sequentialTaskStrategy` or `reviewAndFixStrategy`; both now consume loop
  execution while the deprecated wrappers keep their warning behavior.
- Do not try to revive `dbos` or `dolt` as selectable adapters in this release.
  Use the shipped snapshot or sqlite store instead.
- If you only need one pass, prefer a flow. If you need repeated convergence,
  prefer a loop.

For the wrapper migration, see [`docs/migration-loop-strategies.md`](migration-loop-strategies.md).
