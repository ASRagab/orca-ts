## Context

The Scala `orca` codebase is the behavioral oracle for this port: roughly 25k LOC across the runtime, backend adapters, flow helpers, tooling, examples, ADRs, and tests. The TypeScript repo is standalone. The Scala repo will be cloned beside it for local comparison while fixtures are created, but Scala will not run in CI.

The port must preserve Orca's core thesis: a flow script reads like a direct script, but author-time type feedback catches mistakes before an agent run spends tokens. The runtime still owns git operations so reviewers inspect a real diff. Multi-backend support is foundational, so no single vendor SDK can become the core abstraction.

The biggest intentional scope cut is human-in-the-loop interaction. `ask_user`, tool approvals, and `Plan.interactive` are removed from v1 because live answers undermine deterministic replay and persistent plan recovery. The event model reserves those variants, but every v1 backend reports that it cannot ask the user.

## Goals / Non-Goals

**Goals:**

- Preserve direct-style flow authoring in TypeScript with a single import surface and mandatory `tsc --noEmit` pre-flight.
- Keep a backend-neutral `Conversation` SPI covering Claude, OpenCode, Codex, Gemini, and Pi.
- Freeze a language-neutral JSON event/result contract before backend implementation.
- Use Scala as a local author-time oracle per slice, then retire the oracle once TypeScript fixtures are frozen.
- Gate each vertical slice with stream-to-event parity fixtures and native TypeScript flow-behavior golden tests.
- Ship both a Bun-compiled standalone binary and an npm authoring package.
- Keep the runtime dependency footprint small: `zod`, `neverthrow`, branded types, and Node/Bun built-ins.

**Non-Goals:**

- No Scala-compatible binary, Scala source compatibility, or monorepo migration.
- No v1 implementation of `ask_user`, human approvals, or interactive flows.
- No Claude Agent SDK foundation in v1; it remains a future backend behind the same SPI.
- No Effect-based internal runtime in v1; the seams must allow later migration without changing flow scripts.
- No copy of the Scala ADR tree into this repo; the port references those ADR numbers and creates only port-specific docs.
- No performance rewrite. Agent latency dominates runtime overhead.

## Decisions

### Vertical slices replace module-by-module translation

Implementation proceeds through five parity-gated slices: Claude autonomous plus plans/review, OpenCode, Codex plus Gemini, Pi, then hardening/distribution. Each slice runs from DSL to backend to conversation to structured result to terminal/tools/domain helper.

Alternatives considered:

- Module-by-module translation was rejected because it creates long-lived untested surface area and invites drift before any user-visible flow works.
- A monorepo with Scala was rejected because the target distribution and contributor model are standalone TypeScript.

### Flow runtime uses direct async TypeScript

`flow(args, overrides?)(async () => ...)` stores a `FlowContext` in `AsyncLocalStorage`. Tool accessors read the ambient context, while named overrides allow test/runtime substitution. Recoverable tool boundaries return `Promise<Result<T, E>>`; flow authors await the Promise and then branch or call a small `orThrow` helper. Structured output uses Zod schemas, exported JSON Schema, and inferred static types. Backend session identifiers use branded string types.

Alternatives considered:

- Effect was rejected for v1 because it reintroduces generator/effect ceremony into flow scripts and narrows the contributor pool. The `Result`, `FlowContext`, and schema seams remain compatible with a future Effect migration.
- Throwing for all tool failures was rejected because known recoverable seams such as nothing-to-commit, branch-exists, and push-rejected need typed handling.
- `ResultAsync` was rejected because it makes common flow code noisier than a plain `Promise<Result<T, E>>`.

### Conversation is read-only and backend-neutral

The shared contract exposes an async event stream, `awaitResult()`, and `cancel()`. A bounded async queue replaces the JVM blocking queue. An `Outcome` union captures success, cancellation, and failure. `AbortController` handles cancellation. Reserved `UserQuestion` and `ApproveTool` events exist in the frozen model, but v1 leaves them unimplemented and sets `canAskUser` to `false`.

Alternatives considered:

- Keeping the MCP `ask_user` bridge was rejected because it is the highest-complexity component and conflicts with deterministic plan recovery.
- Building separate backend-specific conversation APIs was rejected because parity depends on one converged event model.

### Backends map transports into one event model

