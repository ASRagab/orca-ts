# Deterministic Scout Evidence Correction Implementation Plan

> **Historical plan — scout timing superseded.** This file preserves the
> completed correction that introduced deterministic evidence gathering. Do
> not implement its 15/75 single-turn timing or its related constants and test
> assertions. Current normative behavior is 10 seconds of gathering, at most
> 80 seconds of synthesis across at most two fresh 40-second conversations,
> retry only for the first attempt's exact timeout cancellation, and a final
> 10-second validation reserve. See the operator runbook, current design, and
> parent implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timing-unstable model-led repository scout with bounded
deterministic evidence gathering plus one tool-free structured synthesis turn.

**Architecture:** The parent workflow chooses at most eight tracked source/test
files, renders a stable 20,000-character evidence packet, and proves gathering
did not change the worktree. One unchanged-model turn synthesizes three
candidates and a ranked-ID permutation from that packet; deterministic
validation either selects rank one or stops before reproduction.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Orcats 0.2.3, Codex CLI,
TypeScript compiler API, Bun test.

## Global Constraints

- Keep the public Orcats API, global Codex configuration, and model policy
  unchanged.
- Keep simple timing at 100 seconds for scout, 560 seconds allocated, and 600
  seconds launcher-to-merge.
- Split scout into at most 15 seconds gather, 75 seconds synthesis, and 10
  seconds validation/reserve.
- Read at most eight tracked paths: at most four `src/**/*.ts` files and at
  most four `tests/**/*.test.ts` files.
- Cap rendered evidence at 20,000 characters with stable path and line ordering.
- Reject protected entrypoints, dependency/release/security/secret/generated,
  documentation, skill, workflow, and `.orca/` paths.
- Reject model tool events, invalid or incomplete rankings, uncited evidence,
  off-packet candidate paths, and any gather-time worktree change.
- Preserve strict baseline, immutable red test, targeted test/lint, independent
  review, one full verify, ready PR, green checks, and SHA-locked squash merge.
- `.orca/` is ignored. For each artifact task, use before/after snapshots,
  SHA-256 manifests, implementer reports, and independent review; do not stage
  ignored artifacts.

## File Map

| File | Responsibility |
|---|---|
| `.orca/workflows/codebase-improvement-lib.ts` | Evidence selection/rendering, ranked schema, citation validation. |
| `.orca/workflows/codebase-improvement-lib.test.ts` | Pure RED/GREEN behavior tests. |
| `.orca/workflows/codebase-improvement-runtime.ts` | Shared async deadline and tool-free conversation guards. |
| `.orca/workflows/codebase-improvement-runtime.test.ts` | Delayed-operation and forbidden-event behavior tests. |
| `.orca/workflows/codebase-improvement.ts` | Bounded gather, tool-event watcher, synthesis, report integration. |
| `.orca/workflows/codebase-improvement-contract.test.ts` | Load-bearing AST/literal contracts and negative mutations. |
| `.orca/workflows/codebase-improvement-artifacts.test.ts` | Runbook and retained-artifact agreement. |
| `.orca/workflows/codebase-improvement.run.md` | Operator timing, evidence, and failure semantics. |
| `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md` | Approved behavior and rationale. |
| `docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md` | Parent lifecycle and completion audit. |

---

### Task 1: Pure Evidence and Ranking Contract

**Files:**

- Modify: `.orca/workflows/codebase-improvement-lib.test.ts`
- Modify: `.orca/workflows/codebase-improvement-lib.ts`

**Interfaces:**

- Produces:
  `ScoutEvidenceFile`,
  `ScoutEvidencePacket`,
  `selectScoutEvidencePaths(trackedPaths, recentPaths, maxFiles)`,
  `renderScoutEvidence(files, maxChars)`,
  `validateCandidateEvidence(candidate, packet)`, and
  `chooseCandidate(candidates, rankedCandidateIds)`.
