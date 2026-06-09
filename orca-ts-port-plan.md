# Orca → TypeScript: Review & Port Strategy
A review of the Scala 3 `orca` codebase and an end-to-end, drift-minimizing strategy to port it to TypeScript. Decisions below were settled in a grilling session; this document is the durable record plus the executable plan.

* * *
## TL;DR — settled decisions
| #   | Decision | Resolution |
| --- | --- | --- |
| 1   | Why port | Broaden contributors + lighter distribution + ecosystem alignment + dogfooding. **Not** perf (orca is I/O-bound on agent latency; runtime is noise). |
| 2   | Architecture | **Faithful SPI port.** Multi-backend is foundational. Claude Agent SDK is a _future_ drop-in behind `Conversation`, not the foundation. |
| 3   | Language | **TypeScript** — only target that keeps orca's thesis: "looks like a script, but typed, with author-time feedback." |
| 4   | Phasing | 5 vertical slices, each **parity-gated**: Claude-autonomous (+Plan+review) → OpenCode → Codex+Gemini → Pi. |
| 5   | ask_user / approvals | **Reserve the seam, drop the implementation.** Removes the MCP/Netty bridge (ADR 0012 out). `Conversation` becomes read-only. `Plan.interactive` + 02-interactive dropped. |
| 6   | Anti-drift | **Hybrid loop**: Scala = author-time oracle per slice; frozen JSON golden fixtures (tier-1 stream→event); native TS e2e golden runs (tier-2 flow behavior). CI is TS-only. |
| 7   | Repo | Standalone `orca-ts`; Scala repo cloned beside it for diffing. Not a monorepo. |
| 8   | Distribution | **bun**, shipped as `bun build --compile` standalone binary (cross-language zero-dependency). npm package for authoring/LSP. Mandatory `tsc --noEmit` pre-flight. |
| 9   | Effect-ts | **Rejected for v1**, documented as upgrade path. Maps 1:1 to the Ox/tapir stack but reintroduces the monadic ceremony that ADR 0001 rejects and taxes goal #1. |
| 10  | Dep stack | **Zod** (schema) + **neverthrow** (Result) + branded types + Node built-ins. Two small single-purpose libs. |

* * *
## Part I — What orca is (review)
~25k LOC Scala 3 (≈13k main / ≈11.6k test), 8 sbt modules, 15 ADRs.

**Product thesis (verbatim, README):** _"Scala 3 looks like Python but with types — so you get quick feedback if your flow script has a problem."_ You write a deterministic top-to-bottom script; orca drives coding-agent CLIs through plan → implement → review → fix → commit → PR → CI. The **runtime owns git** so every reviewer sees a real diff (a self-committing agent would leave an empty `git.diff()`).
### Module / dependency graph
```
tools  (standalone)  — tool traits + os-backed impls + structured I/O + event bus
  ├── flow    → tools   — FlowContext, stage/fail; orca.plan; orca.review; orca.bug
  ├── claude  → tools   — stream-json backend + MCP ask_user bridge
  ├── codex   → tools   — codex exec --json JSONL backend
  ├── opencode→ tools   — HTTP+SSE server backend
  ├── pi      → tools   — pi --mode rpc backend
  ├── gemini  → tools   — gemini stream-json JSONL backend
  └── runner  → all     — flow() entry, DefaultFlowContext, terminal layer
```
### Five load-bearing pillars (each Scala-3-specific)
```
①  Ambient flow DSL      flow(args){ ctx ?=> ... }   context functions + using accessors
②  Backend SPI           LlmBackend[B <: BackendTag]  phantom-typed SessionId[B]/LlmResult[B]
③  Structured output     derives JsonData             tapir Schema + jsoniter codec
④  Stream convergence     StreamConversation           bounded queue → single-consumer Iterator
⑤  ask_user              MCP host bridge (chimp+Netty) claude/codex/gemini; native opencode
```

