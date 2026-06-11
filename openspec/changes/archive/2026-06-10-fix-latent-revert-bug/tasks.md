## 1. Fix the revert bug

- [x] 1.1 Locate `cleanupFile()` catch block in `workflows/ai-slop-cleanup.ts` (~L568)
- [x] 1.2 Add `restoreAttempt(attemptPaths)` call immediately before `return skipped(...)` in the catch block
- [x] 1.3 Verify `restoreAttempt` import is present (it is used in the success path already)

## 2. Add regression test

- [x] 2.1 In `tests/ai-slop-cleanup-revert.test.ts`, add test: mock `askAgentForCleanup` to write a sentinel string to a temp file then throw
- [x] 2.2 Assert file content equals original after `cleanupFile()` returns
- [x] 2.3 Assert `git status --short` shows no dirty entry for the target path
- [x] 2.4 Assert return value is a skipped result (not a throw)

## 3. Verify

- [x] 3.1 Run `bun run typecheck` — must pass
- [x] 3.2 Run `bun test` — all tests pass including new regression test
- [x] 3.3 Manually confirm `git log` shows no unexpected commits from prior failed runs (audit for latent-bug artifacts)