- Changes `ScoutResultSchema` to require exactly three candidates and a unique
  ranked-ID permutation equal to their ID set.

- [ ] **Step 1: Snapshot both Task 1 files**

Run:

```bash
shasum -a 256 +  .orca/workflows/codebase-improvement-lib.ts +  .orca/workflows/codebase-improvement-lib.test.ts
```

Expected: two hashes saved in the Task 1 correction report.

- [ ] **Step 2: Write failing evidence and ranking tests**

Add these imports and tests to the existing test file:

```typescript
import {
  renderScoutEvidence,
  ScoutResultSchema,
  selectScoutEvidencePaths,
  validateCandidateEvidence,
} from "./codebase-improvement-lib.ts";

test("scout evidence paths are stable, balanced, tracked, and capped", () => {
  const tracked = [
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
    "src/e.ts",
    "src/index.ts",
    "tests/a.test.ts",
    "tests/b.test.ts",
    "tests/c.test.ts",
    "tests/d.test.ts",
    "tests/e.test.ts",
    "README.md",
  ];
  const recent = [
    "src/c.ts",
    "tests/c.test.ts",
    "tests/c.test.ts",
    "src/a.ts",
    "tests/a.test.ts",
    "src/c.ts",
  ];
  expect(selectScoutEvidencePaths(tracked, recent, 8)).toEqual([
    "src/c.ts",
    "src/a.ts",
    "src/b.ts",
    "src/d.ts",
    "tests/c.test.ts",
    "tests/a.test.ts",
    "tests/b.test.ts",
    "tests/d.test.ts",
  ]);
});

test("scout evidence is line-addressable and obeys the character cap", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;\n" },
      { path: "tests/a.test.ts", content: "test(\"a\", () => expect(1).toBe(1));\n" },
    ],
    120,
  );
  expect(packet.text.length).toBeLessThanOrEqual(120);
  expect(packet.text).toContain("src/a.ts:1");
  expect(packet.paths).toEqual(["src/a.ts", "tests/a.test.ts"]);
});

test("ranked candidate IDs must be an exact permutation", () => {
  const candidates = [
    { ...candidate, id: "a" },
    { ...candidate, id: "b" },
    { ...candidate, id: "c" },
  ];
  expect(
    ScoutResultSchema.parse({
      candidates,
      rankedCandidateIds: ["c", "a", "b"],
    }).rankedCandidateIds,
  ).toEqual(["c", "a", "b"]);
  for (const rankedCandidateIds of [
    ["a", "a", "b"],
    ["a", "b", "missing"],
    ["a", "b"],
  ]) {
    expect(
      ScoutResultSchema.safeParse({ candidates, rankedCandidateIds }).success,
    ).toBe(false);
  }
  expect(
    ScoutResultSchema.safeParse({
      candidates: [
        { ...candidate, id: "a" },
        { ...candidate, id: "a" },
        { ...candidate, id: "c" },
      ],
      rankedCandidateIds: ["a", "b", "c"],
    }).success,
  ).toBe(false);
});

test("selection follows validated ranking and evidence stays in packet", () => {
  const candidates = [
    { ...candidate, id: "a", expectedMinutes: 5 },
    { ...candidate, id: "b", expectedMinutes: 9 },
    { ...candidate, id: "c", expectedMinutes: 6 },
  ];
  expect(chooseCandidate(candidates, ["b", "c", "a"]).id).toBe("b");
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
    ],
    1_000,
  );
  expect(
    validateCandidateEvidence(
      { ...candidate, evidence: ["src/tools/process.ts:1 drops output"] },
      packet,
    ),
  ).toEqual([]);
  expect(
    validateCandidateEvidence(
      { ...candidate, evidence: ["uncited claim"], allowedPaths: ["src/other.ts", candidate.testPath] },
      packet,
    ).join(" "),
  ).toContain("evidence packet");
});
```

- [ ] **Step 3: Run Task 1 tests and verify RED**

Run:

