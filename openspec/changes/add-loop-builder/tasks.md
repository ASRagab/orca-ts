## 1. Scaffolding & dependencies

- [x] 1.1 Create `src/loop/` module skeleton (builder, engine, graph, state, io, context submodules) with index re-exports
- [x] 1.2 Add `effect` as a runtime dependency; confirm it imports under Bun
- [x] 1.3 Add the loop public surface to the root runtime export and standalone embedded fallback; expose only Effect-free types
- [x] 1.4 Stand up the facade-gate test harness skeleton (declaration/type-test scan for root runtime exports, loop exports, examples, and `.orca/workflows/**/*.ts`)

## 2. StateStore port + default adapter

- [x] 2.1 Define the `StateStore` port: `load / checkpoint / branch / merge / history`, all `Result`-typed
- [x] 2.2 Define the zod-typed task-manifest type and the `measure`/progress projection over it
- [x] 2.3 Implement the `snapshot` adapter (JSON to `.orca/state-<hash>.json` per cycle); `branch` = copy-on-fanout, `merge` = reducer
- [x] 2.4 Implement `history` for the `snapshot` adapter (append/read prior cycle snapshots)
- [x] 2.5 Tests: zero-config snapshot persistence, adapter-swap leaves loop code unchanged, branch/merge round-trip

## 3. Effect engine behind the facade

- [x] 3.1 Implement the internal engine with Effect (`Schedule` for recurrence/variant stop, `Effect.all({concurrency})` + `Fiber`/`Scope` for fan-out + structured cancellation)
- [x] 3.2 Implement the boundary bridge: `Result` ⟷ `Effect.either`; public entry returns `Result`/plain
- [x] 3.3 Wire internal DI via Effect `Layer` while keeping plain authoring accessors (`fs()/git()/llm()`) Effect-free
- [x] 3.4 Implement the facade gate as a `verify`-blocking type-test/lint check; fail on any Effect type in public/flow surface
- [x] 3.5 Tests: public call returns `Result`, cancellation interrupts in-flight branches, facade gate fails on a seeded leak and passes when clean

## 4. Generic convergence + cyclic graph termination

- [x] 4.1 Expand `fixLoop` into a generic convergence primitive while preserving the current issue-list overload/behavior
- [x] 4.2 Add `budget-exhausted` to the stop union and implement an enforceable token budget over reported `Usage`; absent usage reports `unknown` and does not trip the guard
- [x] 4.3 Implement the hand-built 3-color DFS graph: cycle detection returning the back-edge set, topological order, traversal
- [x] 4.4 Distinguish declared loop back-edges (first-class) from accidental cycles (reported)
- [x] 4.5 Enforce the termination contract at build/lint: a back-edge with no preset and no `.measure()` fails
- [x] 4.6 Unify stuck detection into one fingerprint primitive (action+inputs hash, sliding window, N-repeat + oscillation); keep failed-command signature as a configured projection
- [x] 4.7 Tests: current `fixLoop` callers still pass, unguarded back-edge rejected, budget-exhausted stop, missing-usage budget behavior, repeated-fingerprint `stuck`, A→B→A oscillation `stuck`

## 5. Builder API + preset archetypes

- [x] 5.1 Implement `loop()` lowering to `flow()` + `fixLoop()`: `.reason()`, `.step()`, `.measure()`, `.until()`, `.guard()`
- [x] 5.2 Implement preset archetypes: `untilGatesGreen()`, `untilManifestComplete()`, `untilNoIssues()`, `untilConfident(t)`, `times(n)`
- [x] 5.3 Tests: minimal single-cycle loop runs and is engine-internals-free; preset supplies the variant; `.measure()` overrides a preset

## 6. Fan-out / fan-in

- [x] 6.1 Implement bounded `fanOut` (concurrency cap via Effect structured concurrency; isolated state copy per branch)
- [x] 6.2 Implement `fanIn` join policies: `barrier`, `race`, `quorum`, `reduce`, with a merge reducer and a partial-failure policy
- [x] 6.3 Implement condensed-summary branch returns (isolated branch context returns a bounded summary, not raw state)
- [x] 6.4 Tests: concurrency bound honored, quorum proceeds at k, reducer is the only merge point, partial-failure policy applied

