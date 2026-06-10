## Why

`ResolvedClaudeConfig`, `ResolvedCodexConfig`, and `ResolvedPiConfig` each declare the same seven fields, and `composePrompt` is byte-identical across all three backend adapter files. A prompt composition policy change or a new shared config field requires editing three files. The Scala oracle solved this with `LlmConfig` + `SystemPromptComposer`; the TypeScript port didn't carry the pattern over.

Secondary: `SubprocessConsumer.completed` is a poll flag on a different pattern from the `conversation.signal.aborted` check immediately above it in the same loop. Alignment is cosmetic but improves interface consistency.

## What Changes

- New `src/backends/conversation-config.ts` — exports `SharedBackendConfig<Output>` (the seven common fields) and `composeBackendPrompt(prompt, config)` (the shared prompt assembly function)
- `codex-run.ts`, `claude-run.ts`, `pi-run.ts` — `ResolvedXxxConfig` extends or delegates to `SharedBackendConfig`; local `composePrompt` calls replaced with `composeBackendPrompt`; local `setValue`/`setConfigValue` helpers removed or consolidated
- `SubprocessConsumer.completed?: boolean` → `signal: AbortSignal` — consumer owns its completion signal; loop checks `consumer.signal.aborted` instead of `consumer.completed`

No behavioral changes. No public API changes. The `BackendConfig` per-field merge semantics (request → options → backend-level) are preserved as-is; no Scala-style identity-based whole-replace sentinel is introduced.

## Capabilities

### New Capabilities

- `shared-backend-config`: `SharedBackendConfig<Output>` and `composeBackendPrompt` are testable as pure functions without spawning a subprocess

### Modified Capabilities

- `conversation-backends`: `SubprocessConsumer` interface changes (`completed` → `signal`); `ResolvedXxxConfig` types now share a common base

## Impact

- `src/backends/conversation-config.ts` — new file (~50 lines)
- `src/backends/subprocess-run.ts` — `SubprocessConsumer` interface + loop body
- `src/backends/codex-run.ts`, `claude-run.ts`, `pi-run.ts` — `ResolvedXxxConfig`, `composePrompt`, setter helpers
- `tests/` — no existing tests broken; new unit tests for `composeBackendPrompt` and `resolveSharedConfig`
- `src/backends/codex-jsonl.ts`, `opencode-run.ts`, `opencode-sse.ts`, `pi-rpc.ts` — `SubprocessConsumer` implementors updated to expose `signal` instead of `completed`