```bash
bun test ./.orca/workflows/codebase-improvement-lib.test.ts
```

Expected: fail because the four new exports and ranked schema do not exist.

- [ ] **Step 4: Implement the pure contract**

Add these types and constants beside `ScoutResultSchema`:

```typescript
export interface ScoutEvidenceFile {
  readonly path: string;
  readonly content: string;
  readonly matchLines?: readonly number[];
}

export interface ScoutEvidencePacket {
  readonly paths: readonly string[];
  readonly text: string;
  readonly charCount: number;
}

const sourceScoutPath = /^src\/(?!.*(?:^|\/)index\.ts$).*\.ts$/;
const testScoutPath = /^tests\/.*\.test\.ts$/;
```

Implement stable selection and rendering:

```typescript
export function selectScoutEvidencePaths(
  trackedPaths: readonly string[],
  recentPaths: readonly string[],
  maxFiles: number,
): string[] {
  const touches = new Map<string, number>();
  for (const path of recentPaths) {
    touches.set(path, (touches.get(path) ?? 0) + 1);
  }
  const rank = (paths: readonly string[]): string[] =>
    [...new Set(paths)]
      .filter((path) => !isForbiddenPath(path))
      .sort(
        (left, right) =>
          (touches.get(right) ?? 0) - (touches.get(left) ?? 0) ||
          left.localeCompare(right),
      );
  const sourceLimit = Math.ceil(maxFiles / 2);
  const testLimit = Math.floor(maxFiles / 2);
  return [
    ...rank(trackedPaths.filter((path) => sourceScoutPath.test(path))).slice(
      0,
      sourceLimit,
    ),
    ...rank(trackedPaths.filter((path) => testScoutPath.test(path))).slice(
      0,
      testLimit,
    ),
  ];
}

export function renderScoutEvidence(
  files: readonly ScoutEvidenceFile[],
  maxChars: number,
): ScoutEvidencePacket {
  const paths = [...files.map((file) => file.path)].sort();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const perFileLimit = Math.floor(maxChars / Math.max(paths.length, 1));
  const rendered = paths
    .map((path) => {
      const file = byPath.get(path)!;
      const lines = file.content.split("\n");
      const indexes =
        file.matchLines !== undefined && file.matchLines.length > 0
          ? [...new Set(
              file.matchLines.flatMap((line) => [line - 2, line - 1, line]),
            )]
              .filter((index) => index >= 0 && index < lines.length)
              .sort((left, right) => left - right)
          : lines.map((_, index) => index).slice(0, 40);
      return indexes
        .map((index) => `${path}:${String(index + 1)} ${lines[index] ?? ""}`)
        .join("\n")
        .slice(0, perFileLimit);
    })
    .join("\n\n");
  const text = rendered.slice(0, maxChars);
  return { paths, text, charCount: text.length };
}
```

Change the schema and selection:

```typescript
export const ScoutResultSchema = z
  .object({
    candidates: z.array(CandidateSchema).length(3),
    rankedCandidateIds: z.array(z.string()).length(3),
  })
  .superRefine((value, context) => {
    const candidateIds = [...value.candidates.map((item) => item.id)].sort();
    const rankedIds = [...new Set(value.rankedCandidateIds)].sort();
    if (
      new Set(candidateIds).size !== 3 ||
      rankedIds.length !== 3 ||
      rankedIds.join("\n") !== candidateIds.join("\n")
    ) {
      context.addIssue({
        code: "custom",
        message: "rankedCandidateIds must be the candidate-ID permutation",
      });
    }
  });

export function chooseCandidate(
  candidates: readonly Candidate[],
  rankedCandidateIds: readonly string[],
): Candidate {
  const parsed = ScoutResultSchema.parse({ candidates, rankedCandidateIds });
  return parsed.candidates.find(
    (candidate) => candidate.id === parsed.rankedCandidateIds[0],
  )!;
}
```

Add citation validation:

