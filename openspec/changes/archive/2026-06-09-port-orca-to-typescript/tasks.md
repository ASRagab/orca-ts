## 1. Repository and Tooling Setup

- [x] 1.1 Initialize the standalone TypeScript package structure with Bun, TypeScript, test runner, lint/import-boundary configuration, and source/test directories.
- [x] 1.2 Add runtime dependencies for Zod and neverthrow plus development dependencies for typecheck, tests, build, and fixture validation.
- [x] 1.3 Add Apache 2.0 license text, `NOTICE`, VirtusLab attribution, package metadata, and release metadata checks.
- [x] 1.4 Create public package entry points for flow helpers, backend constructors, schemas, event types, tools, and test utilities.
- [x] 1.5 Create fixture directories for canonical models, Tier 1 backend streams, Tier 2 flow e2e runs, prompt parity, and ADR disposition checks.
- [x] 1.6 Add baseline commands for `bun test`, `tsc --noEmit`, fixture validation, and release build validation.

## 2. Frozen Model and Parity Harness

- [x] 2.1 Define canonical Zod schemas and TypeScript types for `ConversationEvent`, `OrcaEvent`, `LlmResult`, `Usage`, `BackendTag`, reserved user-interaction events, and tagged runtime errors.
- [x] 2.2 Export JSON Schema for every canonical model and add tests that fail on schema drift without fixture updates.
- [x] 2.3 Implement fixture loaders and exact JSON comparison helpers for Tier 1 stream-to-event tests.
- [x] 2.4 Implement fake subprocess, fake HTTP/SSE, fake RPC, and fake agent utilities for deterministic backend and flow tests.
- [x] 2.5 Add Tier 2 golden helpers that assert commits, `.orca/plan-<hash>.md` content, terminal output, and runtime events.
- [x] 2.6 Add the ADR disposition matrix and tests that require every referenced ADR to be ported, cut, or deferred with an acceptance marker.

## 3. Core Flow Runtime

- [x] 3.1 Implement `flow(args, overrides?)(asyncFn)` with `AsyncLocalStorage`-backed `FlowContext` and named runtime service overrides.
- [x] 3.2 Implement public accessors for filesystem, git, GitHub, terminal, LLM tools, plan helpers, and review helpers.
- [x] 3.3 Implement branded backend session identifiers and compile-time tests for matching and mismatched backend usage.
- [x] 3.4 Implement `Promise<Result<T, E>>` tool return conventions, tagged error unions, and an `orThrow` helper.
- [x] 3.5 Implement Zod-backed structured result helpers with validation errors that preserve raw backend output.
- [x] 3.6 Implement the runner pre-flight that executes `tsc --noEmit` by default and exits before backend startup on compiler failure.
- [x] 3.7 Add unit tests for ambient context resolution, override behavior, structured output validation, typed failures, and pre-flight behavior.

## 4. Shared Conversation Engine

- [x] 4.1 Implement the read-only `Conversation` interface with async event iteration, `awaitResult()`, `cancel()`, and `canAskUser`.
- [x] 4.2 Implement the bounded async queue, success/cancelled/failed `Outcome` handling, producer backpressure, and single-consumer iteration.
- [x] 4.3 Wire `AbortController` cancellation into subprocess and transport lifecycle helpers.
- [x] 4.4 Add ordered-event, slow-consumer, early-failure, and cancellation tests for the shared conversation engine.
- [x] 4.5 Add unsupported-feature handling for reserved `UserQuestion` and `ApproveTool` events.

## 5. Slice 1: Claude, Plans, Review, Tools, and Terminal

- [x] 5.1 Port Claude stream-json read-path parsing into the shared conversation engine.
- [x] 5.2 Create Claude Tier 1 fixtures from the Scala oracle and add exact event/result parity tests.
- [x] 5.3 Implement filesystem, git, and GitHub runtime tools with quiet process handling and typed recoverable errors.
- [x] 5.4 Implement terminal event-log rendering and deterministic status bar/plain-mode fallback behavior.
- [x] 5.5 Implement persistent plan path generation, plan file writing, plan recovery, and implement-task loop behavior.
- [x] 5.6 Port review-and-fix loop orchestration, reviewer selection, and reviewer result handling.
- [x] 5.7 Copy the eight reviewer prompt files verbatim from Scala and add byte-parity tests.
- [x] 5.8 Add Tier 2 golden flows for simple autonomous execution, plan persistence/recovery, runtime-owned commits, review/fix loop, and terminal output.
- [x] 5.9 Add explicit unsupported behavior tests for `Plan.interactive`, ask-user, and human approval requests.

## 6. Slice 2: OpenCode Backend

- [x] 6.1 Implement lazy OpenCode server startup, reuse, health detection, and shutdown on runtime teardown.
- [x] 6.2 Implement HTTP/SSE event consumption and OpenCode message translation into normalized conversation events.
- [x] 6.3 Implement OpenCode structured output handling through schema-format result events.
- [x] 6.4 Create OpenCode Tier 1 fixtures from the Scala oracle and add exact event/result parity tests.
- [x] 6.5 Add lifecycle tests covering server reuse, failed startup, cancellation, and SIGINT teardown.

## 7. Slice 3: Codex and Gemini Backends

- [x] 7.1 Implement Codex exec JSONL process startup, flag mapping, event translation, usage extraction, and synthesized result completion.
- [x] 7.2 Create Codex Tier 1 fixtures from the Scala oracle and add exact event/result parity tests.
- [x] 7.3 Implement Gemini stream-json JSONL startup, model/approval flag mapping, event translation, usage extraction, and result completion.
- [x] 7.4 Ensure Gemini backend does not mutate settings for ask-user wiring.
- [x] 7.5 Create Gemini Tier 1 fixtures from the Scala oracle and add exact event/result parity tests.
- [x] 7.6 Add backend tests for unsupported reserved user-interaction messages in Codex and Gemini.

## 8. Slice 4: Pi Backend

- [x] 8.1 Implement Pi `--mode rpc` process startup, request/response handling, event translation, and result completion.
- [x] 8.2 Create Pi Tier 1 fixtures from the Scala oracle and add exact event/result parity tests.
- [x] 8.3 Add Pi cancellation, failure, and branded-session tests.
- [x] 8.4 Add a Tier 2 fake-agent flow that proves Pi works through the same flow runtime and conversation contract.

## 9. Slice 5: Distribution, Documentation, and Integration

- [x] 9.1 Implement the CLI entry point, argument parsing, backend selection, typecheck pre-flight options, and run metadata for skipped typecheck.
- [x] 9.2 Configure `bun build --compile` for target standalone binaries and add a build smoke test that invokes the compiled binary.
- [x] 9.3 Configure npm package exports, declarations, `bin`, and `bunx` execution path.
- [x] 9.4 Port supported non-interactive examples and intentionally omit the dropped interactive example.
- [x] 9.5 Write README and contributor docs covering runtime setup, backend setup, plans, review automation, parity tests, v1 scope cuts, and release commands.
- [x] 9.6 Add a gated real-repo integration smoke that runs one autonomous flow against a real backend when credentials are available.
- [x] 9.7 Measure Bun binary size and cold start, record fallback runtime guidance, and update docs if thresholds are unacceptable.
- [x] 9.8 Run full verification: typecheck, unit tests, Tier 1 fixtures, Tier 2 golden flows, prompt parity, ADR matrix, build smoke, and docs/example checks.
