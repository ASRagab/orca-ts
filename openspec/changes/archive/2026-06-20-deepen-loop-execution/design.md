## Context

The loop builder shipped with the intended module names and public authoring surface, but the depth is uneven. `fanOut` isolates state with `structuredClone` while the `StateStore` port and docs say branch/merge are the fan-out/fan-in seam. `loop().run` drives recurrence through review-owned `fixLoop`, while `src/loop/engine` has a separate `runRecurrence` path. Context compaction and offload exist as tested utilities, but the loop cycle does not own automatic token-pressure behavior.

The change deepens loop execution without changing the authoring thesis: flow authors write plain TypeScript, public loop APIs stay `Result`-typed and Effect-free, and Effect remains internal to the loop engine.

## Goals / Non-Goals

**Goals:**

- Make loop execution the module that owns recurrence, cycle body execution, guards, stop reasons, and progress reporting.
- Make store-backed fan-out/fan-in use `StateStore.branch()` and `StateStore.merge()` as the documented seam.
- Make opt-in managed context offload and compaction happen during cycle execution, not only in standalone helpers.
- Preserve existing `fixLoop`, review, and persistent-plan behavior for callers.
- Keep public declarations, examples, and generated workflows free of Effect types.

**Non-Goals:**

- No breaking public API removal in this change.
- No DBOS, Dolt, distributed execution, or new durable-state adapter.
- No rewrite of `Source`/`Sink` or served-loop firing; that is covered by `deepen-loop-firing`.
- No compaction of durable loop state snapshots. Only model-visible context is compacted.

## Decisions

### D1: Loop execution owns recurrence

Introduce a loop execution module as the single implementation root for recurrence. The builder will lower its authored body, variant, guards, and progress callbacks into this module. The module may use `runRecurrence` or an evolved equivalent internally, but the public contract is plain promises and `Result`s.

`fixLoop` remains public and keeps its existing overloads and stop behavior. Review and plan strategies become consumers of loop execution instead of being the recurrence owner for the builder.

Alternatives considered:

- Keep builder recurrence on `fixLoop`: preserves current code but leaves loop execution subordinate to the review module.
- Call `runRecurrence` directly only from the builder: improves builder shape but still leaves review/plan convergence on a separate recurrence path.

### D2: Store-backed fan-out is an adapter over the StateStore seam

Keep the pure summary combinators for small in-memory use and tests, but add execution-level store-backed fan-out/fan-in that works from a checkpoint hash. The execution path checkpoints current state, branches per branch, runs isolated branch work, records branch outcomes, selects successful branches by join policy, and merges selected branch snapshots through `StateStore.merge()`.

This preserves locality for simple summary-only fan-out while making the documented state seam real when a loop has a store.

Alternatives considered:

- Replace all fan-out with `StateStore`: makes the simple surface heavier and forces persistence into uses that only need bounded summary work.
- Keep `structuredClone` only: leaves `StateStore.branch()` / `merge()` as decorative depth.

### D3: Context management is cycle behavior

When managed context is explicitly enabled, execution records observations from reason outputs, step outputs, and relevant cycle metadata. Oversized observation content is intercepted by the offload store before it enters model-visible context. At the end of each cycle, token pressure drives compaction through mask, prune, then summarize stages. Direct loop execution without managed context does not capture raw observations.

The durable state manifest remains the replay source. Context is an input budget for future agent turns and may be compacted; state snapshots must stay exact.

Alternatives considered:

- Leave compaction as an author-called helper: keeps helpers isolated from execution and loses cycle progress pressure signals.
- Compact all state and context together: risks corrupting replay and making crash recovery lossy.

### D4: Progress reflects the execution spine

Per-cycle progress should be emitted from loop execution so the measure, stop reason, branch outcomes, usage, offload count, and compaction stages are all derived from the same cycle. Missing usage remains `unknown` and must not be treated as zero.

### D5: Facade gate remains load-bearing

Effect can remain inside `src/loop/engine/**`, but no public runtime declaration, example, or generated workflow may expose Effect. The existing facade gate remains the enforcement point after type generation.

## Risks / Trade-offs

- Larger loop execution module can become a grab bag -> keep recurrence, state branching, context management, and observability behind explicit interfaces with focused tests.
- Store-backed fan-out adds IO to branch execution -> keep pure fan-out available for summary-only work and make store-backed fan-out opt-in through execution/state configuration.
- Review/fixLoop migration can change stop semantics accidentally -> preserve current tests and add compatibility tests around stop reasons, token budget, stuck detection, and deprecated wrappers.
- Context compaction can hide useful debugging evidence -> offload large payloads exactly, preserve pointers, record compaction stages, and keep durable state unmodified.

## Migration Plan

1. Introduce the loop execution interface and move builder recurrence onto it behind unchanged public APIs.
2. Add store-backed fan-out/fan-in execution while preserving pure combinator behavior.
3. Wire opt-in managed context offload and compaction into cycle execution.
4. Move review/plan convergence strategies onto loop execution while preserving `fixLoop` overloads and wrappers.
5. Update docs, examples, and tests; run the facade gate and deterministic verification.

Rollback is straightforward because public authoring APIs remain stable: revert the builder and strategies to the existing `fixLoop` path while leaving pure fan-out, state stores, and context helpers intact.

## Open Questions

- Should store-backed fan-out be surfaced as an additive public helper or remain internal to loop execution first?
- Should context pressure metrics be part of the existing progress callback payload or a separate monitor event?
