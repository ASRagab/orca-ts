## Context

`cleanupFile()` in `workflows/ai-slop-cleanup.ts` (gitignored) follows this sequence:
1. `markAttempt(file)` — records pre-attempt state in `attemptPaths`
2. `askAgentForCleanup(...)` — spawns codex, which may edit the file
3. On success: validate, commit or revert based on outcome
4. On throw (catch block): return `skipped(...)` — **without calling `restoreAttempt`**

The end-of-group commit path checks `git status --short` and commits any dirty file it finds. So when codex edits a file and then `askAgentForCleanup` throws, the edit lands in the next group commit even though the cleanup was marked skipped.

This is contained entirely within the gitignored workflow and its test — no public API is affected.

## Goals / Non-Goals

**Goals:**
- `cleanupFile()` catch block restores any in-progress file edits before returning
- A unit test encodes the invariant so regression is impossible
- "Skipped" genuinely means "file is unchanged"

**Non-Goals:**
- Not changing the happy path (success + validation logic)
- Not changing tracked source files or public API
- Not addressing the opencode session.idle hang (separate issue)

## Decisions

**Restore before return in catch**: Call `restoreAttempt(attemptPaths)` in the catch block immediately before `return skipped(...)`. `restoreAttempt` already exists and handles the `git restore` mechanics — no new abstraction needed. No try/catch wrapping the restore itself (if restore throws, we want the error to surface, not be swallowed).

**Test via mock**: The workflow is gitignored, so a workflow-level unit test is the only way to encode this. Mock `askAgentForCleanup` to throw after writing a sentinel string to the target file. Assert: file content equals original after `cleanupFile()` returns. Assert: `git status` shows no dirty files for that path.

**No log change for the revert path**: The existing skip reason logged by the caller is sufficient. Adding a separate "reverted due to error" log would be nice but is out of scope — this PR is correctness only.

## Risks / Trade-offs

- `restoreAttempt` failure in the catch path surfaces as an unhandled error — acceptable; a failed restore is a worse state than a clean throw
- Test runs `git restore` on a real file in a temp dir — integration-flavored test, slightly slower than pure-unit but necessary for confidence

## Open Questions

- None. The fix and test are fully specified.
