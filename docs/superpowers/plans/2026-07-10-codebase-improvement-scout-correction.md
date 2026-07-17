# Deterministic Scout Evidence Correction Implementation Plan

> **Historical plan — scout timing superseded.** This file preserves the
> completed correction that introduced deterministic evidence gathering. Do
> not implement its 15/75 single-turn timing or its related constants and test
> assertions. Current normative behavior is 10 seconds of gathering, at most
> 80 seconds of synthesis across at most two fresh 40-second conversations,
> retry only for the first attempt's exact timeout cancellation, and a final
> 10-second validation reserve. See the operator runbook, current design, and
> parent implementation plan. Correction 18 also supersedes every timer-helper
> sketch below with absolute-completion checks and owned-timeout semantics.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timing-unstable model-led repository scout with
10-second deterministic evidence gathering, tool-free synthesis across at most
two fresh synthesis conversations, each capped at 40 seconds within 80 seconds
total, and 10-second validation.

**Architecture:** The parent workflow chooses at most eight tracked source/test
files, renders a stable 10,000-character evidence packet, and proves gathering
did not change the worktree within 10 seconds. Tool-free synthesis uses at most
two fresh unchanged-model conversations, each capped at 40 seconds within 80
seconds total; a second attempt occurs only after the first attempt's exact
timeout cancellation. The final 10 seconds validate the packet and synthesis
or fail closed. Deterministic reproduction then attempts candidates in rank
order under one shared budget and accepts only the first candidate with a
genuine RED proof.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Orcats 0.2.3, Codex CLI,
TypeScript compiler API, Bun test.

## Global Constraints

- Keep the public Orcats API, global Codex configuration, and model policy
  unchanged.
- Keep simple timing at 100 seconds for scout, 560 seconds allocated, and 600
  seconds launcher-to-merge.
- Split scout into at most 10 seconds gather, at most two fresh synthesis
  conversations each capped at 40 seconds within 80 seconds total, and 10
  seconds validation/reserve.
- Read at most eight tracked paths: at most four `src/**/*.ts` files and at
  most four `tests/**/*.test.ts` files.
- Cap rendered evidence at 10,000 characters with stable path and line ordering.
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
the first candidate with a genuine RED proof selected, red/green proof present,
zero final review blockers,
`bun run verify` green, `CI / Verify` green, PR `MERGED`, matched head SHA,
elapsed at most 600,000ms, and main's pre-existing `package-lock.json` hash
unchanged.

- [x] **Step 6: Replace manual linkage with terminal ledger commit**

The launcher now closes every latest-open ID dynamically. It appends same-ID
resolved rows naming the actual proving run only while staging the zero-open
canonical ledger, then commits that ledger atomically after Step 5 succeeds.

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
merge within 600 seconds. Only after that proof may the launcher atomically
commit same-ID resolved rows for every latest-open issue.

Run `20260713171459-43785` consumed this authorization and failed closed at the
red gate after 112,181ms. Its control passed, but the target also passed because
the regression searched all stderr for `undefined`; Bun's later uncaught-error
diagnostic supplied that text even though the Orcats `run_finished` line omitted
its error. No push, pull request, CI wait, or merge occurred.

---

## Correction 9: Self-Verified Isolated Red Proof

**Goal:** Prevent a reproduction turn from returning a target test that passes
through incidental runner, stack, or source text.

**Architecture:** Keep the parent gates authoritative. Before the reproduction
turn returns, require it to run the exact filtered control and full target
commands itself. If the target passes, it strengthens only the target assertion
until the control passes and the target fails with the expected pattern. The
parent then repeats both commands independently before saving the immutable
test diff. Prompt command rendering shell-quotes non-plain arguments so the
space in `^control <candidate.id>$` cannot split the pattern.

- [x] **Step 1: Write failing prompt and runbook contracts**

The focused contract run had 36 passes and three expected failures for the two
missing prompt directives and missing runbook proof.

- [x] **Step 2: Implement the minimal reproduction directive**

Require the exact two commands, prohibit incidental-output matches, and retain
the existing no-production-edit and no-Git constraints.

- [x] **Step 3: Verify focused GREEN**

The contract and artifact suite passes 39 tests with 228 assertions.

Review found that joining process arguments rendered the control pattern as two
shell words. A behavior-first regression failed, command rendering gained
shell-safe argument quoting, and the focused library and contract suite then
passed 58 tests with 257 assertions.

- [ ] **Step 4: Run a newly authorized complete simple proof**

Do not reuse run `20260713171459-43785`, its branch, or its worktree. A new run
must start from current `origin/main` and satisfy the unchanged ready-PR, green
CI, matched-head, SHA-locked squash-merge, and 600-second gates.

---

## Correction 10: Source-Built Runtime Provenance

**Goal:** Make every proof execute the current source runtime and directly test
all profile deadlines and path limits.

**Architecture:** Every launcher mode installs the frozen source dependencies,
rebuilds `dist/orcats`, verifies that the source binary resolves first on the
launch PATH, and records its path, source HEAD, SHA-256, and version. Live
execution receives the same PATH pin. A stale global installation is ignored.

- [x] **Step 1: Record the stale-runtime failure**

The pre-correction audit found that bare `orcats` resolved to the global
installation and that its hash differed from the source binary. The existing
source binary also predated current HEAD. No live run was started from that
unproven runtime.

- [x] **Step 2: Implement launcher and profile contracts**

Require build-before-fetch ordering, executable source-binary resolution, the
live PATH pin, runtime provenance in `latest.json`, and matching runbook text.
Directly assert deadlines `600000/1800000/2700000` and path limits `3/6/10`.

- [x] **Step 3: Complete deterministic verification**

The workflow suite passed 111 tests. Flow typecheck, documentation gates, and
the full `bun run verify` gate also exited zero.

- [x] **Step 4: Run fresh source-pinned preflight**

Preflight `20260713174754-60933` passed in 27,968ms with 68 workflow tests,
flow typecheck, 444 repository tests plus one gated skip, and lint. It recorded
source HEAD `d68fce0d12ca2e648380952e6974bf435bfbd8af`, binary SHA-256
`83bc5f0493eca6db55bb65663970776fc8e1a13adf3aff0724150613585f10e9`,
and Orcats `0.2.3`.

- [ ] **Step 5: Run the authorized complete simple proof**

Run `bash ./.orca/workflows/codebase-improvement.sh --complexity=simple`
exactly once from this source worktree. Preserve every prior worktree and
evidence file. Require the unchanged ready-PR, all-green checks, matched-head,
SHA-locked squash-merge, and 600-second gates.

Run `20260713175736-9351` consumed this authorization. It completed scout,
isolated red proof, implementation, targeted gates, independent review, full
verification, commit, push, and ready pull request creation in 275,454ms. Its
first remote-check query ran before GitHub created a check run; `gh pr checks`
returned exit 1 with `no checks reported`, and the workflow failed instead of
polling. No second backend run was started.

The authorized delivery was continued manually. `CI / Verify` and GitGuardian
both passed for captured head
`d5c1bd3602f96676a2b76ece3b306a020f29f3f7`. Pull request 40 was squash-merged
with `--match-head-commit` at merge commit
`e0adc736caa1202172adcff38f97a187e26e643f`. This proves the selected change's
delivery, but does not rewrite the failed workflow report or satisfy the
600-second end-to-end proof; manual merge occurred after 775,192ms.

---

## Correction 11: Pending Check-Startup Rollup

**Goal:** Keep a newly created pull request in the remote-check polling loop
while GitHub has not created its first check run, without hiding real GitHub
CLI failures.

**Architecture:** Classify only the exact exit-1 `no checks reported on the
'<branch>' branch` result as startup-pending. Convert it to an empty check
rollup, which existing `remoteCheckState([])` treats as pending. Retain the
five-second poll, delivery deadline, head-SHA checks, and fail-closed handling
for every other non-success result.

- [x] **Step 1: Capture the root cause and delivery evidence**

The failed query completed at `2026-07-13T18:02:12Z`; `CI / Verify` began five
seconds later. Preserve the original exit-1 report separately from the manual
all-green, matched-head merge evidence.

- [x] **Step 2: Prove RED**

The new helper test first failed because the export was absent, then failed on
`false` versus expected `true`. The workflow wiring contract and runbook
contract each failed on their missing startup-pending behavior.

- [x] **Step 3: Implement the narrow correction**

Add an exact-message predicate, return an empty rollup only for that result,
and document the pending state. Tests require authentication failures and a
successful command carrying the same text to remain non-matches.

- [x] **Step 4: Complete deterministic verification**

Run all workflow tests, flow typecheck, documentation checks, full
`bun run verify`, and `git diff --check`. Do not start another live backend run.

All 112 workflow tests passed with 419 assertions, flow typecheck printed
`typecheck OK`, full verification passed 459 repository tests with one gated
skip, and `git diff --check` exited zero.

- [ ] **Step 5: Require a later authorized end-to-end proof**

The remote-check issue remains open until a new run itself waits, merges at its
captured head, reports success, and completes within its profile deadline.

---

## Correction 12: Delivery and Completion Evidence

**Goal:** Remove three ways a successful-looking run could lack authoritative
delivery, finalization, or review-completion evidence.

**Architecture:** Bind every remote assertion and merge to the immutable local
post-commit SHA. Centralize shutdown and artifact finalization so partial
failure produces truthful terminal evidence. Preserve the first and final
review results and require a persisted literal zero blocker count before
verification.

### Task 1: Immutable Local Delivery SHA

- [x] Capture bounded `git rev-parse HEAD` immediately after commit.
- [x] Require a lowercase 40-character SHA and keep it immutable through push,
  pull-request creation, check polling, and `--match-head-commit` merge.