```typescript
export function validateCandidateEvidence(
  candidate: Candidate,
  packet: ScoutEvidencePacket,
): string[] {
  const issues: string[] = [];
  const packetPaths = new Set(packet.paths);
  for (const path of candidate.allowedPaths) {
    if (!packetPaths.has(path)) {
      issues.push(`candidate path absent from evidence packet: ${path}`);
    }
  }
  const hasCitation = candidate.evidence.some((item) =>
    packet.paths.some((path) => {
      const marker = `${path}:`;
      const index = item.indexOf(marker);
      return (
        index >= 0 &&
        /^[1-9]\d*/.test(item.slice(index + marker.length))
      );
    }),
  );
  if (!hasCitation) {
    issues.push("candidate evidence must cite an evidence packet path and line");
  }
  return issues;
}
```

- [ ] **Step 5: Run Task 1 GREEN and negative checks**

Run:

```bash
bun test ./.orca/workflows/codebase-improvement-lib.test.ts
```

Expected: all Task 1 tests pass. Temporarily replace one ranked ID with
`"missing"`; the permutation test must fail. Restore the source and rerun.

- [ ] **Step 6: Record Task 1 snapshot and review**

Record after hashes and a focused diff. A fresh reviewer checks the exact
schema, stable ordering, caps, protected-path reuse, citation validation, and
the negative mutation before Task 2 begins.

---

### Task 2: Bounded Gather and Tool-Free Synthesis

**Files:**

