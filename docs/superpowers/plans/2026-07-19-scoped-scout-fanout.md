# Scoped Scout Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle exact-three single scout response with at most
four concurrent pair-scoped scouts that yield one to three validated fallback
candidates within the existing 100-second stage.

**Architecture:** Keep deterministic evidence gathering, then render one packet
per reserved source-test pair. Run fresh tool-free Codex conversations under one
shared 80-second wall-clock allocation, validate each independently, stop after
three valid candidates, and deterministically aggregate any one to three valid
results.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Orcats 0.2.3, Codex CLI,
TypeScript compiler API, Bun test.

## Global Constraints

- Keep simple scout timing at 10 seconds gathering, 80 seconds concurrent
  model work, and 10 seconds validation.
- Keep the simple launcher-to-merge ceiling at 600 seconds.
- Start at most four fresh Codex conversations concurrently.
- Give each scope one reserved source path and one reserved test path.
- Permit only the reserved pair in a scoped candidate's `allowedPaths`.
- Accept a scoped `candidate` or a cited `no_candidate` result.
- Accept and rank one to three valid candidates in reserved-pair order.
- Retain the matching control returned with every accepted candidate.
- Run `validateCandidateForProfile()` inside scoped validation before a
  candidate can count toward quorum.
- A failed, invalid, or timed-out scope cannot erase a valid sibling.
- Cancel and terminally settle pending scopes after three valid candidates.
- A scope's `run()` promise is already bounded by
  `awaitToolFreeOutcome(conversation, () => awaitBounded(conversation, ...))`;
  `awaitBounded` is the sole terminal/deadline authority and the quorum helper
  must not create a second deadline.
- Pass the settlement remaining-time callback itself to `awaitBounded`; evaluate
  it only when active work times out and settlement begins.
- Check the shared gather deadline before and after every evidence render and
  digest. No scoped conversation may be constructed after gather expiry.
- Invoke each pending scope's `cancel(reason): void | Promise<void>` at most
  once. Handle synchronous throws and promise rejection without awaiting the
  cancellation promise.
- Retain cancellation records for evidence, but exclude every record with
  `cancelRequested === true` before constructing `ScopedScoutRankedResult` or
  calling `buildScoutResult()`.
- Normalize quorum at the caller to
  `Math.min(SCOUT_SCOPE_QUORUM, scopes.length)` so one and two scopes remain
  valid.
- Preserve read-only, tool-free scouting, selected-model propagation, and low
  reasoning effort.
- Preserve every downstream RED, positive-control, immutable-test, scope,
  review, full-verify, ready-PR, remote-check, fixed-head, and squash-merge gate.
- Do not run preflight, a live proving run, push, create a PR, or merge.
- The retained-baseline import and finalization-parent commit from the companion
  plan must exist in `HEAD`, and Review 1 must report `ZERO FINDINGS`, before
  any scoped task starts.
- After each scoped task commit, run its independent review immediately. A
  dependent task cannot start until the preceding review reports zero findings.
- Use `orca-typecheck-flow.sh` for ignored production workflow TypeScript and
  the pre-edit ESLint suppressions snapshot from Execution Gate 0. Root
  `typecheck` and `lint` exclude `.orca/**`.

## File Map

| File | Responsibility |
|---|---|
| `.orca/workflows/codebase-improvement-lib.ts` | Scoped schemas, validation, and deterministic aggregation. |
| `.orca/workflows/codebase-improvement-lib.test.ts` | Pure scope and one-to-three ranking behavior. |
| `.orca/workflows/codebase-improvement-runtime.ts` | Absolute settlement bounds, concurrent quorum, and pending cancellation. |
| `.orca/workflows/codebase-improvement-runtime.test.ts` | Deadline, real-promise concurrency, and cancellation tests. |
| `.orca/workflows/codebase-improvement.ts` | Packet fan-out, conversations, monitoring, usage, report integration. |
| `.orca/workflows/codebase-improvement-contract.test.ts` | Load-bearing timing, prompt, fan-out, report, and delivery mutations. |
| `.orca/workflows/codebase-improvement-artifacts.test.ts` | Runbook and artifact agreement. |
| `.orca/workflows/codebase-improvement.run.md` | Operator timing and failure semantics. |
| `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md` | Supersession link to the approved repair design. |
| `docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md` | Historical timing supersession note. |

---

## Plan-Wide Dependency

Before Task 1, run:

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
test -s "$baseline_root/repair-base.txt"
test -s "$baseline_root/workflow-eslint-suppressions.json"
review_file="$baseline_root/task-reviews/review-1-finalization-parent.txt"
test -s "$review_file"
review_base=$(sed -n '1s/^Base: //p' "$review_file")
review_head=$(sed -n '2s/^Approved-Head: //p' "$review_file")
test -n "$review_base"
test -n "$review_head"
git cat-file -e "$review_base^{commit}"
git cat-file -e "$review_head^{commit}"
test "$(sed -n '1p' "$review_file")" = "Base: $review_base"
test "$(sed -n '2p' "$review_file")" = "Approved-Head: $review_head"
test "$(tail -n 1 "$review_file")" = 'ZERO FINDINGS'
test "$(git show -s --format='%s' "$review_base")" = \
  'chore(workflow): retain proving artifacts and repair plans'
git merge-base --is-ancestor "$review_base" "$review_head"
test "$(git rev-list --count "$review_base..$review_head")" -ge 1
test "$(git log --format='%s' "$review_base..$review_head" | \
  awk '$0 == "fix(workflow): create finalization evidence parents" { n += 1 } END { print n + 0 }')" -eq 1
test "$(git rev-parse HEAD)" = "$review_head"
```

This binds the prerequisite to Review 1's complete task range rather than the
last two subjects. If the base, approved head, ancestry, required initial
commit, literal `ZERO FINDINGS`, or fixed current `HEAD` check fails, stop. This
prerequisite applies to Tasks 1-3, not only Task 3.

---

### Task 1: Scoped Result And Aggregation Contract

**Files:**

- Modify: `.orca/workflows/codebase-improvement-lib.test.ts:1-101`
- Modify: `.orca/workflows/codebase-improvement-lib.test.ts:592-1018`
- Modify: `.orca/workflows/codebase-improvement-lib.test.ts:1020-1230`
- Modify: `.orca/workflows/codebase-improvement-lib.test.ts:1476-1493`
- Modify: `.orca/workflows/codebase-improvement-lib.ts:49-74`
- Modify: `.orca/workflows/codebase-improvement-lib.ts:571-704`
- Modify: `.orca/workflows/codebase-improvement-lib.ts:782-884`

**Interfaces:**

- Consumes: `ScoutCandidateSchema`, `CandidateControlSchema`,
  `ComplexityProfile`, `ScoutEvidencePacket`, `ScoutSourceTestPair`,
  `validateCandidateEvidence`, and `validateCandidateForProfile`.
- Produces:
  `ScopedScoutResultSchema`, `ScopedScoutResult`,
  `validateScopedScoutResult(result, pair, packet, profile): string[]`,
  `NoSuitableScoutCandidateError`, and
  `buildScoutResult(results): ScoutResult` with `candidateControls` for every
  accepted candidate.
- `ScopedScoutRankedResult` contains only a parsed scoped result and
  `scopeIndex`; it deliberately has no `cancelRequested` field. The caller must
  discard cancellation-requested records before constructing this type.

- [ ] **Step 1: Write failing strict scoped-schema and validation tests**

Extend the library-test imports only with `ScopedScoutResultSchema` and
`validateScopedScoutResult`. Reuse `scoutCandidates` and `selectedControl`.
Add these tests before changing production code:

```ts
test("scoped scout returns one candidate or a cited no-candidate result", () => {
  const control = {
    ...selectedControl,
    candidateId: "a",
    productionPath: "src/a.ts",
  };
  expect(
    ScopedScoutResultSchema.parse({
      status: "candidate",
      candidate: scoutCandidates[0],
      selectedControl: control,
    }).status,
  ).toBe("candidate");
  expect(
    ScopedScoutResultSchema.parse({
      status: "no_candidate",
      reason: "src/a.ts:1 and tests/a.test.ts:1 show no unsupported behavior",
    }).status,
  ).toBe("no_candidate");
  for (const malformed of [
    {
      status: "candidate",
      candidate: scoutCandidates[0],
      selectedControl: { ...control, candidateId: "b" },
    },
    {
      status: "no_candidate",
      reason: "src/a.ts:1 and tests/a.test.ts:1 show no defect",
      candidate: scoutCandidates[0],
      selectedControl: control,
    },
    {
      status: "candidate",
      candidate: scoutCandidates[0],
      selectedControl: control,
      unexpected: true,
    },
  ]) {
    expect(ScopedScoutResultSchema.safeParse(malformed).success).toBe(false);
  }
});

test("scoped validation binds evidence, profile, and control to one pair", () => {
  const pair = { sourcePath: "src/a.ts", testPath: "tests/a.test.ts" };
  const packet = renderScoutEvidence(
    [
      { path: pair.sourcePath, content: "export const a = 1;\n" },
      { path: pair.testPath, content: "test(\"a\", () => {});\n" },
    ],
    1_000,
    "",
    [pair],
  );
  const result = {
    status: "candidate" as const,
    candidate: {
      ...scoutCandidates[0],
      evidence: ["src/a.ts:1 behavior", "tests/a.test.ts:1 observation"],
    },
    selectedControl: {
      ...selectedControl,
      candidateId: "a",
      productionPath: "src/a.ts",
    },
  };

  expect(validateScopedScoutResult(result, pair, packet, "simple")).toEqual([]);
  expect(
    validateScopedScoutResult(
      {
        ...result,
        candidate: {
          ...result.candidate,
          allowedPaths: ["src/a.ts", "src/b.ts", "tests/a.test.ts"],
        },
      },
      pair,
      packet,
      "simple",
    ),
  ).toContain("scoped candidate paths must equal its reserved source-test pair");
  expect(
    validateScopedScoutResult(
      { status: "no_candidate", reason: "nothing suitable" },
      pair,
      packet,
      "simple",
    ),
  ).toContain("no-candidate reason must cite both reserved paths");
  expect(
    validateScopedScoutResult(
      {
        ...result,
        candidate: { ...result.candidate, expectedMinutes: 20 },
      },
      pair,
      packet,
      "simple",
    ),
  ).toContain("expected minutes outside simple profile");
});

test("no-candidate citations reject line-prefix collisions", () => {
  const pair = { sourcePath: "src/a.ts", testPath: "tests/a.test.ts" };
  const packet = renderScoutEvidence(
    [
      { path: pair.sourcePath, content: "export const a = 1;\n" },
      { path: pair.testPath, content: "test(\"a\", () => {});\n" },
    ],
    1_000,
    "",
    [pair],
  );
  expect(
    validateScopedScoutResult(
      {
        status: "no_candidate",
        reason: "src/a.ts:1 and tests/a.test.ts:1 show no defect",
      },
      pair,
      packet,
      "simple",
    ),
  ).toEqual([]);
  expect(
    validateScopedScoutResult(
      {
        status: "no_candidate",
        reason: "src/a.ts:10 and tests/a.test.ts:10 show no defect",
      },
      pair,
      packet,
      "simple",
    ),
  ).toEqual(["no-candidate reason must cite both reserved paths"]);
});
```

- [ ] **Step 2: Run scoped-schema tests and verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  --test-name-pattern "scoped scout|scoped validation|line-prefix"
```

Expected: FAIL with
`SyntaxError: Export named 'ScopedScoutResultSchema' not found in module`.

- [ ] **Step 3: Implement scoped schemas and validation**

Add these definitions after `CandidateControlSchema`:

```ts
const ScopedScoutCandidateResultSchema = z
  .object({
    status: z.literal("candidate"),
    candidate: ScoutCandidateSchema,
    selectedControl: CandidateControlSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selectedControl.candidateId !== value.candidate.id) {
      context.addIssue({
        code: "custom",
        message: "scoped control must target its candidate",
      });
    }
  });

const ScopedScoutNoCandidateResultSchema = z
  .object({
    status: z.literal("no_candidate"),
    reason: z.string().trim().min(1),
  })
  .strict();

export const ScopedScoutResultSchema = z.discriminatedUnion("status", [
  ScopedScoutCandidateResultSchema,
  ScopedScoutNoCandidateResultSchema,
]);

export type ScopedScoutResult = z.infer<typeof ScopedScoutResultSchema>;
```

Move the boundary-safe marker matcher out of `validateCandidateEvidence()` so
both candidate and no-candidate validation use the same helper:

```ts
const citationTokenCharacter = /[\w./\\-]/;

function containsRenderedCitationMarker(
  text: string,
  marker: string,
): boolean {
  for (
    let index = text.indexOf(marker);
    index >= 0;
    index = text.indexOf(marker, index + marker.length)
  ) {
    const previousCharacter = text[index - 1];
    const nextCharacter = text[index + marker.length];
    if (
      (previousCharacter === undefined ||
        !citationTokenCharacter.test(previousCharacter)) &&
      (nextCharacter === undefined ||
        !citationTokenCharacter.test(nextCharacter))
    ) {
      return true;
    }
  }
  return false;
}
```

Replace the local matcher in `validateCandidateEvidence()` with this helper,
then add this validation beside it:

```ts
export function validateScopedScoutResult(
  result: ScopedScoutResult,
  pair: ScoutSourceTestPair,
  packet: ScoutEvidencePacket,
  profile: ComplexityProfile,
): string[] {
  if (result.status === "no_candidate") {
    const cited = [pair.sourcePath, pair.testPath].every((path) =>
      packet.renderedLineMarkers
        .filter((marker) => marker.startsWith(`${path}:`))
        .some((marker) =>
          containsRenderedCitationMarker(result.reason, marker),
        ),
    );
    return cited ? [] : ["no-candidate reason must cite both reserved paths"];
  }
  const issues = [
    ...validateCandidateEvidence(result.candidate, packet),
    ...validateCandidateForProfile(result.candidate, profile),
  ];
  const expectedPaths = [pair.sourcePath, pair.testPath].sort();
  if (
    [...result.candidate.allowedPaths].sort().join("\n") !==
    expectedPaths.join("\n")
  ) {
    issues.push("scoped candidate paths must equal its reserved source-test pair");
  }
  if (result.candidate.testPath !== pair.testPath) {
    issues.push("scoped candidate test must equal its reserved test path");
  }
  if (result.selectedControl.productionPath !== pair.sourcePath) {
    issues.push("scoped control must use its reserved production path");
  }
  return issues;
}
```

- [ ] **Step 4: Run scoped-schema tests and verify GREEN**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  --test-name-pattern "scoped scout|scoped validation|line-prefix"
```

Expected: PASS.

- [ ] **Step 5: Write failing cardinality, deduplication, and fallback tests**

Now extend the imports with `buildScoutResult`, `hydrateCandidate`,
`NoSuitableScoutCandidateError`, and `runRankedCandidateFallback`. Add:

```ts
const scopedControls = scoutCandidates.map((item) => ({
  candidateId: item.id,
  brief: `control ${item.id}`,
  testName: `control ${item.id}`,
  productionPath: `src/${item.id}.ts`,
}));

const scopedResults = scoutCandidates.map((item, index) => ({
  status: "candidate" as const,
  candidate: item,
  selectedControl: scopedControls[index]!,
  scopeIndex: index,
}));

function variableScoutFixture(count: 1 | 2 | 3) {
  const accepted = scopedResults.slice(0, count);
  return {
    candidates: accepted.map((item) => item.candidate),
    rankedCandidateIds: accepted.map((item) => item.candidate.id),
    candidateControls: accepted.map((item) => item.selectedControl),
    selectedControl: accepted[0]!.selectedControl,
  };
}

test("scout result accepts one to three and rejects zero or four", () => {
  for (const count of [1, 2, 3] as const) {
    expect(ScoutResultSchema.safeParse(variableScoutFixture(count)).success).toBe(
      true,
    );
  }
  expect(
    ScoutResultSchema.safeParse({
      candidates: [],
      rankedCandidateIds: [],
      candidateControls: [],
      selectedControl: scopedControls[0],
    }).success,
  ).toBe(false);
  const fourthCandidate = {
    ...scoutCandidates[0],
    id: "d",
    allowedPaths: ["src/d.ts", "tests/d.test.ts"],
    testPath: "tests/d.test.ts",
    targetedTestArgs: ["test", "tests/d.test.ts"],
    expectedFailurePattern: "ORCA_RED:d",
  };
  const fourthControl = {
    candidateId: "d",
    brief: "control d",
    testName: "control d",
    productionPath: "src/d.ts",
  };
  expect(
    ScoutResultSchema.safeParse({
      candidates: [...scoutCandidates, fourthCandidate],
      rankedCandidateIds: ["a", "b", "c", "d"],
      candidateControls: [...scopedControls, fourthControl],
      selectedControl: scopedControls[0],
    }).success,
  ).toBe(false);
});

test("scout result rejects a schema-valid duplicate candidate ID", () => {
  const parsed = ScoutResultSchema.safeParse({
    candidates: [
      scoutCandidates[0],
      {
        ...scoutCandidates[1],
        id: "a",
        expectedFailurePattern: "ORCA_RED:a",
      },
    ],
    rankedCandidateIds: ["a", "a"],
    candidateControls: [scopedControls[0], scopedControls[0]],
    selectedControl: scopedControls[0],
  });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("duplicate candidate fixture parsed");
  expect(parsed.error.issues.map((issue) => issue.message)).toContain(
    "rankedCandidateIds must be the candidate-ID permutation",
  );
});

