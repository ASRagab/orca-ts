# Scoped Scout Fan-out and Resumable Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a 155-second concurrent pair-scoped scout, stop active work at
a validated ready PR, and continue SHA-locked CI delivery without another backend
turn.

**Architecture:** The library owns strict scoped-result and delivery-record
schemas. The runtime owns one shared fan-out clock and terminal settlement. The
workflow owns deterministic packet gathering, active candidate work, ready-PR
publication, and report evidence. A separate launcher continuation reloads a
record and performs only authoritative GitHub reads, bounded CI observation, and
a guarded squash merge.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Bun test, Bash 3.2, GitHub
CLI, and the existing Orcats workflow runtime.

## Global Constraints

- Prerequisite: Review 1 from
  `2026-07-19-finalization-parent-repair.md` ends with literal `ZERO FINDINGS`
  on a range whose base is
  `18cbac02f5a77174ec92066066d768a00a997b21`.
- Active profiles are simple 10-20 minutes with a 30-minute cap, medium 30-60
  with a 60-minute cap, and challenging 60-120 with a 120-minute cap. Reject and
  split a challenging candidate that cannot fit its cap.
- The active clock includes launcher setup through ready-PR record publication.
  Active success is a non-draft PR against `main` at its locked pushed SHA.
- Delivery owns an independent 30-minute window. At the window boundary, pending
  checks produce resumable pending, not active failure. Failed checks or identity
  drift block delivery. Only fresh green unchanged state may merge.
- Scout is exactly 15,000 ms gathering, 120,000 ms shared model/settlement, and
  20,000 ms validation. Start at most four pair-scoped conversations. Accept
  one to three valid siblings; zero valid candidates fails active work with
  ordered scope evidence. `settlementReserveMs` is inside the single
  `modelStartedAtMs + 120_000` deadline; at `now === deadline`, no new run,
  cancellation, or settlement operation may start.
- Preserve read-only tool-free scout configuration, real behavior tests, clean
  tree checks, progress reporting, independent review, immutable test proof,
  full verification, and SHA-locked merge protections.
- No preflight, backend, push, PR creation, CI watch, merge, or GitHub mutation
  is allowed while this plan is being implemented and reviewed.
- Root lint/typecheck excludes `.orca/**`; run the dedicated flow checker and
  scoped ESLint baseline gate for changed workflow sources.
- Before every task or review-repair commit and final freeze, run the exact
  `verify_retained_dirty_baseline` NUL-list/content/mode comparator in
  `2026-07-19-finalization-parent-repair.md`. It must print
  `retained dirty baseline: OK`; it checks the captured tar copy without
  forbidding newly created task paths.
- Task 6 must not modify or stage the three acknowledged dirty documents:
  `.orca/workflows/codebase-improvement.run.md`,
  `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md`, and
  `docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md`.

## Task 2: Scoped Result and Aggregation Contract

**Files:**

- Modify: `.orca/workflows/codebase-improvement-lib.ts`
- Modify: `.orca/workflows/codebase-improvement-lib.test.ts`

**Interfaces:**

```ts
type ScopedScoutResult =
  | { readonly status: "candidate"; readonly candidate: ScoutCandidate;
      readonly selectedControl: CandidateControl }
  | { readonly status: "no_candidate"; readonly reason: string };

function validateScopedScoutResult(
  result: ScopedScoutResult,
  pair: ScoutSourceTestPair,
  packet: ScoutEvidencePacket,
  profile: ComplexityProfile,
): string[];

function buildScoutResult(
  results: readonly { readonly scopeIndex: number; readonly result:
    Extract<ScopedScoutResult, { status: "candidate" }> }[],
): ScoutResult;
```

- [ ] **Step 1: Add strict schema and pair-binding RED tests**

Import the new schema and validator. Prove a valid pair-scoped candidate parses;
a cited `no_candidate` parses; mismatched control candidate ID, unexpected
fields, third allowed path, wrong test path, wrong production control path,
out-of-packet citation, profile violation, and line-prefix collision reject.