The **convergence** is the cleanest part: 5 backends with different wire formats (stream-json NDJSON, exec JSONL, HTTP+SSE, rpc) all translate to one `Conversation.events: Iterator[ConversationEvent]` + `awaitResult(): LlmResult`. `StreamConversation` is the shared engine (bounded `LinkedBlockingQueue`, single-consumer iterator, `Outcome` ADT = Success/Cancelled/Failed, backpressure into the subprocess pipe).
### Complexity callouts (the honest map)
| Area | Verdict |
|---|---|
| `StreamConversation` + backend event-translation tables | **Port faithfully** — core value, maps cleanly to async iterators. |
| `JsonData` (tapir+jsoniter macro derivation) | **Replace, simpler** — Zod is one object for all three jobs. |
| Context-function DSL | **Re-mechanize** — AsyncLocalStorage; same ergonomics, different machine. |
| Phantom types | **Keep via branded types** — preserves session-mismatch safety statically. |
| MCP ask_user bridge (ADR 0012) — chimp+Tapir+Netty + gemini settings.json merge + codex `-c mcp_servers` | **Cut** (see Part V). The single hardest sub-component; contradicts the determinism thesis. |
| Terminal StatusBar (ADR 0008) | **Port the design, no TUI lib** — deterministic ANSI; ink would pull React for no gain. |
| `Announce` typeclass (ADR 0009) | **Simplify** — optional `announce?: (o)=>string` on the call. |
| Reviewer roster (ADR 0011, 8 `.md` prompts) | **Port verbatim** — prompts are data, copy the files. |
| Persistent plans (ADR 0013) | **Port faithfully** — `.orca/plan-<hash>.md` format is a parity-gated contract. |

* * *
## Part II — Target architecture (TypeScript)
### Pillar mapping
```
①  ambient FlowContext    → AsyncLocalStorage holds a FlowContext object,
                            overridable by name: flow(args, {git: myGit})(async () => {...})
②  phantom SessionId[B]    → branded types: type SessionId<B extends BackendTag> = string & {__b: B}
③  JsonData                → Zod: const Plan = z.object({...});  z → JSON Schema via z.toJSONSchema
④  StreamConversation      → bounded async queue + async generator (events) + Outcome union
   Either[E,T]             → neverthrow Result<T,E>; async tools return Promise<Result<T,E>>
   Ox supervised/fork      → async/await; reviewer fan-out = Promise.all w/ concurrency cap
   cancel()                → AbortController
⑤  ask_user/approvals      → reserved variants in the event model, unimplemented (Part V)
```
### Dependency footprint (final)
```
zod          schema: validate + static type + JSON-Schema export      [replaces JsonData]
neverthrow   Result<T,E> and little else, 0 transitive deps           [replaces Either]
(branded types) compile-only, 0 runtime deps                          [replaces phantom types]
Node built-ins: AsyncLocalStorage, AbortController, async generators, child_process
```

**Design rule (keeps flow scripts ceremony-free):** async tool methods return `Promise<Result<T, E>>` — a plain `Result` _inside_ a Promise, **not** neverthrow's `ResultAsync`. Flow authors write `const r = await git.commit()` then branch / `.orThrow()`. Typed-error safety at the recoverable seams only, mirroring the Scala `Either`-at-seams / throw-elsewhere rule. `E` is a discriminated union of tagged errors (`{_tag:"NothingToCommit"}`, `BranchAlreadyExists`, `PushRejected`, …). Add one ~5-line `orThrow` helper.
### Why not Effect-ts (recorded for the new repo's ADR)
Effect maps almost 1:1 to orca's Scala stack (fibers↔Ox, typed-error channel ↔`Either`, `Layer`↔FlowContext DI, `@effect/schema`↔tapir, `Stream`↔Channel). Rejected for v1 because: (a) it **is** the tagless-final effect monad that ADR 0001 explicitly rejects — `Effect.gen`/`yield*` in flow scripts reintroduces the monadic ceremony orca's pitch brags about not having; (b) its steep learning curve taxes goal #1 (broaden contributors — almost nobody in AI-infra knows it); (c) every capability we need is a built-in or one small known lib. Kept as the documented upgrade path: if hand-rolled typed-errors + DI creak as runtime variants multiply, Effect (or just `@effect/schema`) slots in behind the `Result` / `FlowContext` / `Schema` seams without touching flow scripts.
### Distribution
```
orca runner CLI   → bun build --compile → standalone binary (no Node, no JVM)
                    ↳ this is the cross-language win: a Python/Go shop runs orca
                      with zero install. scala-cli could never do this.
flow scripts       → authored in TS, run by the binary
npm "orca" package → editor/LSP author-time types + bunx orca convenience
pre-flight         → mandatory tsc --noEmit before executing a flow
                    ↳ bun/tsx STRIP types without checking; this gate is what
                      preserves the README promise "catch it before you burn tokens".
```

