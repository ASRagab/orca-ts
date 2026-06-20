## 1. Execution Spine

- [x] 1.1 Add focused tests that prove `loop().run` does not route recurrence through review-owned `fixLoop`.
- [x] 1.2 Define the loop execution interface for initial state, cycle body, variant measure, guards, progress callback, and stop outcome.
- [x] 1.3 Move builder recurrence onto the loop execution interface while preserving current `loop()` public behavior.
- [x] 1.4 Reconcile or replace `runRecurrence` so there is one loop-owned recurrence path with Effect confined to `src/loop/engine/**`.
- [x] 1.5 Preserve `fixLoop` overloads, stop reasons, and compatibility behavior for existing callers.

## 2. Store-Backed Fan-Out

- [x] 2.1 Add failing tests for store-backed fan-out using `StateStore.branch()` per branch and `StateStore.merge()` at fan-in.
- [x] 2.2 Implement the store-backed fan-out/fan-in execution path from a checkpoint hash.
- [x] 2.3 Preserve pure summary-only `fanOut`/`fanIn` behavior and existing tests.
- [x] 2.4 Add adapter-agnostic tests covering snapshot and sqlite branch/merge behavior through the same fan-out path.
- [x] 2.5 Update loop docs/examples to distinguish pure summary fan-out from store-backed state fan-out.

## 3. Context Management In Cycle Execution

- [x] 3.1 Add tests proving reason and step outputs become bounded observations during loop execution.
- [x] 3.2 Wire oversized reason/step output through the offload store before it enters model-visible context.
- [x] 3.3 Apply automatic token-pressure compaction at the cycle boundary with aggressive defaults.
- [x] 3.4 Add tests proving durable state checkpoints remain exact when model-visible context is compacted.
- [x] 3.5 Expose or record offload count and compaction stages for cycle progress.

## 4. Review And Plan Strategy Migration

- [x] 4.1 Move review-and-fix strategy execution onto the loop execution interface without changing reviewer prompt parity.
- [x] 4.2 Move sequential task strategy execution onto the loop execution interface without changing persistent plan recovery.
- [x] 4.3 Preserve deprecated wrapper warnings and compatibility tests for `implementTaskLoop` and `runReviewAndFixLoop`.
- [x] 4.4 Add regression tests for token-budget and stuck-detection stop behavior after the recurrence move.

## 5. Observability, Facade, And Documentation

- [x] 5.1 Emit progress records from loop execution with iteration, measure, delta, stop reason, usage, branch status, and context pressure.
- [x] 5.2 Update docs and website docs for loop execution, state fan-out, context compaction, and review strategy behavior.
- [x] 5.3 Run `bun run build:types` and `bun run check:facade-gate`.
- [x] 5.4 Run targeted loop builder, fan-out/state, context, review, and observability tests.
- [x] 5.5 Run `bun run typecheck`, docs checks, and `bun run verify`.