- [ ] **Step 2: Run the scoped-schema RED selection**

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  --test-name-pattern "scoped scout|scoped validation|line-prefix"
```

Expected: the imports do not exist before implementation.

- [ ] **Step 3: Implement strict scoped schema and validation**

Add strict discriminated Zod members. Reuse one boundary-safe rendered-citation
matcher for candidate and no-candidate evidence. A candidate must pass existing
evidence/profile validation and equal its reserved source/test pair. A
no-candidate reason must cite one exact rendered marker from both reserved paths.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command unchanged. Expected: all pair, profile, strictness, and
citation cases pass.

- [ ] **Step 5: Add one-to-three aggregation RED tests**

Test schema acceptance for one, two, and three candidates; rejection for zero,
four, duplicate IDs, duplicate controls, and duplicate test paths. Test
deterministic pair-order deduplication before truncation and ranked fallback
hydration for every accepted cardinality.

- [ ] **Step 6: Run aggregation RED selection**

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  --test-name-pattern "scout result|scoped aggregation|one to three ranks"
```

Expected: missing aggregation export or exact-three schema failure.

- [ ] **Step 7: Implement aggregation**

Change `ScoutResultSchema` arrays from exact-three to matching `.min(1).max(3)`
arrays. Add ordered `candidateControls`; require rank IDs to be the unique
candidate permutation, controls to match rank order, and rank-one control to
equal `selectedControl`. Sort accepted records by `scopeIndex`, remove
duplicates before limiting to three, and throw a typed
`NoSuitableScoutCandidateError` for zero accepted records.

- [ ] **Step 8: Verify GREEN, typecheck, and commit**

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement-lib.ts
verify_retained_dirty_baseline
git add -- .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-lib.test.ts
git diff --cached --check
git commit -m "feat(workflow): add scoped scout results"
```

### Review 2

Review the exact Review-1 approved head through this task head for schema
strictness, pair/citation/profile binding, one-to-three order, fallback
hydration, test strength, and two-file scope. Persist the fixed base/head
envelope and final `ZERO FINDINGS` before Task 3.

## Task 3: Shared Fan-out Deadline and Settlement

**Files:**

- Modify: `.orca/workflows/codebase-improvement-runtime.ts`
- Modify: `.orca/workflows/codebase-improvement-runtime.test.ts`

**Interfaces:**

```ts
interface ScopedScoutConversation<T> {
  readonly label: string;
  run(
    activeRemaining: () => number,
    settlementRemaining: () => number,
  ): Promise<T>;
  cancel(reason: string): void | Promise<void>;
}

function runScopedScoutFanout<T>(options: {
  readonly conversations: readonly ScopedScoutConversation<T>[];
  readonly modelAllocationMs: number;
  readonly settlementReserveMs: number;
  readonly quorum: number;
  readonly accept: (value: T) => boolean;
}): Promise<ScopedScoutFanoutResult<T>>;
```

- [ ] **Step 1: Add runtime RED tests**

Use deferred promises and a controlled clock to prove all scopes start before
any first result resolves; four scopes share one 120,000-ms allocation; settlement
uses only remaining shared time; and a valid sibling survives invalid, timeout,
cancel, and failure records. Add boundary cases at `119_999` and exactly
`120_000` ms: the reserve is subtracted from, never added to, the shared
deadline, and the exact-boundary case records uncompleted scopes without calling
`run`, `cancel`, or settlement again.

- [ ] **Step 2: Run the runtime RED selection**

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts \
  --test-name-pattern "scoped fanout|shared model deadline|settlement|quorum|cancel"
```

Expected: missing controller or sequential execution behavior.

- [ ] **Step 3: Implement bounded fan-out**

