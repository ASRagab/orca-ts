## Context

`orca-ts` ports VirtusLab/orca's pluggable-backend SPI (ADR 0003: `LlmBackend<B extends BackendTag>` with phantom-branded `SessionId<B>`/`LlmResult<B>`). The port plan (`orca-ts-port-plan.md`) treats multi-backend as foundational and phases delivery as Claude → OpenCode → Codex+Gemini → Pi.

Current state, verified in `src/backends/`:
- **codex** — complete live driver. `codex-run.ts` spawns `codex exec --json`, streams stdout JSONL lines through `createCodexJsonlConsumer` into the `StreamConversation` convergence engine, supports model / approval policy / sandbox / read-only / structured-output schema file / cwd / cancellation, and returns a codex-branded result. This is the reference implementation.
- **claude / pi** — parser modules only (`claude-stream-json.ts`, `pi-rpc.ts`). No process spawn, no `LlmBackend` accessor.
- **opencode** — parser plus `createOpenCodeServerManager` (serve lifecycle), but no `LlmBackend` accessor.
- The public `claude()`, `opencode()`, `pi()`, `gemini()` exports return `unsupportedBackend()` (`src/backends/unsupported.ts`).

So the convergence engine and per-transport parsers already pass Tier-1 parity; the missing layer is the **autonomous driver** that launches the real agent process/server and wires its output stream into a conversation.

## Goals / Non-Goals

**Goals:**
- Live autonomous `LlmBackend` drivers for `claude`, `opencode`, and `pi`, behind the existing SPI, returning correctly branded `LlmResult`s.
- Each driver supports model selection, structured output (where the transport allows), and cancellation, matching the codex driver's surface.
- Extract the spawn → parser → `StreamConversation` plumbing shared by codex/claude/pi into one reusable subprocess-stream driver instead of duplicating codex-run.ts three times.
- Unit tests per backend over a fake process/server; gated real-CLI integration smoke tests.

**Non-Goals:**
- `gemini` driver — not in the user's named set; stays a stub this change (JSONL sibling of codex, deferred).
- MCP `ask_user` / live human-approval bridges. ADR 0012's ask-user bridge was deliberately **cut** in the port (port plan Part V); drivers stay autonomous-only (`canAskUser=false`), consistent with the spec's "Human interaction seams are reserved but unimplemented."
- Changing the conversation contract, event model, or `StreamConversation` engine.

## Decisions

**1. Two driver shapes, not three.** `claude` and `pi` are subprocess-stream backends like `codex` (spawn a CLI, read a line/event stream off stdout). Generalize codex-run.ts's spawn→consumer→`StreamConversation` core into a shared `runSubprocessConversation(spawn, parseLine, options)` helper; codex, claude, pi each supply their command/args builder + line consumer. `opencode` is the odd one out (long-lived HTTP server + SSE), so it keeps its own driver on top of `createOpenCodeServerManager`. Alternative considered: one mega-driver with a transport switch — rejected, the SSE/serve lifecycle doesn't fit the spawn-per-call model.

**2. Reuse the existing parsers as-is.** The Tier-1-parity parsers (`claude-stream-json`, `opencode-sse`, `pi-rpc`) are the consumer half; the driver only adds process/server management + result branding. Keeps parity fixtures authoritative and avoids re-deriving event mapping.

**3. Replace stubs at the accessor boundary.** Each `XxxBackendOptions` + `xxx()` accessor mirrors `codex.ts` (`tag`, `autonomous()`, `canAskUser`). Drop `claude`/`opencode`/`pi` from `unsupported.ts` and export the real accessors from `src/backends/index.ts`. Branded `SessionId<B>`/`LlmResult<B>` already exist in `types.ts`.

**4. Structured output per transport.** codex writes a JSON-schema file and passes `--output-schema`. claude/opencode/pi map their native structured-output mechanism to the same `schema` option; where a transport can't enforce a schema, validate the final text against the Zod schema and surface a typed validation error (same failure shape codex returns on invalid JSON).

**5. Integration tests gated by env, unit tests by fake process.** Mirror `codex-backend.test.ts`: drive each backend with a scripted fake process/server (no network) for ordering/result/cancel/structured-output, and put real-CLI smoke tests behind an env flag (`claude`, `opencode`, `pi` must be installed), matching the Scala `ORCA_INTEGRATION` convention.

**6. The Scala orca repo is the reference implementation and gotcha source.** This is a port, not a green-field design — the anti-drift principle is to port each driver faithfully from its already-written Scala sibling at `/Users/ahmad.ragab/Dev/tools/orca`, not to re-derive it. Before writing each TS driver, read the corresponding Scala module and treat it as the authoritative spec for process/server lifecycle, arg construction, event→result mapping, and edge cases:
- claude → `claude/src/main/scala/orca/tools/claude/` (`ClaudeBackend`, `ClaudeArgs`, `ClaudeConversation`, `streamjson/`)
- opencode → `opencode/src/main/scala/orca/tools/opencode/` (`OpencodeBackend`, `OpencodeServer`, `OpencodeConversation`, `OpencodeHttp`/`JavaNetOpencodeHttp`, `OpencodeApi`, `OpencodeArgs`, `OpencodeEvent`, `OpencodeModel`) — the full serve+SSE lifecycle we must mirror
- pi → `pi/src/main/scala/orca/tools/pi/` (`PiBackend`, `PiArgs`, `PiConversation`, `rpc/`)
- reference (already ported): `codex/src/main/scala/orca/tools/codex/` ↔ `src/backends/codex-run.ts` — the diff between these two is the template for what "faithfully ported" looks like.

Scala-only concerns that are intentionally **not** ported: `PiAskUserExtension`, `DefaultXxxTool`, and the MCP ask-user bridge (cut per Decision/Non-Goals). Note the local Scala orca is version 0.0.11; flag any behavior that looks version-specific rather than assuming the TS port must match it.

## Risks / Trade-offs

- **OpenCode serve lifecycle** (lazy start, reuse across conversations, teardown on exit, port allocation) → cover with a fake server-manager unit test plus a gated real-CLI smoke test; reuse the existing `createOpenCodeServerManager` rather than reimplementing.
- **Pi rpc handshake** is the least-exercised transport → start with the parser's fixture as the contract; gate the real driver behind integration tests; ship pi last.
- **CLI flag/version drift** (claude stream-json flags, opencode serve API, pi rpc mode) → drivers assert on a minimum CLI presence and fail with an explicit, actionable error rather than hanging.
- **Cancellation semantics differ** (kill subprocess vs close SSE + stop server) → each driver implements `cancel()` against its own transport; assert cancelled-outcome in unit tests per backend.
- **Refactor regresssion in codex** when extracting the shared subprocess driver → codex's existing test suite is the regression gate; extract behind green tests before adding claude/pi.

## Migration Plan

Additive — no breaking changes to flow scripts. Order: (1) extract shared subprocess driver behind codex's green tests; (2) claude driver; (3) opencode driver; (4) pi driver. Each backend is independently shippable and parity-gated. Rollback = revert the per-backend accessor to `unsupportedBackend()`.

## Open Questions

- Does any in-scope backend need interactive (`canAskUser=true`) this round, or is autonomous-only acceptable for all three? (Plan implies opencode could support CanAskUser later; ask-user bridge is currently cut.)
- Should `gemini` be folded in opportunistically since it's a JSONL sibling of the codex driver, or held strictly out of scope?