- [x] Fail before polling when the created pull request has another head.
- [x] Prove the contract RED, GREEN, flow-typechecked, and independently clean;
  retain before/after snapshots, review diff, and manifest.

### Task 2: Truthful Finalization

- [x] Add behavior-first async tests for shutdown-once ordering, successful-body
  failure-state transition, one complete artifact retry, original body-failure
  preservation, and stable action-ordered errors.
- [x] Delegate workflow finalization to the tested runtime helper. Persist a
  stable `<runId>-finalize` environment issue without duplicate ledger lines.
- [x] Recover and verify the immutable before/after snapshot, review diff, and
  eight-file SHA-256 manifest from retained correction evidence.

### Task 3: Review Completion Evidence

- [x] Snapshot initial findings immediately after the first successful review.
- [x] Persist final findings and `finalReviewBlockerCount` on both no-repair and
  repeated-review paths before either success or blocker failure.
- [x] Require persisted zero blockers before verification and assign
  `stopReason: "completed"` only after merge. The launcher owns later issue
  closure and terminal SLA commitment.
- [x] Prove focused RED/GREEN, Task 2 regression safety, flow typecheck, and
  independent review with immutable snapshots and manifests.

- [ ] **Final proof:** A later workflow-owned run must itself open the ready PR,
  wait for green checks, and SHA-lock the merge within its profile ceiling.

---

## Correction 13: Ranked Reproduction Fallback

**Goal:** Continue from a plausible candidate whose generated target test
passes to the next ranked candidate without accepting false RED or hiding an
operational failure.

**Architecture:** Keep the scout's three control-free seeds, exact ranking, and
one rank-one control. Attempt ranks sequentially under the unchanged reproduce
budget. Generate later controls lazily. Reject only typed invalid proofs,
retain their evidence, restore the exact test snapshot, and publish selection
only after a genuine RED proof.

### Task 1: Pure Ranked Control Flow

- [x] Add `hydrateCandidate(result, control)` for any control whose ID belongs
  to the validated ranking while retaining the rank-one scout-control rule.
- [x] Add `runRankedCandidateFallback`: attempt in rank order, return the first
  accepted value, restore every rejection before continuing, stop on restore
  failure, and report all reasons on exhaustion.
- [x] Cover accepted rank one, later-rank acceptance, restore ordering,
  exhaustion, restore failure, and never-restored acceptance with behavior
  tests.

### Task 2: Proof Classification and Exact Restoration

- [x] Represent only failed/skipped/miscounted control, passing target, wrong
  target pattern, no change, and empty diff as typed invalid proofs.
- [x] Treat timeout markers and `exitCode: null` signal termination as
  operational errors before any invalid-proof classification.
- [x] Distinguish no normalized file-change event from an unconfirmed event.
  Permit terminal-only success only when exact Git path and diff proof exists.
- [x] Move byte capture and restoration into runtime helpers. Verify raw-byte
  SHA-256 plus exact Git status and complete binary diff equality.
- [x] Use real temporary Git repositories to prove non-text bytes, unrelated
  dirty state, full restoration, and mismatch rejection.

Initial independent review exposed the null-exit classification gap, missing
post-persistence budget check, and insufficient restoration proof. The focused
review-fix RED was 87 passes and five failures; GREEN was 92 passes with 392
assertions. Final review then exposed a non-enforcing bare budget read,
single-sided rejected-artifact checks, and restoration tests that did not
independently isolate status and hash verification. A second audit found that
diff equality and each write's scoped budget adjacency also needed independent
mutation protection.

### Task 3: Workflow, Evidence, and Documentation

- [x] Gather latest first-parent commit subject and changed paths into the
  bounded scout packet and report.
- [x] Share one reproduce budget across every rank, lazy control, parent gate,
  evidence write, and restoration. Enforce a positive remainder immediately
  before and after each rejected-artifact write, then recheck it after
  persisting accepted RED.
- [x] Retain each rejected candidate's control, reason, attempted diff,
  candidate-local validation, rank, snapshot hash, baseline status, complete
  binary diff, artifact path, and verified restoration.
- [x] Persist candidate, plan, accepted control, and immutable-red report state
  only after acceptance. Recursively collect rejected artifacts with the run.
- [x] Prove the runbook contract RED at 10 passes and one failure, then GREEN at
  11 passes with 92 assertions.
- [x] Mutation-prove independent status-only and corrupt-byte restoration
  tests, add a diff-only mutation proof, and contract-prove each rejected write
  with scoped adjacent pre/post assertions.
- [x] Behavior- and contract-mutation-prove terminal-only exact Git changes
  while rejecting unconfirmed normalized file-change evidence.
- [x] Bind the failed-proof guard to one typed `no-change` throw with accurate
  confirmed-evidence wording; mutation-prove body and message replacement.
- [ ] Complete immutable Correction 13 evidence and independent re-review with
  zero critical, important, or minor findings.

- [ ] **Final proof:** After preflight, run exactly one authorized simple
  workflow from current `origin/main`. Require exit zero, at most 600 seconds,
  reported usage, zero final review blockers, a ready pull request, green
  `CI / Verify` and every reported check, matching local/remote head SHA, and a
  SHA-locked squash merge. Then require the launcher to atomically bind every
  latest-open issue to that proving run at the canonical ledger commit.

---

## Correction 14: Causal, Independent Scout Candidates

**Failed run:** `20260713224535-26481` stopped at `reproduce-rank-1` after
117,746 ms. Reproduction received 64,948 ms of the exact 65,000 ms shared
budget. Its child transcript showed active tool progress, then explicitly found
that the rank-one empty-package-name premise was false. All three scout ranks
used the same production/test scope and repeated that premise, so timeout was a
candidate-quality symptom rather than premature cancellation.

**Root cause:** The packet paired `src/cli/embedded.ts` with
`tests/cli-run-output-validation.test.ts`. Hotspot rendering exposed adjacent
catch/throw fragments but omitted the `packageJsonName` consumer. The actual
consumer only compares metadata with a fixed package specifier; an empty name
already falls through to the embedded shim. The relevant behavior fixture is
`tests/cli-embedded.test.ts`.

**Decision:** Preserve the 65-second reproduce allocation, 560-second stage
total, and 600-second simple ceiling. Strengthen scout evidence and fallback
independence instead of buying time for false premises.

### Task 1: Behavior RED

- [x] Prove source selection prefers its closest tracked test over an unrelated
  higher-touch test.
- [x] Prove hotspot rendering retains causal context, not only adjacent lines.
- [x] Prove ranked candidates cannot collapse to one file scope.
- [x] Prove every candidate cites both rendered production and target-test
  lines.
- [x] Observe RED: 64 passes, 11 failures, 401 assertions across library and
  workflow contract tests.

### Task 2: Minimal Correction

- [x] Reserve one positive-overlap test for each source that has one before
  globally ranked extras. Maximize injective source coverage before overlap;
  never let a score-zero or shared test consume a later source's only match.
  Preserve each assignment in packet metadata and render it for synthesis.
- [x] Make every hotspot and no-hotspot first line mandatory, reserve the
  latest-commit prefix, then add complete context lines fairly through exact
  +/-16 hotspot boundaries while retaining up to 40 leading no-hotspot lines.
  Fail instead of slicing mandatory overflow.
- [x] Reject duplicate and non-target test paths. Require unique target tests
  plus one evidence-backed production path exclusive to each candidate while
  allowing shared support paths.
- [x] Require `testPath` to be a `tests/**/*.test.ts` behavior file in both
  scout and hydrated candidate schemas.
- [x] Require one real target-test citation and a real citation for every
  allowed production path. Validate only structured rendered-line markers so
  latest-commit prefix text cannot spoof evidence, and require the target test
  to be reserved for an allowed production path.
- [x] Render the exact allowed path list and require the reproduce turn to stop
  unchanged immediately after those paths disprove the causal claim.
- [x] Keep every timing constant and timeout classification unchanged.

### Task 3: Verification and Successor Proof

- [x] Initial focused GREEN: 147 passes, 643 assertions across library, runtime,
  contract, and artifact tests.
- [x] Review-fix GREEN: 177 passes and 743 assertions across the same focused
  suites, including exact context, path-order, decoy-citation, test-path,
  pair propagation, snapshot identity, effective timing, preflight coverage,
  round-robin fairness, prefix-overflow, and final-packet hotspot coverage.
- [x] Current-repository packet probe selected eight files and retained all 20
  hotspot markers in 19,995 characters with none missing.
- [x] Flow typecheck, repository lint, `bun run verify`, and
  `git diff --check` pass.
- [x] Correction 15 closes active repair/review timer overlap, fails launcher
  evidence finalization closed, proves ready-state/head/merge behavior, and
  binds new issue context.
- [x] Correction 16 closes the later locked-digest timing, branch, CI evidence,
  directive, gate, persistence, resolution, usage, and citation findings.
- [x] Reliability-audit GREEN: 183 passes and 795 assertions. The prior seven
  delivery, polling, timing, progress, preflight, and finalization mutants now
  fail their focused behavior or structural contracts.
- [ ] Run full deterministic verification and independent review with zero
  critical, important, or minor findings.
- [ ] Obtain fresh explicit authorization before any successor live run,
  push, pull-request creation, CI wait, or merge.
- [ ] Require the successor run to meet every original final-proof condition,
  then require launcher-owned canonical ledger closure for every latest-open ID.

---

## Correction 16: Locked-Digest Reliability Closure

**Goal:** Close every implementation and test-evidence gap found by the final
quality, specification, and adversarial audits before preflight or another live
authorization.

### Task 1: Behavior and Mutation RED

- [x] Reproduce the active/global timer bypass at all ten post-turn Git probes.
- [x] Prove config, baseline, or auth failure could persist an empty branch.
- [x] Prove successful remote-check rows were discarded before report write.
- [x] Kill wrong non-scout directive, missing targeted lint, changed full verify,
  citation-prefix, no-op issue call/write, no-op JSON write, and no-op seed
  resolver mutations.