* * *
## Part III — The anti-drift harness (the spine)
The explicit ask is "minimize drift." This is the core deliverable. Three tiers plus a freeze step.
### Step 0 — Freeze the model first (highest-drift surface)
Before any backend code, freeze the shared event/result model as a language-neutral JSON spec + Zod schema:

```
ConversationEvent  = AssistantTextDelta | AssistantTurnEnd | AssistantToolCall
                   | ToolResult | Error | UserPrompt
                   | (reserved, unimplemented) UserQuestion | ApproveTool
OrcaEvent          = UserPrompt | ToolUse | AssistantMessage | TokensUsed
                   | StructuredResult{raw, summary?} | Step | Error
LlmResult<B>       = { sessionId: SessionId<B>, output, structured?, usage }
Usage              = { input, output, reasoning? }
BackendTag         = ClaudeCode | Codex | Opencode | Pi | Gemini
```

This file is the contract both implementations agree on. It moves only by deliberate amendment, never by accident.
### Tier 1 — Stream→event parity (per backend)
The Scala conversation tests feed **inline scripted NDJSON/JSONL/SSE strings** to a `FakePipedCliProcess` and assert typed `ConversationEvent` outputs (verified: they are string literals + ADT assertions, not external resources).

```
extract once:
  scripted-stream lines (already JSON)         → fixtures/<backend>/<case>.input.jsonl
  expected ConversationEvent[] (Scala ADT)     → fixtures/<backend>/<case>.events.json   ← one-time JSON encoding
  expected LlmResult / error                   → fixtures/<backend>/<case>.result.json

run forever:
  TS: feed input.jsonl to a FakePipedProcess → assert events + result == golden
  (the input side is free; the expected side is the one-time investment)
```

The expected-value encoding is the only real cost here — a canonical JSON form of `ConversationEvent`/`LlmResult` (which Step 0 already defines). Write a small Scala extractor or hand-port per case; once frozen, it is the regression net.
### Tier 2 — Flow-behavior parity (native TS e2e)
Fixtures don't cover Plan persistence, git commit shape, reviewer selection, or terminal output. For those: golden e2e runs against a **fake agent** (`StubCliRunner` analog) asserting the full triple:

```
(commits made, .orca/plan-<hash>.md content, event-log output)  ==  golden
```
### The hybrid loop (per slice)
```
        ┌─────────────── author slice in orca-ts ───────────────┐
        │                                                        │
   read Scala implementation → port to TS → run TS against:       │
   (oracle, local)                   • tier-1 frozen fixtures    │
        ▲                            • tier-2 e2e golden          │
        │                                    │                    │
        └──── diverge? diff vs Scala oracle ─┘                    │
              (run Scala locally for the same case, Scala wins)   │
        │                                                        │
        └──────── slice passes → retire oracle for that slice ───┘

CI runs TS only (tier-1 + tier-2). Scala never enters CI.
```
### ADRs as acceptance criteria
Each ADR → a checklist item + at least one parity test. The matrix (Appendix) is the slice exit-criteria. An ADR is "ported" only when its test is green or it is explicitly marked cut/deferred.

