## Context

orca-ts is a minimal-dependency (neverthrow + zod), Bun-runtime, `Result`-typed TypeScript library. Its execution core is `flow()` (an `AsyncLocalStorage` DI container exposing ambient `llm/fs/git/gh/terminal/command/plan/review` accessors) and `fixLoop()` (today an `evaluate → fix` issue-list loop with discriminated stops `converged|unfixable|stuck|timeout|ceiling`, a caller-owned `stalled` no-progress predicate, a `wallClockMs` backstop, and an injectable clock). Workflows are authored as imperative TS functions and invoked one-shot via the CLI.

This works but makes the *loop* — the actual unit of agent work — a thing you hand-build every time, with no abstraction for triggers or outputs. This design adds a declarative loop builder modeled as a **cyclic directed graph**, where the back-edge is first-class and termination is guaranteed by construction.

The design is grounded in a loop-engineering source corpus and four TypeScript-ecosystem research surveys. Key external findings: production coding-agent loops are a single in-process `while` (Claude Code's `nO` loop) with composed modules, not adopted orchestration engines; durability is achieved by snapshotting (shadow-git, JSONL transcripts) and the "Ralph" pattern of stateless process-per-iteration with state externalized to a `prd.json` manifest + `progress.txt`; fan-out is small (~3–10, in-process caps); execution is single-machine and ephemeral, triggered by long-running automation (cron/`launchd`).

## Goals / Non-Goals

**Goals:**
- A `loop()` builder authorable and readable by hand without knowing the internals, that lowers to `flow()` plus an expanded generic `fixLoop` convergence primitive.
- Cycles (back-edges) as first-class, with **provable termination by construction** — no back-edge without a termination contract.
- Bounded fan-out, `Result`-typed fan-in with explicit join policies, and cross-iteration context management — the three things the surveyed frameworks are weak on.
- Pluggable triggers (`Source`) and outputs (`Sink`).
- An Effect-powered engine whose power never leaks into the authoring surface.
- Service-free by default, with `snapshot` and `sqlite` state adapters in scope.

**Non-Goals:**
- Adopting an agent framework (LangGraph/Mastra/VoltAgent) or an orchestration daemon (Temporal/Restate). Rejected — see Decisions.
- Distributed / multi-machine execution. Single-machine only.
- Hundreds-wide fan-out. Bounded in-process concurrency only.
- Making the authoring surface Effect-fluent. The facade is plain by mandate.
- Shipping DBOS/Postgres durable mode in this change. DBOS remains a design note and follow-up spike behind the `StateStore` port.

## Decisions

### D1 — Build the loop builder natively; borrow vocabulary, import no framework
Every agent-native framework surveyed (LangGraph.js, Mastra, VoltAgent) is a runtime you adopt, not a layer over yours: each defines its own node contract, state object, and execution loop, so `flow()`/`fixLoop()` would become subordinate — a viral rewrite. None speak `Result`; all assume throw-based control flow. LangGraph's runaway guard is a blunt step counter (`recursionLimit=25`) inferior to orca-ts's existing variant + `stalled` + `wallClockMs`, and it has no bounded fan-out. **Decision:** implement natively, borrowing LangGraph's *conceptual model* — typed state channels with per-channel reducers (fan-in), conditional edges (back-edges), `Send`-style dynamic fan-out — as design language only.
*Alternatives:* adopt LangGraph (viral, LangChain coupling, weaker termination); vendor PocketFlow-TS (near-abandoned, adds little over `fixLoop`); XState as the engine (not agent-native, heavier mental model). All rejected.

### D2 — Effect-powered engine behind a plain, Effect-free facade
The internal engine uses Effect: `Schedule` (composable recurrence + `whileOutput`/`recurUntil` variant stop), bounded structured concurrency (`Effect.all({concurrency})`, `fork`/`Scope` for auto-interrupting runaway branches), `Queue` for backpressure, and optionally the `R` channel as typed DI. Effect's structured-concurrency interruption is genuinely better than hand-wired `AbortSignal` for cancelling fan-out branches, and it unifies retry/schedule/concurrency/typed-errors under one model the maintainer is fluent in.
The cost is that Effect is viral — everything-wants-to-be-an-`Effect` — which would destroy the "readable .ts file" thesis and the non-engineer config-authoring persona if it reached the surface. **Decision:** Effect is confined to `src/loop/engine`. The public API and the flow-authoring surface return `neverthrow` `Result`/plain values; the boundary bridges via `Effect.either` (`result.match(Effect.succeed, Effect.fail)` inward, `Effect.either` + `Either.match(err, ok)` outward). A **type-test + lint gate** asserts no Effect type appears in public runtime signatures or authored flow files.
*Alternatives:* Effect-confined-to-concurrency-only (smaller blast radius but two error idioms at every seam, no unified model); small-libs (cockatiel + hand-built semaphore + microdiff — max readability, zero viral risk, but scattered primitives and forgoes Effect's scope cancellation). Both viable; the maintainer's Effect fluency and the unified model tipped it to D2. The facade gate is what makes D2 safe.
**Scope of Effect:** it powers concurrency + scheduling + structured cancellation only. Effect is **not** the durability layer — Effect's own durable execution (`@effect/cluster`) needs SQL + a shard manager and is not library-only, so durability is owned by the tiers in D4/D5, not Effect.
**DI resolution:** the engine's internal dependency injection moves from `AsyncLocalStorage` to Effect's `R`/`Layer` context — *but only where it doesn't break the Effect-less facade.* The authoring accessors (`fs()/git()/llm()/…`) stay plain functions; a bridge resolves them from the engine's Layer (or a snapshot stashed at the boundary) without exposing any Effect type. Net: Effect `Layer` DI internally, plain accessors externally — a hybrid, with the facade as the hard constraint.
**Facade gate scope:** scan generated declarations for the root runtime export (`orca-ts`), the explicit loop export surface, and `examples/**/*.ts` / `.orca/workflows/**/*.ts` flow-authoring files used in tests. Internal files under `src/loop/engine/**` may mention Effect. `orca-ts/testing` may expose fakes and assertions but must not require users to import Effect for ordinary loop tests.

### D3 — Termination by construction: every back-edge carries a loop variant
A beneficial cycle provably terminates iff it exhibits a **loop variant** — a measure bounded below that strictly decreases (or the loop stops). The manifest pass-flag count, failing-test count, or open-issue count are concrete variants. **Decision:** a back-edge must have a variant — but the author satisfies that by **choosing a preset archetype, not authoring math** (anti-perseveration). Presets bundle a measure + sane guards:
- `untilGatesGreen()` — failing tests/gates → 0 (TDD / compiler loop)
- `untilManifestComplete()` — manifest tasks pending → 0 (the Ralph case)
- `untilNoIssues()` — open review issues → 0 (today's `fixLoop`/review)
- `untilConfident(threshold)` — `1 − confidence` → floor
- `times(n)` — bounded-count escape hatch (variant = remaining iterations)
- `.measure(fn)` — power-user override for a custom variant

So termination-by-construction holds (no measure-less back-edge is buildable) **without** forcing every author to reason about variants — the 99% case picks a preset. `.until()` = variant reached its floor (converged); `.guard()` = seatbelts for when the measure misbehaves. Termination layers, in priority: (1) variant/convergence, (2) fixed-point (`f(state)==state`), (3) seatbelts — iteration ceiling, `wallClockMs`, and a new **token budget**. The budget is enforced over reported `Usage` token totals; backends with no usage data emit `unknown` cost in progress records and cannot trip the token-budget guard.
**`stuck` detection — unified into one generic primitive (simpler):** a single fingerprint = hash of (action identity + inputs) per round over a sliding window, halting on N repeats (catches immediate repeats and A→B→A cycles). The existing failed-command + failing-test-ID signature is a *configured projection* of this one primitive, not a second mechanism; an exploration-spiral (consecutive non-state-modifying actions) is another projection. One mechanism, configurable inputs.

### D4 — State is a manifest behind a pluggable `StateStore` port; simple default, escalate by swapping adapters
State is a typed (zod) loop manifest — the "Ralph" pattern — the single spine for progress, the termination variant, and the monitor stream (all projections over its pass-flags). It is distinct from existing persistent plan markdown: `.orca/plan-<hash>.md` remains the human-readable plan artifact, while the loop manifest is runtime state. Sequential-task strategies may mirror plan task status into the manifest, but manifest files do not replace plan recovery in this change. Two topologies share the manifest: *stateful-conversation* (context persists in-process) and *stateless-respawn* (a fresh agent reads the manifest each cycle — "the agent forgets, the repo does not"). Fan-out branches get isolated state copies; the **fan-in reducer is the only place state merges** (event-sourced/reduce, never shared-mutable) — kills the concurrent-write race class.
**Decision: state is accessed through a `StateStore` port (`load / checkpoint / branch / merge / history`), with a zero-config default and pluggable adapters — not a fixed tier.** This dissolves the earlier T1-vs-T2 question into "one seam, default to the simplest, escalate by swapping an adapter," matching the flexibility-over-commitment goal. Critically, `branch`/`merge`/`history` are **first-class port operations** (the Dolt-inspired insight, valuable even if Dolt isn't adopted): fan-out = `branch`, fan-in = `merge` (with a conflict-resolving reducer), monitoring = `history`.
- **`snapshot` (default):** whole-manifest JSON to `.orca/state-<hash>.json` per cycle. Zero-config, human-readable, git-diffable/hand-editable, zero deps; interrupt loses the current cycle. `branch`/`merge` implemented as copy-on-fanout + reducer-merge.
- **`sqlite` (`bun:sqlite`):** per-step checkpoint to a single WAL file + lease-based crash recovery — finer resume, no service, no install (built into Bun). Reference model: Reflow (`reflow-ts`); LangGraph's `better-sqlite3` saver fails on Bun (ABI mismatch) so we hand-roll on `bun:sqlite`.
- **`dolt` (versioned — design-noted, DEFERRED):** "Git for data" — cycles = commits, **fan-out = `DOLT_BRANCH`, fan-in = `DOLT_MERGE`** with cell-level conflict tables (`dolt_conflicts_<t>`), `AS OF` time-travel; client is painless (`Bun.sql` speaks MySQL natively, zero deps). **Deferred because it cannot be embedded in Bun** — only a Go-only single-process driver, otherwise a 103 MB binary run as a `dolt sql-server` daemon or per-op CLI subprocess, contradicting the no-daemon/minimal-dep ethos (the Beads case study — same solo-tool profile — hit embedded single-process locking, DDL non-atomicity, and a load panic). Branch/merge is tuned for human-scale persistent branches; high-churn ephemeral per-cycle branching is unbenchmarked. The port keeps `branch`/`merge`/`history` first-class so a Dolt adapter stays *possible*; promote from deferred to documented-optional only when a concrete workflow needs DB-adjudicated cell-level fan-in merges on overlapping rows.
- **`dbos` (distributed, DEFERRED):** DBOS + Postgres remains a follow-up spike for multi-process resume-after-crash — see D5.
*Alternatives:* Temporal/Restate/Trigger.dev (mandatory daemon/platform — rejected); a single fixed tier (less flexible than a port); in-memory journal (lost on crash).

### D5 — Defer the `dbos` adapter; keep the port shape ready
For multi-process / at-scale resume-after-crash beyond what the `sqlite` adapter covers, DBOS Transact is the best candidate durable-execution engine needing no separate orchestrator daemon (in-process library + Postgres; Conductor/Cloud optional, observability-only; checkpoints step rows in Postgres → no Temporal-style event-history ceiling on long loops). Its decorator-free TSv3 API (`registerWorkflow`/`runStep`) wraps only chosen entrypoints, leaving the rest plain. **Decision:** do not ship `--durable` or a `dbos` adapter in this change. Record a Bun compatibility spike and keep the `StateStore` port capable of hosting a future DBOS adapter. Caveats: TS is Postgres-only (SQLite system-DB is Python-only today), DBOS cannot be bundled (external dep; `bun run`, not `bun build`), Bun support real but unofficial. T3 is the "graduate to durable multi-process mode once you already have Postgres" tier — never required for core function.
*Alternatives considered for T3:* Temporal (`continueAsNew` ceremony, Bun-incompatible native worker, mandatory daemon); Restate (mandatory Rust daemon, Bun unverified); Inngest/Trigger.dev (external orchestrator / code runs on their workers). All rejected as default; reserved as hypothetical hosted backends only.

### D6 — Hand-built cycle-aware graph
A loop graph is tens of nodes. A ~40-line 3-color (white/grey/black) DFS gives cycle detection *with the offending back-edge set*, topological order, and traversal in one pass — and lets us keep the back-edge set as **first-class domain data** (which cycles are intentional loops vs. accidental), a distinction `isAcyclic`(bool)/`topsort`(throws) erase. **Decision:** hand-build it; no graph dependency. Fall back to `@dagrejs/graphlib` only if weighted paths/SCCs are ever needed.

### D7 — Collapse the three loop functions into `fixLoop` strategies
`implementTaskLoop` (sequential task loop) and `runReviewAndFixLoop` (review-then-fix) are special cases of `fixLoop`. **Decision:** make `fixLoop` the single orchestrator; express the other two as `.until()` strategies. Keep both existing exports for one release as deprecated wrappers so current flows, `PlanTool`, `ReviewTool`, and tests migrate without an immediate break. The later removal is a separate breaking change.

### D8 — `serve` is a thin supervisor that spawns an ephemeral child per trigger firing
A long-lived `serve` must own the triggers (cron/watch/webhook/queue), but running every loop *inside* that one process couples crash domains: one loop's OOM/panic/leak takes down all loops, and a fan-out-heavy loop starves the shared runtime. **Decision:** the supervisor is a thin, stable, long-lived process that owns only triggers; each firing **spawns an ephemeral child process** that runs the loop and exits. Gains: crash isolation, per-loop resource limits, and **OS-level SIGKILL** as the hardest runaway seatbelt (kill a doom-looping child outright); it also *is* the stateless-respawn topology, trigger-driven. Costs accepted: per-run spawn/warmup overhead (fine — fan-out ~3–10, loops run minutes) and cross-loop coordination (global token budget / concurrency cap) via the shared manifest store rather than shared memory.
*Alternatives:* single process hosting all loops (lower overhead + trivial cross-loop coordination, but no isolation and cooperative-only cancellation) — rejected as default; the whole point of a persistent `serve` is isolation.

### D9 — Join policies: ship all four in v1
`barrier | race | quorum | reduce` all land in v1 (not a `barrier`+`reduce` subset). Each maps to a real agent pattern (committee review, redundant-attempt speed, self-consistency voting, gather-and-summarize); they share one fan-in machinery (collect `Result`s, apply a policy fn + reducer + partial-failure policy), so the marginal cost of the extra two is small and avoids a later breaking addition.

### D10 — Context compaction: automatic, aggressive defaults, small working window
Compaction runs **automatically by token pressure** (no author opt-in) with **aggressive default thresholds and a small working-memory window** — the "small windows = smart agents" principle: a tight context forces sharper agent behavior and cheaper turns. Staged: observation masking → pruning → summarization as pressure rises; large outputs (>Nk chars) offloaded to a scratch file with a pointer injected. Authors may tune thresholds but get aggressive defaults out of the box.

## Risks / Trade-offs

- **Effect gravity pulls types outward** → the type-test/lint facade gate is mandatory and CI-blocking; treat any Effect type in a public signature or flow file as a build failure. The gate is the single load-bearing safeguard of D2.
- **Effect learning curve for future contributors** (engine internals) → confine Effect to `src/loop/engine`, document the bridge pattern, keep everything else neverthrow.
- **Builder DSL could itself become "too complex"** (the original complaint) → the single-cycle case must stay trivial (`.reason().measure().until().guard()` reads like a guarded `while`); graph features (fan-out/fan-in) are opt-in combinators, never required.
- **Manifest serialization bloat on very long loops** → cap retained per-cycle snapshots; the manifest is the source of truth, snapshots are diffs.
- **DBOS unofficial-Bun + can't-bundle** → keep `--durable` out of this change; document the spike result before promoting it to a requirement.
- **Token-budget guard depends on backend usage reporting** → enforce only when usage exists; where usage is absent, progress reports `unknown` and the guard does not fire.

## Migration Plan

1. Expand `fixLoop` into a generic convergence primitive while preserving current issue-list overload behavior.
2. Land `src/loop/` (builder, 3-color-DFS graph, `Source`/`Sink`, Effect engine, facade) + the facade gate on top of `flow()` and generic `fixLoop`.
3. Re-express `implementTaskLoop` / `runReviewAndFixLoop` as `.until()` strategies; keep deprecated wrappers for one release. Ship a migration note.
4. Add CLI `run` / `serve` / `loops` without breaking legacy `orca <flow.ts>`.
5. Add context-compaction + per-cycle monitor stream (additive to `WorkflowRunLog`).
6. Record the DBOS Bun spike as follow-up evidence; do not ship `--durable` here.
*Rollback:* the builder lowers to `flow()` + generic `fixLoop`; reverting `src/loop/` leaves existing flow scripts intact. The compatibility wrappers make rollback non-breaking for current public callers.

## Open Questions

*Resolved in review:* `stuck` → one generic fingerprint primitive (D3); `R`/`Layer` DI internal, plain-accessor facade (D2); all four join policies in v1 (D9); automatic aggressive compaction (D10); `serve` = thin supervisor + ephemeral child per firing (D8); mandatory variant satisfied by preset archetypes (D3).

Also resolved: state is a **pluggable `StateStore` port** with `branch`/`merge`/`history` as first-class operations; default adapter = `snapshot` (JSON, readable, git-friendly); `sqlite` is the shipped embedded adapter; `dbos` is deferred (D4/D5). This dissolves the prior "T1 vs T2 default" question — simplest adapter is the default, escalate by swapping.

Also resolved: **`dolt` adapter deferred** (probe verdict) — not embeddable in Bun, daemon-or-103MB-binary only; the `branch`/`merge`/`history` port shape is kept so it remains a possible future adapter, `sqlite` is the shipped embedded option. See D4.

No blocking open questions remain — ready for specs/tasks. Non-blocking items to revisit during implementation: exact `bun:sqlite` checkpoint schema; whether `serve` shares one backend pool across child loops via the manifest store or fully isolates; preset-archetype list finalization.