- Create: `.orca/workflows/codebase-improvement-runtime.test.ts`
- Create: `.orca/workflows/codebase-improvement-runtime.ts`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts`
- Modify: `.orca/workflows/codebase-improvement.ts`

**Interfaces:**

- Consumes all Task 1 exports.
- Produces `awaitWithinDeadline(label, remainingMs, operation)` and
  `awaitToolFreeOutcome(conversation, awaitOutcome)` as internal testable
  runtime guards.
- Produces `RunReport.scoutEvidence`, one bounded synthesis conversation,
  tool-event cancellation, validated ranking, and unchanged downstream input.

- [ ] **Step 1: Snapshot both Task 2 files**

Run `shasum -a 256` for the contract test and workflow; store both hashes.

- [ ] **Step 2: Write failing runtime behavior tests**

Create `codebase-improvement-runtime.test.ts` before the helper exists. Require
`awaitWithinDeadline` to reject a fake delayed filesystem or command operation
at the shared remaining deadline. Parameterize `assistant_tool_call` and
`tool_result`; use a fake conversation whose outcome settles only when
`cancel()` runs, proving event draining is concurrent rather than sequential.
Both cases must reject with `scout attempted tool use: <event-type>` and call
`cancel()` exactly once.

Run:

```bash
bun test ./.orca/workflows/codebase-improvement-runtime.test.ts
```

Expected: fail because the runtime helper module does not exist.

- [ ] **Step 3: Implement the runtime guards and verify GREEN**

`awaitWithinDeadline` reads the shared remaining milliseconds, rejects
immediately when non-positive, races the supplied operation against one timer,
and clears that timer in `finally`. `awaitToolFreeOutcome` starts draining
`conversation.events()` before awaiting the supplied outcome closure; either
forbidden event records its type and cancels the conversation. After both
promises settle, it throws the named tool-use error or returns the outcome.

Run the focused runtime test. Expected: all delayed-operation and both
forbidden-event cases pass with no warning or dangling timer.

- [ ] **Step 4: Write failing static workflow contracts**

Replace the old scout directives with these exact emitted literals:

```typescript
const REQUIRED_SCOUT_PROMPT_DIRECTIVES = [
  "Use only the evidence packet below.",
  "Do not inspect the repository or call tools.",
  "Return exactly three supported candidates.",
  "Return rankedCandidateIds as a best-first permutation of candidate IDs.",
] as const;
```

Extend the AST/literal contract to require one declaration of each:

```typescript
const SCOUT_GATHER_LIMIT_MS = 15_000;
const SCOUT_MODEL_LIMIT_MS = 75_000;
const SCOUT_EVIDENCE_MAX_FILES = 8;
const SCOUT_EVIDENCE_MAX_CHARS = 20_000;
```

Require exactly seven autonomous stage calls, exactly one scout call, the
`assistant_tool_call` and `tool_result` event checks, a call to
`selectScoutEvidencePaths`, evidence hashing, and before/after status
comparison. Add negative mutations for `75_000 -> 76_000`, max files
`8 -> 9`, removal of the no-tools directive, and deletion of either event
type.

- [ ] **Step 5: Run the contract and verify RED**

Run:

```bash
bun test ./.orca/workflows/codebase-improvement-contract.test.ts
```

Expected: failures name missing split constants, evidence gather, ranking
prompt, status comparison, and tool-event checks.

- [ ] **Step 6: Implement deterministic gathering**

Import `createHash` from `node:crypto` and the new Task 1 helpers. Inside the
scout stage:

1. Record `git status --porcelain=v1`.
2. Run `git ls-files src tests` and
   `git log -40 --format= --name-only -- src tests` within the shared
   15-second gather deadline.
3. Select eight paths with `selectScoutEvidencePaths`.
4. Run one bounded `rg -n --no-heading -m 8` scan against only those paths;
   accept exit code 1 as an empty match set, and parse each
   `<path>:<line>:<text>` record into a per-path line-number map.
5. Read only selected files through `fs().readText`, wrapping every read with
   `awaitWithinDeadline` and the same absolute gather remainder. Pass each
   path's parsed line numbers as `matchLines`, render the packet, compute
   `sha256` with `createHash`, and check the shared remainder after both bounded
   synchronous operations.
6. Record a second status and require byte equality.

Append every gather command log to both `report.validation` and
`report.scoutEvidence.commands`.

Populate the report:

```typescript
scoutEvidence?: {
  paths: string[];
  charCount: number;
  sha256: string;
  ranking?: string[];
  commands: CommandLog[];
};
```

- [ ] **Step 7: Implement the watched synthesis turn**

Change `scoutPrompt(profile, limits, evidence)` to emit the four required
directives, candidate constraints, `Evidence packet:`, and the packet text.
Create one conversation with `ScoutResultSchema` and a 75-second limit. Call
`awaitToolFreeOutcome(conversation, () => awaitBounded(conversation, ...))`;
the tested helper owns concurrent event draining, cancellation, and the named
tool-use failure.

Parse `rankedCandidateIds`, validate each candidate against profile, tracked
paths, and `validateCandidateEvidence`, then select:

```typescript
candidate = chooseCandidate(
  scoutResult.candidates,
  scoutResult.rankedCandidateIds,
);
```

Persist the ranking in both report and plan JSON.

- [ ] **Step 8: Run Task 2 GREEN and mutation checks**

Run:

```bash
bun test ./.orca/workflows/codebase-improvement-contract.test.ts
bun test ./.orca/workflows/codebase-improvement-runtime.test.ts
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  ./.orca/workflows/codebase-improvement.ts
```

Expected: contract passes and typecheck prints `typecheck OK`. Run all four
negative mutations independently; each must fail its named contract. Restore
and rerun after every mutation.

- [ ] **Step 9: Record Task 2 snapshot and review**

Record hashes and focused diff for all four Task 2 files. A fresh reviewer
verifies one scout model call, 15/75/10 timing, command/read deadline sharing,
status immutability, behavior-tested no-tool handling, report evidence, ranking
selection, and unchanged later stages.

---

### Task 3: Artifacts, Static Gates, and Live Proof

**Files:**

- Modify: `.orca/workflows/codebase-improvement-artifacts.test.ts`
- Modify: `.orca/workflows/codebase-improvement.run.md`
- Modify:
  `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md`
- Modify:
  `docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md`
- Append only after a proving run:
  `.orca/improvement-loop/issues.jsonl`

**Interfaces:**

- Consumes Tasks 1-2.
- Produces aligned operator guidance, deterministic verification, a successful
  live run, linked issue corrections, merged PR proof, and final audit.

- [ ] **Step 1: Write failing artifact assertions**

Require the runbook to name `15 seconds`, `75 seconds`, `10 seconds`,
`20,000`, `rankedCandidateIds`, evidence digest, no-tool failure, and
unchanged 100/560/600 totals. Run the artifact test and observe failure before
editing the runbook.

- [ ] **Step 2: Align runbook, design, and parent plan**

Document the exact gather commands, eight-file/20,000-character caps, report
fields, ranked selection, failure conditions, timing split, and unchanged
downstream gates. Remove the superseded model-led exploration wording.

- [ ] **Step 3: Run the complete deterministic gate**

Run:

```bash
bun test +  ./.orca/workflows/codebase-improvement-lib.test.ts +  ./.orca/workflows/codebase-improvement-contract.test.ts +  ./.orca/workflows/codebase-improvement-artifacts.test.ts
bash skills/orcats-author/scripts/orca-typecheck-flow.sh +  ./.orca/workflows/codebase-improvement.ts
bun run docs:check
git diff --check
bash ./.orca/workflows/codebase-improvement.sh --preflight-only
```

Expected: all artifact tests pass, typecheck is OK, documentation links pass,
diff check passes, and fresh preflight exits zero from current `origin/main`.

- [ ] **Step 4: Run one fresh simple live workflow with orcats-flow**

Run in a managed background terminal:

```bash
bash ./.orca/workflows/codebase-improvement.sh --complexity=simple
```

Poll at intervals below 60 seconds. Report significant stages. Do not reuse any
failed branch or worktree.

- [ ] **Step 5: Require full delivery evidence**

Inspect latest record, report, monitor, ledger, worktree, PR, checks, merge SHA,
usage, and elapsed time. Required result: exit zero, evidence packet recorded,
rank one selected, red/green proof present, zero final review blockers,
`bun run verify` green, `CI / Verify` green, PR `MERGED`, matched head SHA,
elapsed at most 600,000ms, and main's pre-existing `package-lock.json` hash
unchanged.

- [ ] **Step 6: Link every failed run to the proving run**

Append correction records for runs `20260711020406-91166`,
`20260711024606-61423`, `20260711031450-21409`, and
`20260711031939-72337`. Each record names the actual proving run ID and remains
`corrected` only when Step 5 succeeds.

- [ ] **Step 7: Run broad review and completion audit**

A fresh reviewer checks the cumulative ignored-artifact diff and the parent
plan's objective matrix. Mark Tasks 5-6 complete only when every row has direct
evidence. Then record final usage, leave the active goal status unchanged, and
report `gbrain: QUERY_USED`.

---

## Correction 8: Rank-One Control and Bounded Scout Reasoning

**Goal:** Restore the bounded scout after Correction 7 made every ranked
candidate carry an unused positive-control plan.

**Architecture:** Keep exactly three packet-grounded candidates and their exact
ranking. Return one `selectedControl` bound to rank one, hydrate only the
selected `Candidate.controlBrief`, and set Codex scout reasoning to `low` through
request config. All downstream red/green, review, delivery, and merge gates stay
unchanged.

**Tech Stack:** TypeScript, Zod, Bun tests, Codex JSONL.

### Task 1: Selected-Control Contract

**Files:**

- Modify: `.orca/workflows/codebase-improvement-lib.test.ts`
- Modify: `.orca/workflows/codebase-improvement-lib.ts`

- [x] **Step 1: Write failing schema and hydration tests**

Add cases that reject a missing, blank, or non-rank-one `selectedControl`, retain
the exact three-ID permutation checks, and require:

```typescript
expect(
  chooseCandidate({
    candidates,
    rankedCandidateIds: ["b", "c", "a"],
    selectedControl: { candidateId: "b", brief: "known-good adjacent input" },
  }).controlBrief,
).toBe("known-good adjacent input");
```

- [x] **Step 2: Verify RED**

```bash
bun test ./.orca/workflows/codebase-improvement-lib.test.ts
```

Expected: the new `selectedControl` cases fail because the schema and whole
result selection API do not exist.

- [x] **Step 3: Implement minimal schema split and hydration**

Factor common fields and refinements into `ScoutCandidateSchema`. Define:

```typescript
selectedControl: z.object({
  candidateId: z.string(),
  brief: z.string().trim().min(1),
})
```

Require `selectedControl.candidateId === rankedCandidateIds[0]`. Make
`chooseCandidate(result)` find rank one and return
`CandidateSchema.parse({ ...seed, controlBrief: result.selectedControl.brief })`.

- [x] **Step 4: Verify GREEN**

Run the Task 1 test command. Expected: every selected-control and existing
candidate test passes.

### Task 2: Codex Reasoning-Effort Request Config

**Files:**

- Modify: `tests/jsonl-backends.test.ts`
- Modify: `tests/codex-backend.test.ts`
- Modify: `src/model/backend-config.ts`
- Modify: `src/backends/codex-jsonl.ts`
- Modify: `src/backends/codex-run.ts`
- Modify: `docs/backends.md`
- Modify: `website/src/content/docs/reference/backends.md`

- [x] **Step 1: Write failing argument and propagation tests**

Require `codexExecJsonlArgs({ reasoningEffort: "low" })` and a captured
`autonomous()` request to emit:

```typescript
["exec", "--json", "-c", 'model_reasoning_effort="low"']
```

- [x] **Step 2: Verify RED**

```bash
bun test tests/jsonl-backends.test.ts tests/codex-backend.test.ts
```

Expected: both new assertions fail because the option is ignored.

- [x] **Step 3: Implement minimal Codex-only option**

Add `CodexReasoningEffort`, optional Codex-only `BackendConfig.reasoningEffort`,
request-over-option precedence in `resolveCodexConfig`, and the exact `-c`
argument above. Omitted configuration must retain byte-identical arguments.

- [x] **Step 4: Verify GREEN and docs**

Run the Task 2 tests, `bun run typecheck`, `bun run docs:check`, and
`bun run docs:signatures`. Expected: all exit zero.

### Task 3: Scout-Only Wiring and Proof

**Files:**

- Modify: `.orca/workflows/codebase-improvement-contract.test.ts`
- Modify: `.orca/workflows/codebase-improvement-artifacts.test.ts`
- Modify: `.orca/workflows/codebase-improvement.ts`
- Modify: `.orca/workflows/codebase-improvement.run.md`
- Modify: this plan, parent plan, design, progress, and issue ledger.

- [x] **Step 1: Write failing workflow contracts**

Require one conditional `reasoningEffort: "low"` under `scoutConfig`, one
rank-bound `selectedControl`, complete candidate/control report provenance, and
unchanged seven-call backend isolation. Negative mutations `low` to `medium`
and selected-control ID mismatch must fail.

- [x] **Step 2: Verify RED, implement, and verify GREEN**

```bash
bun test ./.orca/workflows/codebase-improvement-contract.test.ts \
  ./.orca/workflows/codebase-improvement-artifacts.test.ts
```

Update the prompt, parse/validate path, report fields, and docs. Run the same
command until green, then run all acceptance checks and `bun run verify`.

- [ ] **Step 3: Run exactly one authorized simple proof**

Run `bash ./.orca/workflows/codebase-improvement.sh --complexity=simple` once.
Require ready PR, green `CI / Verify`, unchanged head SHA, and SHA-locked squash
merge within 600 seconds. Only after that proof append same-ID `corrected`
records for the 12 non-seed open issues; the seed transition remains automatic.