- [x] Observe focused RED: 124 passes, 8 failures, and 671 assertions across
  library, contract, and artifact suites.

### Task 2: Minimal Correction

- [x] Require explicit active-stage remainder callbacks on every `pathDiff` and
  `changedPaths` call; remove their resettable default callbacks.
- [x] Export `ORCA_IMPROVEMENT_BRANCH`, validate its exact run-ID-derived value
  before config/backend/baseline work, and require Git to match it.
- [x] Persist final passing check rows, exact command log, timestamp, literal
  passed state, and the unchanged locally validated head SHA only after another
  ready-state/head assertion.
- [x] Count baseline repair usage once and extract behavior-tested pure helpers
  for branch validation, append-only latest-state derivation, and passed-check
  evidence. Launcher terminal commit now owns actual resolution.
- [x] Add behavior and AST mutation contracts for exact line citations, every
  node directive, targeted test/lint, single full verify, issue/report writes,
  seed-resolution wiring, branch identity, CI evidence, and timed Git probes.

### Task 3: Verification and Successor Proof

- [x] Focused GREEN: 193 passes and 851 assertions across all four ignored
  workflow suites; flow typecheck passes.
- [x] Refresh full deterministic gates, packet probe, and ordered 13-file digest.
- [ ] Obtain three fresh zero-finding audits against that exact digest.
- [ ] Run a new preflight-only launcher pass.
- [ ] Obtain fresh explicit authorization before one successor live run.
- [ ] Require every original final-proof condition, then require the launcher to
  atomically commit same-ID resolved records for every latest-open ledger ID.

---

## Correction 17: Count-Free Ledger Closure

**Goal:** Keep final proof closure complete as audit findings add ledger rows.

**Finding:** Correction 16 hard-coded a 16-entry remainder even though the
append-only ledger had grown to 26 latest-open IDs. A successful proving run
could therefore leave newer audit findings open while appearing complete.

### Task 1: Dynamic Closure Contract

- [x] Add a regression contract rejecting numeric open-ledger counts.
- [x] Require the successor proof to close every latest-open ID dynamically;
  launcher terminal commit supersedes workflow-owned correction appends.
- [x] Record focused evidence: 203 passes and 906 assertions across the four
  workflow suites before this correction.
- [x] Post-correction focused GREEN: 204 passes and 910 assertions; flow
  typecheck, shell syntax, and diff checks also pass.
- [ ] Re-run focused and full deterministic verification, lock a new ordered
  digest, and obtain three fresh zero-finding audits before preflight.
- [ ] Complete one authorized simple proof and verify every latest-open ledger
  ID resolves only in the launcher's hash-bound canonical ledger commit.

---

## Correction 18: Fail-Closed Proof Integrity

**Goal:** Bind every accepted proof to specific evidence and identical bytes,
including the ignored controls that Git does not normally observe.

**Findings:** Fresh quality and resilience audits found fourteen independent
gaps. Generic or regular-expression failure markers could accept unrelated RED
output; a missing, empty, malformed, multi-value, or seedless ledger reached
launcher side effects; workspace-writing agents could alter ignored `.orca`
controls or evidence; and verified worktree bytes were not compared with the
staged index and committed tree. Ten direct mutation gaps also allowed
implementation budget, CI evidence, usage, finalization, failed-gate evidence,
reproduction prompt evidence, full verification, merged-state checking,
count-free closure, or restoration failure propagation to be weakened.
Follow-up resilience review found six ways the two integrity controls could
still fail: symlink dereference, inconsistent path ordering, lax object-ID and
NUL parsing, a synchronous guard escape, unbounded or stalled manifest reads,
and commit-hook additions outside the validated path set. These remain bound to
the existing ignored-integrity and verified-content audit IDs.

The final locked-quality review found eleven additional proof-chain gaps:
ledger-excluding digest, unbound PR base, unbounded finalization, unproved
package-lock preservation, skipped checks counted green, unbounded terminal
settlement, output-only positive controls, stale post-agent Git metadata,
object-only ledger validation, unattested preflight/live bytes, and non-atomic
ledger replacement. Each has its own append-only open ledger row and must be
resolved by the same successor proving run.

A final launcher review mapped seven more proof gaps onto those same ledger
IDs: missing plan/spec copies made preflight impossible, setup and live commands
escaped the global deadline, `latest.json` could precede final status, stale
preflight success survived later failure, ledger locks lacked signal cleanup,
copied bytes raced their digest, and artifact harnesses missed those behaviors.

A finalization follow-up found that the report still shared retry behavior with
ordinary artifacts, individual actions could hang, a timed-out attempt could
settle late and race its retry, direct target writes were not atomic, and a
deadline failure could leave a passing report. A subsequent audit also showed
that a same-thread synchronous action could block the deadline timer and return
after expiry. The same review narrowed the authorized proof to Codex: accepting
an `ORCA_BACKEND=opencode` override would claim terminal managed-server shutdown
that this ignored workflow does not prove. OpenCode shutdown is deferred to a
separate source-runtime change.

A final commit-point review refined the deadline rule: a generic wrapper clock
read after rename could reinterpret an already committed atomic publication.
Non-publication actions therefore use the post-action remainder check, while a
publisher must capture one authentic positive decision after its temporary
write and immediately before rename, return it through the artifact action, and
have the wrapper accept that exact decision as terminal.

The next audit invalidated the 300-test focused checkpoint and successor digest
beginning `3eb`. Timer callbacks could run late after same-thread blocking, so
callback timing did not prove timely completion. The correction binds every
timer-based helper to an absolute completion timestamp, including terminal
settlement, retry allocation, generic deadline operations, and manifest reads.
It also moves the Codex-only guard ahead of the monitor and every preflight or
I/O surface.

The later frozen checkpoint
`e28a8885678089f1009b75829fa470ca03ba05f7fb4df0e18d901824d7b78530`
is also invalidated historical evidence. Its 319-test, 1,775-assertion GREEN did
not behaviorally protect every non-seed ledger-prefix byte or the final
package-lock existence and hash contract. The correction now runs mutation,
deletion, and reordering against both source and candidate ledgers. Each of the
six cases exits `65`, preserves source bytes, removes the lock, and leaves no
temporary merge file. Mutants reject a seed-only comparison and removal of
either prefix guard. A six-case package-lock finalizer matrix proves unchanged
success; changed, deleted, newly appeared, and different-byte recreation
failure; identical-byte recreation success; and every final existence and
SHA-256 result. The scout mutation diagnostic now says
`scout gather missing shared 10-second absolute deadline` and explicitly
rejects the stale 15-second diagnostic.

The next correction makes ledger-lock ownership exact. The launcher acquires
with `mkdir` and one unique `owner.<pid>.<nonce>` marker, verifies it is the sole
entry and belongs to the current live process, and begins every acquisition or
recovery iteration with the launcher deadline check. Empty locks use `rmdir`.
Only one exact inspected dead marker may be removed before `rmdir`; live,
malformed, and multiple-marker states remain untouched until bounded failure.
The main lock path is never renamed or recursively deleted. Normal release and
`TERM`, `INT`, or `HUP` cleanup remove only the caller's exact marker and merge
temporaries. Replacement-race tests prove stale recovery and release preserve a
successor owner's live marker. A symbolic-link lock directory is rejected before
enumeration, so recovery cannot remove a marker in its target.

The package-lock contract stages preflight success privately and repeats its
existence-and-SHA check before stable success publication. Changed,
disappeared, or newly appeared terminal drift exits `74`, clears a missing
after-hash, discards staging, and publishes only nonzero latest evidence.
Success publishes latest first and claimable preflight last; no fallible cleanup
follows that commit. The parent's post-run hash comparison verifies state after
process return.

The final pre-lock audit found three remaining gaps. Terminal staging allowed a
candidate-authored resolution to supersede a base-open row; the proving binary
was built from dirty source-worktree bytes while attesting only committed HEAD;
and one locked mutant changed timeout clamping instead of exercising swallowed
failure. Terminal candidate suffixes now retain only each ID whose latest row is
open, leaving canonical resolution to the launcher. Runtime build archives the
captured HEAD into a private directory and pins the copied executable from run
evidence. The mutation test now synthesizes a zero-exit command log after a
rejection. Three append-only audit rows bind these corrections to the successor
live proof.

The final bounded proving audits found four successor gaps. Cached passing CI
could survive until merge without a fresh check poll; local Git replacement refs
could substitute runtime archive bytes; ledger-merge signals all exited `143`;
and terminal closure tested only one open ID. Correction 19 repolls and persists
all-pass CI immediately before an unchanged-head recheck, archives with
replacement objects disabled, preserves signal-specific exits, and proves two
independent latest-open IDs close. The failed-run harness already executed and
asserted exact merged bytes; its explicit latest-state assertions reject the
auditor's proposed resolution leak directly.

Resumed bounded audits found three Correction 20 gaps. The final child wait
could overwrite a recorded signal, terminal monitor hashing trusted filesystem
order, and the repository had no server-enforced status check to close the race
between the last CI poll and merge. The corrected wrapper gives signals
precedence after child reaping and trap restoration. Terminal success accepts
one identity-matched Codex monitor with one clean completed outcome and no
failures. Merge requires strict admin-enforced `Verify` protection from workflow
`CI` before the fresh poll, fixed-head assertion, and SHA-locked merge command.

The terminal-binding audit found three Correction 21 gaps. Terminal commit
trusted hashes captured before latest publication, terminal staging copied
provisional resolutions into stable run-local evidence, and the terminal record
did not bind remaining `latest.json` metadata. The correction rehashes the
candidate ledger, staged canonical ledger, report, monitor, and cycle-free
latest projection under the terminal lock. It checks latest's ledger,
projection, and proof claims separately and keeps stable run-local issues
candidate-only until canonical rename.

