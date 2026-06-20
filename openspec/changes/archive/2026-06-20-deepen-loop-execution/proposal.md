## Why

The loop builder has the right public vocabulary, but several execution responsibilities are still shallow or split: fan-out/fan-in bypass the `StateStore` branch/merge seam, recurrence is owned by the review module instead of loop execution, and context compaction/offload exists as isolated utilities rather than cycle behavior. Deepening loop execution now makes the shipped architecture match its documented contracts while keeping authoring Effect-free.

## What Changes

- Make loop execution the owner of recurrence, cycle body execution, stop evaluation, guards, and per-cycle progress.
- Route store-backed fan-out/fan-in through `StateStore.branch()` and `StateStore.merge()` while preserving summary-only pure combinators where they are still useful.
- Integrate context observation, large-output offload, and token-pressure compaction into the loop cycle when managed context is explicitly enabled, with aggressive defaults for enabled context.
- Keep loop state replayable and separate from compacted model-visible context; compaction must never rewrite durable state snapshots.
- Re-express review and plan convergence strategies over the deeper loop execution interface while preserving existing `fixLoop` public behavior.
- Preserve the public Effect-free facade and the existing facade gate.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `loop-builder`: loop builder execution ownership changes from review-owned `fixLoop` recurrence to a loop execution module while keeping the authoring surface Effect-free.
- `loop-state`: fan-out/fan-in state isolation and recombination become real `StateStore.branch()` / `StateStore.merge()` behavior for store-backed loops.
- `loop-context`: managed context compaction and offload become part of cycle execution rather than standalone helpers.
- `execution-observability`: per-cycle progress includes execution-owned recurrence data, branch status, and context pressure/offload/compaction evidence.
- `plans-and-review`: existing review/plan convergence behavior is preserved while strategies consume loop execution instead of owning recurrence.

## Impact

- Affected code: `src/loop/builder/`, `src/loop/engine/`, `src/loop/fanout.ts`, `src/loop/state/`, `src/loop/context/`, `src/review/`, public loop exports, tests, docs, and examples.
- Affected APIs: no planned breaking API changes; possible additive internal or public types for execution strategies, context events, or store-backed fan-out options.
- Dependencies: no new runtime dependencies; Effect remains confined behind the existing facade.
- Verification: targeted loop builder, fan-out/state, context, review/fixLoop, facade-gate, typecheck, docs checks, and `bun run verify`.