Start every eligible `run()` without serial awaits. Track records by original
pair index. On three accepted values, request cancellation once per pending
scope, retain synchronous throws and asynchronous cancellation rejections, and
drain terminal settlement inside the shared allocation. Set one
`deadlineAtMs = modelStartedAtMs + modelAllocationMs`; make the reserve a final
slice of that clock and, at `now >= deadlineAtMs`, record timeout/settlement
evidence without another operation. Do not add a second deadline. Exclude
cancellation-requested records from aggregation but retain them in scope
evidence.

- [ ] **Step 4: Add zero-valid ordering RED**

Test zero eligible pairs and zero valid terminal records. Require scope records
to persist in pair order, then report summary, then ledger summary, followed by
the typed `NoSuitableScoutCandidateError`.

- [ ] **Step 5: Implement finalization and verify GREEN**

Add `finalizeScopedScoutRecords` to validate tracked paths, record terminal
usage once in pair order, build one-to-three candidates, and produce the ordered
zero-valid proof. Run both Task 3 selections unchanged.

- [ ] **Step 6: Run focused checks and commit**

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement-runtime.ts
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement-runtime.ts
verify_retained_dirty_baseline
git add -- .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts
git diff --cached --check
git commit -m "feat(workflow): collect concurrent scout scopes"
```

### Review 3

Review the prior approved head through this task head for real concurrent start,
one shared deadline, settlement, cancellation, terminal drain, evidence order,
and two-file scope. Require literal `ZERO FINDINGS` before Task 4.

## Task 4: Active Ready-PR Boundary

**Files:**

- Modify: `.orca/workflows/codebase-improvement-lib.ts`
- Modify: `.orca/workflows/codebase-improvement-lib.test.ts`
- Modify: `.orca/workflows/codebase-improvement.ts`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts`
- Modify: `.orca/workflows/codebase-improvement-artifacts.test.ts`

**Interfaces:**

```ts
interface DeliveryRecordV1 {
  readonly version: 1;
  readonly runId: string;
  readonly repository: string;
  readonly prUrl: string;
  readonly branch: string;
  readonly baseRefName: "main";
  readonly lockedHeadSha: string;
  readonly active: ActiveDeliveryEvidence;
  readonly delivery: DeliveryStatusEvidence;
}

function assertCandidateFitsActiveProfile(
  candidate: ScoutCandidate,
  profile: ComplexityProfile,
): void;
```

- [ ] **Step 1: Add active-contract RED tests**

Assert profile candidate targets and cap values, scaled active stages, exact
15/120/20 scout values, no sequential retry constant, and ready PR as active
success. Add a challenging-profile RED where a candidate with estimated active
cost `7_200_001` ms throws `CandidateRequiresSplitError`, creates no
implementation conversation, and records the split reason; a `7_200_000`-ms
candidate remains eligible. Use command doubles to prove active work writes a
strict delivery record only after exact remote branch and ready PR SHA proof, and
never calls remote checks or merge after that record is published.

- [ ] **Step 2: Run active-boundary RED**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "active ready PR|delivery record|profile cap|challenging split|scout timing"
```

Expected: old terminal merge path and old clocks violate the new assertions.

- [ ] **Step 3: Implement profile, report, and record contract**

Replace old profile deadlines/scales and split active `ready-pr` from external
delivery. Add strict delivery record schemas, immutable identity/evidence
fields, a report `activeStatus` plus delivery status, and atomic record
publication next to `report.json`. Add `assertCandidateFitsActiveProfile` before
implementation selection: an over-cap challenging candidate returns the typed
split-required result and cannot create a backend conversation. Active
finalization reports passed only for a published ready record within its active
cap. Preserve legacy validation, candidate manifest, clean-tree, and
issue-finalization logic.

- [ ] **Step 4: Wire concurrent scout and active exit**

Replace the sequential exact-three scout path with Task 2/3 helpers. Use 15,000
ms gather, 120,000 ms shared fan-out/settlement, and 20,000 ms validation.
Persist all scope records. After commit/push/PR exact-head proof, persist the
record and return active success; do not poll CI, merge, or close issues in the
active execution path.

- [ ] **Step 5: Verify GREEN and commit**

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
verify_retained_dirty_baseline
git add -- .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
git diff --cached --check
git commit -m "feat(workflow): stop active work at ready PR"
```