Claude stream-json is the first backend because it exercises the spine and plan/review flow. OpenCode follows to prove HTTP/SSE transport support. Codex and Gemini share JSONL-style mapping work. Pi stays in scope as the final backend. Each adapter owns only transport lifecycle and event translation; `StreamConversation` owns buffering, ordering, cancellation, and result completion.

Alternatives considered:

- Starting with all adapters at once was rejected because fixtures and failure modes are easier to stabilize one transport family at a time.
- Building on Claude Agent SDK first was rejected because it would orphan the other backends and make the SPI a wrapper around one provider.

### Parity harness is the drift-control spine

Before backend code, the port freezes canonical JSON for `ConversationEvent`, `OrcaEvent`, `LlmResult`, `Usage`, and `BackendTag`. Tier 1 fixtures feed scripted backend streams to fake processes and assert expected events/results. Tier 2 fixtures run native TypeScript e2e flows against fake agents and assert commits, `.orca/plan-<hash>.md`, and event logs. CI runs TypeScript tests only.

Alternatives considered:

- Running Scala in CI was rejected because it couples the new repo to the old toolchain and slows distribution work.
- Snapshotting raw CLI output only was rejected because it misses semantic event/result drift.

### Plans, review, terminal, and tools port as user-visible contracts

Persistent plan file names and content are parity-gated because recovery is a core behavior. The review/fix loop ports the reviewer selector and eight reviewer prompt files verbatim. Runtime-owned git/GitHub/filesystem operations use child processes and structured results, with quiet process handling that captures stderr without polluting terminal output. Terminal output ports event log and status bar behavior with deterministic ANSI and plain-mode fallbacks.

Alternatives considered:

- Re-authoring reviewer prompts was rejected because prompt text is part of the behavioral contract.
- Pulling a TUI library was rejected because the Scala status bar behavior is small and deterministic.

### Distribution uses Bun compile plus npm authoring support

The CLI builds with `bun build --compile` so non-TypeScript shops can run Orca without installing Node or the JVM. The npm package provides editor types, imports, and `bunx` convenience. The runner performs `tsc --noEmit` before executing a flow by default, with an explicit escape hatch for local iteration.

Alternatives considered:

- A Node-only runtime was rejected because standalone distribution is one of the port's main advantages.
- Skipping typecheck was rejected because Bun/tsx can strip types without enforcing the author-time feedback that Orca promises.

## Risks / Trade-offs

- Tier 1 expected fixture encoding takes manual work -> define canonical JSON first and write a Scala extractor if the case count grows.
- `tsc --noEmit` adds flow-start latency -> cache results and provide an explicit `--no-typecheck` escape while keeping typecheck default-on.
- Async queue backpressure can differ from the JVM blocking queue -> add slow-consumer and ordering fixtures around the shared `StreamConversation`.
- ANSI status behavior can vary across terminals -> port `NO_COLOR`, CI, and TTY detection and golden plain-mode output.
- Bun binary size and cold start are unknown until late -> measure in Slice 5 and keep Node/Bun script execution as a fallback runtime.
- Prompt drift is easy to miss -> copy prompt files verbatim and test byte equality against the Scala originals during fixture generation.
- Derivative licensing must stay visible -> keep Apache 2.0, `NOTICE`, and VirtusLab attribution in repository setup tasks.

## Migration Plan

1. Freeze the JSON event/result model and create fixture directories.
2. Implement Slice 1: Claude autonomous, flow runtime, structured output, stream convergence, tools, terminal output, persistent plans, review loop, and reviewer prompts.
3. Implement Slice 2: OpenCode HTTP/SSE backend and lifecycle management.
4. Implement Slice 3: Codex and Gemini JSONL backends, model/approval flag mapping, and no settings mutation for ask-user wiring.
5. Implement Slice 4: Pi RPC backend.
6. Implement Slice 5: Bun binary, npm package, docs, examples, integration smoke, and release metadata.

Rollback is repository-local because this is a new runtime. A bad release can be unpublished if policy allows, deprecated, or replaced by a reverted tag without affecting Scala Orca users.

## Open Questions

- Whether Tier 1 expected values are generated by a Scala extractor or hand-ported per case depends on the final fixture count.
- Bun binary size, cold start, and cross-platform packaging are measured in Slice 5.