The final protection and terminal-worker audit found four Correction 22 gaps.
GitHub emits required check context `Verify`; `CI` is separate workflow
metadata. Protection was checked too late, a recorded signal could precede the
terminal worker, and failed terminal publication could leave a success-shaped
staging ledger. Preflight now validates strict administrator-enforced
protection as its first gate, live revalidates it before attestation claim, the
worker refuses a pending signal, and failure removes terminal stage.

The source-identity audit found one Correction 23 gap. Both validators accepted
the `Verify` context without proving its producer. They now require the
protected check entry to bind `Verify` to GitHub Actions app ID `15368`, and
reject missing, unrestricted, or wrong-app entries.

Correction 23 verification exposed one Correction 24 test-harness gap. Two
process-heavy launcher tests passed immediately in isolation but exceeded
test-only caps under loaded-host scheduling. Success-path harness deadlines and
Bun test timeouts now tolerate process startup without changing production
deadlines or assertions.

Correction 25 closes the terminal-worker PID-capture race and a protection-test
false positive. A two-phase start and acknowledgement gate keeps the child from
executing until the parent has its PID and rechecks signals. The preflight test
requires both ordered calls to exist, exercises deletion of the protection
call, and anchors its final-wait signal injection after the new acknowledgement
wait.

Correction 26 closes bounded-capture signal deferral, terminal-stage cleanup,
and latent merge recovery. Shell behavioral RED produced six expected failures
plus one unrelated loaded-host timeout. It proved that command substitution
could defer the parent signal trap, and that signal or deadline paths after
terminal staging could leave success-shaped evidence. All 24 bounded output
captures now use `capture_before_deadline` in the main shell. Signal, timeout,
and finalizer cleanup remove terminal staging before prior-evidence
invalidation.

The merge behavioral RED was 0/1: `Expected []`; `Received ["merge must persist
its command result and confirm exact merged state even after a failed
response"]`. Merge now persists its exact SHA-locked `CommandLog` for every
result and always performs bounded authoritative confirmation. Latent success
requires the exact pull request URL and repository, base `main`, head ref, head
SHA, non-draft state, and `MERGED`. Failed confirmation after a passed command
surfaces the confirmation error; failure of both paths preserves both errors.

Correction 27 closes two frozen-audit races. Active-child deadline polling
invoked `bun` through command substitution, so a stalled clock deferred TERM
for 2,174 milliseconds against a 1,500-millisecond bound. Preflight also marked
terminal ownership before either rename; TERM immediately before the first
publication was recorded but ignored, and success exited `0` instead of `143`.

Remainder checks now assign from Bash's built-in `SECONDS` counter in the main
shell, while finalizer timestamps use bounded main-shell capture. Signals own
cleanup through latest publication. Live transfers ownership only before the
canonical ledger worker, and preflight only after its final rename returns.

### Task 1: Behavior and Contract RED

- [x] Reject generic failure markers in scout and hydrated candidate schemas.
- [x] Prove expected failure punctuation is literal, not a regular expression.
- [x] Prove manifest comparison rejects content, mode, deletion, and addition.
- [x] Prove manifest guards run after both successful and failed operations.
- [x] Use temporary repositories to prove ignored byte, mode, add, delete, and
  symlink mutations; synchronous failure checks; byte, entry, path, and deadline
  bounds; symlink worktree/index/commit equality; divergent trees; commit-hook
  additions; and no push path after mismatch.
- [x] Reject malformed NUL framing, non-blob modes, non-stage-zero index rows,
  non-40-or-64-character object IDs, and duplicate paths; normalize every
  manifest with deterministic bytewise path ordering independent of input
  order or letter case.
- [x] Reject missing, empty, malformed, multi-value, and altered-seed ledgers
  before build, fetch, worktree, or backend activity.
- [x] Add direct mutation contracts for all ten previously indirect invariants.
- [x] Add direct mutants for a no-op ignored guard, index/commit delegation to
  worktree capture, swallowed manifest mismatch, and bypassed committed path
  comparison.
- [x] Record behavior RED for separating the terminal report from retryable
  artifacts; bounding asynchronous shutdown, ledger, monitor, and report
  actions; aborting and invalidating stale attempts; atomic publication; and
  rejecting a passing report after deadline failure.
- [x] Add the synchronous-overrun RED and a side-effect witness proving that a
  non-empty `ORCA_BACKEND` other than `codex` is rejected before monitor,
  preflight, filesystem, config, command, or backend work.
- [x] Add commit-point mutants that reject a decision before the temporary
  write, relocated away from the immediate pre-rename position, after rename,
  forged rather than returned by the context, requested more than once, or
  followed by fallible post-rename cleanup.
- [x] Prove all timer helpers use absolute completion checks with equality
  rejected. Cover settled-late success and rejection, pending cancellation and
  bounded settlement, no redundant cancellation, one total-remainder retry
  snapshot, total-expiry suppression, manifest equality, and blocked evidence
  commit. Prove timeout usage and terminal evidence remain JSON-safe.
- [x] Prove expiry immediately before claimable preflight publication leaves no
  stable success, a signal after the rename remains owned by the successful
  commit, invalidation continues after a preflight quarantine rename fails,
  live rejects a claim whose quarantined latest evidence is missing or
  superseded, and failed latest retraction cannot retain a success-shaped
  `latest.json`.
- [x] Prove terminal staging rejects candidate authority over a base-open ID and
  still emits the launcher's canonical resolution row.
- [x] Prove a dirty tracked runtime input cannot affect the executable built for
  an attested committed HEAD.
- [x] Replace the timeout-only required-command mutant with a synthetic-success
  failure-swallow mutant.
- [x] Reproduce replace-ref runtime substitution and signal-specific status loss
  before editing the launcher.
- [x] Reject a merge contract that consumes only the earlier passing CI snapshot.
- [x] Seed two independent terminal open IDs and assert both latest states close.
- [x] Reproduce signal loss exactly at the final child wait.
- [x] Reject multiple, identity-mismatched, and failed terminal monitors.
- [x] Reject merge delivery without strict admin-enforced `Verify` from workflow
  `CI`.
- [x] Reject report, monitor, latest metadata, ledger-claim, proof-claim, and
  latest-projection-claim mutation after terminal staging.
- [x] Prove signal and timeout after terminal staging leave stable run-local
  issue evidence candidate-only.
- [x] Prove post-rename recovery requires one exact terminal record, matching
  final-ledger hash, cycle-free latest projection, and embedded claims.
- [x] Reject called `not`, `resolves`, and `rejects` modifiers, unknown terminal
  matchers, and unknown intermediate matcher properties while preserving valid
  property-modifier chains.
- [x] Reproduce a successful bounded-command leader that leaves a delayed
  background writer alive, then require nonzero status and no delayed write.

### Task 2: Fail-Closed Implementation

- [x] Guard baseline repair, reproduction, implementation, targeted repair, and
  review repair with before/after ignored `.orca` content manifests.
- [x] Bound ignored-manifest entry count, path bytes, content bytes, and every
  filesystem wait; hash symbolic-link text rather than its target file.
- [x] Capture the verified candidate manifest after `bun run verify`; compare it
  with the pre-stage worktree, staged index, and committed tree before push.
- [x] Parse index and commit manifests through one binary path ordering and
  strict framing/mode/object-ID contract; reject every extra committed path
  before push, including paths introduced by commit hooks.
- [x] Validate the source ledger and exact historical seed as the launcher's
  first evidence operation; exit `65` without modifying invalid input.
- [x] Append fourteen open audit rows without rewriting existing ledger rows.
- [x] Separate retryable ledger and monitor artifacts from one terminal report;
  pass abort, generation-current, attempt, and remaining-time context into
  run-and-attempt-unique same-directory atomic publication. Non-publication
  actions recheck the remainder after completion. A publisher captures one
  authentic positive commit decision immediately after its temporary write and
  immediately before rename; issue, monitor, and report actions return that
  decision, and the wrapper treats it as terminal without a later
  reclassification. Pre-publication cleanup removes only the attempt's
  temporary file, preserves the publication error as primary, and attaches any
  cleanup failure as secondary. Successful rename returns immediately with no
  cleanup or other fallible work.
- [x] Pin the proving workflow to default or explicit Codex before side effects,
  and keep OpenCode managed shutdown as deferred source-runtime work.
- [x] Make `awaitBounded` retain terminal completion time, usage, and normalized
  JSON-safe evidence. Convert overdue settled outcomes into owned timeouts
  without cancellation; cancel a pending timeout once and await its bounded
  terminal settlement.
- [x] Give `awaitOneTimeoutRetry` one total-remainder snapshot with settlement
  reserve. Retry only the first exact owned timeout while retry time remains;
  never retry an unrelated cancellation or any outcome at/after total expiry.
- [x] Make `awaitWithinDeadline` and manifest operations reject late success,
  late rejection, and exact-deadline equality before returning or committing
  evidence. Run the non-Codex guard before monitor, preflight, filesystem,
  config, command, or backend work.
- [x] Bind ledger merge to the complete captured prefix for both source and
  candidate ledgers. Prove mutate, delete, and reorder failures exit `65`
  without changing source bytes or leaving lock and temporary artifacts, and
  reject seed-only and removed-guard mutants.
- [x] Prove the protected package lock through six final existence and SHA-256
  cases: unchanged and same-byte recreation succeed; changed, deleted,
  appeared, and different-byte recreation fail.
- [x] Correct the scout gather contract diagnostic to the shared 10-second
  absolute deadline and reject the stale 15-second message.
- [x] Acquire the ledger lock through `mkdir` and one exact unique owner marker;
  verify sole ownership, bound every loop attempt, recover only one exact dead
  marker with `rmdir`, fail closed on symlinked directories, malformed states,
  or multiple entries, and prove signal, release, stale-recovery, and
  replacement-owner races.
