# Migration: loop wrappers → `fixLoop` `.until()` strategies

`implementTaskLoop` and `runReviewAndFixLoop` are now thin, **deprecated**
wrappers over the single generic convergence orchestrator `fixLoop` (design D7).
Each delegates to a named `.until()` strategy. The wrappers stay for **one
release** and emit a `DeprecationWarning` (code `ORCA_DEP_LOOP_COLLAPSE`) on every
call; their later removal is a separate breaking change.

For new loop-builder authoring with `loop()`, presets, state stores, and
`.orca/loops/` modules, start with [Loops](loops.md). This page only covers the
legacy wrapper migration.

## Review-and-fix

`runReviewAndFixLoop(options)` → `reviewAndFixStrategy(options)`.

Same signature, same `ReviewLoopSummary` (`selected` / `issues` / `fixed` /
`events`) and the same single review pass + at-most-one fix. The strategy drives
`fixLoop` with a review-and-fix policy that converges when no fixable issue
remains.

```ts
// before
import { runReviewAndFixLoop } from "@twelvehart/orcats";
const summary = await runReviewAndFixLoop(options);

// after
import { reviewAndFixStrategy } from "@twelvehart/orcats";
const summary = await reviewAndFixStrategy(options);
```

## Sequential tasks

`implementTaskLoop(tasks, implement)` → `sequentialTaskStrategy(tasks, implement)`.

Same signature and `PlanLoopResult` (`{ completed }`); still stops at the first
typed failure. The strategy drives `fixLoop` with a sequential-task policy that
converges when the pending-task count reaches zero.

```ts
// before
import { implementTaskLoop } from "@twelvehart/orcats";
const result = await implementTaskLoop(tasks, implement);

// after
import { sequentialTaskStrategy } from "@twelvehart/orcats";
const result = await sequentialTaskStrategy(tasks, implement);
```

## Notes

- `ReviewTool` (`createReviewTool`) already calls `reviewAndFixStrategy`
  directly, so the tool path emits no deprecation warning.
- `PlanTool.implementTaskLoop` keeps the wrapper for compatibility; it works
  unchanged and surfaces the deprecation warning — switch the wiring to
  `sequentialTaskStrategy` when convenient.
