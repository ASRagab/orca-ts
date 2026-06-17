## Why

orca-ts today is an imperative scripting harness: you author a workflow as a TypeScript function inside `flow()` and hand-wire orchestration, state, fan-out, termination, and output every time. Authoring a *reliable cyclic loop* — the actual unit of agent work (`reason → act → observe → evaluate → reason`) — means rebuilding the same boilerplate per workflow, and there is no abstraction for what *triggers* a loop or where its *output* goes. Loop engineering needs the cycle to be first-class, with the back-edge that makes it useful and the termination guarantee that keeps it from running away.

Research (a loop-engineering source corpus + four TypeScript-ecosystem surveys: agent-native graph frameworks, durable-execution engines, state-machine/structured-concurrency libs, and unopinionated building blocks) converged hard: **build the loop builder natively** — every agent framework (LangGraph.js, Mastra, VoltAgent) is a runtime you adopt, not a layer over yours, none speak `Result`, and orca-ts's existing `fixLoop` termination (`converged|unfixable|stuck|timeout|ceiling` + `stalled` + `wallClockMs`) is already superior to their blunt recursion caps. Borrow the *vocabulary* (typed state channels + reducers for fan-in, conditional edges for back-edges), import none of it, and add the three things every framework is weak on: **bounded fan-out, `Result`-typed fan-in, and context compaction.**

## What Changes