- [x] Stage preflight privately; recheck package-lock existence and SHA before
  stable success; convert changed, disappeared, or appeared drift to status
  `74`; publish latest first; and publish claimable preflight last.
- [x] Install the full finalizer trap before prior-evidence invalidation. Move
  stable preflight and latest evidence into run-unique same-directory
  quarantines, continue through both paths after one rename failure, and bind a
  live claim to matching quarantined latest success. Stage new success
  privately,
  print diagnostics, obtain immediate positive decisions before latest and
  preflight renames, commit preflight only at its final rename, abort live mode
  on a signal before canonical ledger commit, and replace an unretractable
  success with an atomic failure tombstone.
- [x] Keep candidate resolutions provisional. On failure, merge only each
  candidate ID's latest-open row. On live success, reject concurrent source
  suffixes and atomically rename a zero-open canonical ledger with one exact
  terminal record binding candidate-ledger, report, and monitor hashes.
- [x] Treat `latest.json` as non-authoritative. Prove SIGKILL and TERM before
  canonical ledger commit cannot authorize success, and allow post-rename
  recovery only through the exact terminal record and final ledger hash.
- [x] Reserve terminal-report time for failure issue and monitor republication.
- [x] Append six terminal-protocol audit rows without rewriting prior history.
- [x] Append three final pre-lock audit rows without rewriting prior history.
- [x] Build the proving runtime from an archive of captured HEAD and pin the
  copied executable under run evidence.
- [x] Filter terminal candidate suffixes to latest-open rows before launcher
  resolution.
- [x] Disable Git replacement objects while archiving the captured runtime HEAD.
- [x] Repoll GitHub checks immediately before merge, persist fresh all-pass
  evidence, and reassert the unchanged ready head before the merge command.
- [x] Preserve `TERM`, `INT`, and `HUP` ledger-merge exits as `143`, `130`, and
  `129` while retaining exact-marker cleanup.
- [x] Append four final proving-audit rows without rewriting prior history.
- [x] Reap the final child and restore caller traps before returning a recorded
  signal status.
- [x] Select exactly one monitor and validate its filename identity, backend,
  clean completed outcome, summary, and empty failures before terminal hashing.
- [x] Require strict `Verify` branch protection from workflow `CI`, pinned to
  GitHub Actions app ID `15368`, with administrator enforcement before the final
  check poll and merge.
- [x] Append three Correction 20 audit rows without rewriting prior history.
- [x] Rehash candidate, staged canonical, report, monitor, and latest projection
  evidence under the terminal lock immediately before canonical rename.
- [x] Keep stable run-local issue evidence candidate-only until canonical
  commit; never copy provisional resolved rows into it.
- [x] Bind the terminal record to the cycle-free latest projection and validate
  latest's ledger, projection, and proof claims separately.
- [x] Append three Correction 21 audit rows without rewriting prior history.
- [x] Append four Correction 22 audit rows without rewriting prior history.
- [x] Append one Correction 23 audit row without rewriting prior history.
- [x] Append one Correction 24 audit row without rewriting prior history.
- [x] Append two Correction 25 audit rows without rewriting prior history.
- [x] Append three Correction 26 audit rows without rewriting prior history.
- [x] Replace all 24 bounded command-substitution captures with main-shell
  capture and remove terminal staging before signal, timeout, or finalizer
  invalidation.
- [x] Persist every SHA-locked merge attempt, confirm exact merged state after
  every response, and preserve both errors when command and confirmation fail.
- [x] Append two Correction 27 audit rows without rewriting prior history.
- [x] Remove external clock work from active-child deadline polling, bound both
  finalizer clock reads, and raise main-shell bounded captures to 26.
- [x] Keep terminal ownership false through latest publication and until live
  canonical commit begins or the preflight final rename returns.
- [x] Carry allowed production path plus exported entrypoint through semantic
  taint and reject a RED assertion that switches exports within the same file.
- [x] Replace the concurrent same-ID ledger harness's fixed delay with a
  bounded marker handshake after its base snapshot and before conflict review.
- [x] Append two Correction 28 audit rows without rewriting prior history.
- [x] Bind semantic production taint to lexical symbol identity; shadowing
  declarations and untainted reassignments must clear an outer origin.
- [x] Require candidate source to equal baseline raw bytes plus one exact
  contiguous top-level-test insertion, and reject inserted disabling directive
  tokens.
- [x] When canonical quarantines and reused private fallbacks are both occupied,
  clear or reallocate fresh current-run private paths, retry preflight signal
  retraction, and verify canonical preflight and latest success absent.
- [x] Append three Correction 29 audit rows without rewriting prior history.
- [x] Require one allowlisted terminal Bun matcher after only recognized
  property modifiers; reject called modifiers and unknown properties.
- [x] After a bounded-command leader exits, terminate residual process-group
  members and convert a would-be success to exit `125` before finalization.
- [x] Append two Correction 30 audit rows without rewriting prior history.
- [x] Require the positive-control production result to reach an allowlisted
  Bun matcher and require the exact RED marker on the target `(fail)` record.
- [x] Decode source as fatal UTF-8 while retaining BOM bytes in the additive
  proof.
- [x] Terminate inherited-token descendants that escape into another process
  group or session, and fail closed when owner inspection fails.
- [x] Append four Correction 31 audit rows without rewriting prior history.
- [x] Reject unreachable causal matchers and exact-marker prefix collisions.
- [x] Isolate host owner scans from unrelated finalizer harnesses while keeping
  dedicated real process tests.
- [x] Filter owner scans before persistence so temporary state contains matched
  PID lines only, with `ps` and filter failures propagated through pipefail.
- [x] Append four Correction 32 audit rows without rewriting prior history.
- [x] Propagate label-scoped exits and reject optional calls or indexes that can
  skip production or matcher evaluation.
- [x] Apply matching reachability, production-origin, and side-effect rules to
  controls and RED tests; nested evaluated writes and invoked local behavior
  invalidate exact provenance.
- [x] Require passive matcher arguments independent of the received value,
  reject `toSatisfy`, restrict later production-call arguments after exact
  observation, and preserve named or namespace origins through safe `await`.
- [x] Require the RED marker to be absent from baseline source and retain the
  exact single added test's nonempty static name.
- [x] Run only the anchored and escaped exact RED test name, then require one
  matching `(fail)` record and one canonical Bun summary proving zero passes,
  one failure, nonzero expectation calls, one test, and one file; duplicate or
  contradictory summary fields fail closed.
- [x] Append eleven Correction 33 audit rows without rewriting prior history.
- [x] Require matcher-argument const bindings to resolve recursively to
  primitives and reject effectful bindings.
- [x] Make the reproduction agent run the filtered control and exact named RED
  command instead of requiring whole-file RED.
- [x] Append two Correction 34 audit rows without rewriting prior history.
- [x] Reject mutable const matcher containers and remove prototype-dependent
  `toBeOneOf` from causal proof.
- [x] Validate inline object-literal values without treating keys as bindings,
  and accept only unshadowed global `undefined`.
- [x] Append three Correction 35 audit rows without rewriting prior history.
- [x] Install one deadline-bound, byte-verified frozen Bun matcher preload before
  both controls, exact named RED, and post-fix targeted GREEN.
- [x] Classify causal matcher failures before expect-integrity failures, while
  rejecting aliases, extensions, escaped assertion objects, and prototype
  writes.
- [x] Append one Correction 36 audit row without rewriting prior history.
- [x] Trace transitive named proof wrappers and reject direct, aliased, hoisted,
  or indirect pre-install execution while accepting post-install safe hoisting.
- [x] Append one Correction 37 audit row without rewriting prior history.
- [x] Resolve proof-wrapper closure by TypeScript binding identity and compare
  runtime wrapper invocation order rather than declaration position.
- [x] Append two Correction 38 audit rows without rewriting prior history.
- [x] Give the five-case fresh-preflight harness a 15-second test timeout while
  retaining every launcher, preflight, stage, and live deadline.
- [x] Append one Correction 39 audit row without rewriting prior history.
- [x] Record the frozen digest, zero-finding audits, passing preflight, and the
  authorized live run's pre-backend compiled-loader failure.
- [x] Enable Bun runtime package metadata loading in local and release binaries,
  replace release source-syntax validation with the host-native release smoke,
  and prove both compiled paths can import a project package.
- [x] Append one Correction 40 live-run row without rewriting prior history.
- [x] Historical checkpoint: all four focused suites, flow typecheck, shell
  syntax, diff checks, and full deterministic verification passed after the
  launcher corrections and before the finalization/backend-pin follow-up.

### Task 3: Locked Successor Proof

- [x] Invalidated checkpoint: 300 focused tests and the digest beginning `3eb`
  are historical evidence only.
- [x] Invalidated frozen checkpoint:
  `e28a8885678089f1009b75829fa470ca03ba05f7fb4df0e18d901824d7b78530`
  captured 319 tests and 1,775 assertions before the coverage audit.
- [x] Latest-correction focused GREEN: 327 tests and 1,963 assertions across
  all four workflow suites.
- [x] Invalidated corrected checkpoint: 328 focused tests and 1,984 assertions
  across all four workflow suites before the post-checkpoint finalization audit.
- [x] Invalidated finalization-correction checkpoint: 331 focused tests and
  2,013 assertions before the pre-lock audit corrected its fault boundaries.
- [x] Invalidated pre-lock correction checkpoint: 331 focused tests and 2,016
  assertions before the terminal-ledger protocol audit.
- [x] Invalidated terminal-protocol checkpoint: 340 focused tests and 2,061
  assertions across all four workflow suites before the final pre-lock audit.
