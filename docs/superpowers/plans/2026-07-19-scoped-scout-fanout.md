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
  ordered scope evidence.
- Preserve read-only tool-free scout configuration, real behavior tests, clean
  tree checks, progress reporting, independent review, immutable test proof,
  full verification, and SHA-locked merge protections.
- No preflight, backend, push, PR creation, CI watch, merge, or GitHub mutation
  is allowed while this plan is being implemented and reviewed.
- Root lint/typecheck excludes `.orca/**`; run the dedicated flow checker and
  scoped ESLint baseline gate for changed workflow sources.

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
cancel, and failure records.

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
drain terminal settlement inside the shared allocation. Do not add a second
deadline. Exclude cancellation-requested records from aggregation but retain
them in scope evidence.

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
```

- [ ] **Step 1: Add active-contract RED tests**

Assert profile candidate targets and cap values, scaled active stages, exact
15/120/20 scout values, no sequential retry constant, and ready PR as active
success. Use command doubles to prove active work writes a strict delivery
record only after exact remote branch and ready PR SHA proof, and never calls
remote checks or merge after that record is published.

- [ ] **Step 2: Run active-boundary RED**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "active ready PR|delivery record|profile cap|scout timing"
```

Expected: old terminal merge path and old clocks violate the new assertions.

- [ ] **Step 3: Implement profile, report, and record contract**

Replace old profile deadlines/scales and split active `ready-pr` from external
delivery. Add strict delivery record schemas, immutable identity/evidence
fields, a report `activeStatus` plus delivery status, and atomic record
publication next to `report.json`. Active finalization reports passed only for
a published ready record within its active cap. Preserve legacy validation,
candidate manifest, clean-tree, and issue-finalization logic.

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

Create strict record fixtures and fake `gh` outputs. Prove
`--continue-delivery=<run-id>` rejects mixed arguments, reloads the record,
does not invoke backend selection or `llm()`, and makes fresh PR reads.

Test three outcomes:

1. Pending checks at exactly 30 minutes write a new pending attempt, preserve the
   locked SHA, exit `75`, and do not merge.
2. Failed checks, draft/base/branch/repository mismatch, or head mismatch write
   blocked evidence and never merge.
3. Fresh required checks plus identical ready PR/head permit
   `gh pr merge --squash --match-head-commit <lockedHeadSha>`, followed by a
   final authoritative `MERGED` confirmation with the same identity.

- [ ] **Step 2: Run continuation RED selection**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "delivery continuation|delivery pending|locked squash merge|no backend"
bun test .orca/workflows/codebase-improvement-artifacts.test.ts \
  --test-name-pattern "continue-delivery|active ready"
```

Expected: the active-only launcher and merge-bound workflow fail the new cases.

- [ ] **Step 3: Implement continuation**

Add an exclusive launcher mode that validates the run ID and routes to the
TypeScript continuation. The continuation loads the strict record, sets a new
30-minute external deadline, reuses bounded PR/check/protection/merge helpers,
and atomically appends an attempt to record/report evidence. It must not create
a work candidate, call a backend, run model prompts, modify the branch, or turn
pending into active failure.

- [ ] **Step 4: Verify GREEN and commit**

```bash
/bin/bash -n .orca/workflows/codebase-improvement.sh
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
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

- Modify only the new rebaseline design, runbook, historical design notice,
  historical scout correction notice, `.superpowers/sdd/progress.md`, and
  tests that mechanically bind their public wording.

- [ ] **Step 1: Add documentation RED tests**

Require the runbook and artifact contracts to name active-ready success, profile
caps, 15/120/20 fan-out, one-to-three siblings, separate 30-minute delivery,
pending continuation, and SHA-locked merge. Require old sequential timing and
merge-bound success language only inside explicit historical supersession notices.

- [ ] **Step 2: Implement documentation and progress update**

Update both documentation surfaces and append a Correction 64 progress entry
that records the rebaseline, baseline commit, reviewed task ranges, and final
evidence without rewriting any prior ledger/progress history.

- [ ] **Step 3: Verify docs and commit**

```bash
bun test .orca/workflows/codebase-improvement-artifacts.test.ts
bun run docs:check
bun run docs:symbols
git add -p -- .orca/workflows/codebase-improvement.run.md \
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md \
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md
git add -- docs/superpowers/specs/2026-07-20-codebase-improvement-active-delivery-rebaseline.md \
  .superpowers/sdd/progress.md
git diff --cached --check
git commit -m "docs(workflow): record active delivery contract"
```

Accept only rebaseline hunks in the three preserved dirty documents. The known
fifteen-path baseline must remain unchanged outside those reviewed hunks.

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
bun run docs:check
bun run docs:symbols
git diff --check
bun run verify
```

Then compare the live working tree to the NUL-safe execution baseline, preserve
all fifteen original tracked paths, bind the reviewed commit range, and freeze
the ledger/report/plan artifacts. Stop and request fresh explicit authorization
 before any preflight, backend, push, PR, CI watch, or merge.