test("scout result rejects a duplicate control ID", () => {
  const parsed = ScoutResultSchema.safeParse({
    candidates: scoutCandidates.slice(0, 2),
    rankedCandidateIds: ["a", "b"],
    candidateControls: [
      scopedControls[0],
      { ...scopedControls[1], candidateId: "a" },
    ],
    selectedControl: scopedControls[0],
  });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("duplicate control fixture parsed");
  expect(parsed.error.issues.map((issue) => issue.message)).toContain(
    "candidateControls must match rankedCandidateIds in order",
  );
});

test("scoped aggregation deduplicates before slicing in scope order", () => {
  const duplicate = {
    ...scopedResults[0]!,
    scopeIndex: 1,
  };
  const shifted = scopedResults.slice(1).map((item, index) => ({
    ...item,
    scopeIndex: index + 2,
  }));
  const result = buildScoutResult([scopedResults[0]!, duplicate, ...shifted]);
  expect(result.rankedCandidateIds).toEqual(["a", "b", "c"]);
  expect(result.candidateControls.map((item) => item.candidateId)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("one to three ranks preserve fallback hydration contracts", async () => {
  for (const count of [1, 2, 3] as const) {
    const result = buildScoutResult(scopedResults.slice(0, count).reverse());
    const attempted: string[] = [];
    const restored: string[] = [];
    const fallback = await runRankedCandidateFallback(
      result.rankedCandidateIds,
      async (candidateId, rank) => {
        attempted.push(candidateId);
        const source = result.candidates.find((item) => item.id === candidateId)!;
        const hydrated = hydrateCandidate(result, result.candidateControls[rank]!);
        expect(hydrated.expectedFailurePattern).toBe(`ORCA_RED:${candidateId}`);
        expect(hydrated.testPath).toBe(source.testPath);
        expect(hydrated.targetedTestArgs).toEqual(source.targetedTestArgs);
        expect(hydrated.allowedPaths).toEqual(source.allowedPaths);
        if (rank < count - 1) {
          return {
            status: "rejected" as const,
            reason: `invalid:${candidateId}`,
            restore: async () => {
              restored.push(candidateId);
            },
          };
        }
        return { status: "accepted" as const, value: hydrated };
      },
    );
    expect(attempted).toEqual(result.rankedCandidateIds);
    expect(restored).toEqual(result.rankedCandidateIds.slice(0, -1));
    expect(fallback.value.id).toBe(result.rankedCandidateIds.at(-1));
  }
});

test("scoped aggregation accepts one to three candidates in input order", () => {
  const scoped = scoutCandidates.map((item, index) => ({
    status: "candidate" as const,
    candidate: item,
    selectedControl: {
      candidateId: item.id,
      brief: `control ${item.id}`,
      testName: `control ${item.id}`,
      productionPath: `src/${item.id}.ts`,
    },
    scopeIndex: index,
  }));

  for (const count of [1, 2, 3]) {
    const result = buildScoutResult(scoped.slice(0, count).reverse());
    expect(result.candidates.map((item) => item.id)).toEqual(
      scoped.slice(0, count).map((item) => item.candidate.id),
    );
    expect(result.rankedCandidateIds).toEqual(
      result.candidates.map((item) => item.id),
    );
    expect(result.selectedControl.candidateId).toBe(
      result.rankedCandidateIds[0],
    );
    expect(result.candidateControls.map((control) => control.candidateId)).toEqual(
      result.rankedCandidateIds,
    );
  }
});

test("scoped aggregation rejects zero candidates", () => {
  expect(() => buildScoutResult([])).toThrow(NoSuitableScoutCandidateError);
});
```

- [ ] **Step 6: Run aggregation tests and verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  --test-name-pattern "scout result|scoped aggregation|one to three ranks"
```

Expected: FAIL with
`SyntaxError: Export named 'buildScoutResult' not found in module`. After that
export exists, the cardinality assertions must still fail until
`ScoutResultSchema` accepts dynamic one-to-three lengths and requires
`candidateControls`.

- [ ] **Step 7: Implement variable ranking and aggregation**

Replace the complete schema with the dynamic contract below. Equality between
`selectedControl` and the first ranked control is field-by-field, not object
identity:

```ts
function candidateControlsEqual(
  left: CandidateControl,
  right: CandidateControl,
): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.brief === right.brief &&
    left.testName === right.testName &&
    left.productionPath === right.productionPath
  );
}

export const ScoutResultSchema = z
  .object({
    candidates: z.array(ScoutCandidateSchema).min(1).max(3),
    rankedCandidateIds: z.array(candidateIdSchema).min(1).max(3),
    candidateControls: z.array(CandidateControlSchema).min(1).max(3),
    selectedControl: CandidateControlSchema,
  })
  .superRefine((value, context) => {
    const candidateIds = value.candidates.map((item) => item.id);
    const rankedIds = value.rankedCandidateIds;
    if (
      new Set(candidateIds).size !== candidateIds.length ||
      new Set(rankedIds).size !== rankedIds.length ||
      rankedIds.length !== candidateIds.length ||
      [...rankedIds].sort().join("\n") !== [...candidateIds].sort().join("\n")
    ) {
      context.addIssue({
        code: "custom",
        message: "rankedCandidateIds must be the candidate-ID permutation",
      });
    }
    const controlIds = value.candidateControls.map((item) => item.candidateId);
    if (
      controlIds.length !== rankedIds.length ||
      new Set(controlIds).size !== controlIds.length ||
      controlIds.join("\n") !== rankedIds.join("\n")
    ) {
      context.addIssue({
        code: "custom",
        message: "candidateControls must match rankedCandidateIds in order",
      });
    }
    if (value.selectedControl.candidateId !== rankedIds[0]) {
      context.addIssue({
        code: "custom",
        message: "selectedControl must target the rank-one candidate",
      });
    }
    const firstControl = value.candidateControls[0];
    if (
      firstControl === undefined ||
      !candidateControlsEqual(value.selectedControl, firstControl)
    ) {
      context.addIssue({
        code: "custom",
        message: "selectedControl must equal the first candidate control",
      });
    }
    const testPaths = value.candidates.map((candidate) => candidate.testPath);
    if (new Set(testPaths).size !== testPaths.length) {
      context.addIssue({
        code: "custom",
        message: "ranked candidates must use unique target test paths",
      });
    }
    const productionScopes = value.candidates.map(
      (candidate) =>
        new Set(
          candidate.allowedPaths.filter((path) => !path.startsWith("tests/")),
        ),
    );
    for (const [candidateIndex, productionScope] of productionScopes.entries()) {
      const otherPaths = new Set(
        productionScopes.flatMap((scope, scopeIndex) =>
          scopeIndex === candidateIndex ? [] : [...scope],
        ),
      );
      if (![...productionScope].some((path) => !otherPaths.has(path))) {
        context.addIssue({
          code: "custom",
          message: "each ranked candidate must have an exclusive production path",
        });
      }
    }
  });
```

Update the existing library fixture to retain every control:

```ts
const candidateControls = [
  {
    candidateId: "a",
    brief: "control a",
    testName: "control a",
    productionPath: "src/a.ts",
  },
  selectedControl,
  {
    candidateId: "c",
    brief: "control c",
    testName: "control c",
    productionPath: "src/c.ts",
  },
];
const scoutResult = {
  candidates: scoutCandidates,
  rankedCandidateIds: ["b", "c", "a"],
  candidateControls: [
    selectedControl,
    candidateControls[2]!,
    candidateControls[0]!,
  ],
  selectedControl,
};
```

Add:

```ts
export class NoSuitableScoutCandidateError extends Error {
  override readonly name = "NoSuitableScoutCandidateError";

  constructor() {
    super("no suitable scout candidate in reserved source-test scopes");
  }
}

export type ScopedScoutRankedResult =
  | (z.infer<typeof ScopedScoutCandidateResultSchema> & {
      readonly scopeIndex: number;
    })
  | (z.infer<typeof ScopedScoutNoCandidateResultSchema> & {
      readonly scopeIndex: number;
    });

export function buildScoutResult(
  results: readonly ScopedScoutRankedResult[],
): ScoutResult {
  const sortedCandidates = results
    .filter(
      (
        result,
      ): result is Extract<
        ScopedScoutRankedResult,
        { readonly status: "candidate" }
      > =>
        result.status === "candidate",
    )
    .sort(
      (left, right) =>
        left.scopeIndex - right.scopeIndex ||
        left.candidate.id.localeCompare(right.candidate.id),
    );
  const seenCandidateIds = new Set<string>();
  const accepted = sortedCandidates
    .filter((result) => {
      if (seenCandidateIds.has(result.candidate.id)) return false;
      seenCandidateIds.add(result.candidate.id);
      return true;
    })
    .slice(0, 3);
  const selected = accepted[0];
  if (selected === undefined) throw new NoSuitableScoutCandidateError();
  return ScoutResultSchema.parse({
    candidates: accepted.map((result) => result.candidate),
    rankedCandidateIds: accepted.map((result) => result.candidate.id),
    candidateControls: accepted.map((result) => result.selectedControl),
    selectedControl: selected.selectedControl,
  });
}
```

- [ ] **Step 8: Repeat the aggregation selection and verify GREEN**

Run the identical selection used for RED:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  --test-name-pattern "scout result|scoped aggregation|one to three ranks"
```

Expected: PASS, including both isolated duplicate-ID diagnostics.

- [ ] **Step 9: Run the complete library tests and ignored-source checks**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement-lib.ts
```

Expected: PASS. Update every existing `ScoutResultSchema` fixture to include
its ordered `candidateControls`; keep the independent-scope,
exact-permutation, positive-control, RED-marker, immutable-test, and
allowed-path assertions unchanged.

- [ ] **Step 10: Stage and inspect only Task 1 files**

```bash
git add -- .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-lib.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached -- .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-lib.test.ts
```

Expected staged list, exactly:

```text
.orca/workflows/codebase-improvement-lib.test.ts
.orca/workflows/codebase-improvement-lib.ts
```

- [ ] **Step 11: Commit Task 1 after the staged review passes**

```bash
git commit -m "feat(workflow): add scoped scout results"
```

- [ ] **Review 2: Independently review scoped-result Task 1 range**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
prior_review="$review_root/review-1-finalization-parent.txt"
review_file="$review_root/review-2-scoped-result.txt"
task_base=$(sed -n '2s/^Approved-Head: //p' "$prior_review")
approved_head=$(git rev-parse HEAD)
test -n "$task_base"
test "$(tail -n 1 "$prior_review")" = 'ZERO FINDINGS'
git merge-base --is-ancestor "$task_base" "$approved_head"
test "$(git rev-list --count "$task_base..$approved_head")" -ge 1
test "$(git log --format='%s' "$task_base..$approved_head" | \
  awk '$0 == "feat(workflow): add scoped scout results" { n += 1 } END { print n + 0 }')" -eq 1
git diff --check "$task_base..$approved_head"
git diff "$task_base..$approved_head" -- \
  .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-lib.test.ts
```

Give a fresh reviewer the complete `task_base..approved_head` diff and every
RED/GREEN/typecheck/lint result. Save the verbatim response at `$review_file`;
its first two lines must be `Base: <task_base>` and
`Approved-Head: <approved_head>`, and its final line must be literal
`ZERO FINDINGS`. Then run:

```bash
test -s "$review_file"
test "$(sed -n '1p' "$review_file")" = "Base: $task_base"
test "$(sed -n '2p' "$review_file")" = "Approved-Head: $approved_head"
test "$(tail -n 1 "$review_file")" = 'ZERO FINDINGS'
test "$(git rev-parse HEAD)" = "$approved_head"
```

Require zero findings for schema, citations, profile validation, cardinality,
duplicate IDs, controls, ordering, and ranked fallback. On a finding, do not
retain an approved review file and never amend, rebase, squash, or rewrite.
Repair only the two Task 1 paths, rerun its focused checks, add
`fix(review): repair scoped-result task`, and repeat Review 2 over the same
`task_base..HEAD` range. Task 2 cannot start before a clean, range-bound Review
2.

---

### Task 2: Concurrent Scope Quorum

**Files:**

- Modify: `.orca/workflows/codebase-improvement-runtime.test.ts:15-35`
- Modify: `.orca/workflows/codebase-improvement-runtime.test.ts:2567-2814`
- Modify: `.orca/workflows/codebase-improvement-runtime.test.ts:3513-3820`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts:218-236`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts:2989-3046`

**Interfaces:**

- Consumes: private `observeTerminal(operation, now)`. Every `run()` supplied
  by Task 3 must already be the single bounded terminal promise created by
  `awaitToolFreeOutcome(conversation, () => awaitBounded(conversation, ...))`.
- Produces: `ConcurrentScope<T>`, `ConcurrentScopeRecord<T>`, and
  `awaitConcurrentScopeQuorum(scopes, quorum, accept, now?)`. It also changes
  `awaitBounded()` to accept a numeric settlement reserve or a remaining-time
  callback evaluated only after the active timer wins.
- `ConcurrentScope.cancel` returns `void | Promise<void>`. The helper invokes it
  once, owns synchronous throws and async rejection, never awaits it, and adds
  no deadline; the bounded `run()` settlement remains terminal authority.

- [ ] **Step 1: Write all concurrent, cancellation, and mixed-outcome RED tests**

Import the produced helper. Add:

```ts
test("awaitBounded late settlement callback caps the absolute deadline", async () => {
  let nowMs = 0;
  const events: string[] = [];
  const pending = settleWithin(
    awaitBounded(
      {
        awaitResult: () => new Promise<never>(() => {}),
        cancel: () => {
          events.push(`cancel:${String(nowMs)}`);
          nowMs = 80_000;
          return new Promise<void>(() => {});
        },
      },
      5,
      "late scout",
      () => {
        events.push(`settlement:${String(nowMs)}`);
        return 80_000 - nowMs;
      },
      () => nowMs,
    ),
    100,
  );
  setTimeout(() => {
    nowMs = 79_999;
  }, 0);

  await expect(pending).rejects.toThrow(
    "late scout cancellation did not settle within 1ms",
  );
  expect(events).toEqual(["settlement:79999", "cancel:79999"]);
  expect(nowMs).toBe(80_000);
});

test("concurrent scope quorum starts every scope and cancels pending work", async () => {
  const started: number[] = [];
  const cancelled: number[] = [];
  const resolvers: Array<(value: string) => void> = [];
  const scopes = Array.from({ length: 4 }, (_, index) => ({
    label: `scope-${String(index)}`,
    run: () => {
      started.push(index);
      return new Promise<string>((resolve) => {
        resolvers[index] = resolve;
      });
    },
    cancel: async () => {
      cancelled.push(index);
      resolvers[index]!("cancelled");
    },
  }));

  const pending = awaitConcurrentScopeQuorum(
    scopes,
    3,
    (value) => value === "candidate",
  );
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  resolvers[2]!("candidate");
  resolvers[0]!("candidate");
  resolvers[1]!("candidate");

  const records = await pending;
  expect(cancelled).toEqual([3]);
  expect(records.map((record) => record.index)).toEqual([0, 1, 2, 3]);
  expect(records[3]).toMatchObject({
    status: "fulfilled",
    value: "cancelled",
    cancelRequested: true,
  });
});

test("quorum cancellation is invoked once and never awaited", async () => {
  const rejectedRun = Promise.withResolvers<string>();
  const pendingRun = Promise.withResolvers<string>();
  const throwingRun = Promise.withResolvers<string>();
  const cancelCalls = [0, 0, 0];
  const recordsPromise = awaitConcurrentScopeQuorum(
    [
      { label: "valid", run: async () => "candidate", cancel: () => {} },
      {
        label: "rejecting-cancel",
        run: () => rejectedRun.promise,
        cancel: () => {
          cancelCalls[0] += 1;
          return Promise.reject(new Error("async cancel failed"));
        },
      },
      {
        label: "pending-cancel",
        run: () => pendingRun.promise,
        cancel: () => {
          cancelCalls[1] += 1;
          return new Promise<void>(() => {});
        },
      },
      {
        label: "throwing-cancel",
        run: () => throwingRun.promise,
        cancel: () => {
          cancelCalls[2] += 1;
          throw new Error("sync cancel failed");
        },
      },
    ],
    1,
    (value) => value === "candidate",
  );
  await Promise.resolve();
  await Promise.resolve();
  rejectedRun.resolve("bounded terminal");
  pendingRun.resolve("bounded terminal");
  throwingRun.resolve("bounded terminal");
  const records = await recordsPromise;
  expect(cancelCalls).toEqual([1, 1, 1]);
  expect(records[1]).toMatchObject({
    cancelRequested: true,
    cancelError: new Error("async cancel failed"),
  });
  expect(records[2]).toMatchObject({
    status: "fulfilled",
    value: "bounded terminal",
    cancelRequested: true,
  });
  expect(records[3]).toMatchObject({
    status: "fulfilled",
    value: "bounded terminal",
    cancelRequested: true,
    cancelError: new Error("sync cancel failed"),
  });
  expect(
    records.filter(
      (record) => record.status === "fulfilled" && !record.cancelRequested,
    ),
  ).toHaveLength(1);
});

test("concurrent scope quorum retains candidate no-candidate invalid and timeout", async () => {
  const records = await awaitConcurrentScopeQuorum(
    [
      { label: "candidate", run: async () => "candidate", cancel: () => {} },
      { label: "empty", run: async () => "no_candidate", cancel: () => {} },
      {
        label: "invalid",
        run: async (): Promise<string> => {
          throw new Error("invalid scope");
        },
        cancel: () => {},
      },
      {
        label: "timeout",
        run: async (): Promise<string> => {
          throw new Error("scout scope timed out");
        },
        cancel: () => {},
      },
    ],
    4,
    (value) => value === "candidate",
  );
  expect(records.map((record) => record.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
    "rejected",
  ]);
  expect(records[0]).toMatchObject({ value: "candidate" });
  expect(records[1]).toMatchObject({ value: "no_candidate" });
  expect(records[2]).toMatchObject({ reason: new Error("invalid scope") });
  expect(records[3]).toMatchObject({
    reason: new Error("scout scope timed out"),
  });
});

```

- [ ] **Step 2: Run the quorum test and verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts \
  --test-name-pattern "awaitBounded late settlement|concurrent scope quorum|quorum cancellation"
```

Expected: FAIL with
`SyntaxError: Export named 'awaitConcurrentScopeQuorum' not found in module`.

- [ ] **Step 3: Implement concurrent quorum collection**

First replace the complete `awaitBounded()` implementation so numeric callers
remain compatible while scoped callers defer settlement-budget evaluation until
the active timer actually wins:

```ts
export async function awaitBounded<T>(
  conversation: BoundedConversation<T>,
  timeoutMs: number,
  stage: string,
  settlementTimeout: number | (() => number) = timeoutMs,
  now: () => number = Date.now,
): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`sla-overrun before ${stage}`);
  if (typeof settlementTimeout === "number" && settlementTimeout <= 0) {
    throw new Error(`sla-overrun before ${stage} cancellation settlement`);
  }
  const deadlineAtMs = now() + timeoutMs;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new ConversationTimeoutError(stage, timeoutMs);
  const terminal = observeTerminal(() => conversation.awaitResult(), now);
  const activeDeadline = new Promise<{ readonly type: "timeout" }>((resolve) => {
    activeTimer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
  });
  const first = await Promise.race([terminal, activeDeadline]);
  if (activeTimer !== undefined) clearTimeout(activeTimer);
  if (!("type" in first)) {
    if (first.completedAtMs >= deadlineAtMs) {
      throw new ConversationTimeoutError(stage, timeoutMs, first);
    }
    if (first.status === "rejected") throw first.reason;
    return first.value;
  }

  const cancellation = Promise.resolve().then(() =>
    conversation.cancel(timeoutError.message),
  );
  let settlementTimeoutMs: number;
  try {
    settlementTimeoutMs =
      typeof settlementTimeout === "function"
        ? settlementTimeout()
        : settlementTimeout;
  } catch (error) {
    void cancellation.catch(() => {});
    throw error;
  }
  if (!Number.isFinite(settlementTimeoutMs) || settlementTimeoutMs <= 0) {
    void cancellation.catch(() => {});
    throw new ConversationSettlementTimeoutError(stage, 0);
  }
  const settlementDeadlineAtMs = now() + settlementTimeoutMs;
  const terminalSettlement = observeTerminal(async () => {
    await Promise.allSettled([terminal, cancellation]);
  }, now);
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  const settlementDeadline = new Promise<{ readonly status: "timeout" }>(
    (resolve) => {
      settlementTimer = setTimeout(
        () => resolve({ status: "timeout" }),
        settlementTimeoutMs,
      );
    },
  );
  const settled = await Promise.race([terminalSettlement, settlementDeadline]);
  if (settlementTimer !== undefined) clearTimeout(settlementTimer);
  if (
    settled.status === "timeout" ||
    settled.completedAtMs >= settlementDeadlineAtMs
  ) {
    throw new ConversationSettlementTimeoutError(stage, settlementTimeoutMs);
  }
  throw new ConversationTimeoutError(stage, timeoutMs, await terminal);
}
```

Add these exported types and helper near the existing bounded-operation helpers:

```ts
export interface ConcurrentScope<T> {
  readonly label: string;
  readonly run: () => Promise<T>;
  readonly cancel: (reason: string) => void | Promise<void>;
}

export type ConcurrentScopeRecord<T> =
  | {
      readonly index: number;
      readonly label: string;
      readonly status: "fulfilled";
      readonly value: T;
      readonly durationMs: number;
      readonly cancelRequested: boolean;
      readonly cancelError?: unknown;
    }
  | {
      readonly index: number;
      readonly label: string;
      readonly status: "rejected";
      readonly reason: unknown;
      readonly durationMs: number;
      readonly cancelRequested: boolean;
      readonly cancelError?: unknown;
    };

export async function awaitConcurrentScopeQuorum<T>(
  scopes: readonly ConcurrentScope<T>[],
  quorum: number,
  accept: (value: T) => boolean,
  now: () => number = Date.now,
): Promise<ConcurrentScopeRecord<T>[]> {
  if (!Number.isSafeInteger(quorum) || quorum <= 0 || quorum > scopes.length) {
    throw new Error("concurrent scope quorum must fit the scope count");
  }
  const states = scopes.map((scope, index) => {
    const startedAtMs = now();
    let settled = false;
    let cancelRequested = false;
    let cancelError: unknown;
    const terminal = observeTerminal(scope.run, now).then((value) => {
      settled = true;
      return value;
    });
    return {
      scope,
      index,
      startedAtMs,
      terminal,
      isSettled: () => settled,
      markCancelRequested: () => {
        cancelRequested = true;
      },
      setCancelError: (error: unknown) => {
        cancelError = error;
      },
      cancelRequested: () => cancelRequested,
      cancelError: () => cancelError,
    };
  });
  const pending = new Map(states.map((state) => [state.index, state]));
  const records: ConcurrentScopeRecord<T>[] = [];
  let accepted = 0;
  let cancelledForQuorum = false;

  while (pending.size > 0) {
    const completed = await Promise.race(
      [...pending.values()].map((state) =>
        state.terminal.then((terminal) => ({ state, terminal })),
      ),
    );
    pending.delete(completed.state.index);
    const common = {
      index: completed.state.index,
      label: completed.state.scope.label,
      durationMs: Math.max(
        0,
        completed.terminal.completedAtMs - completed.state.startedAtMs,
      ),
      cancelRequested: completed.state.cancelRequested(),
      ...(completed.state.cancelError() === undefined
        ? {}
        : { cancelError: completed.state.cancelError() }),
    };
    if (completed.terminal.status === "fulfilled") {
      if (accept(completed.terminal.value)) accepted += 1;
      records.push({ ...common, status: "fulfilled", value: completed.terminal.value });
    } else {
      records.push({ ...common, status: "rejected", reason: completed.terminal.reason });
    }
    if (!cancelledForQuorum && accepted >= quorum && pending.size > 0) {
      cancelledForQuorum = true;
      for (const state of pending.values()) {
        if (state.isSettled() || state.cancelRequested()) continue;
        state.markCancelRequested();
        try {
          const cancellation = state.scope.cancel(
            "scout candidate quorum reached",
          );
          void Promise.resolve(cancellation).catch((error: unknown) => {
            state.setCancelError(error);
          });
        } catch (error) {
          state.setCancelError(error);
        }
      }
    }
  }
  return records.sort((left, right) => left.index - right.index);
}
```

Do not add a timer, deadline, or `await` around cancellation. The helper drains
only the already-bounded `run()` terminal promises and sorts their records.

- [ ] **Step 4: Run the quorum test and verify GREEN**

Run:

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts \
  --test-name-pattern "awaitBounded late settlement|concurrent scope quorum|quorum cancellation"
```

Expected: PASS.

- [ ] **Step 5: Repeat the identical concurrent selection and mutation check**

Run:

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts \
  --test-name-pattern "awaitBounded late settlement|concurrent scope quorum|quorum cancellation"
```

Expected: PASS. Temporarily move `scope.run()` invocation after the first
completion and confirm the start-order assertion fails with
`Expected: [0, 1, 2, 3], Received: [0]`; restore the helper immediately.

- [ ] **Step 6: Run the complete runtime tests**

Run:

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts
```

Expected: PASS without weakening the existing deadline, settlement, or exact
timeout-retry tests.

- [ ] **Step 7: Typecheck and lint the ignored runtime source**

```bash
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement-runtime.ts
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement-runtime.ts
```

Expected: `typecheck OK` and no unsuppressed ESLint diagnostic.

- [ ] **Step 8: Stage and inspect only Task 2 files**

```bash
git add -- .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached -- .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts
```

Expected staged list, exactly:

```text
.orca/workflows/codebase-improvement-runtime.test.ts
.orca/workflows/codebase-improvement-runtime.ts
```

- [ ] **Step 9: Commit Task 2 after the staged review passes**

```bash
git commit -m "feat(workflow): collect concurrent scout scopes"
```

- [ ] **Review 3: Independently review concurrent-quorum Task 2 range**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
prior_review="$review_root/review-2-scoped-result.txt"
review_file="$review_root/review-3-concurrent-quorum.txt"
task_base=$(sed -n '2s/^Approved-Head: //p' "$prior_review")
approved_head=$(git rev-parse HEAD)
test -n "$task_base"
test "$(tail -n 1 "$prior_review")" = 'ZERO FINDINGS'
git merge-base --is-ancestor "$task_base" "$approved_head"
test "$(git rev-list --count "$task_base..$approved_head")" -ge 1
test "$(git log --format='%s' "$task_base..$approved_head" | \
  awk '$0 == "feat(workflow): collect concurrent scout scopes" { n += 1 } END { print n + 0 }')" -eq 1
git diff --check "$task_base..$approved_head"
git diff "$task_base..$approved_head" -- \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts
```

Give a fresh reviewer the complete `task_base..approved_head` diff and every
RED/GREEN/typecheck/lint result. Save the verbatim response at `$review_file`
with exact `Base: <task_base>` and `Approved-Head: <approved_head>` first lines
and a final `ZERO FINDINGS`, then run:

```bash
test -s "$review_file"
test "$(sed -n '1p' "$review_file")" = "Base: $task_base"
test "$(sed -n '2p' "$review_file")" = "Approved-Head: $approved_head"
test "$(tail -n 1 "$review_file")" = 'ZERO FINDINGS'
test "$(git rev-parse HEAD)" = "$approved_head"
```

Require zero findings for eager start, accepted-count quorum, single
cancellation, synchronous throw and async rejection handling, terminal
draining, record ordering, and absence of a second deadline. On a finding, do
not retain an approved review file and never amend, rebase, squash, or rewrite.
Repair only the two Task 2 paths, rerun its focused checks, add
`fix(review): repair concurrent-quorum task`, and repeat Review 3 over the same
`task_base..HEAD` range. Task 3 cannot start before a clean, range-bound Review
3.

---

### Task 3: Integrate Scoped Conversations And Evidence

**Files:**

- Modify: `.orca/workflows/codebase-improvement.ts:120-150`
- Modify: `.orca/workflows/codebase-improvement.ts:180-300`
- Modify: `.orca/workflows/codebase-improvement.ts:663-980`
- Modify: `.orca/workflows/codebase-improvement.ts:2700-2924`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts:2989-3700`
- Modify: `.orca/workflows/codebase-improvement-runtime.test.ts:3513-3950`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:25-90`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:1500-2621`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:8700-8850`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:9680-10150`
- Modify: `.orca/workflows/codebase-improvement-artifacts.test.ts:1-19019`
- Modify: `.orca/workflows/codebase-improvement.run.md:1-1838`
- Modify: `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md:1-2213`
- Modify: `docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md:1-2787`

**Interfaces:**

- Consumes: Task 1 scoped schemas, validation, aggregation, and typed error;
  Task 2 concurrent quorum helper; existing `reserveConversationTimeouts`,
  `awaitBounded`, `awaitToolFreeOutcome`, `renderScoutEvidence`, and monitor.
- Produces: `runScopedScoutFanout()`, `finalizeScopedScoutRecords()`,
  `failZeroReservedScoutScopes()`, concurrent scope execution,
  `report.scoutEvidence.scopes`, accepted IDs, and scope-classified failure
  evidence.

Task 3 begins only after the finalization-parent task is committed and its
independent Review 1 is clean, and Reviews 2-3 are also clean. Do not start
preflight, a live backend run,
delivery, push, pull-request creation, or merge in this task.

- [ ] **Step 1: Write executable fan-out and finalization behavior tests**

Extend runtime-test imports with `ConversationSettlementTimeoutError`,
`failZeroReservedScoutScopes`, `finalizeScopedScoutRecords`,
`runScopedScoutFanout`, `ScopedScoutFailure`, and the `ConcurrentScopeRecord`
and `ValidatedScopedResult` types. Import
`NoSuitableScoutCandidateError` and the `ScopedScoutResult` type from
`codebase-improvement-lib.ts`. Add this complete fixture and these tests before
changing runtime or workflow production code:

```ts
function scopedCandidateResult(
  index: number,
): Extract<ScopedScoutResult, { readonly status: "candidate" }> {
  const id = ["a", "b", "c", "d"][index];
  if (id === undefined) throw new Error(`missing candidate ${String(index)}`);
  const sourcePath = `src/${id}.ts`;
  const testPath = `tests/${id}.test.ts`;
  return {
    status: "candidate",
    candidate: {
      id,
      title: `fix: repair ${id}`,
      problem: `scope ${id} has a supported defect`,
      evidence: [`${sourcePath}:1 behavior`, `${testPath}:1 observation`],
      allowedPaths: [sourcePath, testPath],
      testPath,
      targetedTestArgs: ["test", testPath],
      expectedFailurePattern: `ORCA_RED:${id}`,
      implementationBrief: `repair ${id} without changing its test`,
      expectedMinutes: 5,
      risk: "low",
    },
    selectedControl: {
      candidateId: id,
      brief: `control ${id}`,
      testName: `control ${id}`,
      productionPath: sourcePath,
    },
  };
}

function scopedNoCandidate(index: number): ScopedScoutResult {
  const id = ["a", "b", "c", "d"][index];
  if (id === undefined) throw new Error(`missing no-candidate ${String(index)}`);
  return {
    status: "no_candidate",
    reason: `src/${id}.ts:1 and tests/${id}.test.ts:1 show no defect`,
  };
}

function scopedPacket(index: number) {
  const id = ["a", "b", "c", "d"][index];
  if (id === undefined) throw new Error(`missing packet ${String(index)}`);
  return {
    pair: { sourcePath: `src/${id}.ts`, testPath: `tests/${id}.test.ts` },
    evidenceSha256: id.repeat(64),
  };
}

function validatedScope(
  index: number,
  result: ScopedScoutResult,
  input: number,
): ValidatedScopedResult {
  return {
    scopeIndex: index,
    result,
    usage: { input, output: input + 10 },
  };
}

test("scoped fanout shares one 75s active and 5s settlement deadline", async () => {
  let nowMs = 0;
  const started: number[] = [];
  const initialActive: number[] = [];
  const initialSettlement: number[] = [];
  const activeRemaining: Array<() => number> = [];
  const settlementRemaining: Array<() => number> = [];
  const deferred = Array.from({ length: 4 }, () =>
    Promise.withResolvers<"no_candidate">(),
  );
  const pending = runScopedScoutFanout({
    conversations: deferred.map((item, index) => ({
      label: `scout scope ${String(index + 1)}`,
      run: (active, settlement) => {
        started.push(index);
        activeRemaining.push(active);
        settlementRemaining.push(settlement);
        initialActive.push(active());
        initialSettlement.push(settlement());
        nowMs += 1_000;
        return item.promise;
      },
      cancel: () => {},
    })),
    modelAllocationMs: 80_000,
    settlementReserveMs: 5_000,
    quorum: 4,
    accept: () => false,
    now: () => nowMs,
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  expect(initialActive).toEqual([75_000, 74_000, 73_000, 72_000]);
  expect(initialSettlement).toEqual([5_000, 5_000, 5_000, 5_000]);

  nowMs = 74_999;
  expect(activeRemaining.map((remaining) => remaining())).toEqual([1, 1, 1, 1]);
  expect(settlementRemaining.map((remaining) => remaining())).toEqual([
    5_000,
    5_000,
    5_000,
    5_000,
  ]);
  nowMs = 75_000;
  for (const remaining of activeRemaining) expect(remaining).toThrow();
  nowMs = 79_999;
  expect(settlementRemaining.map((remaining) => remaining())).toEqual([
    1,
    1,
    1,
    1,
  ]);
  nowMs = 80_000;
  for (const remaining of settlementRemaining) expect(remaining).toThrow();

  for (const item of deferred) item.resolve("no_candidate");
  const result = await pending;
  expect(result.activeTimeoutMs).toBe(75_000);
  expect(result.settlementTimeoutMs).toBe(5_000);
  expect(result.activeDeadlineAtMs).toBe(75_000);
  expect(result.settlementDeadlineAtMs).toBe(80_000);
  expect(result.records).toHaveLength(4);
});

test("scoped fanout preserves exact 80s records before validation", async () => {
  let nowMs = 0;
  const trailing = Promise.withResolvers<ValidatedScopedResult>();
  const pending = runScopedScoutFanout({
    conversations: [
      {
        label: "scout scope 1",
        run: async () => validatedScope(0, scopedCandidateResult(0), 1),
        cancel: () => {},
      },
      {
        label: "scout scope 2",
        run: () => trailing.promise,
        cancel: () => {},
      },
    ],
    modelAllocationMs: 80_000,
    settlementReserveMs: 5_000,
    quorum: 2,
    accept: (value) => value.result.status === "candidate",
    now: () => nowMs,
  });
  await Promise.resolve();
  await Promise.resolve();
  nowMs = 80_000;
  trailing.resolve(validatedScope(1, scopedNoCandidate(1), 2));
  const fanout = await pending;
  const statuses: string[] = [];
  const result = await finalizeScopedScoutRecords({
    records: fanout.records,
    packets: [0, 1].map(scopedPacket),
    timeouts: fanout,
    remaining: () => 10_000,
    persistScopes: (scopes) => statuses.push(...scopes.map((scope) => scope.status)),
    recordUsage: () => {},
    validateTrackedPaths: async () => {},
    persistAccepted: () => {},
    persistZeroValidReport: () => {
      throw new Error("exact-boundary valid sibling must not persist zero-valid report");
    },
    persistZeroValidLedger: () => {
      throw new Error("exact-boundary valid sibling must not persist zero-valid ledger");
    },
  });

  expect(fanout.records[1]?.durationMs).toBe(80_000);
  expect(statuses).toEqual(["candidate", "no_candidate"]);
  expect(result.rankedCandidateIds).toEqual(["a"]);
});

test("scoped finalization keeps one valid mixed sibling and pair-order usage", async () => {
  const records: ConcurrentScopeRecord<ValidatedScopedResult>[] = [
    {
      index: 0,
      label: "scout scope 1",
      status: "fulfilled",
      value: validatedScope(0, scopedCandidateResult(0), 1),
      durationMs: 10,
      cancelRequested: false,
    },
    {
      index: 1,
      label: "scout scope 2",
      status: "fulfilled",
      value: validatedScope(1, scopedNoCandidate(1), 2),
      durationMs: 20,
      cancelRequested: false,
    },
    {
      index: 2,
      label: "scout scope 3",
      status: "rejected",
      reason: new ScopedScoutFailure(
        "off-packet citation",
        "off-packet citation",
        { input: 3, output: 13 },
      ),
      durationMs: 30,
      cancelRequested: false,
    },
    {
      index: 3,
      label: "scout scope 4",
      status: "rejected",
      reason: new ConversationTimeoutError("scout scope 4", 75_000),
      durationMs: 75_000,
      cancelRequested: false,
    },
  ];
  const events: string[] = [];
  const usageInputs: Array<number | undefined> = [];
  const tracked: string[] = [];
  let persistedStatuses: string[] = [];
  let persistedAccepted: string[] = [];
  const result = await finalizeScopedScoutRecords({
    records,
    packets: [0, 1, 2, 3].map(scopedPacket),
    timeouts: { activeTimeoutMs: 75_000, settlementTimeoutMs: 5_000 },
    remaining: () => 10_000,
    persistScopes: (scopes) => {
      persistedStatuses = scopes.map((scope) => scope.status);
      events.push(`scopes:${persistedStatuses.join(",")}`);
    },
    recordUsage: (usage) => {
      usageInputs.push(usage?.input);
      events.push(`usage:${String(usage?.input ?? "none")}`);
    },
    validateTrackedPaths: async (candidate) => {
      tracked.push(candidate.id);
    },
    persistAccepted: (accepted) => {
      persistedAccepted = [...accepted.rankedCandidateIds];
      events.push(`accepted:${persistedAccepted.join(",")}`);
    },
    persistZeroValidReport: () => {
      throw new Error("mixed result must not persist zero-valid report");
    },
    persistZeroValidLedger: () => {
      throw new Error("mixed result must not persist zero-valid ledger");
    },
  });

  expect(result.rankedCandidateIds).toEqual(["a"]);
  expect(persistedStatuses).toEqual([
    "candidate",
    "no_candidate",
    "invalid",
    "timed_out",
  ]);
  expect(usageInputs).toEqual([1, 2, 3, undefined]);
  expect(tracked).toEqual(["a"]);
  expect(persistedAccepted).toEqual(["a"]);
  expect(events[0]).toBe("scopes:candidate,no_candidate,invalid,timed_out");
  expect(events.at(-1)).toBe("accepted:a");
});

test("scoped finalization retains cancelled terminal usage without accepting it", async () => {
  const records: ConcurrentScopeRecord<ValidatedScopedResult>[] = [
    {
      index: 0,
      label: "scout scope 1",
      status: "fulfilled",
      value: validatedScope(0, scopedCandidateResult(0), 1),
      durationMs: 10,
      cancelRequested: false,
    },
    {
      index: 1,
      label: "scout scope 2",
      status: "fulfilled",
      value: validatedScope(1, scopedCandidateResult(1), 4),
      durationMs: 20,
      cancelRequested: true,
    },
  ];
  const statuses: string[] = [];
  const usageInputs: Array<number | undefined> = [];
  const result = await finalizeScopedScoutRecords({
    records,
    packets: [0, 1].map(scopedPacket),
    timeouts: { activeTimeoutMs: 75_000, settlementTimeoutMs: 5_000 },
    remaining: () => 10_000,
    persistScopes: (scopes) => statuses.push(...scopes.map((scope) => scope.status)),
    recordUsage: (usage) => usageInputs.push(usage?.input),
    validateTrackedPaths: async () => {},
    persistAccepted: () => {},
    persistZeroValidReport: () => {},
    persistZeroValidLedger: () => {},
  });
  expect(statuses).toEqual(["candidate", "cancelled_after_quorum"]);
  expect(usageInputs).toEqual([1, 4]);
  expect(result.rankedCandidateIds).toEqual(["a"]);
});

test("scoped finalization persists zero-valid report and ledger before no delivery", async () => {
  const records: ConcurrentScopeRecord<ValidatedScopedResult>[] = [
    {
      index: 0,
      label: "scout scope 1",
      status: "fulfilled",
      value: validatedScope(0, scopedNoCandidate(0), 1),
      durationMs: 10,
      cancelRequested: false,
    },
    {
      index: 1,
      label: "scout scope 2",
      status: "rejected",
      reason: new Error("assistant_tool_call is forbidden"),
      durationMs: 20,
      cancelRequested: false,
    },
    {
      index: 2,
      label: "scout scope 3",
      status: "rejected",
      reason: new ConversationTimeoutError("scout scope 3", 75_000),
      durationMs: 75_000,
      cancelRequested: false,
    },
    {
      index: 3,
      label: "scout scope 4",
      status: "rejected",
      reason: new ConversationSettlementTimeoutError("scout scope 4", 5_000),
      durationMs: 80_000,
      cancelRequested: false,
    },
  ];
  const events: string[] = [];
  let reportSummary = "";
  let ledgerSummary = "";
  let settlementTerminal = "";
  let reproduceCalls = 0;
  let deliveryCalls = 0;
  let thrown: unknown;
  try {
    const result = await finalizeScopedScoutRecords({
      records,
      packets: [0, 1, 2, 3].map(scopedPacket),
      timeouts: { activeTimeoutMs: 75_000, settlementTimeoutMs: 5_000 },
      remaining: () => 10_000,
      persistScopes: (scopes) => {
        events.push(`scopes:${scopes.map((scope) => scope.status).join(",")}`);
        settlementTerminal = scopes[3]?.terminal.status ?? "missing";
      },
      recordUsage: (usage) => events.push(`usage:${String(usage?.input ?? "none")}`),
      validateTrackedPaths: async () => {},
      persistAccepted: () => {
        throw new Error("zero-valid result must not persist accepted candidates");
      },
      persistZeroValidReport: (summary) => {
        reportSummary = summary;
        events.push("zero-valid-report");
      },
      persistZeroValidLedger: (summary) => {
        ledgerSummary = summary;
        events.push("zero-valid-ledger");
      },
    });
    reproduceCalls += 1;
    void result;
    deliveryCalls += 1;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(NoSuitableScoutCandidateError);
  expect(events[0]).toBe("scopes:no_candidate,invalid,timed_out,timed_out");
  expect(events.slice(-2)).toEqual(["zero-valid-report", "zero-valid-ledger"]);
  expect(reportSummary).toBe(ledgerSummary);
  expect(reportSummary).toContain("scout scope 1|no_candidate");
  expect(reportSummary).toContain("assistant_tool_call is forbidden");
  expect(reportSummary).toContain("scout scope 3 exceeded 75000ms");
  expect(reportSummary).toContain("cancellation did not settle within 5000ms");
  expect(settlementTerminal).toBe("unsettled");
  expect(reproduceCalls).toBe(0);
  expect(deliveryCalls).toBe(0);
});

test("scoped finalization routes zero reserved scopes to typed no delivery", () => {
  const events: string[] = [];
  let reportSummary = "";
  let ledgerSummary = "";
  let reproduceCalls = 0;
  let deliveryCalls = 0;
  let thrown: unknown;
  try {
    failZeroReservedScoutScopes({
      persistZeroValidReport: (summary) => {
        reportSummary = summary;
        events.push("zero-valid-report");
      },
      persistZeroValidLedger: (summary) => {
        ledgerSummary = summary;
        events.push("zero-valid-ledger");
      },
    });
    reproduceCalls += 1;
    deliveryCalls += 1;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(NoSuitableScoutCandidateError);
  expect(reportSummary.length).toBeGreaterThan(0);
  expect(reportSummary).toBe(ledgerSummary);
  expect(events).toEqual(["zero-valid-report", "zero-valid-ledger"]);
  expect(reproduceCalls).toBe(0);
  expect(deliveryCalls).toBe(0);
});
```

- [ ] **Step 2: Run every new behavior test and verify RED**

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts \
  --test-name-pattern "scoped fanout|scoped finalization"
```

Expected: FAIL with an import diagnostic naming
`runScopedScoutFanout` or `finalizeScopedScoutRecords`. A fixture, parse, or
unrelated failure is not the required RED.

- [ ] **Step 3: Implement shared deadlines and record finalization**

Add `Outcome` to the runtime's Orcats type imports. Extend its library import
with `buildScoutResult`, `NoSuitableScoutCandidateError`, and the
`ScoutCandidate`, `ScoutResult`, `ScoutSourceTestPair`,
`ScopedScoutRankedResult`, and `ScopedScoutResult` types. Add this complete code
after Task 2's `awaitConcurrentScopeQuorum()`:

```ts
export interface ScopedScoutConversation<T> {
  readonly label: string;
  readonly run: (
    activeRemaining: () => number,
    settlementRemaining: () => number,
  ) => Promise<T>;
  readonly cancel: (reason: string) => void | Promise<void>;
}

export interface ScopedScoutFanoutResult<T> {
  readonly records: ConcurrentScopeRecord<T>[];
  readonly activeTimeoutMs: number;
  readonly settlementTimeoutMs: number;
  readonly activeDeadlineAtMs: number;
  readonly settlementDeadlineAtMs: number;
}

export async function runScopedScoutFanout<T>(options: {
  readonly conversations: readonly ScopedScoutConversation<T>[];
  readonly modelAllocationMs: number;
  readonly settlementReserveMs: number;
  readonly quorum: number;
  readonly accept: (value: T) => boolean;
  readonly now?: () => number;
}): Promise<ScopedScoutFanoutResult<T>> {
  const now = options.now ?? Date.now;
  const timeouts = reserveConversationTimeouts(
    options.modelAllocationMs,
    options.modelAllocationMs,
    options.settlementReserveMs,
    "scout",
  );
  const startedAtMs = now();
  const activeDeadlineAtMs = startedAtMs + timeouts.activeTimeoutMs;
  const settlementDeadlineAtMs =
    activeDeadlineAtMs + timeouts.settlementTimeoutMs;
  const scopes: ConcurrentScope<T>[] = options.conversations.map(
    (conversation) => ({
      label: conversation.label,
      run: () =>
        conversation.run(
          () =>
            remainingTimeout(
              timeouts.activeTimeoutMs,
              activeDeadlineAtMs - now(),
              conversation.label,
            ),
          () =>
            remainingTimeout(
              timeouts.settlementTimeoutMs,
              settlementDeadlineAtMs - now(),
              `${conversation.label} settlement`,
            ),
        ),
      cancel: conversation.cancel,
    }),
  );
  const records = await awaitConcurrentScopeQuorum(
    scopes,
    options.quorum,
    options.accept,
    now,
  );
  return {
    records,
    activeTimeoutMs: timeouts.activeTimeoutMs,
    settlementTimeoutMs: timeouts.settlementTimeoutMs,
    activeDeadlineAtMs,
    settlementDeadlineAtMs,
  };
}

export interface ValidatedScopedResult {
  readonly scopeIndex: number;
  readonly result: ScopedScoutResult;
  readonly usage?: Usage;
}

export interface ScopedScoutPacket {
  readonly pair: ScoutSourceTestPair;
  readonly evidenceSha256: string;
}

export interface ScopedScoutScopeReport {
  readonly index: number;
  readonly sourcePath: string;
  readonly testPath: string;
  readonly label: string;
  readonly status:
    | "candidate"
    | "no_candidate"
    | "invalid"
    | "timed_out"
    | "cancelled_after_quorum";
  readonly durationMs: number;
  readonly activeTimeoutMs: number;
  readonly settlementTimeoutMs: number;
  readonly evidenceSha256: string;
  readonly candidateId?: string;
  readonly reason?: string;
  readonly validationFailure?: string;
  readonly failure?: string;
  readonly cancelRequested: boolean;
  readonly cancelFailure?: string;
  readonly terminal: {
    readonly status: "fulfilled" | "rejected" | "unsettled";
    readonly failure?: string;
    readonly usage?: Usage;
  };
  readonly usage?: Usage;
}

type FulfilledCandidateScopeRecord = Extract<
  ConcurrentScopeRecord<ValidatedScopedResult>,
  { readonly status: "fulfilled" }
> & {
  readonly value: ValidatedScopedResult & {
    readonly result: Extract<
      ScopedScoutResult,
      { readonly status: "candidate" }
    >;
  };
};

export class ScopedScoutFailure extends Error {
  constructor(
    message: string,
    readonly validationFailure?: string,
    readonly usage?: Usage,
  ) {
    super(message);
    this.name = "ScopedScoutFailure";
  }
}

function outcomeUsage(outcome: Outcome): Usage | undefined {
  return outcome.type === "success" ? outcome.result.usage : undefined;
}

export function scopedOutcomeFailure(outcome: Outcome): ScopedScoutFailure {
  if (outcome.type === "success") {
    throw new Error("successful scout outcome cannot be a scope failure");
  }
  return new ScopedScoutFailure(normalizeFailure(outcome), undefined);
}

export function scopedValidationFailure(
  failure: string,
  usage: Usage | undefined,
): ScopedScoutFailure {
  return new ScopedScoutFailure(failure, failure, usage);
}

function scopeRecordTerminalUsage(
  record: ConcurrentScopeRecord<ValidatedScopedResult>,
): Usage | undefined {
  if (record.status === "fulfilled") return record.value.usage;
  if (record.reason instanceof ScopedScoutFailure) return record.reason.usage;
  if (
    record.reason instanceof ConversationTimeoutError &&
    record.reason.terminal?.status === "fulfilled"
  ) {
    return outcomeUsage(record.reason.terminal.value as Outcome);
  }
  return undefined;
}

function scopeRecordTerminal(
  record: ConcurrentScopeRecord<ValidatedScopedResult>,
): ScopedScoutScopeReport["terminal"] {
  const usage = scopeRecordTerminalUsage(record);
  if (record.status === "fulfilled" || record.reason instanceof ScopedScoutFailure) {
    return { status: "fulfilled", ...(usage === undefined ? {} : { usage }) };
  }
  if (record.reason instanceof ConversationSettlementTimeoutError) {
    return {
      status: "unsettled",
      failure: normalizeFailure(record.reason),
    };
  }
  if (record.reason instanceof ConversationTimeoutError) {
    const terminal = record.reason.terminal;
    if (terminal === undefined) {
      return { status: "unsettled", failure: normalizeFailure(record.reason) };
    }
    if (terminal.status === "rejected") {
      return { status: "rejected", failure: normalizeFailure(terminal.reason) };
    }
    const terminalUsage = outcomeUsage(terminal.value as Outcome);
    return {
      status: "fulfilled",
      ...(terminalUsage === undefined ? {} : { usage: terminalUsage }),
    };
  }
  return { status: "rejected", failure: normalizeFailure(record.reason) };
}

function toScopedScoutScopeReport(
  record: ConcurrentScopeRecord<ValidatedScopedResult>,
  packets: readonly ScopedScoutPacket[],
  timeouts: {
    readonly activeTimeoutMs: number;
    readonly settlementTimeoutMs: number;
  },
): ScopedScoutScopeReport {
  const packet = packets[record.index];
  if (packet === undefined) {
    throw new Error(`scout scope ${String(record.index + 1)} packet is missing`);
  }
  const usage = scopeRecordTerminalUsage(record);
  const common = {
    index: record.index,
    sourcePath: packet.pair.sourcePath,
    testPath: packet.pair.testPath,
    label: `scout scope ${String(record.index + 1)}`,
    durationMs: record.durationMs,
    activeTimeoutMs: timeouts.activeTimeoutMs,
    settlementTimeoutMs: timeouts.settlementTimeoutMs,
    evidenceSha256: packet.evidenceSha256,
    cancelRequested: record.cancelRequested,
    ...(record.cancelError === undefined
      ? {}
      : { cancelFailure: normalizeFailure(record.cancelError) }),
    terminal: scopeRecordTerminal(record),
    ...(usage === undefined ? {} : { usage }),
  };
  if (record.cancelRequested) {
    return {
      ...common,
      status: "cancelled_after_quorum",
      ...(record.status === "rejected"
        ? { failure: normalizeFailure(record.reason) }
        : {}),
    };
  }
  if (record.status === "fulfilled") {
    return record.value.result.status === "no_candidate"
      ? { ...common, status: "no_candidate", reason: record.value.result.reason }
      : {
          ...common,
          status: "candidate",
          candidateId: record.value.result.candidate.id,
        };
  }
  if (
    record.reason instanceof ConversationTimeoutError ||
    record.reason instanceof ConversationSettlementTimeoutError
  ) {
    return {
      ...common,
      status: "timed_out",
      failure: normalizeFailure(record.reason),
    };
  }
  if (record.reason instanceof ScopedScoutFailure) {
    return {
      ...common,
      status: "invalid",
      failure: record.reason.message,
      ...(record.reason.validationFailure === undefined
        ? {}
        : { validationFailure: record.reason.validationFailure }),
    };
  }
  return { ...common, status: "invalid", failure: normalizeFailure(record.reason) };
}

function summarizeScopedScoutFailures(
  scopes: readonly ScopedScoutScopeReport[],
): string {
  return scopes
    .map((scope) =>
      [
        scope.label,
        scope.status,
        scope.sourcePath,
        scope.testPath,
        scope.reason ?? scope.validationFailure ?? scope.failure ?? "none",
      ].join("|"),
    )
    .join("\n");
}

const ZERO_RESERVED_SCOUT_SCOPES_SUMMARY =
  "scout reservation produced no reserved source-test scopes";

export function failZeroReservedScoutScopes(options: {
  readonly persistZeroValidReport: (summary: string) => void;
  readonly persistZeroValidLedger: (summary: string) => void;
}): never {
  options.persistZeroValidReport(ZERO_RESERVED_SCOUT_SCOPES_SUMMARY);
  options.persistZeroValidLedger(ZERO_RESERVED_SCOUT_SCOPES_SUMMARY);
  throw new NoSuitableScoutCandidateError();
}

function isFulfilledCandidateScopeRecord(
  record: ConcurrentScopeRecord<ValidatedScopedResult>,
): record is FulfilledCandidateScopeRecord {
  return (
    record.status === "fulfilled" &&
    !record.cancelRequested &&
    record.value.result.status === "candidate"
  );
}

export async function finalizeScopedScoutRecords(options: {
  readonly records: readonly ConcurrentScopeRecord<ValidatedScopedResult>[];
  readonly packets: readonly ScopedScoutPacket[];
  readonly timeouts: {
    readonly activeTimeoutMs: number;
    readonly settlementTimeoutMs: number;
  };
  readonly remaining: () => number;
  readonly persistScopes: (scopes: readonly ScopedScoutScopeReport[]) => void;
  readonly recordUsage: (usage: Usage | undefined) => void;
  readonly validateTrackedPaths: (candidate: ScoutCandidate) => Promise<void>;
  readonly persistAccepted: (result: ScoutResult) => void;
  readonly persistZeroValidReport: (summary: string) => void;
  readonly persistZeroValidLedger: (summary: string) => void;
}): Promise<ScoutResult> {
  options.remaining();
  const records = [...options.records].sort(
    (left, right) => left.index - right.index,
  );
  const scopes = records.map((record) =>
    toScopedScoutScopeReport(record, options.packets, options.timeouts),
  );
  options.persistScopes(scopes);
  for (const record of records) {
    options.remaining();
    options.recordUsage(scopeRecordTerminalUsage(record));
  }
  const accepted = records.filter(isFulfilledCandidateScopeRecord);
  for (const record of accepted) {
    options.remaining();
    await options.validateTrackedPaths(record.value.result.candidate);
  }
  options.remaining();
  if (accepted.length === 0) {
    const summary = summarizeScopedScoutFailures(scopes);
    options.persistZeroValidReport(summary);
    options.remaining();
    options.persistZeroValidLedger(summary);
    throw new NoSuitableScoutCandidateError();
  }
  const ranked: ScopedScoutRankedResult[] = accepted.map((record) => ({
    ...record.value.result,
    scopeIndex: record.value.scopeIndex,
  }));
  const result = buildScoutResult(ranked);
  options.remaining();
  options.persistAccepted(result);
  return result;
}
```

- [ ] **Step 4: Repeat every behavior test and verify GREEN**

```bash
bun test .orca/workflows/codebase-improvement-runtime.test.ts \
  --test-name-pattern "scoped fanout|scoped finalization"
```

Expected: PASS. This is byte-for-byte the RED selection from Step 2 and proves
mixed siblings, pair-order report/usage persistence, cancellation exclusion,
typed zero-valid/no-delivery behavior, one absolute `75_000 + 5_000` deadline,
active timeout, tool failure, and settlement timeout as unsettled timed-out
evidence.

- [ ] **Step 5: Write workflow wiring contract tests**

Extend the contract-test runtime import with `remainingTimeout`.

Update the contract fixture's scout constants to:

```ts
const EXPECTED_SCOUT_NUMERIC_CONSTANTS = {
  SCOUT_GATHER_LIMIT_MS: 10_000,
  SCOUT_MODEL_LIMIT_MS: 80_000,
  SCOUT_VALIDATION_LIMIT_MS: 10_000,
  SCOUT_SCOPE_QUORUM: 3,
  SCOUT_EVIDENCE_MAX_FILES: 8,
  SCOUT_EVIDENCE_MAX_CHARS: 10_000,
} as const;
```

Remove `SCOUT_ATTEMPT_LIMIT_MS` and `FALLBACK_CONTROL_LIMIT_MS` from that
fixture. Replace its plural exact-three prompt directives with:

```ts
const REQUIRED_SCOUT_PROMPT_DIRECTIVES = [
  "Use only this reserved source-test evidence packet.",
  "Do not inspect the repository or call tools.",
  "Return status candidate only for one supported low-risk defect in this pair.",
  "Otherwise return status no_candidate with cited packet evidence.",
  "Set allowedPaths exactly to the reserved source and test paths.",
  'Set targetedTestArgs exactly to ["test", testPath].',
  "Set expectedFailurePattern exactly to ORCA_RED:<candidate-id>.",
  "Cite rendered lines from both reserved paths.",
] as const;
```

Add these complete whitespace-free wiring helpers. They deliberately test only
that the workflow calls the already behavior-tested runtime helpers correctly;
Steps 1-4 own record classification, ordering, cancellation, time, usage, and
zero-valid behavior.

```ts
function replaceOnce(source: string, from: string, to: string): string {
  const mutated = source.replace(from, to);
  expect(mutated).not.toBe(source);
  return mutated;
}

function compactTypeScript(source: string): string {
  return source.replace(/\s+/g, "");
}

function scoutWorkflowBlock(source: string): string {
  const start = source.indexOf('enter("scout")');
  const end = source.indexOf('enter("reproduce")', start + 1);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

function occurrenceCount(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function scopedScoutWorkflowIssues(
  workflowSource: string,
  runtimeSource: string,
): string[] {
  const issues: string[] = [];
  const workflow = compactTypeScript(workflowSource);
  const scout = compactTypeScript(scoutWorkflowBlock(workflowSource));
  const runtime = compactTypeScript(runtimeSource);
  const requireWorkflow = (needle: string, issue: string): void => {
    if (!workflow.includes(compactTypeScript(needle))) issues.push(issue);
  };
  const requireScout = (needle: string, issue: string): void => {
    if (!scout.includes(compactTypeScript(needle))) issues.push(issue);
  };
  const requireRuntime = (needle: string, issue: string): void => {
    if (!runtime.includes(compactTypeScript(needle))) issues.push(issue);
  };

  if (scout === "") issues.push("scout stage block is missing");
  requireWorkflow(
    'stageConfig("scout", config.stages.scout, true)',
    "scout config must remain read-only",
  );
  requireScout(
    "const reservedPairs: ScoutSourceTestPair[] = selection.sourceTestPairs.slice(0, 4).map((pair) => ({ ...pair }))",
    "scout must copy one capped canonical reservedPairs array",
  );
  requireScout(
    "const scopedPackets = reservedPairs.map((pair) =>",
    "scout packets must derive from canonical reservedPairs",
  );
  requireScout(
    "gatherRemaining(); const evidence = renderScoutEvidence(evidenceFiles, SCOUT_EVIDENCE_MAX_CHARS, latestCommitPrefix, reservedPairs,); gatherRemaining(); const evidenceSha256 = createHash(\"sha256\").update(evidence.text).digest(\"hex\"); gatherRemaining()",
    "shared evidence render and digest must remain inside gather deadline",
  );
  requireScout(
    "if (reservedPairs.length === 0) { failZeroReservedScoutScopes({",
    "zero reserved pairs must use typed report-and-ledger failure",
  );
  requireScout(
    "report.scoutEvidence.sourceTestPairs = reservedPairs.map((pair) => ({ ...pair }))",
    "scout report pairs must derive from canonical reservedPairs",
  );
  requireScout(
    "const scopedConversations: ScopedScoutConversation<ValidatedScopedResult>[] = scopedPackets.map",
    "scoped conversations must derive from canonical scopedPackets",
  );
  requireScout(
    "gatherRemaining(); const scopedConversations: ScopedScoutConversation<ValidatedScopedResult>[] = scopedPackets.map",
    "conversation construction must start inside the gather deadline",
  );
  requireScout(
    "const label = `scout scope ${String(index + 1)}`; gatherRemaining(); const scoutConversation = llm().autonomous",
    "each scoped conversation must check gather expiry before construction",
  );
  requireScout(
    "renderScoutEvidence(files, pairEvidenceLimit, latestCommitPrefix, [pair])",
    "each scoped packet must contain only its reserved pair",
  );
  requireScout(
    "gatherRemaining(); const packet = renderScoutEvidence(files, pairEvidenceLimit, latestCommitPrefix, [pair],); gatherRemaining(); const scopedEvidenceSha256 = createHash(\"sha256\").update(packet.text).digest(\"hex\"); gatherRemaining(); return { pair, packet, evidenceSha256: scopedEvidenceSha256,",
    "each scoped packet render and digest must remain inside gather deadline",
  );
  requireScout(
    "llm().autonomous(selectedStageBackend",
    "scoped scout must use selected backend",
  );
  requireScout(
    "config: selectedStageConfig(scoutConfig)",
    "scoped scout must use selected configuration",
  );
  requireScout(
    "const label = `scout scope ${String(index + 1)}`",
    "scoped scout label is missing",
  );
  requireScout(
    "awaitToolFreeOutcome(scoutConversation, () => awaitBounded(scoutConversation, activeRemaining(), label, settlementRemaining,),)",
    "scoped scout must nest one same-conversation bounded wait in tool guard",
  );
  requireScout(
    "...(outcome.result.usage === undefined ? {} : { usage: outcome.result.usage })",
    "scoped result must omit absent optional usage",
  );
  requireScout(
    "validateScopedScoutResult(parsed.data, pair, packet, profile)",
    "scoped result must validate profile and packet before finalization",
  );
  requireScout(
    "const fanout = await runScopedScoutFanout({ conversations: scopedConversations",
    "workflow must call runScopedScoutFanout",
  );
  requireScout(
    "quorum: Math.min(SCOUT_SCOPE_QUORUM, scopedConversations.length)",
    "fanout quorum must be normalized to conversation count",
  );
  requireScout(
    'accept: (value) => value.result.status === "candidate"',
    "fanout acceptance must use validated candidate status",
  );
  requireScout(
    "const scoutResult = await finalizeScopedScoutRecords({ records: fanout.records",
    "workflow must call finalizeScopedScoutRecords",
  );
  requireScout(
    "packets: scopedPackets.map(({ pair, evidenceSha256 }) => ({ pair, evidenceSha256 }))",
    "finalization packets must reuse canonical scopedPackets",
  );
  requireScout(
    "persistScopes: (scopes) => { report.scoutEvidence.scopes = scopes.map",
    "ordered scopes must persist into report",
  );
  requireScout(
    "recordUsage, validateTrackedPaths: async (candidate) =>",
    "finalization must receive one usage sink and tracked-path callback",
  );
  requireScout(
    "persistAccepted: (accepted) => { report.scoutEvidence.acceptedCandidateIds",
    "accepted ranking must persist into report",
  );
  requireScout(
    "persistZeroValidReport: (summary) => { report.scoutEvidence.zeroValidSummary = summary",
    "zero-valid report callback is missing",
  );
  requireScout(
    "persistZeroValidLedger: (summary) => { zeroValidLedgerEvidence = summary",
    "zero-valid ledger callback is missing",
  );
  requireWorkflow(
    "error instanceof NoSuitableScoutCandidateError ? zeroValidLedgerEvidence ?? report.scoutEvidence?.zeroValidSummary ?? normalizeFailure(error) : normalizeFailure(error)",
    "typed zero-valid issue must reuse ordered ledger/report evidence",
  );
  requireRuntime(
    "const records = [...options.records].sort((left, right) => left.index - right.index)",
    "runtime must sort records in pair order",
  );
  requireRuntime(
    "options.persistScopes(scopes); for (const record of records) { options.remaining(); options.recordUsage(scopeRecordTerminalUsage(record)); }",
    "runtime must persist scopes then record usage once in pair order",
  );
  requireRuntime(
    "options.persistZeroValidReport(summary); options.remaining(); options.persistZeroValidLedger(summary); throw new NoSuitableScoutCandidateError()",
    "runtime must persist report then ledger before typed zero-valid failure",
  );
  requireRuntime(
    "options.persistZeroValidReport(ZERO_RESERVED_SCOUT_SCOPES_SUMMARY); options.persistZeroValidLedger(ZERO_RESERVED_SCOUT_SCOPES_SUMMARY); throw new NoSuitableScoutCandidateError()",
    "zero reserved scopes must persist deterministic report and ledger evidence",
  );
  requireRuntime(
    "record.reason instanceof ConversationSettlementTimeoutError) { return { status: \"unsettled\"",
    "settlement timeout must persist an unsettled terminal",
  );
  requireRuntime(
    "record.reason instanceof ConversationTimeoutError || record.reason instanceof ConversationSettlementTimeoutError",
    "settlement timeout must map to timed-out scope status",
  );

  if (occurrenceCount(scout, "constreservedPairs:") !== 1) {
    issues.push("scout must declare reservedPairs exactly once");
  }
  if (occurrenceCount(scout, "constscopedPackets=") !== 1) {
    issues.push("scout must declare scopedPackets exactly once");
  }
  if (
    occurrenceCount(
      runtime,
      "options.recordUsage(scopeRecordTerminalUsage(record));",
    ) !== 1 ||
    scout.includes("recordUsage(")
  ) {
    issues.push("terminal usage must have one runtime pair-order loop");
  }
  if (scout.includes("Promise.all(")) {
    issues.push("scout workflow must not bypass bounded fanout with Promise.all");
  }
  if (scout.includes("if(Date.now()>=fanout.settlementDeadlineAtMs)")) {
    issues.push("exact-boundary fanout records must reach finalization");
  }
  for (const stale of [
    "awaitOneTimeoutRetry",
    "SCOUT_ATTEMPT_LIMIT_MS",
    "FALLBACK_CONTROL_LIMIT_MS",
    "fallbackControlPrompt",
    "resolveFallbackControl",
  ]) {
    if (workflowSource.includes(stale)) issues.push(`stale scout path remains: ${stale}`);
  }
  for (const duplicate of [
    "interface ValidatedScopedResult",
    "interface ScopedScoutConversation",
    "interface ScopedScoutPacket",
    "interface ScopedScoutScopeReport",
    "type FulfilledCandidateScopeRecord",
    "class ScopedScoutFailure",
    "function scopeRecordTerminalUsage",
    "function toScopedScoutScopeReport",
    "function summarizeScopedScoutFailures",
  ]) {
    if (workflowSource.includes(duplicate)) {
      issues.push(`workflow duplicates runtime scout helper: ${duplicate}`);
    }
  }
  return issues;
}
```

Add the baseline and mutation tests:

```ts
test("scoped scout workflow wires runtime helpers", async () => {
  const [workflowSource, runtimeSource] = await Promise.all([
    Bun.file(path).text(),
    Bun.file(runtimePath).text(),
  ]);
  expect(scopedScoutWorkflowIssues(workflowSource, runtimeSource)).toEqual([]);
});

test("scoped scout workflow blocks model start after delayed packet render", () => {
  let nowMs = 0;
  let hashCalls = 0;
  let modelStarts = 0;
  const gatherDeadlineAtMs = 10_000;
  const gatherRemaining = (): number =>
    remainingTimeout(
      10_000,
      gatherDeadlineAtMs - nowMs,
      "scout gather",
    );
  const renderPacket = (): string => {
    nowMs = gatherDeadlineAtMs;
    return "delayed-packet";
  };

  expect(() => {
    gatherRemaining();
    void renderPacket();
    gatherRemaining();
    hashCalls += 1;
    gatherRemaining();
    modelStarts += 1;
  }).toThrow("sla-overrun before scout gather");
  expect(hashCalls).toBe(0);
  expect(modelStarts).toBe(0);
});

test("scoped scout workflow rejects wiring mutations", async () => {
  const [workflowSource, runtimeSource] = await Promise.all([
    Bun.file(path).text(),
    Bun.file(runtimePath).text(),
  ]);
  const workflowMutations = [
    [
      "writable scout",
      'stageConfig("scout", config.stages.scout, true)',
      'stageConfig("scout", config.stages.scout, false)',
      "scout config must remain read-only",
    ],
    [
      "noncanonical packets",
      "const scopedPackets = reservedPairs.map",
      "const scopedPackets = selection.sourceTestPairs.map",
      "scout packets must derive from canonical reservedPairs",
    ],
    [
      "raw quorum",
      "Math.min(SCOUT_SCOPE_QUORUM, scopedConversations.length)",
      "SCOUT_SCOPE_QUORUM",
      "fanout quorum must be normalized to conversation count",
    ],
    [
      "wrong bounded conversation",
      "awaitBounded(\n                scoutConversation,",
      "awaitBounded(\n                otherConversation,",
      "scoped scout must nest one same-conversation bounded wait in tool guard",
    ],
    [
      "eager settlement budget",
      "settlementRemaining,\n              )",
      "settlementRemaining(),\n              )",
      "scoped scout must nest one same-conversation bounded wait in tool guard",
    ],
    [
      "missing post-render gather deadline",
      "  );\n  gatherRemaining();\n  const scopedEvidenceSha256 = createHash(\"sha256\")",
      "  );\n  void 0;\n  const scopedEvidenceSha256 = createHash(\"sha256\")",
      "each scoped packet render and digest must remain inside gather deadline",
    ],
    [
      "missing post-digest gather deadline",
      "    .digest(\"hex\");\n  gatherRemaining();\n  return {",
      "    .digest(\"hex\");\n  void 0;\n  return {",
      "each scoped packet render and digest must remain inside gather deadline",
    ],
    [
      "missing pre-conversation gather deadline",
      "    const label = `scout scope ${String(index + 1)}`;\n    gatherRemaining();\n    const scoutConversation = llm().autonomous",
      "    const label = `scout scope ${String(index + 1)}`;\n    void 0;\n    const scoutConversation = llm().autonomous",
      "each scoped conversation must check gather expiry before construction",
    ],
    [
      "generic zero-reservation failure",
      "failZeroReservedScoutScopes({",
      "ignoreZeroReservedScoutScopes({",
      "zero reserved pairs must use typed report-and-ledger failure",
    ],
    [
      "missing profile validation",
      "validateScopedScoutResult(\n            parsed.data,\n            pair,\n            packet,\n            profile,\n          )",
      "validateScopedScoutResult(parsed.data, pair, packet, \"simple\")",
      "scoped result must validate profile and packet before finalization",
    ],
    [
      "unbounded Promise.all",
      "const fanout = await runScopedScoutFanout({",
      "void Promise.all([]);\n      const fanout = await runScopedScoutFanout({",
      "scout workflow must not bypass bounded fanout with Promise.all",
    ],
    [
      "missing finalization",
      "const scoutResult = await finalizeScopedScoutRecords({",
      "const scoutResult = await Promise.resolve({",
      "workflow must call finalizeScopedScoutRecords",
    ],
    [
      "post-model boundary rejection",
      "const validationDeadlineAtMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;",
      "if (Date.now() >= fanout.settlementDeadlineAtMs) throw new Error(\"late\");\n      const validationDeadlineAtMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;",
      "exact-boundary fanout records must reach finalization",
    ],
    [
      "missing tracked paths",
      "validateTrackedPaths: async (candidate) =>",
      "validateTrackedPaths: async () =>",
      "finalization must receive one usage sink and tracked-path callback",
    ],
  ] as const;
  for (const [name, from, to, issue] of workflowMutations) {
    const mutated = replaceOnce(workflowSource, from, to);
    expect(scopedScoutWorkflowIssues(mutated, runtimeSource), name).toContain(
      issue,
    );
  }

  const usageMutation = replaceOnce(
    runtimeSource,
    "options.recordUsage(scopeRecordTerminalUsage(record));",
    "options.recordUsage(undefined);",
  );
  expect(scopedScoutWorkflowIssues(workflowSource, usageMutation)).toContain(
    "runtime must persist scopes then record usage once in pair order",
  );
  const orderMutation = replaceOnce(
    runtimeSource,
    "options.persistZeroValidReport(summary);",
    "options.persistZeroValidLedger(summary);",
  );
  expect(scopedScoutWorkflowIssues(workflowSource, orderMutation)).toContain(
    "runtime must persist report then ledger before typed zero-valid failure",
  );
  const settlementMutation = replaceOnce(
    runtimeSource,
    "record.reason instanceof ConversationSettlementTimeoutError",
    "record.reason instanceof ScopedScoutFailure",
  );
  expect(scopedScoutWorkflowIssues(workflowSource, settlementMutation)).toContain(
    "settlement timeout must persist an unsettled terminal",
  );
});
```

- [ ] **Step 6: Run the exact contract selection and verify RED**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "scoped scout workflow|scout synthesis|scout prompt|scout timing|scout report|one to three ranked"
```

Expected: FAIL only because the workflow has not yet declared canonical scoped
packets or called `runScopedScoutFanout()` and `finalizeScopedScoutRecords()`.
The runtime settlement, ordering, and usage checks already pass after Step 4.
A fixture, parse, or unrelated failure is not the required RED.

- [ ] **Step 7: Wire scoped prompt, report, imports, fanout, and finalization**

Add `SCOUT_SCOPE_QUORUM = 3`. Delete `SCOUT_ATTEMPT_LIMIT_MS` and
`FALLBACK_CONTROL_LIMIT_MS`. Replace `scoutPrompt()` with:

```ts
function scopedScoutPrompt(
  profile: ComplexityProfile,
  limits: (typeof profileLimits)[ComplexityProfile],
  pair: ScoutSourceTestPair,
  evidence: string,
): string {
  return [
    "Use only this reserved source-test evidence packet.",
    "Do not inspect the repository or call tools.",
    "Return status candidate only for one supported low-risk defect in this pair.",
    "Otherwise return status no_candidate with cited packet evidence.",
    `Reserved source path: ${pair.sourcePath}.`,
    `Reserved test path: ${pair.testPath}.`,
    "Set allowedPaths exactly to the reserved source and test paths.",
    'Set targetedTestArgs exactly to ["test", testPath].',
    "Set expectedFailurePattern exactly to ORCA_RED:<candidate-id>.",
    "Cite rendered lines from both reserved paths.",
    `The candidate must fit ${profile}: ${String(limits.minMinutes)}-${String(limits.maxMinutes)} minutes and at most ${String(limits.maxPaths)} paths.`,
    "Treat current implementation and tests as stronger evidence than speculation.",
    evidence,
  ].join("\n");
}
```

In `RunReport.scoutEvidence`, replace `attempts: TimeoutRetryRecord[]` with
these fields and retain the existing paths, pairs, character count, digest,
accepted-control, latest-commit, command, candidate, and ranking fields:

```ts
scopes: ScopedScoutScopeReport[];
acceptedCandidateIds?: string[];
candidateControls?: ScoutResult["candidateControls"];
zeroValidSummary?: string;
```

Initialize `scopes: []` when scout evidence is created. Add beside
`pendingIssue`:

```ts
let zeroValidLedgerEvidence: string | undefined;
```

Remove these workflow imports:

```ts
CandidateControlSchema
ScoutResultSchema
validateCandidateEvidence
TimeoutRetryRecord
awaitOneTimeoutRetry
```

Add these library imports without duplicating names already present:

```ts
NoSuitableScoutCandidateError
ScopedScoutResultSchema
validateScopedScoutResult
type ScoutSourceTestPair
```

Add these runtime imports without copying their implementations into the
workflow:

```ts
failZeroReservedScoutScopes
finalizeScopedScoutRecords
runScopedScoutFanout
scopedOutcomeFailure
scopedValidationFailure
type ScopedScoutConversation
type ScopedScoutScopeReport
type ValidatedScopedResult
```

Delete `fallbackControlPrompt()`, `resolveFallbackControl()`, and every local
scout record/report/failure/terminal helper or type. Keep gathering through
`evidenceFiles` and the post-gather status check, but replace pair selection,
packet rendering, old retry synthesis, and inline aggregation with:

```ts
const reservedPairs: ScoutSourceTestPair[] = selection.sourceTestPairs
  .slice(0, 4)
  .map((pair) => ({ ...pair }));
if (reservedPairs.length === 0) {
  failZeroReservedScoutScopes({
    persistZeroValidReport: (summary) => {
      report.scoutEvidence.zeroValidSummary = summary;
    },
    persistZeroValidLedger: (summary) => {
      zeroValidLedgerEvidence = summary;
    },
  });
}
const latestCommitPrefix = latestCommitEvidencePrefix(latestCommit.stdout);
gatherRemaining();
const evidence = renderScoutEvidence(
  evidenceFiles,
  SCOUT_EVIDENCE_MAX_CHARS,
  latestCommitPrefix,
  reservedPairs,
);
gatherRemaining();
const evidenceSha256 = createHash("sha256").update(evidence.text).digest("hex");
gatherRemaining();
const statusAfter = await gatherRequired("git", ["status", "--porcelain=v1"]);
if (statusBefore.stdout !== statusAfter.stdout) {
  throw new Error("scout evidence gather changed worktree status");
}
report.scoutEvidence.paths = [...evidence.paths];
report.scoutEvidence.sourceTestPairs = reservedPairs.map((pair) => ({ ...pair }));
report.scoutEvidence.charCount = evidence.charCount;
report.scoutEvidence.sha256 = evidenceSha256;
report.scoutEvidence.latestCommit = latestCommit.stdout;

const pairEvidenceLimit = Math.max(
  2_500,
  Math.floor(SCOUT_EVIDENCE_MAX_CHARS / reservedPairs.length),
);
const scopedPackets = reservedPairs.map((pair) => {
  const files = [pair.sourcePath, pair.testPath].map((path) => {
    const file = evidenceFiles.find((item) => item.path === path);
    if (file === undefined) throw new Error(`scout packet missing ${path}`);
    return file;
  });
  gatherRemaining();
  const packet = renderScoutEvidence(
    files,
    pairEvidenceLimit,
    latestCommitPrefix,
    [pair],
  );
  gatherRemaining();
  const scopedEvidenceSha256 = createHash("sha256")
    .update(packet.text)
    .digest("hex");
  gatherRemaining();
  return {
    pair,
    packet,
    evidenceSha256: scopedEvidenceSha256,
  };
});
const modelAllocationMs = remainingTimeout(
  SCOUT_MODEL_LIMIT_MS,
  budget("scout") - SCOUT_VALIDATION_LIMIT_MS,
  "scout",
);
gatherRemaining();
const scopedConversations: ScopedScoutConversation<ValidatedScopedResult>[] =
  scopedPackets.map(({ pair, packet, evidenceSha256 }, index) => {
    const label = `scout scope ${String(index + 1)}`;
    gatherRemaining();
    const scoutConversation = llm().autonomous(selectedStageBackend, {
      prompt: scopedScoutPrompt(
        profile,
        profileLimits[profile],
        pair,
        packet.text,
      ),
      schema: ScopedScoutResultSchema,
      config: selectedStageConfig(scoutConfig),
    });
    return {
      label,
      run: (activeRemaining, settlementRemaining) =>
        monitor.stage(label, async () => {
          const outcome = await awaitToolFreeOutcome(
            scoutConversation,
            () =>
              awaitBounded(
                scoutConversation,
                activeRemaining(),
                label,
                settlementRemaining,
              ),
          );
          if (outcome.type !== "success") {
            throw scopedOutcomeFailure(outcome);
          }
          const parsed = ScopedScoutResultSchema.safeParse(
            outcome.result.structured,
          );
          if (!parsed.success) {
            throw scopedValidationFailure(
              `structured output invalid: ${parsed.error.message}`,
              outcome.result.usage,
            );
          }
          const validationIssues = validateScopedScoutResult(
            parsed.data,
            pair,
            packet,
            profile,
          );
          if (validationIssues.length > 0) {
            throw scopedValidationFailure(
              validationIssues.join("; "),
              outcome.result.usage,
            );
          }
          return {
            scopeIndex: index,
            result: parsed.data,
            ...(outcome.result.usage === undefined
              ? {}
              : { usage: outcome.result.usage }),
          };
        }),
      cancel: (reason) => scoutConversation.cancel(reason),
    };
  });
const fanout = await runScopedScoutFanout({
  conversations: scopedConversations,
  modelAllocationMs,
  settlementReserveMs: CONVERSATION_SETTLEMENT_RESERVE_MS,
  quorum: Math.min(SCOUT_SCOPE_QUORUM, scopedConversations.length),
  accept: (value) => value.result.status === "candidate",
});
const validationDeadlineAtMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;
const validationRemaining = (): number =>
  remainingTimeout(
    SCOUT_VALIDATION_LIMIT_MS,
    Math.min(validationDeadlineAtMs - Date.now(), budget("scout")),
    "scout validation",
  );
const scoutResult = await finalizeScopedScoutRecords({
  records: fanout.records,
  packets: scopedPackets.map(({ pair, evidenceSha256 }) => ({
    pair,
    evidenceSha256,
  })),
  timeouts: fanout,
  remaining: validationRemaining,
  persistScopes: (scopes) => {
    report.scoutEvidence.scopes = scopes.map((scope) => ({
      ...scope,
      terminal: { ...scope.terminal },
    }));
  },
  recordUsage,
  validateTrackedPaths: async (candidate) =>
    await awaitWithinDeadline(
      `candidate ${candidate.id} tracked paths`,
      validationRemaining,
      () => assertTrackedPaths(candidate.allowedPaths, validationRemaining()),
    ),
  persistAccepted: (accepted) => {
    report.scoutEvidence.acceptedCandidateIds = [
      ...accepted.rankedCandidateIds,
    ];
    report.scoutEvidence.candidateControls = accepted.candidateControls.map(
      (control) => ({ ...control }),
    );
  },
  persistZeroValidReport: (summary) => {
    report.scoutEvidence.zeroValidSummary = summary;
  },
  persistZeroValidLedger: (summary) => {
    zeroValidLedgerEvidence = summary;
  },
});
```

The scoped conversation has already run
`validateScopedScoutResult(parsed.data, pair, packet, profile)` before its value
can enter `finalizeScopedScoutRecords()`. Do not repeat profile validation in
the finalizer. Do not call `recordUsage()` anywhere else in the scout block;
the runtime helper's one sorted loop owns terminal usage.

After the scout succeeds, retain the existing report candidate/ranking fields.
In ranked reproduction, replace fallback control synthesis with:

```ts
const control = scoutResult.candidateControls.find(
  (item) => item.candidateId === candidateId,
);
if (control === undefined) {
  throw new Error(`ranked candidate ${candidateId} control is missing`);
}
const attempted = hydrateCandidate(scoutResult, control);
```

Add the typed classification before message-based classification:

```ts
if (stage === "scout" && error instanceof NoSuitableScoutCandidateError) {
  return "scope";
}
```

In the outer catch, replace the evidence argument construction with:

```ts
const issueEvidence =
  error instanceof NoSuitableScoutCandidateError
    ? zeroValidLedgerEvidence ??
      report.scoutEvidence?.zeroValidSummary ??
      normalizeFailure(error)
    : normalizeFailure(error);
pendingIssue = buildRunIssue(
  `${runId}-${report.stage}-${String(Date.now())}`,
  report.stage,
  classifyIssue(report.stage, error),
  Date.now() - startedAtMs,
  issueEvidence,
);
```

Do not change the first `sla-overrun` classification check for other failures.
A zero-valid helper call writes ordered scopes, then report evidence, then
ledger evidence, and throws before `enter("reproduce")`; the existing finalizer
therefore persists the pending ledger issue and report before the rejection
escapes the flow.

- [ ] **Step 8: Repeat the exact contract selection and verify GREEN**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "scoped scout workflow|scout synthesis|scout prompt|scout timing|scout report|one to three ranked"
```

Expected: PASS. This command is byte-for-byte Step 6's RED selection. It proves
the selected backend/config, actual read-only config, canonical pair/packet
reuse, normalized quorum, same-conversation bounded tool guard, prior profile
validation, tracked paths, one runtime usage loop, ordered zero-valid callbacks,
settlement-timeout mapping, no `Promise.all`, and no obsolete local helpers.

- [ ] **Step 9: Write the retained-artifact test and verify RED**

Replace the old `runbook names the deterministic scout packet and unchanged
timing` test with:

```ts
test("runbook and historical notices name scoped scout fan-out", async () => {
  const [runbook, design, correction] = await Promise.all([
    Bun.file(".orca/workflows/codebase-improvement.run.md").text(),
    Bun.file(
      "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
    ).text(),
    Bun.file(
      "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    ).text(),
  ]);
  const compactRunbook = runbook.replace(/\s+/g, " ");
  for (const required of [
    "Scout: <=10s deterministic gather, <=80s concurrent work across at most four fresh pair-scoped Codex conversations, <=10s aggregation and validation.",
    "The workflow accepts one to three independently validated candidates, cancels pending scopes after three, and fails with scoped evidence when none qualify.",
    "10,000-character",
    "Reserved source-test pairs",
    "100-second scout allocation",
    "560-second allocation",
    "600-second launcher-to-merge ceiling",
  ]) {
    expect(compactRunbook).toContain(required);
  }
  for (const stale of [
    "two fresh synthesis conversations",
    "each limited to 40 seconds",
    "only when the first ends in its exact timeout cancellation",
    "synthesis attempt records",
    "2 x 40s",
  ]) {
    expect(compactRunbook).not.toContain(stale);
  }
  expect(design).toContain(
    "> **Superseded scout synthesis contract:** The sequential `2 x 40s` exact-three synthesis contract is superseded by [the scoped scout fan-out repair](./2026-07-19-codebase-improvement-scout-fanout-repair-design.md).",
  );
  expect(correction).toContain(
    "> **Superseded scout synthesis contract:** The sequential `2 x 40s` exact-three synthesis contract is superseded by [the scoped scout fan-out repair](../specs/2026-07-19-codebase-improvement-scout-fanout-repair-design.md).",
  );
});
```

Run:

```bash
bun test .orca/workflows/codebase-improvement-artifacts.test.ts \
  --test-name-pattern "runbook and historical notices name scoped scout fan-out"
```

Expected: FAIL with `Expected substring` for `Scout: <=10s deterministic
gather`; a missing test file, parse error, or unrelated assertion is not RED.

- [ ] **Step 10: Update retained artifacts and verify GREEN**

Replace the old sequential timing paragraph in the runbook with exactly:

```text
Scout: <=10s deterministic gather, <=80s concurrent work across at most four
fresh pair-scoped Codex conversations, <=10s aggregation and validation.
The workflow accepts one to three independently validated candidates, cancels
pending scopes after three, and fails with scoped evidence when none qualify.
```

Add this exact notice after the historical design title:

```markdown
> **Superseded scout synthesis contract:** The sequential `2 x 40s` exact-three synthesis contract is superseded by [the scoped scout fan-out repair](./2026-07-19-codebase-improvement-scout-fanout-repair-design.md).
```

Add this context-relative notice after the historical correction-plan title:

```markdown
> **Superseded scout synthesis contract:** The sequential `2 x 40s` exact-three synthesis contract is superseded by [the scoped scout fan-out repair](../specs/2026-07-19-codebase-improvement-scout-fanout-repair-design.md).
```

Run the identical artifact selection:

```bash
bun test .orca/workflows/codebase-improvement-artifacts.test.ts \
  --test-name-pattern "runbook and historical notices name scoped scout fan-out"
```

Expected: PASS. No sequential retry wording remains outside the two explicit
supersession notices.

- [ ] **Step 11: Run all workflow tests**

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
```

Expected: PASS with zero failures and no warnings. This includes Steps 1-4's
executable fanout/finalization cases and the existing behavioral tool-event
tests.

- [ ] **Step 12: Typecheck and lint both ignored production sources**

```bash
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement-runtime.ts
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement.ts \
  .orca/workflows/codebase-improvement-runtime.ts
```

Expected: `typecheck OK` and no unsuppressed ESLint diagnostic. Root
`typecheck` and `lint` do not cover `.orca/**`; they are not substitutes.

- [ ] **Step 13: Stage and inspect exactly eight Task 3 paths**

Stage the five imported implementation/test paths normally:

```bash
git add -- \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.ts
git diff -- .orca/workflows/codebase-improvement.run.md
git add -p -- .orca/workflows/codebase-improvement.run.md
git diff -- docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
git add -p -- docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
git diff -- docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md
git add -p -- docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md
git diff --cached --name-only
git diff --cached --check
git diff --cached -- \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.run.md \
  .orca/workflows/codebase-improvement.ts \
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md \
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
```

The runbook and two historical files contain pre-existing unrelated dirty
hunks. At each `git add -p`, accept only the new fanout/supersession hunk and
reject every earlier hunk. Never whole-file-add those three paths. Require this
exact cached list:

```text
.orca/workflows/codebase-improvement-artifacts.test.ts
.orca/workflows/codebase-improvement-contract.test.ts
.orca/workflows/codebase-improvement-runtime.test.ts
.orca/workflows/codebase-improvement-runtime.ts
.orca/workflows/codebase-improvement.run.md
.orca/workflows/codebase-improvement.ts
docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md
docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
```

Expected: exactly eight paths; `git diff --cached --check` prints nothing; the
cached diff contains only Task 3 runtime behavior, workflow wiring, contract and
artifact tests, current runbook wording, and two supersession notices.

- [ ] **Step 14: Commit Task 3**

```bash
git commit -m "feat(workflow): fan out scoped scouts"
```

Expected: one new commit after Tasks 1-2, containing exactly the eight inspected
paths. Do not amend either earlier commit.

- [ ] **Review 4: Independently review scoped-integration Task 3 range immediately**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
prior_review="$review_root/review-3-concurrent-quorum.txt"
review_file="$review_root/review-4-scoped-integration.txt"
task_base=$(sed -n '2s/^Approved-Head: //p' "$prior_review")
approved_head=$(git rev-parse HEAD)
test -n "$task_base"
test "$(tail -n 1 "$prior_review")" = 'ZERO FINDINGS'
git merge-base --is-ancestor "$task_base" "$approved_head"
test "$(git rev-list --count "$task_base..$approved_head")" -ge 1
test "$(git log --format='%s' "$task_base..$approved_head" | \
  awk '$0 == "feat(workflow): fan out scoped scouts" { n += 1 } END { print n + 0 }')" -eq 1
git diff --check "$task_base..$approved_head"
git diff "$task_base..$approved_head" -- \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.run.md \
  .orca/workflows/codebase-improvement.ts \
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md \
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
```

Give a fresh reviewer the complete `task_base..approved_head` diff and every
RED/GREEN, full workflow-test, typecheck, lint, and partial-staging result. Save
the verbatim response at `$review_file` with exact `Base: <task_base>` and
`Approved-Head: <approved_head>` first lines and a final `ZERO FINDINGS`, then
run:

```bash
test -s "$review_file"
test "$(sed -n '1p' "$review_file")" = "Base: $task_base"
test "$(sed -n '2p' "$review_file")" = "Approved-Head: $approved_head"
test "$(tail -n 1 "$review_file")" = 'ZERO FINDINGS'
test "$(git rev-parse HEAD)" = "$approved_head"
```

Require zero findings for prompt/schema wiring, actual read-only configuration,
canonical pairs/packets, same-conversation bounds, normalized quorum,
profile/tracked-path validation, usage/report/ledger order, settlement timeout,
no downstream delivery, historical docs, and exact eight-path staging. On a
finding, do not retain an approved review file and never amend, rebase, squash,
or rewrite. Repair only the eight Task 3 paths, rerun its focused checks, add
`fix(review): repair scoped-integration task`, and repeat Review 4 over the same
`task_base..HEAD` range. Controller Verification cannot start before a clean,
range-bound Review 4.

---


## Controller Verification

Do not begin until the retained-baseline import and all four reviewed task
ranges have clean, range-bound reviews. Immediate review evidence lives in
the Execution Gate 0 baseline root and is an input, not something this
controller reconstructs. The controller creates a new evidence directory and
accepts additional reviewed repair commits without amending or rewriting
history.

- [ ] **Create one controller evidence root and capture approved bindings**

```bash
if [[ -e /tmp/orcats-scoped-scout-controller.root ]]; then
  printf '%s\n' \
    'refusing to reuse /tmp/orcats-scoped-scout-controller.root' >&2
  exit 1
fi
controller_root=$(mktemp -d /tmp/orcats-scoped-scout-controller.XXXXXX)
(set -o noclobber; printf '%s\n' "$controller_root" \
  > /tmp/orcats-scoped-scout-controller.root)
mkdir -m 0700 "$controller_root/successor-audits"
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
test -d "$review_root"
controller_head=$(git rev-parse HEAD)
repair_base=$(cat "$baseline_root/repair-base.txt")
git cat-file -e "$repair_base^{commit}"
printf '%s\n' "$controller_head" > "$controller_root/controller-head.txt"
printf '%s\n' "$repair_base" > "$controller_root/repair-base.txt"
printf '%s\n' "$review_root" > "$controller_root/task-review-root.txt"
```

Expected: a new private controller root, the fixed current head, the original
repair base, and the durable immediate-review root. No commit is inferred with
`HEAD~N`, and no fixed implementation-commit count is assumed.

- [ ] **Verify the four immediate task-review evidence records**

Use the four verbatim files already produced under `$review_root`:

```text
review-1-finalization-parent.txt
review-2-scoped-result.txt
review-3-concurrent-quorum.txt
review-4-scoped-integration.txt
```

Do not synthesize, paraphrase, or backfill a review. Each file must begin with
`Base: <full commit ID>`, continue with
`Approved-Head: <full commit ID>`, and end with exactly `ZERO FINDINGS`.

Review scopes and commit bindings are exact:

1. Review 1: finalization-parent task range; correctness, security, RED/GREEN
   ordering, publication ordering, and exact two-file scope.
2. Review 2: scoped result/aggregation task range; schema, citations, profile,
   cardinality, deduplication, controls, and fallback.
3. Review 3: concurrent quorum task range; eager start, cancellation,
   synchronous throw, async rejection, terminal draining, order, and no new
   deadline.
4. Review 4: scoped integration/artifacts task range; packets, config/backend,
   deadline, usage, evidence, no-delivery, docs, and exact eight-file scope.

Run:

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
controller_head=$(cat "$controller_root/controller-head.txt")
repair_base=$(cat "$controller_root/repair-base.txt")
review_root=$(cat "$controller_root/task-review-root.txt")
review_1="$review_root/review-1-finalization-parent.txt"
review_2="$review_root/review-2-scoped-result.txt"
review_3="$review_root/review-3-concurrent-quorum.txt"
review_4="$review_root/review-4-scoped-integration.txt"
for file in "$review_1" "$review_2" "$review_3" "$review_4"; do
  test -s "$file"
  test -n "$(sed -n '1s/^Base: //p' "$file")"
  test -n "$(sed -n '2s/^Approved-Head: //p' "$file")"
  test "$(tail -n 1 "$file")" = 'ZERO FINDINGS'
done

review_1_base=$(sed -n '1s/^Base: //p' "$review_1")
review_1_head=$(sed -n '2s/^Approved-Head: //p' "$review_1")
review_2_base=$(sed -n '1s/^Base: //p' "$review_2")
review_2_head=$(sed -n '2s/^Approved-Head: //p' "$review_2")
review_3_base=$(sed -n '1s/^Base: //p' "$review_3")
review_3_head=$(sed -n '2s/^Approved-Head: //p' "$review_3")
review_4_base=$(sed -n '1s/^Base: //p' "$review_4")
review_4_head=$(sed -n '2s/^Approved-Head: //p' "$review_4")
for commit in \
  "$review_1_base" "$review_1_head" \
  "$review_2_base" "$review_2_head" \
  "$review_3_base" "$review_3_head" \
  "$review_4_base" "$review_4_head"; do
  git cat-file -e "$commit^{commit}"
done

test "$review_2_base" = "$review_1_head"
test "$review_3_base" = "$review_2_head"
test "$review_4_base" = "$review_3_head"
test "$(git show -s --format='%s' "$review_1_base")" = \
  'chore(workflow): retain proving artifacts and repair plans'
git merge-base --is-ancestor "$repair_base" "$review_1_base"
test "$(git rev-list --count "$repair_base..$review_1_base")" -eq 1
for range in \
  "$review_1_base..$review_1_head" \
  "$review_2_base..$review_2_head" \
  "$review_3_base..$review_3_head" \
  "$review_4_base..$review_4_head"; do
  base=${range%%..*}
  head=${range##*..}
  git merge-base --is-ancestor "$base" "$head"
  test "$(git rev-list --count "$range")" -ge 1
done
git merge-base --is-ancestor "$review_4_head" "$controller_head"

require_task_subjects() {
  range=$1
  label=$2
  initial=$3
  repair=$4
  file="$controller_root/$label.subjects.txt"
  git log --format='%s' "$range" > "$file"
  test "$(awk -v wanted="$initial" '$0 == wanted { n += 1 } END { print n + 0 }' "$file")" -eq 1
  awk -v initial="$initial" -v repair="$repair" \
    '$0 != initial && $0 != repair { exit 1 }' "$file"
}
require_task_paths() {
  range=$1
  label=$2
  shift 2
  printf '%s\n' "$@" | LC_ALL=C sort > \
    "$controller_root/$label.paths.expected.txt"
  git diff --name-only "$range" | LC_ALL=C sort > \
    "$controller_root/$label.paths.actual.txt"
  cmp "$controller_root/$label.paths.expected.txt" \
    "$controller_root/$label.paths.actual.txt"
}
require_task_subjects \
  "$review_1_base..$review_1_head" review-1 \
  'fix(workflow): create finalization evidence parents' \
  'fix(review): repair finalization-parent task'
require_task_paths "$review_1_base..$review_1_head" review-1 \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts
require_task_subjects \
  "$review_2_base..$review_2_head" review-2 \
  'feat(workflow): add scoped scout results' \
  'fix(review): repair scoped-result task'
require_task_paths "$review_2_base..$review_2_head" review-2 \
  .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-lib.ts
require_task_subjects \
  "$review_3_base..$review_3_head" review-3 \
  'feat(workflow): collect concurrent scout scopes' \
  'fix(review): repair concurrent-quorum task'
require_task_paths "$review_3_base..$review_3_head" review-3 \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts
require_task_subjects \
  "$review_4_base..$review_4_head" review-4 \
  'feat(workflow): fan out scoped scouts' \
  'fix(review): repair scoped-integration task'
require_task_paths "$review_4_base..$review_4_head" review-4 \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.run.md \
  .orca/workflows/codebase-improvement.ts \
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md \
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md

printf '%s\t%s\t%s\n' \
  review-1 "$review_1_base" "$review_1_head" \
  review-2 "$review_2_base" "$review_2_head" \
  review-3 "$review_3_base" "$review_3_head" \
  review-4 "$review_4_base" "$review_4_head" \
  > "$controller_root/task-ranges.tsv"

git rev-list --reverse "$review_4_head..$controller_head" > \
  "$controller_root/cumulative-repair-commits.txt"
while IFS= read -r commit; do
  test -n "$commit"
  parent_record=$(git rev-list --parents -n 1 "$commit")
  test "$(printf '%s\n' "$parent_record" | wc -w | tr -d ' ')" -eq 2
  parent=$(printf '%s\n' "$parent_record" | awk '{ print $2 }')
  subject=$(git show -s --format='%s' "$commit")
  case "$subject" in
    'fix(review): repair finalization-parent task') task=finalization-parent ;;
    'fix(review): repair scoped-result task') task=scoped-result ;;
    'fix(review): repair concurrent-quorum task') task=concurrent-quorum ;;
    'fix(review): repair scoped-integration task') task=scoped-integration ;;
    *) exit 1 ;;
  esac
  repair_review="$review_root/cumulative-repair-$commit.txt"
  test -s "$repair_review"
  test "$(sed -n '1p' "$repair_review")" = "Task: $task"
  test "$(sed -n '2p' "$repair_review")" = "Base: $parent"
  test "$(sed -n '3p' "$repair_review")" = "Approved-Head: $commit"
  test "$(tail -n 1 "$repair_review")" = 'ZERO FINDINGS'
  git diff --check "$parent..$commit"
  git diff --name-only "$parent..$commit" > \
    "$controller_root/cumulative-repair-$commit.paths.txt"
  test -s "$controller_root/cumulative-repair-$commit.paths.txt"
  while IFS= read -r path; do
    case "$task:$path" in
      finalization-parent:.orca/workflows/codebase-improvement-contract.test.ts|\
      finalization-parent:.orca/workflows/codebase-improvement-runtime.ts|\
      scoped-result:.orca/workflows/codebase-improvement-lib.test.ts|\
      scoped-result:.orca/workflows/codebase-improvement-lib.ts|\
      concurrent-quorum:.orca/workflows/codebase-improvement-runtime.test.ts|\
      concurrent-quorum:.orca/workflows/codebase-improvement-runtime.ts|\
      scoped-integration:.orca/workflows/codebase-improvement-artifacts.test.ts|\
      scoped-integration:.orca/workflows/codebase-improvement-contract.test.ts|\
      scoped-integration:.orca/workflows/codebase-improvement-runtime.test.ts|\
      scoped-integration:.orca/workflows/codebase-improvement-runtime.ts|\
      scoped-integration:.orca/workflows/codebase-improvement.run.md|\
      scoped-integration:.orca/workflows/codebase-improvement.ts|\
      scoped-integration:docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md|\
      scoped-integration:docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md) ;;
      *) exit 1 ;;
    esac
  done < "$controller_root/cumulative-repair-$commit.paths.txt"
done < "$controller_root/cumulative-repair-commits.txt"
test "$(git rev-parse HEAD)" = "$controller_head"
```

Expected: all four independently produced immediate reviews are present,
bound to non-empty ordered task ranges, limited to their exact subjects and
paths, and end in literal `ZERO FINDINGS`. Any commits after Review 4 are
single-parent, task-scoped cumulative-review repairs with their own verbatim
review evidence. `HEAD` has not moved.

- [ ] **Run one fresh broad cumulative review**

Give a fresh reviewer the fixed range `$repair_base..$controller_head`, both
July 19 plans, the approved July 19 repair design, all task RED/GREEN and
typecheck evidence, and the four verified immediate-review files. Require the
reviewer to inspect the retained-baseline import, all four reviewed task ranges,
and any reviewed repair commits together for cross-task correctness, security,
contract consistency, test strength, task order, staged scope, documentation,
and no-live compliance.

Create `$controller_root/cumulative-review.txt` from the verbatim response. Its
first two lines must bind the complete cumulative range and its final line must
be exactly `ZERO FINDINGS`:

```text
Base: <repair_base>
Approved-Head: <controller_head>
...
ZERO FINDINGS
```

Then run:

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
controller_head=$(cat "$controller_root/controller-head.txt")
repair_base=$(cat "$controller_root/repair-base.txt")
cumulative_review="$controller_root/cumulative-review.txt"
test -s "$cumulative_review"
test "$(sed -n '1p' "$cumulative_review")" = "Base: $repair_base"
test "$(sed -n '2p' "$cumulative_review")" = \
  "Approved-Head: $controller_head"
test "$(tail -n 1 "$cumulative_review")" = 'ZERO FINDINGS'
git merge-base --is-ancestor "$repair_base" "$controller_head"
test "$(git rev-parse HEAD)" = "$controller_head"
```

Any finding stops this controller attempt before repository verification and
returns ownership to the task that introduced it. Never amend, rebase, squash,
or rewrite an approved task range. Add a new task-scoped repair commit at the
current head using exactly one of these subjects:

```text
fix(review): repair finalization-parent task
fix(review): repair scoped-result task
fix(review): repair concurrent-quorum task
fix(review): repair scoped-integration task
```

Stage only that task's paths listed in its immediate review, rerun that task's
focused tests/typecheck/lint, and give a fresh reviewer the cumulative finding,
the exact one-commit repair diff, and the new evidence. Save the verbatim clean
response as
`$review_root/cumulative-repair-<repair_head>.txt` with this exact envelope:

```text
Task: <finalization-parent|scoped-result|concurrent-quorum|scoped-integration>
Base: <repair_parent>
Approved-Head: <repair_head>
...
ZERO FINDINGS
```

Verify those four binding fields against Git, then preserve the invalid
controller pointer without deleting evidence:

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
repair_head=$(git rev-parse HEAD)
parent_record=$(git rev-list --parents -n 1 "$repair_head")
test "$(printf '%s\n' "$parent_record" | wc -w | tr -d ' ')" -eq 2
repair_parent=$(printf '%s\n' "$parent_record" | awk '{ print $2 }')
repair_subject=$(git show -s --format='%s' "$repair_head")
case "$repair_subject" in
  'fix(review): repair finalization-parent task') task=finalization-parent ;;
  'fix(review): repair scoped-result task') task=scoped-result ;;
  'fix(review): repair concurrent-quorum task') task=concurrent-quorum ;;
  'fix(review): repair scoped-integration task') task=scoped-integration ;;
  *) exit 1 ;;
esac
repair_review="$review_root/cumulative-repair-$repair_head.txt"
test -s "$repair_review"
test "$(sed -n '1p' "$repair_review")" = "Task: $task"
test "$(sed -n '2p' "$repair_review")" = "Base: $repair_parent"
test "$(sed -n '3p' "$repair_review")" = "Approved-Head: $repair_head"
test "$(tail -n 1 "$repair_review")" = 'ZERO FINDINGS'
test "$(git rev-parse HEAD)" = "$repair_head"
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
mv /tmp/orcats-scoped-scout-controller.root \
  "$controller_root/invalidated-controller.root-pointer"
```

Restart Controller Verification with a new root. It must validate every repair
commit and repair-review envelope after Review 4, then rerun one fresh broad
review over the full original `repair_base..new_controller_head` range. No
repository verification may run until that cumulative range ends in literal
`ZERO FINDINGS`.

- [ ] **Run supported workflow typechecks and repository verification once**

The root TypeScript and ESLint projects exclude `.orca/**`. First run the
supported production-flow checker for all three production workflow files;
then run the repository verification exactly once:

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
controller_head=$(cat "$controller_root/controller-head.txt")
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
production_workflow_sources=(
  .orca/workflows/codebase-improvement-lib.ts
  .orca/workflows/codebase-improvement-runtime.ts
  .orca/workflows/codebase-improvement.ts
)
for file in "${production_workflow_sources[@]}"; do
  bash skills/orcats-author/scripts/orca-typecheck-flow.sh "$file" || exit 1
done
test "$(git rev-parse HEAD)" = "$controller_head"

verify_marker="$baseline_root/bun-run-verify.started"
test ! -e "$verify_marker"
(set -o noclobber; printf '%s\n' "$controller_head" > "$verify_marker")
verify_status=0
(set -o pipefail
 bun run verify 2>&1 | tee "$controller_root/bun-run-verify.log") \
  || verify_status=$?
printf '%s\n' "$verify_status" > "$controller_root/bun-run-verify.status"
printf '%s\n' "$controller_root" > "$baseline_root/bun-run-verify.controller-root"
test "$verify_status" -eq 0
test "$(git rev-parse HEAD)" = "$controller_head"
```

Expected: all three helper invocations print `typecheck OK`; `bun run verify`
runs once and exits zero. Root verification's green lint/typecheck results do
not claim `.orca/**` lint coverage. The marker belongs to the execution
baseline, not one controller attempt, so `bun run verify` cannot be rerun after
any result. A nonzero result is a reported blocker; do not repair and retry it
inside this execution baseline.

- [ ] **Verify the reviewed ranges and fixed approved HEAD**

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
controller_head=$(cat "$controller_root/controller-head.txt")
repair_base=$(cat "$controller_root/repair-base.txt")
cumulative_review="$controller_root/cumulative-review.txt"
test "$(sed -n '1p' "$cumulative_review")" = "Base: $repair_base"
test "$(sed -n '2p' "$cumulative_review")" = \
  "Approved-Head: $controller_head"
test "$(tail -n 1 "$cumulative_review")" = 'ZERO FINDINGS'
git merge-base --is-ancestor "$repair_base" "$controller_head"
git rev-list --reverse --parents "$repair_base..$controller_head" > \
  "$controller_root/reviewed-commit-range.txt"
test -s "$controller_root/reviewed-commit-range.txt"
test "$(git rev-parse HEAD)" = "$controller_head"
git diff --check "$repair_base..$controller_head"
git diff "$repair_base..$controller_head" --stat
git diff "$repair_base..$controller_head"
test "$(git rev-parse HEAD)" = "$controller_head"
```

Expected: the import, four ordered non-empty task ranges, and any separately
reviewed task-scoped repair commits form one ancestry chain from `repair_base`
to the cumulative review's fixed approved head. No `HEAD~N` inference or exact
commit count is used. The complete reviewed diff has no whitespace error and
`HEAD` remains fixed.

- [ ] **Compare the working tree with the original fifteen-path baseline**

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
controller_head=$(cat "$controller_root/controller-head.txt")
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
review_4="$review_root/review-4-scoped-integration.txt"
review_4_base=$(sed -n '1s/^Base: //p' "$review_4")
test -n "$review_4_base"
git merge-base --is-ancestor "$review_4_base" "$controller_head"
test -s "$baseline_root/tracked-dirty.z"
test -f "$baseline_root/tracked-dirty.tar"
test -f "$baseline_root/untracked-nonignored.z"
git diff --cached --quiet --
git diff --check
git diff --name-only -z > "$controller_root/tracked-dirty.final.z"
cmp "$baseline_root/tracked-dirty.z" \
  "$controller_root/tracked-dirty.final.z"
git ls-files --others --exclude-standard -z \
  > "$controller_root/untracked-nonignored.final.z"
cmp "$baseline_root/untracked-nonignored.z" \
  "$controller_root/untracked-nonignored.final.z"

baseline_check=$(mktemp -d /tmp/orcats-baseline-check.XXXXXX)
tar -xf "$baseline_root/tracked-dirty.tar" -C "$baseline_check"
untouched_baseline=(
  docs/backends.md
  docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md
  src/backends/subprocess-run.ts
  src/backends/subprocess-termination.ts
  src/conversation/conversation.ts
  src/conversation/settlement-reservation.ts
  tests/claude-backend.test.ts
  tests/codex-backend.test.ts
  tests/conversation.test.ts
  tests/jsonl-backends.test.ts
  website/src/content/docs/reference/backends.md
  website/src/content/docs/reference/errors-and-results.md
)
for path in "${untouched_baseline[@]}"; do
  cmp "$baseline_check/$path" "$path"
  test "$(stat -f '%Lp' "$baseline_check/$path")" = \
    "$(stat -f '%Lp' "$path")"
done

mixed_docs=(
  .orca/workflows/codebase-improvement.run.md
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
)
printf '%s\0' "${mixed_docs[@]}" \
  > "$controller_root/mixed-docs.expected.z"
git diff --name-only -z -- "${mixed_docs[@]}" \
  > "$controller_root/mixed-docs.actual.z"
cmp "$controller_root/mixed-docs.expected.z" \
  "$controller_root/mixed-docs.actual.z"
git diff "$review_4_base..$controller_head" -- "${mixed_docs[@]}" \
  > "$controller_root/mixed-docs.committed-review.patch"
test -s "$controller_root/mixed-docs.committed-review.patch"
test "$(git rev-parse HEAD)" = "$controller_head"
```

Inspect `mixed-docs.committed-review.patch` literally. Across the full reviewed
Task 3 range and any later scoped-integration repair commits, it must contain
only the new runbook fan-out paragraph and two supersession notices; no
Correction 63 baseline hunk may appear. Only after that inspection, record the
three acknowledgements:

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
printf '%s\t%s\n' \
  .orca/workflows/codebase-improvement.run.md 'CACHED HUNK REVIEWED' \
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md \
  'CACHED HUNK REVIEWED' \
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md \
  'CACHED HUNK REVIEWED' \
  > "$controller_root/mixed-docs.acknowledgements.txt"
test "$(wc -l < "$controller_root/mixed-docs.acknowledgements.txt" \
  | tr -d ' ')" = 3
git status --short
```

Expected: clean index; working diff has the original exact fifteen-path NUL
set, not three paths; nonignored untracked set is unchanged; twelve untouched
paths are byte- and mode-identical to their archived copies; the three mixed
docs remain dirty for preserved baseline hunks and have explicit cached-hunk
review acknowledgements. No implementation or generated residue remains.

- [ ] **Freeze one fixed commit into fourteen artifacts and three contexts**

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
freeze_head=$(cat "$controller_root/controller-head.txt")
test "$(git rev-parse HEAD)" = "$freeze_head"
artifact_root="$controller_root/frozen-artifacts"
context_root="$controller_root/frozen-contexts"
test ! -e "$artifact_root"
test ! -e "$context_root"
mkdir -m 0700 "$artifact_root" "$context_root"
printf '%s\n' "$freeze_head" > "$controller_root/freeze-head.txt"

artifacts=(
  .orca/improvement-loop/issues.jsonl
  .orca/workflows/codebase-improvement-artifacts.test.ts
  .orca/workflows/codebase-improvement-contract.test.ts
  .orca/workflows/codebase-improvement-lib.test.ts
  .orca/workflows/codebase-improvement-lib.ts
  .orca/workflows/codebase-improvement-runtime.test.ts
  .orca/workflows/codebase-improvement-runtime.ts
  .orca/workflows/codebase-improvement.config.json
  .orca/workflows/codebase-improvement.run.md
  .orca/workflows/codebase-improvement.sh
  .orca/workflows/codebase-improvement.ts
  docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md
  docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md
  docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
)
contexts=(
  docs/superpowers/specs/2026-07-19-codebase-improvement-scout-fanout-repair-design.md
  docs/superpowers/plans/2026-07-19-finalization-parent-repair.md
  docs/superpowers/plans/2026-07-19-scoped-scout-fanout.md
)
printf '%s\0' "${artifacts[@]}" \
  > "$controller_root/artifact-paths.z"
printf '%s\0' "${contexts[@]}" \
  > "$controller_root/context-paths.z"
for path in "${artifacts[@]}" "${contexts[@]}"; do
  git cat-file -e "$freeze_head:$path"
done

(set -o pipefail
 git archive --format=tar "$freeze_head" -- "${artifacts[@]}" \
   | tar -xf - -C "$artifact_root")
(set -o pipefail
 git archive --format=tar "$freeze_head" -- "${contexts[@]}" \
   | tar -xf - -C "$context_root")
(
  cd "$artifact_root"
  shasum -a 256 "${artifacts[@]}"
) > "$controller_root/artifact-manifest.sha256"
(
  cd "$context_root"
  shasum -a 256 "${contexts[@]}"
) > "$controller_root/context-manifest.sha256"
test "$(wc -l < "$controller_root/artifact-manifest.sha256" \
  | tr -d ' ')" = 14
test "$(wc -l < "$controller_root/context-manifest.sha256" \
  | tr -d ' ')" = 3
(
  cd "$artifact_root"
  shasum -a 256 -c "$controller_root/artifact-manifest.sha256"
)
(
  cd "$context_root"
  shasum -a 256 -c "$controller_root/context-manifest.sha256"
)

git ls-tree -rz --full-tree "$freeze_head" -- \
  "${artifacts[@]}" "${contexts[@]}" \
  > "$controller_root/tree-binding.z"
python3 - \
  "$controller_root/tree-binding.z" \
  "$controller_root/artifact-paths.z" \
  "$controller_root/context-paths.z" <<'PY'
from pathlib import Path
import sys

def nul_paths(path: str) -> list[bytes]:
    raw = Path(path).read_bytes()
    assert raw.endswith(b"\0")
    return raw[:-1].split(b"\0")

expected = nul_paths(sys.argv[2]) + nul_paths(sys.argv[3])
records = {}
raw = Path(sys.argv[1]).read_bytes()
assert raw.endswith(b"\0")
for record in raw[:-1].split(b"\0"):
    metadata, path = record.split(b"\t", 1)
    mode, object_type, object_id = metadata.split(b" ", 2)
    records[path] = (mode, object_type, object_id)

assert len(expected) == 17
assert len(records) == 17
assert set(records) == set(expected)
for path in expected:
    mode, object_type, object_id = records[path]
    wanted = (
        b"100755"
        if path == b".orca/workflows/codebase-improvement.sh"
        else b"100644"
    )
    assert mode == wanted, (path, mode, wanted)
    assert object_type == b"blob", (path, object_type)
    assert object_id, path
PY

shasum -a 256 \
  "$controller_root/freeze-head.txt" \
  "$controller_root/artifact-manifest.sha256" \
  "$controller_root/context-manifest.sha256" \
  "$controller_root/tree-binding.z" \
  > "$controller_root/freeze-digests.sha256"
test "$(git rev-parse HEAD)" = "$freeze_head"
```

Expected: one immutable `freeze_head`; exactly fourteen artifact hashes and
three July 19 context hashes from that commit; seventeen tree records bind every
path, blob ID, and Git mode. Only `codebase-improvement.sh` is `100755`; every
other frozen path is `100644`.

- [ ] **Run three independent audits using only the frozen roots**

Give three fresh reviewers the same `$artifact_root`, `$context_root`,
`freeze-head.txt`, both manifests, `tree-binding.z`, and
`freeze-digests.sha256`. Do not give them mutable live plan files, one another's
responses, or permission to edit. Save each verbatim response in the controller-
created paths below:

```text
$controller_root/successor-audits/1-type-interface.txt
$controller_root/successor-audits/2-plan-hygiene.txt
$controller_root/successor-audits/3-plan-to-spec.txt
```

The independent scopes are:

1. Type/interface audit: exports and local signatures, imports, structured
   result types, deadlines, terminal usage, and cancellation.
2. Plan hygiene audit: complete code, observed RED before GREEN, exact commands
   and diagnostics, dependency reviews, and partial staging.
3. Plan-to-spec audit: every approved design requirement and all twelve
   verification cases, including combined completion order.

Each response's final line must be exactly `ZERO FINDINGS`. Verify:

```bash
controller_root=$(cat /tmp/orcats-scoped-scout-controller.root)
freeze_head=$(cat "$controller_root/freeze-head.txt")
audit_files=(
  "$controller_root/successor-audits/1-type-interface.txt"
  "$controller_root/successor-audits/2-plan-hygiene.txt"
  "$controller_root/successor-audits/3-plan-to-spec.txt"
)
for file in "${audit_files[@]}"; do
  test -s "$file"
  test "$(tail -n 1 "$file")" = 'ZERO FINDINGS'
done
test "$(git rev-parse HEAD)" = "$freeze_head"
```

Any other result invalidates the frozen set and this controller attempt.

- [ ] **Stop at a fresh authorization gate**

Present all of the following together:

- four ordered range-bound immediate reviews ending in `ZERO FINDINGS`;
- every later task-scoped repair review plus the fresh cumulative
  `repair_base..approved_head` review ending in `ZERO FINDINGS`;
- three supported production-flow typechecks and the single successful
  `bun run verify` log/status;
- validated task-range subjects, paths, ancestry, optional reviewed repair
  commits, fixed approved `HEAD`, and committed-diff evidence;
- original fifteen-path working-baseline comparison, twelve byte/mode matches,
  and three cached-hunk acknowledgements;
- fixed fourteen-artifact and three-context manifests, tree-mode binding, and
  freeze digests;
- three independent frozen-root audits ending in `ZERO FINDINGS`.

Also confirm from the execution transcripts that no preflight, live backend,
delivery, push, PR creation, CI wait, merge, or GitHub mutation ran. Then stop
and request fresh explicit authorization. Do not perform any of those actions
without that new authorization.