- [x] Invalidated final pre-lock checkpoint: 342 focused tests and 2,086
  assertions across all four workflow suites before Correction 19.
- [x] Invalidated Correction 19 focused checkpoint: 342 tests and 2,103
  assertions across all four workflow suites before the resumed bounded audit.
- [x] Invalidated Correction 20 checkpoint: terminal-binding audit found
  cross-file revalidation, provisional run-evidence, and latest-projection gaps.
- [x] Correction 21 focused checkpoint: 348 tests and 2,176 assertions across
  all four workflow suites. Flow typecheck, exact ledger validation, lint,
  documentation link, symbol, signature, shell, diff, and full verification
  pass; full verification records 461 passes, one gated skip, and 1,317
  assertions.
- [x] Correction 22 deterministic checkpoint: 352 focused tests and 2,208
  assertions pass; flow typecheck, exact ledger validation, shell syntax, diff
  checks, and full verification pass. Full verification records 461 passes, one
  gated skip, and 1,317 assertions.
- [x] Correction 23 and 24 deterministic checkpoint: 352 focused tests and
  2,215 assertions pass; flow typecheck, exact 80-row ledger validation, shell
  syntax, diff checks, and full verification pass. Full verification records
  461 passes, one gated skip, and 1,317 assertions.
- [x] Correction 25 runtime and test checkpoint: 353 focused tests and 2,227
  assertions pass. The exact 80-row ledger prefix is unchanged and two open
  audit rows bring the append-only ledger to 82 rows. Final deterministic gates
  run on these recorded bytes before digest lock.
- [x] Correction 26 runtime and test checkpoint: 363 focused tests and 2,353
  assertions pass. The exact 82-row prefix has SHA-256
  `ed4306a940db3275dec36e3bd91e61e7a942bdecd1f57d46f351aa7f934f91ec`;
  three open rows bring the append-only ledger to 85 unique rows. Correction
  25's 353-test, 2,227-assertion, 82-row checkpoint remains historical. Full
  deterministic verification passes 461 tests with one gated skip, zero
  failures, and 1,317 assertions.
- [x] Invalidated Correction 26 predecessor digest: the historical
  fourteen-artifact digest is recorded only as abbreviated `d603...4e60`. It
  is invalid and non-reconstructable; missing hexadecimal characters must not
  be invented.
- [x] Correction 27 deterministic checkpoint: 365 focused tests and 2,367
  assertions pass. The exact 85-row prefix has SHA-256
  `6478fc33be4155396e3cd2aaa3355016b5c3107706580f4bcb90a3da8a4c0418`;
  two open rows bring the append-only ledger to 87 unique rows. Full
  deterministic verification passes 461 tests with one gated skip, zero
  failures, and 1,317 assertions.
- [x] Invalidated Correction 27 predecessor digest:
  `b039dd863b146132233239d1003bb3f41f48f336b5160b2bc270169bbe7afc77`.
- [x] Correction 28 deterministic checkpoint: 366 focused tests and 2,377
  assertions pass. The exact 87-row prefix has SHA-256
  `d1580b5f595fbbbf4325d08aee3afcce15f2a4a9fb19c4c1714673c3e06587ad`;
  two open rows bring the append-only ledger to 89 unique rows. Full
  deterministic verification passes 461 tests with one gated skip, zero
  failures, and 1,317 assertions.
- [x] Invalidated Correction 28 predecessor digest:
  `89a9381f4734052151a3329d56fce2c96d2a0b6518123e9ae303e4a05890e0d8`.
- [x] Invalidated Correction 29 predecessor digest:
  `9c3824b40178183c2af42ea068063412d896f6f4ec5caa78faf07cc23da3dc24`.
  Lexical taint shadowing, non-raw additive proof with disabling-directive gaps,
  and occupied-quarantine signal retraction invalidate those exact bytes.
- [x] Correction 29 deterministic checkpoint: 371 focused tests and 2,427
  assertions pass. The exact 89-row ledger prefix retains SHA-256
  `e897a979014f817046b766f9063e7021dceab6181e335cb9339aca3b466f3a32`;
  three open rows bring the append-only ledger to 92 unique rows. Flow
  typecheck, exact ledger validation, shell syntax, documentation links, diff
  checks, and full verification pass. Full verification records 461 passes,
  one gated skip, zero failures, and 1,317 assertions.
- [x] Invalidated Correction 29 successor digest:
  `be08eb2843d4163f22d76edfa0617e7f7a98b34063f86afaa507f1c70ffe179a`.
  A called matcher modifier and a successful leader with surviving process-group
  descendants invalidate those exact bytes.
- [x] Correction 30 deterministic checkpoint: 373 focused tests and 2,447
  assertions pass. Flow typecheck, exact ledger validation, shell syntax,
  documentation links, diff checks, and full verification pass. Full
  verification records 461 passes, one gated skip, zero failures, and 1,317
  assertions. The checkpoint retains
  the exact 92-row ledger prefix with SHA-256
  `3c2e9579ff986a29c35a5038548b28e635a94f57606d17c28bcfcbf5a8daa013`,
  with 94 unique rows after the two open appends.
- [x] Invalidated Correction 30 successor digest:
  `c6749dcf831c1070755e602a57baf97e8f628e11284abda53cd0359f54e4d2d4`.
  A non-causal control matcher, unrelated RED failure, stripped UTF-8 BOM, and
  detached `setsid()` descendant invalidate those exact bytes.
- [x] Correction 31 audit checkpoint: the exact 94-row prefix has SHA-256
  `6ba0aaa3319134b5f8b1261806adb68b2f782ac17c433e6221d7496660fc4b4d`;
  four open rows bring the ledger to 98 unique rows with SHA-256
  `89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`.
  No digest was frozen because audit found an unreachable control matcher and
  RED marker-prefix collision, while the default artifact suite exposed live
  owner-scan test coupling and raw-environment persistence.
- [x] Correction 32 deterministic checkpoint: 384 focused tests and 2,496
  assertions pass. The exact 98-row prefix retains SHA-256
  `89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`;
  four open rows bring the append-only ledger to 102 unique rows with SHA-256
  `021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`.
- [x] Correction 33 semantic checkpoint: all four focused suites pass at 406
  tests and 2,663 assertions: 84 library, 157 runtime, 82 contract, and 83
  artifact tests. Flow typecheck passes. The exact 102-row prefix retains
  SHA-256
  `021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`;
  eleven open rows bring the append-only ledger to 113 unique rows with SHA-256
  `d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`.
  Full deterministic verification passes 461 tests with one gated skip, zero
  failures, and 1,317 assertions. The successor digest, three audits, preflight,
  and live run remain pending.
- [x] Correction 34 ledger checkpoint: the exact 113-row prefix retains SHA-256
  `d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`;
  two open rows bring the append-only ledger to 115 unique rows with SHA-256
  `20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`.
- [x] Correction 35 ledger checkpoint: the exact 115-row prefix retains SHA-256
  `20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`;
  three open rows bring the append-only ledger to 118 unique rows with SHA-256
  `aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`.
- [x] Correction 36 focused checkpoint: all four suites pass at 417 tests and
  2,715 assertions: 84 library with 323 assertions, 167 runtime with 682, 83
  contract with 704, and 83 artifact with 1,006. Flow typecheck passes. The
  exact 118-row prefix retains SHA-256
  `aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`;
  one open row brings the append-only ledger to 119 unique rows with SHA-256
  `bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`.
  Full deterministic verification, the successor digest, three audits,
  preflight, and live run remain pending.
- [x] Correction 37 ledger checkpoint: the exact 119-row prefix retains SHA-256
  `bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`;
  one open row brings the append-only ledger to 120 unique rows with SHA-256
  `625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`.
- [x] Correction 38 focused checkpoint: 85 contract tests with 716 assertions
  pass, and flow typecheck passes. The exact 120-row prefix retains SHA-256
  `625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`;
  two open rows bring the append-only ledger to 122 unique rows with SHA-256
  `189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`.
  The full artifact suite exposed the Correction 39 harness-timeout gap.
- [x] Correction 39 focused checkpoint: all four suites pass at 419 tests and
  2,727 assertions: 84 library with 323 assertions, 167 runtime with 682, 85
  contract with 716, and 83 artifact with 1,006. Flow typecheck passes. The
  exact 122-row prefix retains SHA-256
  `189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`;
  one open row brings the append-only ledger to 123 unique rows with SHA-256
  `71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`.
  Full deterministic verification, the successor digest, three audits,
  preflight, and live run remain pending.
- [x] Correction 40 loader checkpoint: frozen digest
  `65f7e553e851d657cdc220ec72660dfc5dba1b356fa31a461dd54ed5077b816b`,
  three literal `ZERO FINDINGS` audits, and preflight
  `20260716182959-15561` passed. Authorized live run
  `20260716183318-48343` exited 1 after 17,815ms before backend startup because
  the compiled runtime could not resolve installed `typescript`. The local
  binary smoke failed RED and passed GREEN after enabling runtime package
  metadata loading. The host-native release smoke replaces release
  source-syntax validation by invoking the real release-builder entrypoint and
  executing its unarchived artifact. Its autoload-removal mutation proof failed
  with the retained resolution error and passed after the flag was restored.
  Strict release-option tests, typecheck, touched-file lint, release validation,
  embedded-loader tests, and retained inert runtime import pass. The exact
  123-row prefix
  retains SHA-256
  `71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`;
  one open row brings the ledger to 124 unique rows with SHA-256
  `fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`.
  All four focused suites pass at 419 tests and 2,727 assertions, and full
  verification passes 466 tests with one gated skip, zero failures, and 1,336 assertions.
  Successor digest, audits, and preflight remain pending; another live run
  requires fresh explicit authorization.