* * *
## Part IV — Phased implementation (5 vertical slices)
Each slice is the **thinnest full path** (DSL → backend → Conversation → structured output → terminal → tools → domain helper), gated by parity. Never module-by-module translation (drifts the day it's written).
### Slice 1 — Claude autonomous + Plan + review _(the spine; ~70% of architecture)_
```
build: AsyncLocalStorage FlowContext + flow() entry + named overrides
       LlmTool.autonomous + resultAs[O] (Zod) + branded SessionId
       claude stream-json read-path parser → Conversation.events (async gen)
       StreamConversation engine (bounded queue, Outcome union, AbortController)
       terminal: event-log + StatusBar (ADR 0008, hand-rolled ANSI)
       tools: fs / git / gh (child_process via a QuietProc analog — capture stderr)
       Plan: defaultPath/recover/implementTaskLoop, .orca/plan-<hash>.md (ADR 0013)
       reviewAndFixLoop + ReviewerSelector + 8-reviewer roster (.md prompts copied)
gate:  01-simple example produces identical event sequence + result + commits
       + plan-file content vs Scala, against shared fixtures.
defer: interactive, ask_user, approvals (reserved seams only).
```
### Slice 2 — OpenCode (HTTP+SSE)
```
build: opencode serve lifecycle (lazy, shared, SIGINT teardown)
       SSE line-source → SAME StreamConversation engine (proves transport-agnostic)
       structured output via native format=json_schema; result from message.updated
why:   validates the Conversation SPI generalizes beyond subprocess stdio.
gate:  opencode autonomous parity (stream→event + structured result) vs Scala.
```
### Slice 3 — Codex + Gemini (JSONL siblings)
```
build: two event-translation tables onto the existing StreamConversation
       codex: thread.started/item.completed/turn.completed → events + synth result
       gemini: init/message/tool_use/tool_result/result → events
       approval/model flag mapping (ADR 0007 / 0015), settings WITHOUT ask_user
why:   cheap once the engine exists — mostly mapping tables.
gate:  codex + gemini parity fixtures green.
```
### Slice 4 — Pi (rpc)
```
build: pi --mode rpc driver → events; per user, pi stays in scope.
gate:  pi parity fixtures green.
```
### Slice 5 — Hardening + distribution
```
build: bun build --compile binary; npm publish; tsc --noEmit pre-flight wired
       into the runner; README + AGENTS.md equivalents; all examples ported
       (except 02-interactive, dropped).
gate:  full e2e on a real repo with a real backend (gated integration test).
```

* * *
## Part V — Scope cuts & deferrals (reserve the seam, drop the implementation)
### ask_user / tool approvals / interactive — **CUT, seam reserved**
Rationale (user's, correct): mid-session `ask_user` reintroduces the live human-in-the-loop orca exists to replace, and it breaks orca's own guarantees — **determinism** (behavior depends on live typing) and **resumability** (a recovered plan can't replay a human answer after a crash; ADR 0013).

Cascade:

```
deterministic flow = autonomous turns + auto-approve everything
  ↳ ask_user (ADR 0012)  needs MCP host bridge (chimp+Tapir+Netty) on
                         claude/codex/gemini + opencode native + gemini
                         settings.json merge dance   → ALL CUT
  ↳ approvals (ADR 0006) human per-tool y/n          → bypassed by auto-approve
  ↳ interactive mode     bidirectional stdin; already no-op on codex+gemini;
                         without ask_user collapses into "autonomous + live
                         render" = just autonomous   → CUT
  ↳ Conversation becomes READ-ONLY: events + awaitResult + cancel
  ↳ Plan.interactive + 02-interactive example        → DROPPED
```

Preserved seam (so we never code ourselves out): keep `ConversationEvent.UserQuestion`/`ApproveTool` and `canAskUser: boolean` reserved in the frozen model; `canAskUser` returns `false` everywhere; write a new-repo ADR documenting the cut and the one legit future use (planner asks clarifying questions _before_ the deterministic loop, answer baked into the persisted plan).
### Claude Agent SDK — deferred, seam reserved
Future drop-in `claude-sdk` backend behind the same `Conversation` contract for anyone wanting native `canUseTool`. Not the foundation (would orphan the other 4 backends). ADR 0006's stream-json read-path is what we port.
### Effect-ts — deferred, seam reserved
See Part II. `Result`/`FlowContext`/`Schema` seams drawn for a later slot-in.

* * *
## Part VI — Risks & open questions
| Risk | Mitigation |
|---|---|
| Tier-1 expected-value encoding is hand-work per case | Bounded; Step-0 spec defines the canonical JSON; write a Scala extractor if cases are many. |
| `tsc --noEmit` pre-flight latency on every flow run | Cache; offer `--no-typecheck` escape; it's the thesis, keep it default-on. |
| Backpressure semantics differ (JVM blocking queue vs async queue) | Tier-1 fixtures pin event *order*; add a slow-consumer test to pin backpressure. |
| StatusBar ANSI parity across terminals | ADR 0008 auto-detect (NO_COLOR/CI/no-TTY) ported; golden the plain-mode output. |
| bun `--compile` binary size / cold-start | Acceptable; measure in Slice 5; node+tsx remains a fallback runtime. |
| Drift in domain prompts (reviewer roster wording) | Prompts are copied `.md` files, not re-authored; diff against Scala originals. |
### Resolved (was: open questions)
1. **Repo** → new standalone repo in personal account: **`ASRagab/orca-ts`**. Scala `orca` cloned beside it locally as the diffing oracle.
2. **License** → keep **Apache 2.0** + `NOTICE` + upstream VirtusLab credit (derivative work).
3. **ADRs** → **do not copy** the Scala ADRs into `orca-ts/adr/`. The matrix below *references* them by number (the cloned Scala repo holds the text). Port-specific decisions (TS, ask_user cut, Effect deferred) live in this plan's TL;DR — **no new `adr/` tree** in orca-ts.

* * *
## Appendix — ADR → acceptance-criteria matrix
References the Scala repo's ADRs by number (not copied into orca-ts). "Disposition" = how each is realized, cut, or deferred in the port.
| ADR | Subject | Port disposition | Acceptance test |
|---|---|---|---|
| 0001 | Direct-style on Ox | Re-mechanized: async/await, no effect monad | Flow scripts compile + read top-to-bottom (no `.gen`/`yield*`) |
| 0002 | Context-function DSL | AsyncLocalStorage FlowContext | `flow(args,{overrides})` resolves accessors; override swaps runtime |
| 0003 | Pluggable LlmBackend[B] | Branded `BackendTag`; SPI kept | Cross-backend SessionId mismatch is a *compile* error |
| 0004 | Module layout | Mirror as TS packages/dirs | Dep direction enforced (lint/import boundaries) |
| 0005 | DSL reshape (`import orca.{*,given}`) | Single `import { ... } from "orca"` | One-import flow script compiles |
| 0006 | Claude stream-json | Read-path only (write-side cut) | Tier-1 claude fixtures: every InboundMessage → expected events |
| 0007 | Codex exec JSONL | Translation table | Tier-1 codex fixtures green |
| 0008 | Terminal event-log + status bar | Hand-rolled ANSI | StatusBarTest + no-`✔`-in-log + auto-detect golden |
| 0009 | Announce typeclass | Optional `announce?` callback | StructuredResult emits summary when provided, raw otherwise |
| 0010 | Prompts/helpers convention | `XxxPrompts` object + default param | Override-by-arg works; default prompt pinned in test |
| 0011 | Reviewer roster (8) | `.md` prompts copied verbatim | Selector picks subset; prompts byte-match Scala |
| 0012 | MCP ask_user bridge | **CUT** (seam reserved) | `canAskUser === false`; reserved variants exist, unimplemented |
| 0013 | Persistent plans | Ported faithfully | `.orca/plan-<hash>.md` format + recover/loop parity (tier-2) |
| 0014 | OpenCode server driver | Ported (Slice 2) | Tier-1 opencode fixtures + serve lifecycle teardown |
| 0015 | Gemini stream-json | Ported, minus settings.json ask_user merge | Tier-1 gemini fixtures green; no settings mutation |