- **Add a declarative `loop()` builder** as the new front door, authorable by hand and readable without knowing the internals. It lowers to `flow()` plus an expanded generic `fixLoop` convergence primitive — no new public runtime.
- **Model a loop as a cyclic directed graph**: nodes (deterministic steps + a single `.reason()` LLM verb), forward edges, and **back-edges**. Every back-edge requires a **termination contract** — a loop variant with a floor, plus guards. An unguarded back-edge is a build/lint error: cycles allowed, runaway impossible by construction. The variant is satisfied by **choosing a preset archetype** (`untilGatesGreen()` / `untilManifestComplete()` / `untilNoIssues()` / `untilConfident()` / `times(n)`), not by authoring math — `.measure(fn)` is the power-user override. Authors get rigor without perseverating on variants.
- **Effect-powered internal engine behind a plain facade.** The runtime uses Effect (`Schedule` for recurrence/variant stop, `Queue`/structured concurrency for bounded fan-out, `Fiber`+`Scope` for auto-interrupting runaway branches; optionally the `R` channel as typed DI). The **public API and the flow-authoring surface stay Effect-free** — they return `neverthrow` `Result`/plain values, bridged at the boundary via `Effect.either`. Enforced by a no-Effect-leak type/lint gate.
- **Typed State Object = a task manifest** (the "Ralph" pattern: discrete subtasks with boolean pass-flags). Progress, the termination variant, and monitoring are the same projection over that manifest. Serialized each cycle to `.orca/state-<hash>.json`; resumable and diffable.
- **Two loop topologies** sharing the manifest spine: *stateful-conversation* (context persists across cycles, today's model) and *stateless-respawn* (fresh agent reads the externalized manifest each cycle — eliminates context drift, makes durability "re-read the file").
- **Pluggable `Source` (trigger) and `Sink` (output)** — two-method interfaces. Bundled sources: `manual / cron / watch / webhook / queue`. Bundled sinks: `pr / file / slack / queue / stdout`.
- **Bounded fan-out + `Result`-typed fan-in.** Fan-out is concurrency-capped (the hazard frameworks ignore — and the class of bug orca-ts already hit). Fan-in declares an explicit join policy — `barrier | race | quorum | reduce` — with a merge reducer, partial-failure policy, and condensed-summary branch returns (isolated branch context, ~1–2k-token summaries, not raw state).
- **Expanded termination guards** on `.guard()`: existing stops plus a **token budget** over reported `Usage`; `stuck` detection upgraded with doom-loop fingerprinting (hash of tool + args, 3× in a sliding window) and an exploration-spiral counter (N consecutive non-state-modifying actions).
- **Context-management capability** orca-ts lacks: staged compaction (observation masking → pruning → summarization by token pressure) and large-output offloading (write >Nk-char payloads to a scratch file, inject a pointer).
- **Per-cycle progress monitor stream** — `{ iteration, measure, delta, stopReasonSoFar, branches: [{id, status, usage}], cumulativeUsage }` — extending the existing `WorkflowRunLog`.
- **Collapse `implementTaskLoop` and `runReviewAndFixLoop` into `fixLoop` strategies.** `fixLoop` becomes the one orchestrator; the other two remain exported for one release as deprecated compatibility wrappers that call the strategies.
- **CLI**: `orca run <loop>` (one-shot loop execution), `orca serve <loop>` (long-lived host that honors the loop's Source — cron/watch/webhook/queue), `orca loops` (list defined loops + their source/sink). Legacy `orca <flow.ts>` keeps today's one-shot flow-script behavior.
- **Pluggable `StateStore` port** with `load / checkpoint / branch / merge / history` as first-class operations (so fan-out = branch, fan-in = merge, monitoring = history). Shipped adapters: `snapshot` (JSON to `.orca/state-<hash>.json`, the zero-config default — readable, git-diffable) and `sqlite` (embedded `bun:sqlite` per-step checkpoint + lease recovery, no service, no install). `dbos` and `dolt` stay deferred design notes behind the same port shape.
- **New runtime dependency**: `effect` (engine, confined behind the facade). No new optional peer dependency ships in this change; DBOS remains a follow-up spike.

## Capabilities

### New Capabilities
- `loop-builder`: the declarative `loop()` API, its lowering to `flow()`+`fixLoop()`, the cyclic-graph model (nodes / forward edges / back-edges), the mandatory per-back-edge termination contract, and the Effect-engine-behind-plain-facade boundary discipline.
- `loop-io`: the `Source` (trigger) and `Sink` (output) interfaces and their bundled implementations.
- `loop-state`: the typed manifest State Object, the stateful-conversation vs stateless-respawn topologies, and the pluggable `StateStore` port (`load/checkpoint/branch/merge/history`) with shipped adapters (`snapshot` default, `sqlite`) and deferred adapter notes (`dbos`, `dolt`).
- `loop-context`: cross-iteration context management — staged compaction and large-output offloading.

### Modified Capabilities
- `flow-runtime`: `loop()` lowers onto `flow()`; the internal engine becomes Effect-powered; the conversation/queue/harness machinery is hidden from the authoring surface.
- `plans-and-review`: `fixLoop` becomes the single generic convergence orchestrator; `implementTaskLoop` and `runReviewAndFixLoop` become deprecated wrappers over `.until()` strategies; `stuck` detection gains fingerprinting + spiral counters; guards gain a token budget.
- `execution-observability`: `WorkflowRunLog` extended with a per-cycle progress stream (measure/delta/branch-status/cumulative token usage).
- `distribution`: CLI gains `run` / `serve` / `loops`; `serve` introduces a long-lived trigger-host process model.

## Impact

- **New module** `src/loop/` (builder, graph + cycle detection via a hand-built 3-color DFS, `Source`/`Sink`, Effect engine, facade). 
- **Dependencies**: `+effect` (core). neverthrow + zod retained. No framework runtime adopted.
- **Facade gate**: a type-test/lint check asserting the public API + flow-authoring surface expose no Effect types (the load-bearing constraint for the "readable .ts file" ethos).
- **Compatibility**: `implementTaskLoop` / `runReviewAndFixLoop` remain for one release as deprecated wrappers; migration to `.until()` strategies is documented before removal.
- **Backends/tools**: `.reason()` wraps a per-turn backend call with resilience policy (retry/timeout/breaker via Effect `Schedule`); fan-out branch isolation reuses existing per-conversation context. DBOS remains a deferred follow-up because it cannot be bundled.
