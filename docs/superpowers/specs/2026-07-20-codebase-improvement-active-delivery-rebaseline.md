# Codebase Improvement Active and Delivery Rebaseline

## Status

This specification supersedes the workflow timing and terminal-state contract in
the July 10 design and the two July 19 implementation plans. It is a design
artifact only: it authorizes deterministic local implementation and commits, not
a preflight, backend turn, push, pull request, CI watch, or merge.

## Problem

The old workflow treated a merged pull request as the only successful result and
charged variable external CI time to one 600-second launcher deadline. A real
candidate reached a ready pull request but CI timing exceeded that clock. The
workflow therefore reported an implementation failure even though active work
had finished at a verified immutable candidate SHA.

The scout also used a sequential, exact-three contract: 10 seconds gathering,
two 40-second attempts, and 10 seconds validation. One failed scope discarded
otherwise valid evidence.

## Goals

- Active work succeeds at a non-draft ready-for-review pull request whose remote
  branch and `headRefOid` equal one validated immutable SHA.
- Active work has profile-specific targets and hard caps: simple 10-20 minutes
  within 30, medium 30-60 within 60, challenging 60-120 within 120. A
  challenging candidate that cannot fit its cap is rejected and split before
  implementation.
- Simple scouting has one 155-second allocation: 15 seconds deterministic
  gathering, 120 seconds for at most four concurrent pair-scoped model runs
  including terminal settlement, and 20 seconds validation.
- One to three independently valid scout siblings are sufficient. A failed,
  invalid, cancelled, or timed-out scope cannot remove a valid sibling.
- Delivery starts only after active success and has its own 30-minute external
  window. It reloads authoritative PR state, never starts a backend turn, and
  either merges a still-matched green SHA, returns resumable pending, or reports
  a delivery block.
- Merge remains SHA-locked squash merge with fresh repository, PR, branch,
  ready-state, required-check, and final `MERGED` proof.

## Non-goals

- No relaxation of clean-tree, evidence, test, review, immutable-head, or merge
  protection requirements.
- No parallel writers. One bounded implementation task is reviewed and repaired
  to literal `ZERO FINDINGS` before its dependent task starts.
- No automatic preflight, live backend run, GitHub mutation, CI watch, or merge
  in this redesign. Those actions require new explicit authorization after the
  deterministic freeze.
- No broad cleanup of retained worktrees, branches, ignored files, or fixture
  processes.

## Clock model

The launcher starts the active clock before source capture and worktree setup.
All active setup, deterministic gates, model activity, review, verification,
commit, push, ready-PR confirmation, record publication, and finalization are
inside that clock. CI observation and merge are not.

| Profile | Candidate target | Active hard cap | Stage multiplier |
| --- | --- | --- | --- |
| simple | 10-20 minutes | 1,800,000 ms | 1 |
| medium | 30-60 minutes | 3,600,000 ms | 2 |
| challenging | 60-120 minutes | 7,200,000 ms | 4 |

Simple active stage limits are: preflight 300,000 ms; scout 155,000 ms;
reproduce 120,000 ms; implement 300,000 ms; repairs 180,000 ms; review
180,000 ms; verify 180,000 ms; commit/push/ready-PR publication 180,000 ms;
and finalization reserve 60,000 ms. The scaled stage limits plus reserve remain
strictly below the corresponding profile cap. The implementation must calculate
every deadline from the launcher-provided absolute active deadline; no stage may
extend the active clock.

Simple scout limits are exactly `15_000`, `120_000`, and `20_000` milliseconds.
The 120-second model allocation includes cancellation and settlement. There is
no sequential retry allocation and no per-scope independent 120-second clock.

## State machines

### Active

```text
initialize -> preflight -> scout -> reproduce -> implement -> repair
           -> review -> verify -> commit-push -> ready-pr -> active-ready
                                                              |
                                                              v
                                                        active-failed
```

`active-ready` requires all of the following before the active report can be
successful:

1. Candidate tests, independent reviews, scoped lint/typecheck, and verification
   evidence are recorded.
2. The local commit is the verified candidate content and exactly one child of
   the captured base.
3. The exact commit SHA is pushed to the expected branch.
4. A newly created or authoritative PR is non-draft, targets `main`, names the
   expected branch, and reports `headRefOid` exactly equal to the pushed SHA.
5. A versioned delivery record and active report bind the same repository, PR,
   branch, locked SHA, timing, and verification evidence before finalization.

`active-ready` exits zero even though the candidate is not merged. Any failure
before those conditions is `active-failed`; it preserves final report and ledger
evidence using existing finalization protections.

