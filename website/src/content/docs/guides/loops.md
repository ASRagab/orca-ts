---
title: Loops
description: Repeat work until a measured state converges.
---

Use a loop when one pass is not enough and the state itself should decide when to stop.

| Use a flow when | Use a loop when |
| --- | --- |
| Work is one pass. | Work repeats until a measured condition is met. |
| Input is simple task args. | Input becomes state checked across cycles. |
| You do not need branch isolation. | You need checkpoints, fan-out, or resume. |

## Minimal loop module

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
      output: result.value.state
    });
  }
});
```

Run it:

```bash
orca run countdown
orca run .orca/loops/countdown.ts
orca loops
```

## Stop rules

Every loop needs a stop rule from a preset or custom `.measure()`.

| Preset | Use it for |
| --- | --- |
| `untilGatesGreen()` | test or gate repair loops |
| `untilManifestComplete()` | task-manifest loops |
| `untilNoIssues()` | review and fix loops |
| `untilConfident(threshold)` | confidence-driven loops |
| `times(n)` | bounded repeats or smoke loops |

Add `.guard({ maxIterations, wallClockMs, tokenBudget })` for seatbelts. A cyclic loop with no preset and no custom measure is rejected before it runs.

Read the reference pages for the [loop API](../../reference/loop-api/) and [state stores](../../reference/state-stores/).