### Review 4

Review the full prior-approved-head through Task 4 range for fixed active clock,
record-before-success ordering, exact ready-head proof, no CI/merge activity in
active work, fan-out integration, progress/report evidence, and exact staged
scope. Require `ZERO FINDINGS` before Task 5.

## Task 5: No-backend Delivery Continuation

**Files:**

- Modify: `.orca/workflows/codebase-improvement.ts`
- Modify: `.orca/workflows/codebase-improvement.sh`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts`
- Modify: `.orca/workflows/codebase-improvement-artifacts.test.ts`

- [ ] **Step 1: Add continuation RED tests**

Create strict record fixtures, fake `gh` outputs, and a TypeScript-flow spawn
sentinel. Prove `--continue-delivery=<run-id>` rejects mixed arguments. Add
launcher RED cases for a missing, unreadable, and malformed-JSON
`delivery.json`: each exits with the documented usage/configuration error before
the TypeScript-flow spawn sentinel, backend selection, or `llm()` call. Prove a
syntactically valid but schema-invalid fixture (for example `{"version":1}`)
also exits before that sentinel. The launcher test must prove it calls the exact
strict `DeliveryRecordV1` schema validator rather than `JSON.parse` alone. Prove
a valid record reloads and makes fresh PR reads.

Test three outcomes:

1. Pending checks at exactly 30 minutes write a new pending attempt, preserve the
   locked SHA, exit `75`, and do not merge.
2. Failed checks, draft/base/branch/repository mismatch, or head mismatch write
   blocked evidence and never merge.
3. Fresh required checks plus identical ready PR/head permit
   `gh pr merge --squash --match-head-commit <lockedHeadSha>`, followed by a
   final authoritative `MERGED` confirmation with the same identity.
4. After initial green evidence, the command log is exactly `protection`,
   `checks`, `pr-identity`, then `merge`; drift in any post-green reread blocks
   before the merge command.

- [ ] **Step 2: Run continuation RED selection**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "delivery continuation|delivery pending|locked squash merge|no backend"
bun test .orca/workflows/codebase-improvement-artifacts.test.ts \
  --test-name-pattern "continue-delivery|active ready|missing delivery record|malformed delivery record|schema-invalid delivery record|post-green reread"
```

Expected: the active-only launcher and merge-bound workflow fail the new cases.

- [ ] **Step 3: Implement continuation**

Add an exclusive launcher mode that validates the run ID and routes to the
TypeScript continuation. Before that spawn, require a readable file and parse
its JSON with the launcher-only bounded parser, then call the exact strict
`DeliveryRecordV1` schema validator before it invokes the TypeScript flow.
Missing, unreadable, malformed, or schema-invalid JSON (including
syntactically-valid records with missing, wrong-typed, invalid-literal, or
unknown fields) exits without executing the flow; `JSON.parse` alone is
insufficient. The continuation receives the launcher-validated record, repeats
the strict parse defensively, sets a new 30-minute external deadline, reuses
bounded PR/check/protection/merge helpers, and atomically appends an attempt to
record/report evidence. Once the initial checks are green, immediately reread
protection, checks, and PR identity in that exact order with no write between
them; merge only if all rereads retain the locked identity. It must not create a
work candidate, call a backend, run model prompts, modify the branch, or turn
pending into active failure.

- [ ] **Step 4: Verify GREEN and commit**

```bash
/bin/bash -n .orca/workflows/codebase-improvement.sh
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
verify_retained_dirty_baseline
git add -- .orca/workflows/codebase-improvement.ts \
  .orca/workflows/codebase-improvement.sh \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
git diff --cached --check
git commit -m "feat(workflow): resume SHA-locked delivery"
```

