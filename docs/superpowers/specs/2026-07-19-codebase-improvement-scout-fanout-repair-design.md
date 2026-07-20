# Codebase Improvement Scout Fan-out Repair Design

## Context

The final authorized simple proving run reached the scout and stopped before any
repository or GitHub mutation. Run `20260720051952-58632` gave two fresh Codex
scout conversations 40,000 ms and 34,996 ms. Both emitted reasoning events but
neither emitted an assistant result before cancellation. Run
`20260717000416-46151` showed the same two-timeout pattern.

Historical `gpt-5.6-sol` scouts that completed the earlier contract finished in
19-32 seconds. The later contract added cross-candidate uniqueness, reserved
source-test pairing, exact controls, and production-and-test citations. Since
that change, four consecutive live attempts have timed out. The current model
must discover exactly three real, distinct defects from one fixed evidence
packet; some packets cannot satisfy that requirement. A larger timeout alone
would preserve the unsatisfied contract and consume the simple profile's
delivery reserve.

The failed run exposed a separate finalization defect. Atomic monitor and report
publication opens a temporary file beside its destination without first
creating the destination parent. Fresh candidate worktrees do not contain the
ignored `.orca/monitoring` or per-run report directories, so both publications
failed with `ENOENT` and `latest.json` could not link their evidence.

## Goals

1. Keep the simple scout within its existing 100-second wall-clock allocation.
2. Preserve diverse source-test scopes without forcing one model response to
   invent three defects.
3. Continue when at least one independently validated candidate exists.
4. Fail explicitly when no scope yields a suitable candidate.
5. Preserve tool-free, read-only scouting and fresh Codex conversations.
6. Publish monitor and report evidence from a fresh worktree.
7. Preserve all downstream red-green, review, verification, ready-PR, remote
   check, head-SHA, and squash-merge gates.

## Non-goals

- No public Orcats API or backend transport change.
- No model-policy or global Codex configuration change.
- No larger simple-profile deadline.
- No weakening of candidate evidence, protected-path, or change-scope checks.
- No live proving run, push, PR, or merge as part of this repair itself.

## Scout Architecture

### Deterministic gathering

Keep the current 10-second gather limit, eight-file maximum, 10,000-character
cap, stable rendering, latest-commit context, and worktree-status guard.
Evidence selection may reserve at most four unique source-test pairs.

Render one scoped packet per reserved pair. A scoped packet contains the shared
latest-commit context plus only that pair's source and test evidence. It cannot
reference another test path or production scope.

### Bounded fan-out

Start at most four fresh, tool-free Codex conversations concurrently. All
conversations share one absolute 80-second model deadline. Each receives the
same selected model, low reasoning effort, read-only configuration, and a
5-second terminal-settlement reserve. Concurrent work changes model usage, not
the scout's wall-clock budget.

Each scoped conversation returns a discriminated result:

- `candidate`: exactly one candidate and its matching positive control; or
- `no_candidate`: a non-empty packet-grounded reason.

The scoped prompt fixes `testPath`, the production path, and `allowedPaths` to
its reserved pair. It asks the model to decide whether that scope contains a
supported low-risk defect; it does not ask the model to compare or coordinate
with sibling scopes.

Validate each result independently. Tool use, malformed output, off-packet
paths, missing citations, invalid control evidence, and timeout invalidate only
that scope. Record every scope outcome and terminal usage. Once three valid
candidates exist, cancel and settle pending siblings. Otherwise wait until the
shared model deadline and retain every valid result already completed.

### Aggregation

Accept one to three valid candidates. Preserve deterministic order using the
reserved-pair selection order, with candidate ID as the final tie-breaker.
Unique reserved pairs provide unique test and production scopes without a
cross-candidate model constraint. The first candidate supplies the selected
control; existing ranked reproduction tries candidates in that order and keeps
its current RED-proof requirements.

If no valid candidate exists, fail with a typed no-suitable-candidate outcome.
This is a scout result, not an SLA timeout. The issue ledger and final report
must distinguish no candidate, invalid scope, and timed-out scope evidence.

The final 10 seconds remain reserved for aggregation and candidate validation.
The simple stage allocation remains 10 seconds gather, 80 seconds concurrent
model work, and 10 seconds validation.

## Progress And Evidence

Monitor each child as `scout scope <n>` so concurrent progress is visible. Add
one report record per reserved pair with pair paths, duration, effective active
and settlement limits, result status, validation failure when present, and
retained terminal usage. The aggregate report records the accepted candidate
IDs and deterministic ranking.

A failed scope cannot erase a sibling's accepted evidence. A successful scout
cannot omit a started scope's terminal or cancellation record.

## Finalization Publication

Before creating the unpredictable same-directory temporary file,
`publishFinalizationText()` creates the destination parent recursively with
owner-only permissions for newly created directories. It then verifies the
final parent component is a real directory and not a symbolic link.

Parent preparation happens before the publication commit decision. All existing
temporary-file identity, mode, byte-length, flush, cleanup, single commit-call,
and atomic rename checks remain. No fallible work is added after rename.

## Failure Handling

- One scope timeout does not cancel completed valid siblings.
- One invalid or tool-using scope does not fail a valid aggregate.
- Zero valid candidates fails closed with complete per-scope evidence.
- Failure to create or validate a publication parent remains the primary
  publication error; cleanup failures remain attached as secondary evidence.
- The workflow never advances to commit or GitHub delivery after scout or
  evidence-publication failure.

## Verification

Test-first work must prove:

1. scoped schemas accept one candidate or an explicit no-candidate result;
2. four conversations start under one shared deadline;
3. three valid results cancel pending work and rank deterministically;
4. one valid result survives sibling no-candidate, invalid, and timeout results;
5. zero valid results retain distinct failure evidence and fail closed;
6. tool events remain forbidden per scope;
7. active work plus settlement cannot exceed the 80-second model allocation;
8. reports contain every started scope and aggregate selection;
9. existing ranked reproduction accepts one to three candidates without
   weakening RED proof or scope checks;
10. publication creates missing nested parents and writes a mode-`0600` file;
11. a symbolic-link parent is rejected before the commit decision;
12. existing symlink, stale-attempt, cleanup, and atomic-rename mutants remain
    rejected.

Run focused library, runtime, contract, and artifact tests first. Then run
`bun run verify` once before freezing the repaired artifacts for independent
successor audits.

## Completion Boundary

Repair completion means deterministic tests and full verification pass, the
artifact set is refrozen, and successor audits report zero findings. A new live
preflight and proving run require separate explicit authorization because the
previous one-run authorization was consumed by `20260720051952-58632`.
