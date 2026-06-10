## 0. Reference: read the Scala oracle first

- [x] 0.1 Read `codex/src/main/scala/orca/tools/codex/` against `src/backends/codex-run.ts` to fix the "faithfully ported driver" template (what maps 1:1, what the port intentionally drops).
- [x] 0.2 Skim the in-scope Scala driver modules to harvest gotchas before coding: `claude/.../tools/claude/`, `opencode/.../tools/opencode/`, `pi/.../tools/pi/` at `/Users/ahmad.ragab/Dev/tools/orca`. Note Scala-only concerns NOT to port (`PiAskUserExtension`, `DefaultXxxTool`, MCP ask-user bridge) and any 0.0.11-version-specific behavior.

## 1. Shared subprocess-stream driver (refactor behind codex's green tests)

- [x] 1.1 Extract codex-run.ts's spawn → line-consumer → `StreamConversation` core into a reusable `runSubprocessConversation(command, args, parseLine, options)` helper (cwd, env, stderr capture, non-zero-exit failure, cancellation). Cross-check against `CodexBackend.scala`/`CodexConversation.scala`.
- [x] 1.2 Re-implement the codex driver on top of the shared helper; codex command/args builder + JSONL consumer plug in unchanged.
- [x] 1.3 Run the full codex test suite (`tests/codex-backend.test.ts`, `tests/jsonl-backends.test.ts`) and confirm all stream/result/structured-output/session/cancel tests pass unchanged.

## 2. Claude live driver

- [x] 2.1 Add `ClaudeBackendOptions` + a `claude()` accessor returning `LlmBackend<"claude">` (mirror `codex.ts`: `tag`, `autonomous()`, `canAskUser:false`).
- [x] 2.2 Port `ClaudeBackend`/`ClaudeArgs`/`ClaudeConversation`: build the claude stream-json command/args (model selection, structured-output schema) and wire the existing `claude-stream-json.ts` parser as the line consumer over the shared helper.
- [x] 2.3 Map structured output to the `schema` option; validate final output against the Zod schema and return a typed validation error with raw output on mismatch.
- [x] 2.4 Remove the `claude` stub from `src/backends/unsupported.ts` and export the real accessor from `src/backends/index.ts`.
- [x] 2.5 Add fake-process unit tests for claude: ordered events, branded result, structured output (valid + invalid), cancellation.

## 3. OpenCode live driver

- [x] 3.1 Port `OpencodeBackend`/`OpencodeServer`/`OpencodeConversation`/`OpencodeHttp`: add `OpenCodeBackendOptions` + an `opencode()` accessor returning `LlmBackend<"opencode">` built on `createOpenCodeServerManager` (lazy start, shared server, teardown on shutdown). The Scala serve+SSE lifecycle is the authoritative reference here.
- [x] 3.2 Drive a conversation through the managed server's HTTP/SSE path and feed the existing `opencode-sse.ts` parser; return an OpenCode-branded result.
- [x] 3.3 Implement structured output and `cancel()` (close SSE, complete cancelled, keep the shared server alive).
- [x] 3.4 Remove the `opencode` stub from `src/backends/unsupported.ts` and export the real accessor.
- [x] 3.5 Add fake-server-manager unit tests: branded result, server reuse across conversations + teardown on shutdown, structured result via SSE, cancellation.

## 4. Pi live driver

- [x] 4.1 Add `PiBackendOptions` + a `pi()` accessor returning `LlmBackend<"pi">` over the shared subprocess helper.
- [x] 4.2 Port `PiBackend`/`PiArgs`/`PiConversation`/`rpc`: build the `pi --mode rpc` command/args (model selection) and wire the existing `pi-rpc.ts` parser as the line consumer. Skip `PiAskUserExtension` (ask-user bridge is cut).
- [x] 4.3 Implement structured output where the RPC transport allows; otherwise validate final text against the schema.
- [x] 4.4 Remove the `pi` stub from `src/backends/unsupported.ts` and export the real accessor.
- [x] 4.5 Add fake-process unit tests for pi: ordered events, branded result, cancellation.

## 5. Integration smoke tests (gated)

- [x] 5.1 Add env-gated (`ORCA_INTEGRATION=1`) real-CLI smoke tests for claude, opencode, and pi that run a trivial autonomous prompt and assert a successful branded result; each skips if its CLI is absent.
- [x] 5.2 Document required CLIs and the integration flag in `docs/backends.md`.

## 6. Validation & wrap-up

- [x] 6.1 `bun run typecheck` and `bun run lint` clean.
- [x] 6.2 Full `bun test` green (unit + parity); confirm parity fixtures unchanged.
- [x] 6.3 Update the ADR matrix / `docs/backends.md` disposition for claude, opencode, pi from parse-only to live driver; note gemini still deferred.
- [x] 6.4 Per-backend parity pass: diff each finished TS driver's behavior against its Scala sibling (lifecycle, args, result branding, failure/cancel paths) and record any deliberate divergence.
- [x] 6.5 Run `openspec validate multi-backend-drivers` and confirm the change is implementation-complete against the spec delta.