### Review 5

Review the complete Task 5 range for no-backend execution, strict record parse,
pending semantics, fresh identity/check reads, failure blocking, exact
`--match-head-commit`, authoritative `MERGED`, exit status, shell argument
isolation, and staged scope. Repair with additive commits and repeat the same
range review until the final line is `ZERO FINDINGS`.

## Task 6: Documentation, Progress, and Freeze

**Files:**

- Modify: `docs/superpowers/specs/2026-07-20-codebase-improvement-active-delivery-rebaseline.md`.
- Modify: `.superpowers/sdd/progress.md`.
- Modify: `.orca/workflows/codebase-improvement-artifacts.test.ts` for every
  mechanical documentation assertion; no other Task 6 documentation test path
  is permitted unless it is named here and added to both commit and Review 6.
- Read only: the three acknowledged dirty documents named in Global Constraints;
  they remain byte-for-byte and mode-for-mode equal to the captured baseline.

- [ ] **Step 1: Add documentation RED tests**

Require the new rebaseline specification and artifact contracts to name
active-ready success, profile caps, 15/120/20 fan-out, one-to-three siblings,
separate 30-minute delivery, pending continuation, SHA-locked merge, the
post-green reread order, and the NUL-list dirty-baseline gate. Also assert that
the three acknowledged dirty documents have their captured bytes and modes.

- [ ] **Step 2: Implement documentation and progress update**

Update only the new rebaseline specification and append a Correction 64 progress
entry that records the rebaseline, baseline commit, reviewed task ranges, and
final evidence without rewriting prior ledger/progress history. Do not edit or
stage the three acknowledged dirty documents; historical supersession text stays
as captured until separately authorized.

- [ ] **Step 3: Verify docs and commit**

```bash
bun test .orca/workflows/codebase-improvement-artifacts.test.ts
bun run docs:check
bun run docs:symbols
verify_retained_dirty_baseline
git add -- docs/superpowers/specs/2026-07-20-codebase-improvement-active-delivery-rebaseline.md \
  .superpowers/sdd/progress.md \
  .orca/workflows/codebase-improvement-artifacts.test.ts
git diff --cached --check
git commit -m "docs(workflow): record active delivery contract"
```

Expected cached paths are exactly the new rebaseline specification, the progress
entry, and `.orca/workflows/codebase-improvement-artifacts.test.ts`. The known
fifteen-path baseline remains unchanged; no hunk from an acknowledged dirty
document is staged.

## Review 6

Use the literal Review-5 approved head as the fixed base and the Task-6 commit as
the head. Review that exact range for documentation truth, the no-staged-dirty
rule, NUL-list/content/mode evidence, all earlier audit gates, final-check scope,
and exactly these Task 6 paths: the new rebaseline specification, progress entry,
and `.orca/workflows/codebase-improvement-artifacts.test.ts`. Save the verbatim
response with these first and final lines:

```text
Base: <review-5-approved-head>
Approved-Head: <task-6-head>
...
ZERO FINDINGS
```

If Review 6 finds an issue, repair it with an additive commit after
`verify_retained_dirty_baseline`, keep the same fixed Review-5 base, and repeat
the review through the new head. Do not freeze until the final literal line is
`ZERO FINDINGS`.

## Controller Verification and Authorization Gate

After every immediate review and any additive review repair is bound to its full
base/head range with `ZERO FINDINGS`, run once on final bytes:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
/bin/bash -n .orca/workflows/codebase-improvement.sh
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.ts
bun run docs:check
bun run docs:symbols
git diff --check
verify_retained_dirty_baseline
bun run verify
```

Then compare the live working tree to the NUL-safe execution baseline, preserve
all fifteen original tracked paths, bind the reviewed commit range, and freeze
the ledger/report/plan artifacts. Stop and request fresh explicit authorization
 before any preflight, backend, push, PR, CI watch, or merge.