- [x] Correction 41 absolute-deadline checkpoint: successor digest
  `16e2c3824553866e404fccd4eaf7e8b3930db28f81894a7e9e68c9c7ff866748`
  is invalid. Whole-second launcher remainder accounting could publish live
  canonical-ledger or preflight success up to 999 milliseconds after the exact
  deadline. Default decisions now subtract a fresh validated `now_ms` from
  `launcher_deadline_at_ms`; active-child polling stays shell-native, starts
  from an exact remainder, and rechecks exact time after success. Deterministic
  live and preflight expired-deadline harnesses failed RED with exit 0 and pass
  GREEN by publishing no canonical success. The prior stalled-clock signal
  harness remains green. The exact 124-row prefix retains SHA-256
  `fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`;
  one open row brings the ledger to 125 unique rows with SHA-256
  `952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`.
  All four focused suites pass at 421 tests and 2,737 assertions: 84 library
  with 323 assertions, 167 runtime with 682, 85 contract with 716, and 85
  artifact with 1,016. Full verification passes 466 tests with one gated skip,
  zero failures, and 1,336 assertions. A new digest, three audits, and preflight
  remain pending; another live run requires fresh authorization.
- [x] Correction 42 terminal-ledger commit checkpoint: Correction 41 expired
  before first publication and missed the interval between latest publication
  and canonical-ledger rename. The worker could rename before the wrapper's
  exact post-action check, and matching committed hashes converted that timeout
  back to success. Terminal commit now makes a fresh exact deadline decision
  immediately before rename. A boundary harness keeps 4.9 seconds of polling
  budget and advances only the exact clock after hash binding. RED expected
  exit 74 but received 0 with a committed ledger; GREEN exits 74, retracts
  success-shaped latest evidence, and preserves the ledger. Post-rename
  recovery and the stalled-clock signal guard remain green. The exact 125-row
  prefix retains SHA-256
  `952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`;
  one open row brings the ledger to 126 unique rows with SHA-256
  `9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`.
  All four focused suites pass at 422 tests and 2,743 assertions: 84 library
  with 323 assertions, 167 runtime with 682, 85 contract with 716, and 86
  artifact with 1,022. Full verification passes 466 tests with one gated skip,
  zero failures, and 1,336 assertions. Fresh reviews, a new digest, three audits,
  and preflight remain pending; another live run requires fresh authorization.
- [x] Correction 43 proof-sensitivity checkpoint: frozen digest
  `14b684dc4829740debc908b96b1ce00cd47d605ff5958deca10aed485d87590f`
  is invalid. The expiry harness advanced exact time after only the staged-ledger
  hash and used `now_ms=6000` against deadline `5000`. An early relocated
  decision and a strict-before `-lt` equality mutant therefore both remained
  green. The harness now flips exact time after the final binding decision and
  uses exact equality. Both mutation proofs failed RED because the weakened
  launchers still returned 74 and pass GREEN by returning 0; the production
  regression exits 74. Post-rename recovery and stalled-clock signal handling
  remain green. The exact 126-row prefix retains SHA-256
  `9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`;
  two open rows bring the ledger to 128 unique rows with SHA-256
  `2476a42e688b8d125a8d5765bd366f514a38ac99c81e711e1415d2b48d935ec9`.
  All four focused suites pass at 424 tests and 2,756 assertions: 84 library
  with 323 assertions, 167 runtime with 682, 85 contract with 716, and 88
  artifact with 1,035. Full verification passes 466 tests with one gated skip,
  zero failures, and 1,336 assertions. A new digest, three audits, and preflight
  remain pending; another live run requires fresh authorization.
- [x] Correction 44 compact-scout evidence checkpoint: authorized run
  `20260717000416-46151` failed in scout before edits, push, PR, CI, or merge.
  Its first scout attempt saw 73,245 model-visible input characters,
  establishing prompt-size correlation; reasoning-effort causality remains
  unproven.

  Compact rendering emits one `File: <path>` header followed by numbered source
  lines, while citations remain `<path>:<line>`. Offline replay over the exact
  failed-run files rendered 9,998 characters under the 10,000-character cap and
  retained every required hotspot. The 100-second scout allocation remains 10
  seconds for gathering, at most two fresh 40-second synthesis attempts, and 10
  seconds for validation.

  Append-only ledger row 129 is retained; its current SHA-256 is
  `96c1c4df54aa386adef1ceea1154b4925476095249966eafe0b9988351f6274a`.
  Full verification, successor manifest/audits, and preflight remain pending.
  Another live run requires fresh explicit authorization.
- [x] Correction 45 frozen-audit fix checkpoint:
  `audit-scout-validation-reserve-deadline`,
  `audit-candidate-citation-token-boundary`, and
  `audit-current-scout-plan-evidence-cap` showed that early synthesis left
  validation able to consume the whole scout remainder, forged prefix,
  nested-path, and line-suffix text satisfied rendered markers, and the current
  imperative Task 2 snippet still prescribed `20_000`.

  Scout validation now starts one absolute 10-second validation deadline
  immediately after synthesis, bounds every tracked-path operation by its
  shared remainder, and performs a final remainder check. Candidate citations
  now require exact citation-token boundaries. The current Task 2 snippet uses
  the normative 10,000-character cap and names the validation-limit constant.

  Three append-only open audit rows bring the ledger to 132 rows and 132 unique
  IDs with SHA-256
  `1ebfb5e0bec4d7f3fd4db71c8550ab7193e181e52c733ae8850bbcd7a0f261f1`.
  Focused library, contract, and artifact regressions pass. Prompt-size
  correlation and the unproven reasoning-effort causality conclusion are
  unchanged. Full verification, a new manifest, three fresh audits, preflight,
  and any live run remain pending. Another live run requires
  fresh explicit authorization.
- [x] Correction 46 harness-timeout fix checkpoint: the aggregate library,
  contract, and artifact gate exposed
  `terminal package-lock drift blocks success publication` as a behavioral
  RED. The test runs three subprocess harnesses under Bun's default 5-second
  timeout; it timed out in the aggregate gate and took 4.98 seconds isolated.
  Only this existing three-scenario artifact test now has an explicit
  15-second timeout, matching its neighboring harness.

  Append-only open row `review-terminal-package-lock-harness-timeout` brings
  the ledger to 133 rows and 133 unique IDs with SHA-256
  `07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347`.
  The focused target and artifact proof pass 1/1 each, the isolated artifact
  suite passes 91/91, and the aggregate gate passes 262/262. Full verification,
  a new manifest, three fresh audits, preflight, and any live run remain
  pending. Another live run requires fresh explicit authorization.
- [x] Correction 47 finalizer-harness timeout-policy checkpoint: the complete
  four-suite gate exposed
  `successful terminal publication validates monitor identity and outcome`
  timing out after 5003.72 milliseconds. It expected launcher exit 74 but
  received timeout status 143. An AST inventory found 31 finalizer-harness tests,
  33 static calls, and 52 loop-expanded subprocess runs.
  The 24 default-timeout tests relied on Bun's five-second default, six already
  declared 15 seconds, and the named six-scenario mutation test declared 30
  seconds. Every ordinary test now declares a 15-second timeout; the mutation
  test retains its 30-second timeout. An AST guard locks the 31-test, 33-call,
  and 52-run expansion. It rejects indirect harness references and duplicate
  exception titles.
  It permits exactly one six-scenario 30-second exception.
  It rejects reduced scenario sets.

  Append-only open row `review-finalizer-harness-timeout-policy` preserves the
  exact 133-row prefix with SHA-256
  `07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347`
  and brings the ledger to 134 rows and 134 unique IDs with SHA-256
  `24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f`.
  The isolated artifact suite passes 93/93 with 1,317 assertions, and the
  four-suite aggregate passes 431/431 with 3,064 assertions. Full verification
  records 466 passes, one gated skip, zero failures, and 1,336 assertions. A
  new manifest, three fresh audits, preflight, and any live run remain pending.
  Another live run requires fresh explicit authorization.
- [x] Correction 48 unconditional-scenario checkpoint: the frozen-byte policy
  audit found `audit-finalizer-harness-conditional-skip`. The first AST guard
  counted six declared loop elements, but a conditional `continue` could skip
  one at runtime while preserving 31 tests, 33 calls, 52 expanded runs, and an
  empty issue list.

  The sole 30-second exception must now use one top-level `for...of` loop whose
  first body statement is an unconditional top-level harness call awaited into
  one variable. Conditional, early-exit, alternate-loop, nested, and labeled
  control flow are rejected. A mutation regression proves all six scenarios
  must execute. The loop must enumerate the exact six unique mutation literals;
  duplicate literals and spread elements are rejected.

  Append-only open row `audit-finalizer-harness-conditional-skip` preserves the
  exact 134-row prefix with SHA-256
  `24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f`
  and brings the ledger to 135 rows and 135 unique IDs with SHA-256
  `f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3`.
  Focused policy and proof verification passes. The isolated artifact suite
  passes 94/94 with 1,405 assertions, and the four-suite aggregate passes
  432/432 with 3,152 assertions. Full verification records 466 passes, one
  gated skip, zero failures, and 1,336 assertions. A new manifest, three fresh
  audits, preflight, and any live run remain pending.
  Another live run requires fresh explicit authorization.