## 7. Context management

- [x] 7.1 Implement automatic staged compaction by token pressure (mask → prune → summarize) with aggressive defaults and a small working window
- [x] 7.2 Implement large-output offload (>threshold → scratch file + injected pointer) with pointer resolution
- [x] 7.3 Tests: compaction escalates across thresholds, defaults apply with no config, oversized output offloaded and retrievable

## 8. Sources & Sinks

- [ ] 8.1 Define the `Source` interface; implement `manual`, `cron`, `watch`, `webhook`, `queue`
- [ ] 8.2 Define the `Sink` interface; implement `pr`, `file`, `slack`, `queue`, `stdout` (all `Result`-typed)
- [ ] 8.3 Provide fake `Source`/`Sink` in `test-utils`
- [ ] 8.4 Tests: bundled source triggers a run, sink failure is `err`, whole loop runs end-to-end against fake `Source`/`Sink` plus fake `FlowContext` services with no real trigger/output/tool IO

## 9. Observability

- [ ] 9.1 Extend `WorkflowRunLog` with a per-cycle progress record (`iteration`, `measure`, `delta`, `stopReasonSoFar`, per-branch status, cumulative reported token usage or `unknown`)
- [ ] 9.2 Derive the progress stream from the manifest projection so it stays consistent with the variant
- [ ] 9.3 Tests: per-cycle record emitted, fan-out per-branch status recorded, flat-delta-with-rising-token-usage surfaces incipient runaway

## 10. CLI

- [ ] 10.1 Add explicit CLI command parsing for `run`, `serve`, and `loops` while preserving legacy `orca <flow.ts>` behavior, `--backend`, `--no-typecheck`, and post-`--` flow args
- [ ] 10.2 Define loop discovery: `orca run <loop>` accepts a loop module path or registered loop name; `orca loops` lists metadata from the same registry without executing loops
- [ ] 10.3 Implement `orca serve <loop>` as a thin supervisor owning triggers, spawning an ephemeral child per firing
- [ ] 10.4 Child isolation: independent termination incl. OS-level kill; cross-loop token budget via the shared manifest store
- [ ] 10.5 Tests: legacy `orca <flow.ts>` still works, `run` exits with stop-reason status, `loops` lists without side effects, trigger firing spawns isolated child, one child crash leaves supervisor + others alive

## 11. Collapse legacy loop functions behind compatibility wrappers

- [ ] 11.1 Express `runReviewAndFixLoop` behavior as a review-and-fix `.until()` strategy over `fixLoop`
- [ ] 11.2 Express `implementTaskLoop` behavior as a sequential-task `.until()` strategy over `fixLoop`
- [ ] 11.3 Keep both public exports for one release as deprecated wrappers; preserve `PlanTool` and `ReviewTool` compatibility
- [ ] 11.4 Ship a migration note from wrappers to `.until()` strategies
- [ ] 11.5 Tests: both strategies reproduce prior behavior; wrappers emit deprecation warnings; existing plan/review tests continue to pass

## 12. Optional state adapters

- [ ] 12.1 Implement the `sqlite` adapter on `bun:sqlite` (per-step WAL checkpoint + lease-based crash recovery; `history` table for time-travel)
- [ ] 12.2 Spike DBOS on Bun (functional `registerWorkflow`/`runStep` API, external/non-bundled) and record the verdict as a follow-up design note; do not ship `--durable` in this change
- [ ] 12.3 Leave `dolt` deferred: keep only the design note; no adapter implementation (port shape already supports it)
- [ ] 12.4 Tests: sqlite mid-loop resume, default run needs no service, DBOS/Dolt are not exposed as selectable adapters

## 13. Docs, examples, verification

- [ ] 13.1 Add example loop flows (single-cycle preset loop; a fan-out/fan-in loop) to `examples/`
- [ ] 13.2 Update README + AGENTS.md: `loop()` authoring, presets, StateStore adapters, `run/serve/loops`, legacy CLI compatibility, Effect-behind-facade note, DBOS/Dolt-deferred rationale
- [ ] 13.3 Ensure every spec scenario across the 8 capabilities has a corresponding test
- [ ] 13.4 Confirm full `bun run verify` (typecheck + tests + lint + docs:check + facade gate) passes green
