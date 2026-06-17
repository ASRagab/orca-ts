---
title: Loop API
description: Loop builder, presets, guards, distribution, sources, and sinks.
---

## Builder

```ts
const result = await loop<State>("name")
  .step("do-work", async (state) => state)
  .until(untilGatesGreen())
  .guard({ maxIterations: 10 })
  .run(initialState);
```

Use `.reason(backend, { prompt })` when a cycle needs an autonomous backend turn. Use `.step(name, fn)` for deterministic state transitions.

## Presets

| Preset | Stops when |
| --- | --- |
| `untilGatesGreen()` | failing gates reach `0` |
| `untilManifestComplete()` | pending tasks reach `0` |
| `untilNoIssues()` | open issues reach `0` |
| `untilConfident(threshold)` | confidence reaches the threshold |
| `times(n)` | `n` cycles have run |

`.measure(fn)` overrides a preset measure. `.guard()` adds or overrides seatbelts such as `maxIterations`, `wallClockMs`, and `tokenBudget`.

## Stop reasons

`converged`, `ceiling`, `timeout`, `stuck`, `unfixable`, `budget-exhausted`, and `cancelled` are the user-facing stop reasons. `orca run` maps them to an exit status.

## Distribution

`defineLoop({ name, source, sink, onTrigger })` packages a loop module. Put it under `.orca/loops/`, export it, then use `orca loops`, `orca run`, or `orca serve`.

Built-in source kinds: `manual`, `cron`, `watch`, `webhook`, `queue`.

Built-in sink kinds: `pr`, `file`, `slack`, `queue`, `stdout`.