- [x] Correction 49 exact-scenario checkpoint: the Correction 48 frozen-byte
  audits found `audit-finalizer-harness-scenario-binding`,
  `audit-finalizer-harness-global-loop-control`,
  `audit-finalizer-harness-option-integrity`,
  `audit-finalizer-harness-scenario-identity`, and
  `audit-finalizer-harness-callable-identity`.

  All seven harness loops require exact scenario-array digests.
  They require exact scenario-to-option selector paths.
  They use inline non-spread scenario literals.
  They use const loop bindings and a first awaited harness call.
  Remaining values are pure harness options with unique static keys.
  Pre-loop and post-call returns, breaks, catching try blocks, conditional
  skips, spreads, computed overrides, assignments, calls, and irrelevant
  bindings fail closed.
  The file retains one top-level `runFinalizerHarness`.
  It retains one top-level `terminalMonitorFixture`.
  Both are used only through direct calls.

  The exact 135-row ledger prefix retains SHA-256
  `f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3`.
  Five append-only open rows bring the ledger to 140 rows and 140 unique IDs
  with SHA-256
  `401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
  Deterministic verification also exposed that the four-scenario terminal-stage
  boundary test consumed 14.0-14.9 seconds under its 15-second limit. The
  harness now tightens only its test-local `run_before_deadline` polling from
  50ms to 10ms for `afterTerminalStage` scenarios; production launcher polling
  and the 15-second test limit are unchanged. The focused boundary test passes
  1/1 with 32 assertions in 11.5 seconds.

  Focused policy verification passes 18/18 with 88 assertions. The isolated
  artifact suite passes 112/112 with 1,584 assertions, and the four-suite
  aggregate passes 450/450 with 3,331 assertions. Flow typecheck, exact ledger
  validation, Bash syntax, documentation link, symbol, and signature checks
  pass. Full verification records 466 passes, one gated skip, zero failures,
  and 1,336 assertions. A new manifest, three fresh audits, preflight, and any
  live run remain pending.
  Another live run requires fresh explicit authorization.
- [x] Correction 50 audit-closure checkpoint:

Nine validated root causes remained after Correction 49:

- `audit-finalizer-harness-callback-identity`: fragment and count checks did not
  bind complete callbacks. The policy now requires exact normalized callback
  source digests for all seven protected tests.
- `audit-finalizer-harness-option-binding-purity`: an effectful pre-loop alias
  could satisfy an otherwise passive option expression. The protected callback
  identities now require the exact pure pre-loop option bindings.
- `audit-matcher-proof-symbol-identity`: same-name local shadows could satisfy
  matcher checks. The contract now resolves canonical TypeScript symbol identity
  for the preload writer and imported matcher helper.
- `audit-delivery-immutable-push-ref`: mutable `HEAD` and the current remote name
  could drift. Delivery now uses one captured origin URL, an immutable
  validated-SHA push ref, and an exact `ls-remote` branch-SHA proof before PR
  creation.
- `audit-merge-command-authority`: confirmation could hide a failed squash
  response. A failed squash command now throws before confirmation can run.
- `audit-terminal-report-binding`: a nonempty PR URL could authorize launcher
  success. A complete terminal report binding now proves launcher, run, monitor,
  repository, fixed head, CI, merge, timing, SLA, and usage claims before hash or
  ledger staging.
- `audit-work-finalization-reserve`: active work could consume the full deadline,
  and merge subtracted the reserve twice. Runtime work now leaves one worker
  finalization reserve, merge consumes that cutoff without another subtraction,
  and launcher work leaves its own reserve before terminal publication.
- `audit-timeout-usage-accounting`: non-scout timeouts discarded valid settled
  usage. The shared wrapper records fulfilled terminal usage once and rethrows
  the same timeout.
- `audit-design-contract-drift`: design text omitted two control fields, allowed
  one path, and described only one commit. It now documents the four-field
  `selectedControl`, exactly two to three changed paths, and the full
  parent-to-head diff.

The unchanged 140-row prefix retains SHA-256
`401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
Nine append-only open rows bring the ledger to 149 rows and 149 unique IDs with
SHA-256
`607bd1a3250dcf1afeb9880683179391a69cc98fda7e151c938d0b9658604338`.

Final measured gates: focused docs/proof verification passes 2/2 with 150
assertions. The isolated artifact suite passes 119/119 with 1,936 assertions,
and the four-suite aggregate passes 464/464 with 3,700 assertions. Flow
typecheck and exact launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest, three fresh audits, preflight, and a live run remain pending.
No manifest generation, audit, preflight, live execution, push, PR, CI wait, or
merge ran in Correction 50. Any live run or GitHub write requires fresh explicit
authorization.

- [x] Correction 51 composed-finalization checkpoint:

One cross-layer root cause remained after Correction 50:

- `audit-cross-layer-finalization-reserve-composition`: Task 4 review blocked
  commit because the launcher and runtime independently claimed the same final
  10-second interval. The launcher could terminate a worker while runtime
  terminal evidence was still being published. The launcher now exports its
  absolute worker cutoff through `ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS`;
  runtime binds that exact safe integer as `workerDeadlineAtMs` before fallible
  setup, records it in the terminal report, stops active work 10 seconds earlier,
  and completes finalization by the worker cutoff. Launcher terminal validation
  requires that exact reported cutoff and rejects `finishedAtMs` after it before
  success hashing or ledger staging.
- For the simple profile, runtime active work ends at 580 seconds, runtime
  finalization owns 580-590 seconds, and launcher finalization owns 590-600
  seconds. These disjoint windows preserve the unchanged 600-second outer SLA.
  Medium and challenging profiles retain their unchanged absolute deadlines and
  the same two exact reserves.

The unchanged first 149 rows retain SHA-256
`607bd1a3250dcf1afeb9880683179391a69cc98fda7e151c938d0b9658604338`; the
first 140 rows still retain SHA-256
`401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
One append-only open row brings the ledger to 150 rows and 150 unique IDs with
SHA-256
`f77b1bf5c4ec4a65b28c4d433a3a46e0bf4c43bb0ad72212f86da250af0e9872`.

Final measured gates: focused Correction 51 proof and mutation policy pass 2/2
with 124 assertions. The isolated artifact suite passes 122/122 with 2,093
assertions, and the four-suite aggregate passes 467/467 with 3,861 assertions.
Flow typecheck and exact extracted launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest for the ordered 14-file set, three fresh audits, preflight, and a
live run remain pending. No manifest generation, audit, preflight, live
execution, push, PR, CI wait, or merge ran in Correction 51. Any live run or
GitHub write requires fresh explicit authorization.

- [x] Correction 52 historical-proof checkpoint:

Two evidence-audit root causes remained after Correction 51:

- `audit-correction49-proof-section-boundary`: The Correction 49 proof sliced
  from its heading through end-of-file, allowing Correction 50 or later text to
  supply a missing required historical token. The Correction 49 proof now
  locates an exact Correction 50 Markdown heading and inspects only the bounded
  Correction 49 section. A borrowing mutation removes `exact scenario-array
  digests` from Correction 49 and places it in Correction 50; the policy
  rejects it.
- `audit-correction51-ledger-claim-semantic-binding`: The Correction 51 proof
  required count and SHA-256 fragments rather than affirmative ledger
  semantics. `do not retain SHA-256` and `does not bring the ledger to 150 rows
  and 150 unique IDs` preserved those fragments while reversing the claims.
  The Correction 51 inspector now requires the two exact normalized affirmative
  ledger sentences, and both semantic-negation mutations are rejected.

The unchanged first 150 rows retain SHA-256
`f77b1bf5c4ec4a65b28c4d433a3a46e0bf4c43bb0ad72212f86da250af0e9872`.
Two append-only open rows bring the ledger to 152 rows and 152 unique IDs with
SHA-256
`24328b018809a39e2659dcc62e94c7600d106e63cebb2d4cfc00af83ee24bdcb`.

Final measured gates: focused Correction 52 proof and mutation policy pass 2/2
with 147 assertions. The isolated artifact suite passes 123/123 with 2,235
assertions, and the four-suite aggregate passes 468/468 with 4,003 assertions.
Flow typecheck and exact extracted launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest for the ordered 14-file set, three fresh audits, preflight, and a
live run remain pending. No manifest generation, audit, preflight, live
execution, push, PR, CI wait, or merge ran in Correction 52. Any live run or
GitHub write requires fresh explicit authorization.

- [x] Historical Correction 21 gates: flow typecheck, exact launcher ledger
  validation, lint, documentation link, symbol and signature checks, shell
  syntax, diff checks, and `bun run verify`. Full verification recorded 461
  passes, one gated skip, and 1,317 assertions.
- [ ] Hash this exact bytewise-ordered fourteen-artifact set; the issue ledger
  is part of the lock and cannot change between audit, preflight, and live
  launch:
  - `.orca/improvement-loop/issues.jsonl`
  - `.orca/workflows/codebase-improvement-artifacts.test.ts`
  - `.orca/workflows/codebase-improvement-contract.test.ts`
  - `.orca/workflows/codebase-improvement-lib.test.ts`
  - `.orca/workflows/codebase-improvement-lib.ts`
  - `.orca/workflows/codebase-improvement-runtime.test.ts`
  - `.orca/workflows/codebase-improvement-runtime.ts`
  - `.orca/workflows/codebase-improvement.config.json`
  - `.orca/workflows/codebase-improvement.run.md`
  - `.orca/workflows/codebase-improvement.sh`
  - `.orca/workflows/codebase-improvement.ts`
  - `docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md`
  - `docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md`
  - `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md`
  Membership remains unchanged: deferred OpenCode source-runtime files are not
  part of this proof lock.
- [ ] Lock a new ordered artifact digest and obtain three context-isolated,
  zero-finding audits against those exact bytes.
- [ ] Run preflight only, then consume the one authorized simple live run.
- [ ] Require exit zero within 600 seconds, reported usage, zero review
  blockers, a ready pull request, all-green CI, unchanged head SHA, SHA-locked
  squash merge, a persisted merge attempt, bounded exact confirmation after
  every merge response, and final state `MERGED`.
- [ ] Validate monitor, report, ledger, and GitHub evidence. Require one exact
  terminal record, matching candidate-ledger/report/monitor/latest-projection/
  final-ledger hashes and embedded claims, candidate-only run-local evidence
  before commit, and zero latest-open IDs in the atomically committed canonical
  ledger.