### Delivery

```text
not-started -> pending -> watching -> delivered
                         |
                         +-> pending
                         +-> blocked
```

Delivery begins from a persisted `pending` record and a fresh authoritative PR
read. It owns a distinct 1,800,000-ms external deadline. It may update only the
record and report evidence; it must not call `llm()`, construct a conversation,
or modify the candidate branch.

- Required checks still pending at the boundary: write `pending`, retain the
  last authoritative PR/check observation, exit `75`, and leave active success
  unchanged.
- Required checks failed, PR became draft, base/branch/repository changed, or
  `headRefOid` differs from `lockedHeadSha`: write `blocked`, exit nonzero, and
  never merge.
- Required checks passed: immediately re-read merge protection, checks, and PR
  state; require the same ready repository/PR/branch/SHA; squash merge with
  `--match-head-commit <lockedHeadSha>`; re-read state and require `MERGED` with
  the same repository/PR/branch/SHA; write `delivered`, exit zero.

`pending` is neither `delivered` nor an implementation failure. A later
continuation repeats the authoritative reads under a new external deadline and
uses no new model turn.

## Delivery record

The canonical record is
`.orca/improvement-loop/runs/<run-id>/delivery.json`, next to `report.json`.
It is owner-only finalization output, versioned, and is published before active
finalization reports success. Its schema is strict and includes:

```ts
interface DeliveryRecordV1 {
  readonly version: 1;
  readonly runId: string;
  readonly repository: string;
  readonly prUrl: string;
  readonly branch: string;
  readonly baseRefName: "main";
  readonly lockedHeadSha: string;
  readonly active: {
    readonly profile: "simple" | "medium" | "challenging";
    readonly startedAtMs: number;
    readonly readyAtMs: number;
    readonly elapsedMs: number;
    readonly activeDeadlineAtMs: number;
    readonly verification: readonly CommandLog[];
  };
  readonly delivery: {
    readonly status: "pending" | "blocked" | "delivered";
    readonly attempts: readonly DeliveryAttempt[];
  };
}
```

Each attempt records start/finish time, authoritative PR head evidence, required
check evidence, an optional merge command/confirmation, and one terminal status.
The report mirrors the immutable identity and current delivery status but does
not replace the record. Paths in all emitted evidence stay repository-relative.

## Interfaces

- `codebase-improvement.sh --complexity=<profile>` runs active work only.
- `codebase-improvement.sh --continue-delivery=<run-id>` runs delivery only.
  It rejects combined complexity/preflight arguments and missing or malformed
  records before spawning the TypeScript flow.
- The continuation code parses the record from the source run directory and
  receives the same repository identity checks as active work. It has no backend
  selector or model setup path.
- `DeliveryRecordSchema`, `DeliveryAttemptSchema`, profile limits, remote-check
  parsing, ready-head assertions, and merged-state assertions remain pure or
  bounded helpers with behavioral tests.

## Scout contract

Gather evidence deterministically for at most four reserved source/test pairs.
Render and digest each pair before creating its conversation and re-check the
shared gather deadline after every render/digest. Start all eligible scoped
conversations without serial awaits. Each result is one strict `candidate` or
cited `no_candidate` object tied to its reserved pair.

The shared fan-out controller uses one model deadline, terminally settles every
scope, records usage in pair order, cancels pending scopes after three accepted
candidates, and retains every scope outcome for evidence. It passes only
uncancelled, valid candidates to deterministic ranking. Ranking accepts one to
three candidates in pair order; zero valid candidates creates typed scope
evidence and fails active work safely.

## Acceptance evidence

The final deterministic freeze must prove:

1. Profile caps, target ranges, active ready-PR boundary, and the exact
   15/120/20 scout clocks.
2. One-to-three independent scoped results, shared fan-out deadline, settlement,
   cancellation, zero-valid evidence, and no sequential retry path.
3. Ready PR publication with exact pushed/remote/PR SHA and persisted record.
4. Continuation performs no backend activity; pending is resumable; failed
   checks or identity drift block; only fresh green unchanged state merges.
5. SHA-locked squash merge and authoritative `MERGED` confirmation.
6. Existing parent-publication, clean-tree, progress, review, ledger, process,
   and finalization protections still pass real behavior tests and positive
   controls.

The final proof additionally requires all four workflow suites, scoped flow
typecheck and lint baseline gate, Bash syntax, documentation checks, `git diff
--check`, and one `bun run verify` on final bytes. A later live proof is a
separate authorization-gated acceptance step.
