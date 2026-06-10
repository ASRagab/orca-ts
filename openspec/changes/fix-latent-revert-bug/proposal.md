## Why

When `askAgentForCleanup` throws after codex has already edited a target file, `cleanupFile()` returns `skipped` without restoring the file. The end-of-group dirty-path commit then picks up the uncommitted edit and commits it anyway — producing commits attributed to a "failed" run. Discovered via commit `22e7867` which was produced this way.

## What Changes

- `cleanupFile()` catch block calls `restoreAttempt(attemptPaths)` before returning `skipped(...)` — ensures a thrown `askAgentForCleanup` leaves no dirty files
- New workflow unit test mocks `askAgentForCleanup` to throw after a fake file edit and asserts: file is restored to original, no dirty-path commit is made

## Capabilities

### New Capabilities

- `cleanup-revert-on-failure`: `cleanupFile()` guarantees atomic cleanup — either the file is committed as changed, or it is fully restored to its pre-attempt state

### Modified Capabilities

- `flow-runtime`: `cleanupFile()` error path contract changes — catch block now performs restore before returning skipped

## Impact

- `workflows/ai-slop-cleanup.ts` (gitignored) — `cleanupFile()` catch at ~L568
- New test in `workflows/ai-slop-cleanup.test.ts` (gitignored) — mock throw after fake edit
- No public API changes; no tracked source files change
