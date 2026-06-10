## Why

The port plan makes multi-backend support foundational (`orca-ts-port-plan.md` decision 2; phased slices Claude → OpenCode → Codex+Gemini → Pi), and the `conversation-backends` spec already declares Claude, OpenCode, and Pi "supported." In reality only `codex` is a live autonomous driver: `claude()`, `opencode()`, `pi()`, and `gemini()` return `unsupportedBackend()` stubs. The stream parsers and the `StreamConversation` convergence engine exist and pass Tier-1 parity, but nothing spawns or serves the real agent processes — so a flow author cannot actually run any backend except codex. This closes that gap for the three backends the user named (claude, opencode, pi); codex is already done.

## What Changes

- Wire a live `LlmBackend<"claude">` accessor that spawns `claude` in stream-json mode, feeds its read-path parser into `StreamConversation`, and returns a Claude-branded `LlmResult`.
- Wire a live `LlmBackend<"opencode">` accessor on top of the existing `createOpenCodeServerManager` (serve lifecycle + SSE parser), returning an OpenCode-branded result; reuse one server across conversations and tear it down on exit.
- Wire a live `LlmBackend<"pi">` accessor that drives `pi --mode rpc`, feeds the rpc parser into `StreamConversation`, and returns a Pi-branded result.
- Each driver supports model selection, structured output (JSON schema), and cancellation, matching the codex driver's option surface where the transport allows.
- Replace the corresponding `unsupportedBackend()` stubs in `src/backends/unsupported.ts` / the accessor exports with the real implementations.
- `gemini` stays a stub this change (not in the user's named set) — deferred, noted in design.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `conversation-backends`: today the Claude / OpenCode / Pi requirements assert stream-parsing parity only ("backend is supported" = stream→event mapping of a supplied stream). This change strengthens them to require live autonomous execution — the public accessor drives the real process and returns a branded result — rather than throwing unsupported.

## Impact

- Code: `src/backends/claude-stream-json.ts`, `opencode-sse.ts`, `pi-rpc.ts` (add driver layer), `src/backends/unsupported.ts` (drop claude/opencode/pi stubs), `src/backends/index.ts` / `src/index.ts` (export real accessors), `src/backends/types.ts` (shared driver options if extracted from codex).
- Tests: new autonomous-execution tests per backend using a fake process/server (mirroring `codex-backend.test.ts`); gated integration tests behind an env flag for the real CLIs (`claude`, `opencode`, `pi`).
- Dependencies: relies on `claude`, `opencode`, and `pi` CLIs being installed at run time (integration-gated, like the Scala `ORCA_INTEGRATION` suites). No new package dependencies expected.
- Risk: per-backend process/server lifecycle (esp. OpenCode serve teardown) and cancellation semantics; covered by fake-process unit tests plus gated real-CLI smoke tests.
