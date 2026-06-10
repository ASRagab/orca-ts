## Context

Three subprocess backend adapters (claude, codex, pi) independently declare identical config fields and an identical prompt-composition function. The Scala oracle solved this with `LlmConfig` + `SystemPromptComposer`; the TypeScript port tripled instead. The TypeScript per-field merge semantics (request → options → backend-level defaults) are intentionally simpler than Scala's whole-replace model and must be preserved.

`SubprocessConsumer.completed` is a poll flag checked in the subprocess read loop. The loop already checks `conversation.signal.aborted` using the platform `AbortSignal` pattern; `completed` uses a different idiom for the same purpose.

## Goals / Non-Goals

**Goals:**
- Single source of truth for the seven shared config fields and prompt assembly
- `composeBackendPrompt` is a testable pure function
- `SubprocessConsumer` uses `AbortSignal` consistently with `conversation.signal`
- Zero behavioral change; no public API surface change

**Non-Goals:**
- Scala-style whole-replace config semantics (intentional simplification kept)
- `SystemPromptComposer.combine()` / `foldIntoPrompt()` split (not needed; TS Claude uses stdin/stream-json mode, no `--append-system-prompt-file`)
- Pre-loading or caching reviewer prompts
- Shared config for opencode (serve+SSE model; different shape)

## Decisions

**`SharedBackendConfig<Output>` as a plain interface, not a base class.** Each `ResolvedXxxConfig` continues to extend it structurally. No inheritance hierarchy. TypeScript structural typing makes this painless.

**`composeBackendPrompt` is a standalone exported function**, not a method on a class. It's a pure data transform: `(prompt: string, config: SharedBackendConfig<unknown>) => string`. Same signature as the current three `composePrompt` private functions — just lifted to a named, exported, testable form.

**`SubprocessConsumer.signal: AbortSignal` replaces `completed?: boolean`.** Each consumer creates its own `AbortController` and exposes `controller.signal`. The loop checks `consumer.signal.aborted` after each `consume()` call — identical semantics, consistent idiom. The `AbortController` lives inside the consumer implementation; callers only see the signal.

**`setConfigValue` / `setValue` helpers disappear entirely.** The shared resolution pattern is expressed as explicit `?? ` chains in each backend's `resolveXxxConfig`. This is marginally more verbose but avoids a helper whose only benefit was saving one `undefined` check per field.

## Risks / Trade-offs

- All four `SubprocessConsumer` implementors (codex-jsonl, claude-stream-json, pi-rpc, and any test fakes) need updating — mechanical change, but touching many files
- If a future backend has a `composePrompt` variant (e.g. different git-policy wording), it will either subclass the shared function or diverge; acceptable, since divergence is the signal that backends genuinely differ

## Open Questions

- None. The extraction is mechanical; the design decisions are settled by the "intentional simplification" context.
