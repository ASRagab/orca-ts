## 1. New shared module

- [x] 1.1 Create `src/backends/conversation-config.ts`: export `SharedBackendConfig<Output>` interface (7 fields: model, systemPrompt, readOnly, selfManagedGit, retryAttempts, schema, resumeSessionId)
- [x] 1.2 Export `composeBackendPrompt(prompt: string, config: SharedBackendConfig<unknown>): string` — extracted from the three identical private `composePrompt` functions
- [x] 1.3 Export `conversation-config.ts` from `src/backends/index.ts`

## 2. SubprocessConsumer signal migration

- [x] 2.1 In `subprocess-run.ts`: replace `completed?: boolean` with `signal: AbortSignal` on `SubprocessConsumer`
- [x] 2.2 In `subprocess-run.ts` read loop: replace `consumer.completed` checks with `consumer.signal.aborted`
- [x] 2.3 In `codex-jsonl.ts`: add `AbortController`; abort it where `this.completed = true` was set; expose `get signal()` returning `controller.signal`; remove `completed` getter
- [x] 2.4 In `claude-stream-json.ts`: same `AbortController` pattern — abort where conversation settles; expose `signal`; remove `completed`
- [x] 2.5 In `pi-rpc.ts`: same pattern
- [x] 2.6 In `gemini-jsonl.ts`: same pattern (if it implements `SubprocessConsumer`)
- [x] 2.7 Update any `SubprocessConsumer` fakes in `src/test-utils/` or inline test stubs

## 3. Backend adapter cleanup

- [x] 3.1 In `claude-run.ts`: replace private `composePrompt` call with `composeBackendPrompt`; remove the private function; remove `setValue` helper (inline the `?? ` chains or keep if used more than once)
- [x] 3.2 In `pi-run.ts`: same — replace `composePrompt` with `composeBackendPrompt`; remove private function; remove `setConfigValue`
- [x] 3.3 In `codex-run.ts`: same — replace `composePrompt` with `composeBackendPrompt`; remove private function; remove `setConfigValue`
- [x] 3.4 Confirm each `ResolvedXxxConfig` is structurally assignable to `SharedBackendConfig` (TypeScript will catch drift at compile time)

## 4. Tests

- [x] 4.1 Add unit tests for `composeBackendPrompt` in `tests/backends.test.ts` or a new `tests/conversation-config.test.ts`: all-sections-present, no-sections, selfManagedGit-true, pure-function cases
- [x] 4.2 Verify existing backend tests still pass (no behavioral change expected)

## 5. Verify

- [x] 5.1 `bun run typecheck` — clean
- [x] 5.2 `bun test` — all pass
