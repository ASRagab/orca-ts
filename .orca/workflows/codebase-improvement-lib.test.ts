import { describe, expect, test } from "bun:test";
import * as improvementLib from "./codebase-improvement-lib.ts";
import {
  assertMergedPullRequestState,
  assertReadyPullRequestHead,
  assertCandidateFitsActiveProfile,
  buildScoutResult,
  CandidateRequiresSplitError,
  CandidateSchema,
  chooseCandidate,
  controlTestArgs,
  controlTestName,
  createActiveStageBudgetTracker,
  isRemoteChecksStartupPending,
  namedTestArgs,
  normalizeFailure,
  NoSuitableScoutCandidateError,
  parseRemoteChecksCommandResult,
  profileLimits,
  pullRequestCreateArgs,
  remoteCheckState,
  renderScoutEvidence,
  renderDirective,
  ScoutCandidateSchema,
  type ScoutCandidate,
  ScoutResultSchema,
  ScopedScoutResultSchema,
  selectScoutEvidencePaths,
  stageConfig,
  stageBudgetMs,
  validateCandidateEvidence,
  validateCandidateForProfile,
  validateScopedScoutResult,
  validateChangedPaths,
  hydrateCandidate,
} from "./codebase-improvement-lib.ts";

const candidate = {
  id: "timeout-message",
  title: "fix: preserve timeout diagnostics",
  problem: "Timed-out commands lose their final diagnostic line.",
  evidence: ["src/tools/process.ts drops buffered timeout output"],
  allowedPaths: ["src/tools/process.ts", "tests/tools.test.ts"],
  testPath: "tests/tools.test.ts",
  targetedTestArgs: ["test", "tests/tools.test.ts"],
  expectedFailurePattern: "ORCA_RED:timeout-message",
  implementationBrief: "Preserve buffered stderr when timeout fires.",
  controlBrief:
    "A normal timed-out command preserves its stderr through the same formatter.",
  controlTestName: "preserves [stderr] (baseline)?",
  controlProductionPath: "src/tools/process.ts",
  expectedMinutes: 10,
  risk: "low" as const,
};
const processSourceTestPairs = [
  {
    sourcePath: "src/tools/process.ts",
    testPath: "tests/tools.test.ts",
  },
] as const;

const candidates = [
  {
    ...candidate,
    id: "a",
    allowedPaths: ["src/a.ts", "tests/a.test.ts"],
    testPath: "tests/a.test.ts",
    targetedTestArgs: ["test", "tests/a.test.ts"],
    expectedFailurePattern: "ORCA_RED:a",
    expectedMinutes: 10,
  },
  {
    ...candidate,
    id: "b",
    allowedPaths: ["src/b.ts", "tests/b.test.ts"],
    testPath: "tests/b.test.ts",
    targetedTestArgs: ["test", "tests/b.test.ts"],
    expectedFailurePattern: "ORCA_RED:b",
    expectedMinutes: 10,
  },
  {
    ...candidate,
    id: "c",
    allowedPaths: ["src/c.ts", "tests/c.test.ts"],
    testPath: "tests/c.test.ts",
    targetedTestArgs: ["test", "tests/c.test.ts"],
    expectedFailurePattern: "ORCA_RED:c",
    expectedMinutes: 10,
  },
];
const scoutCandidates = candidates.map(
  ({
    controlBrief: _controlBrief,
    controlTestName: _controlTestName,
    controlProductionPath: _controlProductionPath,
    ...item
  }) => item,
);
const selectedControl = {
  candidateId: "b",
  brief: "A normal timed-out command preserves stderr through the same formatter.",
  testName: "preserves stderr through b [baseline]?",
  productionPath: "src/b.ts",
};
const candidateControlFor = (candidateId: string) =>
  candidateId === selectedControl.candidateId
    ? selectedControl
    : {
        candidateId,
        brief: `A known-good ${candidateId} behavior.`,
        testName: `preserves ${candidateId} [baseline]?`,
        productionPath: `src/${candidateId}.ts`,
      };
function candidateControlsFor(
  candidateSet: readonly {
    readonly id: string;
    readonly allowedPaths: readonly string[];
    readonly testPath: string;
  }[],
  rankedCandidateIds: readonly string[],
) {
  return rankedCandidateIds.map((candidateId) => {
    const candidate = candidateSet.find((item) => item.id === candidateId);
    const productionPath = candidate?.allowedPaths.find(
      (path) => path !== candidate.testPath && !path.startsWith("tests/"),
    );
    return {
      candidateId,
      brief: `A known-good ${candidateId} behavior.`,
      testName: `preserves ${candidateId} [baseline]?`,
      productionPath: productionPath ?? `src/${candidateId}.ts`,
    };
  });
}
const scoutResult = {
  candidates: scoutCandidates,
  rankedCandidateIds: ["b", "c", "a"],
  candidateControls: ["b", "c", "a"].map(candidateControlFor),
  selectedControl,
};

const scopedScoutPair = {
  sourcePath: "src/tools/process.ts",
  testPath: "tests/tools.test.ts",
} as const;
const scopedScoutPacket = renderScoutEvidence(
  [
    { path: scopedScoutPair.sourcePath, content: "export const process = 1;\n" },
    { path: scopedScoutPair.testPath, content: "test(\"process\", () => {});\n" },
  ],
  1_000,
  "",
  [scopedScoutPair],
);
const {
  controlBrief: _scopedControlBrief,
  controlTestName: _scopedControlTestName,
  controlProductionPath: _scopedControlProductionPath,
  ...scopedScoutBaseCandidate
} = candidate;
const scopedScoutCandidate = {
  ...scopedScoutBaseCandidate,
  allowedPaths: [scopedScoutPair.sourcePath, scopedScoutPair.testPath],
  testPath: scopedScoutPair.testPath,
  targetedTestArgs: ["test", scopedScoutPair.testPath],
  evidence: [
    `${scopedScoutPair.sourcePath}:1 drops output`,
    `${scopedScoutPair.testPath}:1 exercises the same path`,
  ],
};
const scopedScoutControl = {
  candidateId: scopedScoutCandidate.id,
  brief: "A normal timed-out command preserves stderr through the same formatter.",
  testName: "preserves stderr through the scoped path",
  productionPath: scopedScoutPair.sourcePath,
};
const scopedScoutCandidateResult = {
  status: "candidate" as const,
  candidate: scopedScoutCandidate,
  selectedControl: scopedScoutControl,
};

function scopedAggregationRecord(scopeIndex: number, id: string) {
  const sourcePath = `src/scoped/${id}.ts`;
  const testPath = `tests/scoped-${id}.test.ts`;
  return {
    scopeIndex,
    result: {
      status: "candidate" as const,
      candidate: {
        ...scopedScoutCandidate,
        id,
        allowedPaths: [sourcePath, testPath],
        testPath,
        targetedTestArgs: ["test", testPath],
        expectedFailurePattern: `ORCA_RED:${id}`,
        evidence: [`${sourcePath}:1 scoped evidence`, `${testPath}:1 scoped test`],
      },
      selectedControl: {
        candidateId: id,
        brief: `Known-good ${id} behavior.`,
        testName: `scoped ${id} baseline`,
        productionPath: sourcePath,
      },
    },
  };
}

function scoutResultForRecords(
  records: readonly ReturnType<typeof scopedAggregationRecord>[],
) {
  const candidates = records.map((record) => record.result.candidate);
  const candidateControls = records.map(
    (record) => record.result.selectedControl,
  );
  return {
    candidates,
    rankedCandidateIds: candidates.map((item) => item.id),
    candidateControls,
    selectedControl: candidateControls[0],
  };
}

function expectScoutResultIssue(value: unknown, message: string): void {
  const result = ScoutResultSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message)).toContain(message);
}

test("scoped scout schema accepts a strict candidate and cited no_candidate", () => {
  expect(ScopedScoutResultSchema.parse(scopedScoutCandidateResult)).toEqual(
    scopedScoutCandidateResult,
  );
  expect(
    ScopedScoutResultSchema.parse({
      status: "no_candidate",
      reason:
        "src/tools/process.ts:1 has no safe small repair; tests/tools.test.ts:1 covers the behavior.",
    }),
  ).toEqual({
    status: "no_candidate",
    reason:
      "src/tools/process.ts:1 has no safe small repair; tests/tools.test.ts:1 covers the behavior.",
  });
  for (const result of [
    {
      ...scopedScoutCandidateResult,
      selectedControl: { ...scopedScoutControl, candidateId: "other" },
    },
    { ...scopedScoutCandidateResult, unexpected: true },
    {
      status: "no_candidate" as const,
      reason: "src/tools/process.ts:1 and tests/tools.test.ts:1",
      unexpected: true,
    },
  ]) {
    expect(ScopedScoutResultSchema.safeParse(result).success).toBe(false);
  }
});

test("scoped validation binds a candidate to its reserved pair and profile", () => {
  expect(
    validateScopedScoutResult(
      scopedScoutCandidateResult,
      scopedScoutPair,
      scopedScoutPacket,
      "simple",
    ),
  ).toEqual([]);

  const issuesFor = (result: typeof scopedScoutCandidateResult) =>
    validateScopedScoutResult(result, scopedScoutPair, scopedScoutPacket, "simple");

  expect(
    issuesFor({
      ...scopedScoutCandidateResult,
      candidate: {
        ...scopedScoutCandidate,
        allowedPaths: [
          scopedScoutPair.sourcePath,
          "src/tools/other.ts",
          scopedScoutPair.testPath,
        ],
      },
    }),
  ).toContain("candidate allowed paths must equal the reserved source-test pair");
  expect(
    issuesFor({
      ...scopedScoutCandidateResult,
      candidate: {
        ...scopedScoutCandidate,
        allowedPaths: [scopedScoutPair.sourcePath, "tests/other.test.ts"],
        testPath: "tests/other.test.ts",
        targetedTestArgs: ["test", "tests/other.test.ts"],
        evidence: [
          `${scopedScoutPair.sourcePath}:1 drops output`,
          "tests/other.test.ts:1 exercises the same path",
        ],
      },
    }),
  ).toContain("candidate test path must equal the reserved test path");
  expect(
    issuesFor({
      ...scopedScoutCandidateResult,
      selectedControl: {
        ...scopedScoutControl,
        productionPath: "src/tools/other.ts",
      },
    }),
  ).toContain("control production path must equal the reserved source path");
  expect(
    issuesFor({
      ...scopedScoutCandidateResult,
      candidate: {
        ...scopedScoutCandidate,
        evidence: [
          "src/decoy.ts:1 fabricated source line",
          "tests/tools.test.ts:1 exercises the same path",
        ],
      },
    }),
  ).toContain(
    "candidate evidence must cite a rendered production path line: src/tools/process.ts",
  );
  expect(
    issuesFor({
      ...scopedScoutCandidateResult,
      candidate: { ...scopedScoutCandidate, expectedMinutes: 21 },
    }),
  ).toContain("expected minutes outside simple profile");
});

test("scoped validation requires exact source and test citations for no_candidate", () => {
  const valid = {
    status: "no_candidate" as const,
    reason:
      "src/tools/process.ts:1 has no safe repair; tests/tools.test.ts:1 covers the behavior.",
  };
  expect(
    validateScopedScoutResult(valid, scopedScoutPair, scopedScoutPacket, "simple"),
  ).toEqual([]);
  expect(
    validateScopedScoutResult(
      {
        ...valid,
        reason:
          "src/tools/process.ts:10 has no safe repair; tests/tools.test.ts:1 covers the behavior.",
      },
      scopedScoutPair,
      scopedScoutPacket,
      "simple",
    ),
  ).toContain("no_candidate reason must cite a rendered source path line");
});

test("scout result accepts one to three ranked candidates and rejects invalid cardinality", () => {
  for (const count of [1, 2, 3]) {
    const records = Array.from({ length: count }, (_, index) =>
      scopedAggregationRecord(index, `rank-${String(index + 1)}`),
    );
    expect(ScoutResultSchema.safeParse(scoutResultForRecords(records)).success).toBe(
      true,
    );
  }
  for (const count of [0, 4]) {
    const records = Array.from({ length: count }, (_, index) =>
      scopedAggregationRecord(index, `rank-${String(index + 1)}`),
    );
    expect(ScoutResultSchema.safeParse(scoutResultForRecords(records)).success).toBe(
      false,
    );
  }
});

test("scout result rejects duplicate IDs, controls, and target tests", () => {
  const first = scopedAggregationRecord(0, "a");
  const second = scopedAggregationRecord(1, "b");
  expect(
    ScoutResultSchema.safeParse(
      scoutResultForRecords([
        first,
        {
          ...second,
          result: {
            ...second.result,
            candidate: {
              ...second.result.candidate,
              id: first.result.candidate.id,
              expectedFailurePattern: first.result.candidate.expectedFailurePattern,
            },
            selectedControl: {
              ...second.result.selectedControl,
              candidateId: first.result.selectedControl.candidateId,
            },
          },
        },
      ]),
    ).success,
  ).toBe(false);
  expect(
    ScoutResultSchema.safeParse({
      ...scoutResultForRecords([first, second]),
      candidateControls: [
        first.result.selectedControl,
        first.result.selectedControl,
      ],
    }).success,
  ).toBe(false);
  expect(
    ScoutResultSchema.safeParse(
      scoutResultForRecords([
        first,
        {
          ...second,
          result: {
            ...second.result,
            candidate: {
              ...second.result.candidate,
              allowedPaths: [
                second.result.selectedControl.productionPath,
                first.result.candidate.testPath,
              ],
              testPath: first.result.candidate.testPath,
              targetedTestArgs: ["test", first.result.candidate.testPath],
              evidence: [
                `${second.result.selectedControl.productionPath}:1 scoped evidence`,
                `${first.result.candidate.testPath}:1 scoped test`,
              ],
            },
          },
        },
      ]),
    ).success,
  ).toBe(false);
});

test("scoped aggregation orders and deduplicates pair results before truncating", () => {
  const first = scopedAggregationRecord(0, "a");
  const result = buildScoutResult([
    scopedAggregationRecord(3, "c"),
    { ...first, scopeIndex: 1 },
    scopedAggregationRecord(2, "b"),
    first,
  ]);

  expect(result.rankedCandidateIds).toEqual(["a", "b", "c"]);
  expect(result.candidates.map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(result.candidateControls.map((item) => item.candidateId)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(result.selectedControl).toEqual(result.candidateControls[0]);
  expect(() => buildScoutResult([])).toThrow(NoSuitableScoutCandidateError);
});

test("one to three ranks hydrate every ordered control", () => {
  for (const count of [1, 2, 3]) {
    const result = buildScoutResult(
      Array.from({ length: count }, (_, index) =>
        scopedAggregationRecord(index, `rank-${String(index + 1)}`),
      ),
    );
    for (const [rank, candidateId] of result.rankedCandidateIds.entries()) {
      expect(hydrateCandidate(result, result.candidateControls[rank]!)).toMatchObject({
        id: candidateId,
        controlProductionPath:
          result.candidateControls[rank]!.productionPath,
      });
    }
  }
});

test("derives the exact positive-control test command", () => {
  expect(controlTestName(candidate)).toBe("preserves [stderr] (baseline)?");
  expect(controlTestArgs(candidate)).toEqual([
    "test",
    "tests/tools.test.ts",
    "--test-name-pattern",
    "^preserves \\[stderr\\] \\(baseline\\)\\?$",
  ]);
});

test("derives exact named-test args with every regular-expression metacharacter escaped", () => {
  expect(
    namedTestArgs(
      "tests/tools.test.ts",
      "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o",
    ),
  ).toEqual([
    "test",
    "tests/tools.test.ts",
    "--test-name-pattern",
    "^a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o$",
  ]);
});

test("renders the positive-control args as one executable shell command", () => {
  const renderShellCommand = (
    improvementLib as Record<string, unknown>
  ).renderShellCommand;
  expect(renderShellCommand).toBeFunction();
  if (typeof renderShellCommand !== "function") return;
  expect(renderShellCommand("bun", controlTestArgs(candidate))).toBe(
    "bun test tests/tools.test.ts --test-name-pattern '^preserves \\[stderr\\] \\(baseline\\)\\?$'",
  );
  expect(
    renderShellCommand("bun", ["test", "tests/a b's.test.ts"]),
  ).toBe("bun test 'tests/a b'\"'\"'s.test.ts'");
});

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

test("scout evidence pairs selected sources with their closest tests", () => {
  const tracked = [
    "src/cli/embedded.ts",
    "tests/cli-embedded.test.ts",
    "tests/cli-run-output-validation.test.ts",
  ];
  const recent = [
    "src/cli/embedded.ts",
    "src/cli/embedded.ts",
    "tests/cli-embedded.test.ts",
    "tests/cli-run-output-validation.test.ts",
    "tests/cli-run-output-validation.test.ts",
    "tests/cli-run-output-validation.test.ts",
  ];

  expect(selectScoutEvidencePaths(tracked, recent, 2)).toEqual([
    "src/cli/embedded.ts",
    "tests/cli-embedded.test.ts",
  ]);
});

test("scout evidence preserves each reserved source-test assignment", () => {
  const selectScoutEvidence = (
    improvementLib as Record<string, unknown>
  ).selectScoutEvidence;
  expect(selectScoutEvidence).toBeFunction();
  if (typeof selectScoutEvidence !== "function") return;

  expect(
    selectScoutEvidence(
      [
        "src/cli/embedded.ts",
        "src/backends/codex-run.ts",
        "tests/cli-embedded.test.ts",
        "tests/codex-backend.test.ts",
      ],
      [
        "src/cli/embedded.ts",
        "src/backends/codex-run.ts",
        "tests/cli-embedded.test.ts",
        "tests/codex-backend.test.ts",
      ],
      4,
    ),
  ).toEqual({
    paths: [
      "src/backends/codex-run.ts",
      "src/cli/embedded.ts",
      "tests/codex-backend.test.ts",
      "tests/cli-embedded.test.ts",
    ],
    sourceTestPairs: [
      {
        sourcePath: "src/backends/codex-run.ts",
        testPath: "tests/codex-backend.test.ts",
      },
      {
        sourcePath: "src/cli/embedded.ts",
        testPath: "tests/cli-embedded.test.ts",
      },
    ],
  });
});

test("scout evidence gives each selected source one related test before extras", () => {
  const tracked = [
    "src/alpha.ts",
    "src/beta.ts",
    "tests/alpha-one.test.ts",
    "tests/alpha-two.test.ts",
    "tests/beta.test.ts",
  ];
  const recent = [
    "src/alpha.ts",
    "src/alpha.ts",
    "src/beta.ts",
    "tests/alpha-one.test.ts",
    "tests/alpha-one.test.ts",
    "tests/alpha-two.test.ts",
    "tests/alpha-two.test.ts",
    "tests/beta.test.ts",
  ];

  expect(selectScoutEvidencePaths(tracked, recent, 4)).toEqual([
    "src/alpha.ts",
    "src/beta.ts",
    "tests/alpha-one.test.ts",
    "tests/beta.test.ts",
  ]);
});

test("an unrelated source cannot consume a later source's related test", () => {
  expect(
    selectScoutEvidencePaths(
      ["src/alpha.ts", "src/beta.ts", "tests/beta.test.ts"],
      ["src/alpha.ts", "src/alpha.ts", "src/beta.ts"],
      4,
    ),
  ).toEqual([
    "src/alpha.ts",
    "src/beta.ts",
    "tests/beta.test.ts",
  ]);
});

test("shared-best tests remain unique across source reservations", () => {
  expect(
    selectScoutEvidencePaths(
      [
        "src/foo.ts",
        "src/foo-bar.ts",
        "tests/foo.test.ts",
        "tests/bar.test.ts",
      ],
      [
        "src/foo.ts",
        "src/foo.ts",
        "src/foo-bar.ts",
        "tests/foo.test.ts",
        "tests/foo.test.ts",
      ],
      4,
    ),
  ).toEqual([
    "src/foo.ts",
    "src/foo-bar.ts",
    "tests/foo.test.ts",
    "tests/bar.test.ts",
  ]);
});

test("test reservations maximize source coverage before extras", () => {
  const tracked = [
    "src/alpha.ts",
    "src/beta.ts",
    "src/gamma.ts",
    "tests/alpha-one.test.ts",
    "tests/alpha-two.test.ts",
    "tests/alpha-three.test.ts",
    "tests/beta-gamma.test.ts",
    "tests/beta.test.ts",
  ];
  const recent = [
    ...Array<string>(6).fill("src/alpha.ts"),
    ...Array<string>(5).fill("src/beta.ts"),
    ...Array<string>(4).fill("src/gamma.ts"),
    ...Array<string>(6).fill("tests/alpha-one.test.ts"),
    ...Array<string>(5).fill("tests/beta-gamma.test.ts"),
    ...Array<string>(4).fill("tests/alpha-two.test.ts"),
    ...Array<string>(3).fill("tests/alpha-three.test.ts"),
    ...Array<string>(2).fill("tests/beta.test.ts"),
  ];

  expect(selectScoutEvidencePaths(tracked, recent, 6)).toEqual([
    "src/alpha.ts",
    "src/beta.ts",
    "src/gamma.ts",
    "tests/alpha-one.test.ts",
    "tests/beta.test.ts",
    "tests/beta-gamma.test.ts",
  ]);
});

test("test reservations maximize total overlap after source coverage", () => {
  expect(
    selectScoutEvidencePaths(
      [
        "src/alpha-beta.ts",
        "src/alpha-gamma.ts",
        "tests/alpha-beta.test.ts",
        "tests/alpha-beta-gamma.test.ts",
      ],
      [
        "src/alpha-beta.ts",
        "src/alpha-beta.ts",
        "src/alpha-gamma.ts",
      ],
      4,
    ),
  ).toEqual([
    "src/alpha-beta.ts",
    "src/alpha-gamma.ts",
    "tests/alpha-beta.test.ts",
    "tests/alpha-beta-gamma.test.ts",
  ]);
});

test("public index is rejected independent of rank and cap", () => {
  expect(
    selectScoutEvidencePaths(
      ["src/index.ts"],
      ["src/index.ts", "src/index.ts"],
      8,
    ),
  ).toEqual([]);
});

test("generated paths are protected everywhere", () => {
  expect(
    selectScoutEvidencePaths(
      ["src/generated/client.ts"],
      ["src/generated/client.ts"],
      8,
    ),
  ).toEqual([]);
  expect(
    CandidateSchema.safeParse({
      ...candidate,
      allowedPaths: ["src/generated/client.ts", candidate.testPath],
    }).success,
  ).toBe(false);
});

test("scout evidence is line-addressable and obeys the character cap", () => {
  const packet = renderScoutEvidence(
    [
      { path: "tests/a.test.ts", content: "test(\"a\", () => expect(1).toBe(1));\n" },
      { path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;\n" },
    ],
    120,
  );
  expect(packet.text.length).toBeLessThanOrEqual(120);
  expect(packet.text).toContain("File: src/a.ts\n1 export const a = 1;");
  expect(packet.renderedLineMarkers).toContain("src/a.ts:1");
  expect(packet.paths).toEqual(["src/a.ts", "tests/a.test.ts"]);
  expect(packet.text.indexOf("File: src/a.ts")).toBeLessThan(
    packet.text.indexOf("File: tests/a.test.ts"),
  );
});

test("scout evidence compacts repeated paths into section headers", () => {
  const packet = renderScoutEvidence(
    [{ path: "src/a.ts", content: "alpha\nbeta" }],
    120,
  );

  expect(packet.text).toBe(["File: src/a.ts", "1 alpha", "2 beta"].join("\n"));
  expect(packet.renderedLineMarkers).toEqual(["src/a.ts:1", "src/a.ts:2"]);
});

test("scout evidence keeps the first 40 lines without hotspots", () => {
  const content = Array.from(
    { length: 50 },
    (_, index) => `line ${String(index + 1)}`,
  ).join("\n");
  const packet = renderScoutEvidence(
    [{ path: "src/a.ts", content }],
    10_000,
  );

  expect(packet.text.split("\n")).toEqual(
    [
      "File: src/a.ts",
      ...Array.from({ length: 40 }, (_, index) => {
        const line = index + 1;
        return `${String(line)} line ${String(line)}`;
      }),
    ],
  );
});

test("scout evidence keeps causal context around hotspot lines", () => {
  const content = Array.from(
    { length: 40 },
    (_, index) => `line ${String(index + 1)}`,
  ).join("\n");
  const packet = renderScoutEvidence(
    [{ path: "src/a.ts", content, matchLines: [20] }],
    10_000,
  );

  expect(packet.text.split("\n")).toEqual(
    [
      "File: src/a.ts",
      ...Array.from({ length: 33 }, (_, index) => {
        const line = index + 4;
        return `${String(line)} line ${String(line)}`;
      }),
    ],
  );
});

test("scout evidence keeps exact causal context around every hotspot", () => {
  const content = Array.from(
    { length: 80 },
    (_, index) => `line ${String(index + 1)}`,
  ).join("\n");
  const packet = renderScoutEvidence(
    [{ path: "src/a.ts", content, matchLines: [20, 60] }],
    10_000,
  );

  expect(packet.text.split("\n")).toEqual(
    [
      "File: src/a.ts",
      ...[
        ...Array.from({ length: 33 }, (_, index) => index + 4),
        ...Array.from({ length: 33 }, (_, index) => index + 44),
      ].map((line) => `${String(line)} line ${String(line)}`),
    ],
  );
});

test("scout evidence cannot let long context evict hotspot lines", () => {
  const lines = Array.from(
    { length: 50 },
    (_, index) => `line ${String(index + 1)}`,
  );
  lines[3] = "x".repeat(10_000);
  const packet = renderScoutEvidence(
    [{ path: "src/a.ts", content: lines.join("\n"), matchLines: [20, 40] }],
    1_000,
  );

  expect(packet.text).toContain("20 line 20");
  expect(packet.text).toContain("40 line 40");
  expect(packet.renderedLineMarkers).toEqual(
    expect.arrayContaining(["src/a.ts:20", "src/a.ts:40"]),
  );
});

test("scout evidence distributes tight optional context across files", () => {
  const expected = [
    "File: src/a.ts",
    "1 a1",
    "2 a2",
    "",
    "File: src/b.ts",
    "1 b1",
    "2 b2",
  ].join("\n");
  const packet = renderScoutEvidence(
    [
      { path: "src/a.ts", content: "a1\na2\na3" },
      { path: "src/b.ts", content: "b1\nb2\nb3" },
    ],
    expected.length,
  );

  expect(packet.text).toBe(expected);
});

test("scout evidence distributes tight hotspot context across files", () => {
  const expected = [
    "File: src/a.ts",
    "1 a1",
    "2 a2",
    "",
    "File: src/b.ts",
    "1 b1",
    "2 b2",
  ].join("\n");
  const packet = renderScoutEvidence(
    [
      { path: "src/a.ts", content: "a1\na2\na3", matchLines: [1] },
      { path: "src/b.ts", content: "b1\nb2\nb3", matchLines: [1] },
    ],
    expected.length,
  );

  expect(packet.text).toBe(expected);
});

test("final scout packet retains every hotspot marker", () => {
  const files = Array.from({ length: 8 }, (_, fileIndex) => {
    const path = `${fileIndex < 4 ? "src" : "tests"}/file-${String(fileIndex)}.ts`;
    const lines = Array.from(
      { length: 80 },
      (_, lineIndex) =>
        `line ${String(lineIndex + 1)} ${"x".repeat(180)}`,
    );
    const matchLines = fileIndex < 4 ? [10, 30, 50] : [20, 40];
    return { path, content: lines.join("\n"), matchLines };
  });
  const prefix = [
    "Latest commit subject and changed paths:",
    "Latest commit: abc123",
    "Subject: fixture",
    "Current source and test evidence:",
  ].join("\n");
  const packet = renderScoutEvidence(files, 10_000, prefix);

  expect(packet.text.startsWith(prefix)).toBe(true);
  expect(packet.text.length).toBeLessThanOrEqual(10_000);
  for (const file of files) {
    for (const line of file.matchLines) {
      expect(packet.renderedLineMarkers).toContain(
        `${file.path}:${String(line)}`,
      );
    }
  }
});

test("scout evidence rejects mandatory content beyond the cap", () => {
  expect(() =>
    renderScoutEvidence(
      [{ path: "src/a.ts", content: "required hotspot", matchLines: [1] }],
      10,
      "latest commit evidence",
    ),
  ).toThrow("scout required evidence exceeds character cap");
});

test("latest-commit prefix participates in mandatory overflow", () => {
  const requiredBody = "src/a.ts:1 required hotspot";
  const maxChars = 40;
  expect(requiredBody.length).toBeLessThan(maxChars);
  expect(() =>
    renderScoutEvidence(
      [{ path: "src/a.ts", content: "required hotspot", matchLines: [1] }],
      maxChars,
      "p".repeat(20),
    ),
  ).toThrow("scout required evidence exceeds character cap");
});

test("ranked candidate IDs must be an exact permutation", () => {
  expect(
    ScoutResultSchema.parse({
      candidates,
      rankedCandidateIds: ["c", "a", "b"],
      candidateControls: ["c", "a", "b"].map(candidateControlFor),
      selectedControl: candidateControlFor("c"),
    }).rankedCandidateIds,
  ).toEqual(["c", "a", "b"]);
  for (const rankedCandidateIds of [
    ["a", "a", "b"],
    ["a", "b", "missing"],
    ["a", "b"],
  ]) {
    const candidateControls = candidateControlsFor(candidates, rankedCandidateIds);
    expectScoutResultIssue(
      {
        candidates,
        rankedCandidateIds,
        candidateControls,
        selectedControl: candidateControls[0]!,
      },
      "rankedCandidateIds must be the candidate-ID permutation",
    );
  }
  const duplicateCandidateIds = [
    { ...scoutCandidates[0], id: "a" },
    {
      ...scoutCandidates[1],
      id: "a",
      expectedFailurePattern: "ORCA_RED:a",
    },
    { ...scoutCandidates[2], id: "c" },
  ];
  const duplicateCandidateControls = candidateControlsFor(
    duplicateCandidateIds,
    ["a", "b", "c"],
  );
  expectScoutResultIssue(
    {
      candidates: duplicateCandidateIds,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls: duplicateCandidateControls,
      selectedControl: duplicateCandidateControls[0]!,
    },
    "rankedCandidateIds must be the candidate-ID permutation",
  );
});

test("scout result rejects more than three candidates", () => {
  const extraCandidate = {
    ...scoutCandidates[0],
    id: "d",
    allowedPaths: ["src/d.ts", "tests/d.test.ts"],
    testPath: "tests/d.test.ts",
    targetedTestArgs: ["test", "tests/d.test.ts"],
    expectedFailurePattern: "ORCA_RED:d",
  };
  const candidateSet = [...candidates, extraCandidate];
  const rankedCandidateIds = candidateSet.map((item) => item.id);
  const candidateControls = candidateControlsFor(candidateSet, rankedCandidateIds);
  const result = ScoutResultSchema.safeParse({
    candidates: candidateSet,
    rankedCandidateIds,
    candidateControls,
    selectedControl: candidateControls[0]!,
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.some((issue) => issue.path[0] === "candidates")).toBe(
    true,
  );
});

test("scout result requires one selected control", () => {
  const { selectedControl: _selectedControl, ...withoutControl } = scoutResult;
  expect(ScoutResultSchema.safeParse({
    ...withoutControl,
    candidates,
  }).success).toBe(false);
});

test("scout result rejects a blank selected control", () => {
  expect(ScoutResultSchema.safeParse({
    ...scoutResult,
    candidates,
    selectedControl: { ...selectedControl, brief: "   " },
  }).success).toBe(false);
});

test("selected control must target the rank-one candidate", () => {
  expect(ScoutResultSchema.safeParse({
    ...scoutResult,
    candidates,
    selectedControl: { ...selectedControl, candidateId: "a" },
  }).success).toBe(false);
});

test("ranked fallback candidates require independent file scopes", () => {
  const collapsed = [
    { ...scoutCandidates[0], id: "a" },
    {
      ...scoutCandidates[1],
      id: "b",
      allowedPaths: ["src/a.ts", "tests/b.test.ts"],
      testPath: "tests/b.test.ts",
      targetedTestArgs: ["test", "tests/b.test.ts"],
      expectedFailurePattern: "ORCA_RED:b",
    },
    {
      ...scoutCandidates[2],
      id: "c",
      allowedPaths: ["src/a.ts", "tests/c.test.ts"],
      testPath: "tests/c.test.ts",
      targetedTestArgs: ["test", "tests/c.test.ts"],
      expectedFailurePattern: "ORCA_RED:c",
    },
  ];
  const candidateControls = candidateControlsFor(collapsed, ["a", "b", "c"]);
  expectScoutResultIssue(
    {
      candidates: collapsed,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls,
      selectedControl: candidateControls[0]!,
    },
    "each ranked candidate must have an exclusive production path",
  );
});

test("duplicate allowed paths cannot manufacture independent scopes", () => {
  const duplicateNoise = [
    { ...scoutCandidates[0], id: "a" },
    {
      ...scoutCandidates[0],
      id: "b",
      allowedPaths: ["src/a.ts", "src/a.ts", "tests/a.test.ts"],
      expectedFailurePattern: "ORCA_RED:b",
    },
    {
      ...scoutCandidates[0],
      id: "c",
      allowedPaths: ["src/a.ts", "src/a.ts", "src/a.ts", "tests/a.test.ts"],
      expectedFailurePattern: "ORCA_RED:c",
    },
  ];
  const candidateControls = candidateControlsFor(duplicateNoise, ["a", "b", "c"]);
  expectScoutResultIssue(
    {
      candidates: duplicateNoise,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls,
      selectedControl: candidateControls[0]!,
    },
    "allowed paths must be unique",
  );
});

test("reordered allowed paths cannot manufacture independent scopes", () => {
  const reordered = [
    {
      ...scoutCandidates[0],
      id: "a",
      allowedPaths: ["src/a.ts", "src/shared.ts", "tests/a.test.ts"],
    },
    {
      ...scoutCandidates[0],
      id: "b",
      allowedPaths: ["src/shared.ts", "tests/b.test.ts", "src/a.ts"],
      testPath: "tests/b.test.ts",
      targetedTestArgs: ["test", "tests/b.test.ts"],
      expectedFailurePattern: "ORCA_RED:b",
    },
    { ...scoutCandidates[2], id: "c" },
  ];
  const candidateControls = candidateControlsFor(reordered, ["a", "b", "c"]);
  expectScoutResultIssue(
    {
      candidates: reordered,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls,
      selectedControl: candidateControls[0]!,
    },
    "each ranked candidate must have an exclusive production path",
  );
});

test("ranked fallback candidates require unique target tests", () => {
  const sharedTest = [
    { ...scoutCandidates[0], id: "a" },
    {
      ...scoutCandidates[1],
      id: "b",
      allowedPaths: ["src/b.ts", "tests/a.test.ts"],
      testPath: "tests/a.test.ts",
      targetedTestArgs: ["test", "tests/a.test.ts"],
    },
    { ...scoutCandidates[2], id: "c" },
  ];
  const candidateControls = candidateControlsFor(sharedTest, ["a", "b", "c"]);
  expectScoutResultIssue(
    {
      candidates: sharedTest,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls,
      selectedControl: candidateControls[0]!,
    },
    "ranked candidates must use unique target test paths",
  );
});

test("each ranked candidate requires an exclusive production path", () => {
  const supersetNoise = [
    {
      ...scoutCandidates[0],
      id: "a",
      allowedPaths: ["src/shared.ts", "tests/a.test.ts"],
    },
    {
      ...scoutCandidates[1],
      id: "b",
      allowedPaths: ["src/shared.ts", "src/b.ts", "tests/b.test.ts"],
    },
    { ...scoutCandidates[2], id: "c" },
  ];
  const candidateControls = candidateControlsFor(supersetNoise, ["a", "b", "c"]);
  expectScoutResultIssue(
    {
      candidates: supersetNoise,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls,
      selectedControl: candidateControls[0]!,
    },
    "each ranked candidate must have an exclusive production path",
  );
});

test("ranked candidates may share support paths when each has an exclusive path", () => {
  const sharedSupport = [
    {
      ...scoutCandidates[0],
      id: "a",
      allowedPaths: ["src/shared.ts", "src/a.ts", "tests/a.test.ts"],
    },
    {
      ...scoutCandidates[1],
      id: "b",
      allowedPaths: ["src/shared.ts", "src/b.ts", "tests/b.test.ts"],
    },
    { ...scoutCandidates[2], id: "c" },
  ];
  expect(
    ScoutResultSchema.safeParse({
      candidates: sharedSupport,
      rankedCandidateIds: ["a", "b", "c"],
      candidateControls: ["a", "b", "c"].map(candidateControlFor),
      selectedControl: candidateControlFor("a"),
    }).success,
  ).toBe(true);
});

test("scout result accepts control-free candidates", () => {
  expect(ScoutResultSchema.parse(scoutResult).candidates).toEqual(
    scoutCandidates,
  );
});

test("selection hydrates the rank-one control", () => {
  expect(chooseCandidate(scoutResult)).toEqual({
    ...scoutCandidates[1],
    controlBrief: selectedControl.brief,
    controlTestName: selectedControl.testName,
    controlProductionPath: selectedControl.productionPath,
  });
});

test("hydrates a named baseline control bound to an allowed production path", () => {
  const hydrateCandidate = (
    improvementLib as Record<string, unknown>
  ).hydrateCandidate;
  const CandidateControlSchema = (
    improvementLib as Record<string, unknown>
  ).CandidateControlSchema as {
    safeParse(value: unknown): { success: boolean };
  };
  expect(hydrateCandidate).toBeFunction();
  if (typeof hydrateCandidate !== "function") return;

  expect(
    hydrateCandidate(scoutResult, {
      candidateId: "c",
      brief: "A rank-two known-good case through the same production path.",
      testName: "existing c path (baseline)",
      productionPath: "src/c.ts",
    }),
  ).toEqual({
    ...scoutCandidates[2],
    controlBrief:
      "A rank-two known-good case through the same production path.",
    controlTestName: "existing c path (baseline)",
    controlProductionPath: "src/c.ts",
  });
  expect(
    CandidateControlSchema.safeParse({
      candidateId: "c",
      brief: "Known-good behavior.",
      productionPath: "src/c.ts",
    }).success,
  ).toBe(false);
  expect(() =>
    hydrateCandidate(scoutResult, {
      candidateId: "c",
      brief: "Known-good behavior.",
      testName: "existing c path (baseline)",
      productionPath: "src/not-c.ts",
    }),
  ).toThrow("allowed production path");
  expect(() =>
    hydrateCandidate(scoutResult, {
      candidateId: "c",
      brief: "Known-good behavior.",
      testName: "existing c path (baseline)",
      productionPath: "tests/c.test.ts",
    }),
  ).toThrow("allowed production path");
  expect(() =>
    hydrateCandidate(scoutResult, {
      candidateId: "missing",
      brief: "Unknown candidate control.",
      testName: "existing missing path (baseline)",
      productionPath: "src/missing.ts",
    }),
  ).toThrow("control candidate missing is not ranked");
});

test("candidate hydration rejects generic and regex-equivalent RED markers", () => {
  const hydrateCandidate = (
    improvementLib as Record<string, unknown>
  ).hydrateCandidate;
  expect(hydrateCandidate).toBeFunction();
  if (typeof hydrateCandidate !== "function") return;
  const control = {
    candidateId: "c",
    brief: "Known-good behavior through the production path.",
    testName: "existing c path (baseline)",
    productionPath: "src/c.ts",
  };
  for (const expectedFailurePattern of ["e", "[", "ORCA_RED:c.*"]) {
    expect(() =>
      hydrateCandidate(
        {
          ...scoutResult,
          candidates: scoutResult.candidates.map((item) =>
            item.id === "c" ? { ...item, expectedFailurePattern } : item,
          ),
        },
        control,
      ),
    ).toThrow("expected failure pattern must equal candidate RED marker");
  }
});

test("ranked fallback restores a rejected attempt before trying the next", async () => {
  const runRankedCandidateFallback = (
    improvementLib as Record<string, unknown>
  ).runRankedCandidateFallback;
  expect(runRankedCandidateFallback).toBeFunction();
  if (typeof runRankedCandidateFallback !== "function") return;

  const events: string[] = [];
  const result = await runRankedCandidateFallback(
    ["a", "b"],
    async (candidateId: string) => {
      events.push(`attempt:${candidateId}`);
      if (candidateId === "a") {
        return {
          status: "rejected",
          reason: "target passed before implementation",
          restore: async () => {
            events.push("restore:a");
          },
        };
      }
      return { status: "accepted", value: candidateId };
    },
  );

  expect(events).toEqual(["attempt:a", "restore:a", "attempt:b"]);
  expect(result).toEqual({
    value: "b",
    rejections: [
      { candidateId: "a", reason: "target passed before implementation" },
    ],
  });
});

test("ranked fallback stops when rejected-attempt restoration fails", async () => {
  const runRankedCandidateFallback = (
    improvementLib as Record<string, unknown>
  ).runRankedCandidateFallback;
  expect(runRankedCandidateFallback).toBeFunction();
  if (typeof runRankedCandidateFallback !== "function") return;

  const attempted: string[] = [];
  await expect(
    runRankedCandidateFallback(
      ["a", "b"],
      async (candidateId: string) => {
        attempted.push(candidateId);
        return {
          status: "rejected",
          reason: "positive control failed",
          restore: async () => {
            throw new Error("exact test snapshot restore mismatch");
          },
        };
      },
    ),
  ).rejects.toThrow("exact test snapshot restore mismatch");
  expect(attempted).toEqual(["a"]);
});

test("ranked fallback restores every rejected rank before exhaustion", async () => {
  const runRankedCandidateFallback = (
    improvementLib as Record<string, unknown>
  ).runRankedCandidateFallback;
  expect(runRankedCandidateFallback).toBeFunction();
  if (typeof runRankedCandidateFallback !== "function") return;

  const events: string[] = [];
  await expect(
    runRankedCandidateFallback(
      ["a", "b", "c"],
      async (candidateId: string) => ({
        status: "rejected",
        reason: `invalid:${candidateId}`,
        restore: async () => {
          events.push(`restore:${candidateId}`);
        },
      }),
    ),
  ).rejects.toThrow(
    "ranked candidates exhausted: a: invalid:a; b: invalid:b; c: invalid:c",
  );
  expect(events).toEqual(["restore:a", "restore:b", "restore:c"]);
});

test("ranked fallback never restores an accepted rank", async () => {
  const runRankedCandidateFallback = (
    improvementLib as Record<string, unknown>
  ).runRankedCandidateFallback;
  expect(runRankedCandidateFallback).toBeFunction();
  if (typeof runRankedCandidateFallback !== "function") return;

  let restoreCalls = 0;
  const result = await runRankedCandidateFallback(
    ["a"],
    async () => ({
      status: "accepted",
      value: "a",
      restore: async () => {
        restoreCalls += 1;
      },
    }),
  );

  expect(result.value).toBe("a");
  expect(restoreCalls).toBe(0);
});

test("ranked fallback stops immediately on an operational attempt failure", async () => {
  const runRankedCandidateFallback = (
    improvementLib as Record<string, unknown>
  ).runRankedCandidateFallback;
  expect(runRankedCandidateFallback).toBeFunction();
  if (typeof runRankedCandidateFallback !== "function") return;

  const attempted: string[] = [];
  await expect(
    runRankedCandidateFallback(
      ["a", "b"],
      async (candidateId: string) => {
        attempted.push(candidateId);
        throw new Error("backend failed");
      },
    ),
  ).rejects.toThrow("backend failed");
  expect(attempted).toEqual(["a"]);
});

test("candidate evidence stays within the scout packet", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
      { path: "src/decoy.ts", content: "export const decoy = 1;\n" },
      { path: "tests/decoy.test.ts", content: "test(\"decoy\", () => {});\n" },
    ],
    1_000,
    "",
    processSourceTestPairs,
  );
  expect(packet.text).toContain(
    "Reserved source-test pairs:\nsrc/tools/process.ts -> tests/tools.test.ts",
  );
  expect(
    validateCandidateEvidence(
      {
        ...candidate,
        evidence: [
          "src/tools/process.ts:1 drops output",
          "tests/tools.test.ts:1 exercises the same path",
        ],
      },
      packet,
    ),
  ).toEqual([]);
  expect(
    validateCandidateEvidence(
      {
        ...candidate,
        evidence: ["uncited claim"],
        allowedPaths: ["src/other.ts", candidate.testPath],
      },
      packet,
    ).join(" "),
  ).toContain("evidence packet");
});

test("candidate evidence cites both production and target-test lines", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
      { path: "src/decoy.ts", content: "export const decoy = 1;\n" },
      { path: "tests/decoy.test.ts", content: "test(\"decoy\", () => {});\n" },
    ],
    1_000,
    "",
    processSourceTestPairs,
  );

  expect(
    validateCandidateEvidence(
      { ...candidate, evidence: ["src/tools/process.ts:1 drops output"] },
      packet,
    ).join(" "),
  ).toContain("test path line");
  expect(
    validateCandidateEvidence(
      { ...candidate, evidence: ["tests/tools.test.ts:1 misses output"] },
      packet,
    ).join(" "),
  ).toContain("production path line");
  expect(
    validateCandidateEvidence(
      {
        ...candidate,
        evidence: [
          "src/decoy.ts:1 drops output",
          "tests/decoy.test.ts:1 misses output",
        ],
      },
      packet,
    ).join(" "),
  ).toContain("test path line");
  expect(
    validateCandidateEvidence(
      {
        ...candidate,
        evidence: [
          "src/decoy.ts:1 drops output",
          "tests/tools.test.ts:1 misses output",
        ],
      },
      packet,
    ).join(" "),
  ).toContain("production path line");
});

test("candidate evidence cites every allowed production path", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "src/tools/secondary.ts", content: "export const secondary = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
    ],
    1_000,
    "",
    processSourceTestPairs,
  );
  const scopedCandidate = {
    ...candidate,
    allowedPaths: [
      "src/tools/process.ts",
      "src/tools/secondary.ts",
      "tests/tools.test.ts",
    ],
    evidence: [
      "src/tools/process.ts:1 drops output",
      "tests/tools.test.ts:1 exercises the same path",
    ],
  };

  expect(validateCandidateEvidence(scopedCandidate, packet).join(" ")).toContain(
    "src/tools/secondary.ts",
  );
  expect(
    validateCandidateEvidence(
      {
        ...scopedCandidate,
        evidence: [
          ...scopedCandidate.evidence,
          "src/tools/secondary.ts:1 forwards the result",
        ],
      },
      packet,
    ),
  ).toEqual([]);
});

test("candidate evidence must cite an actually rendered line", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
    ],
    1_000,
    "",
    processSourceTestPairs,
  );
  for (const evidence of [
    "uncited claim",
    "src/tools/process.ts:999 fabricated line",
  ]) {
    expect(
      validateCandidateEvidence({ ...candidate, evidence: [evidence] }, packet),
    ).toEqual([
      "candidate evidence must cite an evidence packet path and line",
    ]);
  }
});

test("candidate evidence cannot cite path-like latest-commit text", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
    ],
    1_000,
    [
      "Latest commit subject and changed paths:",
      "src/tools/process.ts:999 fabricated source line",
      "tests/tools.test.ts:999 fabricated test line",
      "Current source and test evidence:",
    ].join("\n"),
    processSourceTestPairs,
  );
  expect(packet.renderedLineMarkers).toEqual([
    "src/tools/process.ts:1",
    "src/tools/process.ts:2",
    "tests/tools.test.ts:1",
    "tests/tools.test.ts:2",
  ]);

  expect(
    validateCandidateEvidence(
      {
        ...candidate,
        evidence: [
          "src/tools/process.ts:999 claims the defect",
          "tests/tools.test.ts:999 claims coverage",
        ],
      },
      packet,
    ),
  ).toEqual([
    "candidate evidence must cite an evidence packet path and line",
  ]);
});

test("candidate target test must be reserved for an allowed production path", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/tools/process.ts", content: "export const process = 1;\n" },
      { path: "tests/tools.test.ts", content: "test(\"process\", () => {});\n" },
      { path: "src/decoy.ts", content: "export const decoy = 1;\n" },
      { path: "tests/decoy.test.ts", content: "test(\"decoy\", () => {});\n" },
    ],
    1_000,
    "",
    [
      { sourcePath: "src/decoy.ts", testPath: "tests/decoy.test.ts" },
    ],
  );

  expect(
    validateCandidateEvidence(
      {
        ...candidate,
        evidence: [
          "src/tools/process.ts:1 claims the defect",
          "tests/tools.test.ts:1 claims coverage",
        ],
      },
      packet,
    ).join(" "),
  ).toContain("reserved for an allowed production path");
});

test("scout packet rejects forged or duplicate source-test reservations", () => {
  const files = [
    { path: "src/a.ts", content: "export const a = 1;\n" },
    { path: "src/b.ts", content: "export const b = 1;\n" },
    { path: "tests/a.test.ts", content: "test(\"a\", () => {});\n" },
    { path: "tests/b.test.ts", content: "test(\"b\", () => {});\n" },
  ];
  for (const pairs of [
    [{ sourcePath: "src/missing.ts", testPath: "tests/a.test.ts" }],
    [
      { sourcePath: "src/a.ts", testPath: "tests/a.test.ts" },
      { sourcePath: "src/a.ts", testPath: "tests/b.test.ts" },
    ],
    [
      { sourcePath: "src/a.ts", testPath: "tests/a.test.ts" },
      { sourcePath: "src/b.ts", testPath: "tests/a.test.ts" },
    ],
  ]) {
    expect(() => renderScoutEvidence(files, 1_000, "", pairs)).toThrow();
  }
});

describe("CandidateSchema", () => {
  test("requires an evidence-backed positive control", () => {
    const { controlBrief: _controlBrief, ...withoutControl } = candidate;
    expect(CandidateSchema.safeParse(withoutControl).success).toBe(false);
    expect(
      CandidateSchema.safeParse({ ...candidate, controlBrief: "   " }).success,
    ).toBe(false);
  });

  test("requires the exact candidate-derived RED marker", () => {
    const candidateRedMarker = (
      improvementLib as Record<string, unknown>
    ).candidateRedMarker;
    expect(candidateRedMarker).toBeFunction();
    if (typeof candidateRedMarker !== "function") return;
    expect(candidateRedMarker(candidate.id)).toBe("ORCA_RED:timeout-message");
    expect(CandidateSchema.safeParse(candidate).success).toBe(true);
    for (const expectedFailurePattern of [
      "e",
      "x",
      "[",
      "expected",
      "error?",
      "assertion error",
      "AssertionError",
      "error",
      "exception",
      "failure",
      "failed",
      "ReferenceError",
      "syntax error",
      "SyntaxError",
      "test failed",
      "TypeError",
      "unexpected error",
      "unexpected failure",
      "expected failure",
      "  Type   Error:  ",
      "ORCA_RED:other-candidate",
      "orca_red:timeout-message",
      "ORCA_RED:timeout-message.*",
      " ORCA_RED:timeout-message ",
    ]) {
      expect(
        CandidateSchema.safeParse({
          ...candidate,
          expectedFailurePattern,
        }).success,
      ).toBe(false);
      expect(
        ScoutCandidateSchema.safeParse({
          ...scoutCandidates[0],
          expectedFailurePattern,
        }).success,
      ).toBe(false);
    }
  });

  test("requires test and production paths", () => {
    expect(CandidateSchema.parse(candidate)).toEqual(candidate);
    expect(
      CandidateSchema.safeParse({
        ...candidate,
        allowedPaths: ["tests/tools.test.ts", "tests/other.test.ts"],
      }).success,
    ).toBe(false);
  });

  test("requires a tests tree test file", () => {
    for (const testPath of ["src/a.ts", "tests/a.ts"]) {
      const invalidTestPath = {
        ...candidate,
        allowedPaths: [testPath, "src/b.ts"],
        testPath,
        targetedTestArgs: ["test", testPath],
      };
      expect(ScoutCandidateSchema.safeParse(invalidTestPath).success).toBe(
        false,
      );
      expect(CandidateSchema.safeParse(invalidTestPath).success).toBe(false);
    }
  });

  test("requires unique allowed paths", () => {
    expect(
      CandidateSchema.safeParse({
        ...candidate,
        allowedPaths: [
          "src/tools/process.ts",
          "src/tools/process.ts",
          "tests/tools.test.ts",
        ],
      }).success,
    ).toBe(false);
  });

  test("forbids non-target allowed test paths", () => {
    const extraTest = {
      ...candidate,
      allowedPaths: [
        "src/tools/process.ts",
        "tests/tools.test.ts",
        "tests/other.test.ts",
      ],
    };
    expect(ScoutCandidateSchema.safeParse(extraTest).success).toBe(false);
    expect(CandidateSchema.safeParse(extraTest).success).toBe(false);
  });

  test("rejects protected paths", () => {
    for (const path of [
      "package.json",
      "packages/cli/package.json",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "deno.lock",
      "Cargo.lock",
      "poetry.lock",
      "uv.lock",
      "requirements.txt",
      "requirements-dev.txt",
      "pyproject.toml",
      "go.mod",
      "go.sum",
      "build.sbt",
      "install.sh",
      "bin/orcats",
      "skills/orcats-author/SKILL.md",
      ".github/workflows/ci.yml",
      "docs/release.md",
      "SECURITY.md",
      ".env",
      ".env.local",
      "config/.env.production",
      "certs/release.pem",
      "keys/release.key",
      "src/index.ts",
      "src/loop/index.ts",
    ]) {
      expect(
        CandidateSchema.safeParse({
          ...candidate,
          allowedPaths: [path, "tests/tools.test.ts"],
        }).success,
      ).toBe(false);
    }
  });

  test("rejects generic protected target patterns", () => {
    for (const path of [
      "scripts/package-artifact.ts",
      "config/credentials.json",
      "website/src/content/docs/release.md",
      "model/index.ts",
      "src/generated/client.ts",
    ]) {
      expect(
        CandidateSchema.safeParse({
          ...candidate,
          allowedPaths: [path, "tests/tools.test.ts"],
        }).success,
      ).toBe(false);
    }
  });

  test("binds the targeted test command to the test path", () => {
    expect(
      CandidateSchema.safeParse({
        ...candidate,
        targetedTestArgs: ["lint", candidate.testPath],
      }).success,
    ).toBe(false);
    expect(
      CandidateSchema.safeParse({
        ...candidate,
        targetedTestArgs: ["test", "tests/other.test.ts"],
      }).success,
    ).toBe(false);
    expect(
      CandidateSchema.safeParse({
        ...candidate,
        targetedTestArgs: ["test", candidate.testPath, "--watch"],
      }).success,
    ).toBe(false);
  });
});

test("directive carries skill and prompt", () => {
  const rendered = renderDirective("implement", {
    skill: "tdd",
    prompt: "Keep the test unchanged.",
  });
  expect(rendered).toContain("invoke $tdd");
  expect(rendered).toContain("Keep the test unchanged.");
  expect(stageConfig("implement", { skill: "tdd" }, false).systemPrompt).toBe(
    renderDirective("implement", { skill: "tdd" }),
  );
});

test("stage config pins sandbox to read/write intent", () => {
  expect(stageConfig("scout", { prompt: "Rank evidence." }, true)).toMatchObject({
    readOnly: true,
    sandbox: "read-only",
  });
  expect(stageConfig("implement", { skill: "tdd" }, false)).toMatchObject({
    readOnly: false,
    sandbox: "workspace-write",
  });
});

test("profiles enforce time and path limits", () => {
  expect(validateCandidateForProfile(candidate, "simple")).toEqual([]);
  const medium = {
    ...candidate,
    expectedMinutes: 30,
    allowedPaths: [
      "src/tools/process.ts",
      "src/tools/terminal.ts",
      "src/tools/fs.ts",
      "tests/tools.test.ts",
    ],
  };
  expect(validateCandidateForProfile(medium, "medium")).toEqual([]);
  expect(
    validateCandidateForProfile(medium, "simple").length,
  ).toBeGreaterThan(0);
});

test("scope rejects missing test and off-target paths", () => {
  expect(
    validateChangedPaths(candidate, [
      "src/tools/process.ts",
      "tests/tools.test.ts",
    ]),
  ).toEqual([]);
  expect(
    validateChangedPaths(candidate, ["src/tools/process.ts"]).join(" "),
  ).toContain("test path");
  expect(
    validateChangedPaths(candidate, ["src/tools/process.ts", "README.md"]).join(
      " ",
    ),
  ).toContain("off-target");
});

test("scope requires a changed production path", () => {
  const candidateWithTwoTests = {
    ...candidate,
    allowedPaths: [
      "src/tools/process.ts",
      "tests/tools.test.ts",
      "tests/other.test.ts",
    ],
  };
  expect(
    validateChangedPaths(candidateWithTwoTests, [
      "tests/tools.test.ts",
      "tests/other.test.ts",
    ]).join(" "),
  ).toContain("production path");
});

describe("remote checks", () => {
  test("a just-created PR with no reported checks stays pending", () => {
    expect(
      isRemoteChecksStartupPending({
        type: "failure",
        exitCode: 1,
        stdout: "",
        stderr:
          "no checks reported on the 'orca/improve-20260713175736-9351' branch\n",
      }),
    ).toBe(true);
    expect(
      isRemoteChecksStartupPending({
        type: "failure",
        exitCode: 1,
        stdout: "",
        stderr: "HTTP 401: Bad credentials\n",
      }),
    ).toBe(false);
    expect(
      isRemoteChecksStartupPending({
        type: "success",
        exitCode: 0,
        stdout:
          "no checks reported on the 'orca/improve-20260713175736-9351' branch\n",
        stderr: "",
      }),
    ).toBe(false);
  });

  test("empty and missing expected checks stay pending", () => {
    expect(remoteCheckState([])).toBe("pending");
    expect(
      remoteCheckState([
        { name: "GitGuardian", workflow: "", bucket: "pass" },
      ]),
    ).toBe("pending");
  });

  test("all checks must pass", () => {
    expect(
      remoteCheckState([
        { name: "Verify", workflow: "CI", bucket: "pass" },
        { name: "GitGuardian", workflow: "", bucket: "pass" },
      ]),
    ).toBe("passed");
    expect(
      remoteCheckState([
        { name: "Verify", workflow: "CI", bucket: "pass" },
        { name: "GitGuardian", workflow: "", bucket: "fail" },
      ]),
    ).toBe("failed");
  });

  test("a skipped check is failed rather than green or pending", () => {
    expect(
      remoteCheckState([
        { name: "Verify", workflow: "CI", bucket: "pass" },
        { name: "GitGuardian", workflow: "", bucket: "skipping" },
      ]),
    ).toBe("failed");
    expect(
      remoteCheckState([
        { name: "Verify", workflow: "CI", bucket: "skipping" },
      ]),
    ).toBe("failed");
  });

  test("startup parsing never manufactures a passing check", () => {
    expect(
      parseRemoteChecksCommandResult(
        {
          type: "failure",
          exitCode: 1,
          stdout: "",
          stderr:
            "no checks reported on the 'orca/improve-20260713175736-9351' branch\n",
        },
        "gh pr checks",
      ),
    ).toEqual([]);
    expect(
      parseRemoteChecksCommandResult(
        {
          type: "failure",
          exitCode: 8,
          stdout:
            '[{"name":"Verify","workflow":"CI","bucket":"pending"}]',
          stderr: "",
        },
        "gh pr checks",
      ),
    ).toEqual([{ name: "Verify", workflow: "CI", bucket: "pending" }]);
    expect(() =>
      parseRemoteChecksCommandResult(
        {
          type: "failure",
          exitCode: 1,
          stdout: "",
          stderr: "HTTP 401: Bad credentials",
        },
        "gh pr checks",
      ),
    ).toThrow("HTTP 401");
  });
});

test("pull request delivery binds base main, ready state, fixed head, and merge", () => {
  const expectedHead = "a".repeat(40);
  const identity = {
    repository: "example/repo",
    branch: "orca/improve-run-1",
    headSha: expectedHead,
  };
  const ready = {
    url: "https://github.com/example/repo/pull/42",
    baseRefName: "main",
    headRefName: identity.branch,
    headRefOid: expectedHead,
    isDraft: false,
  };
  expect(pullRequestCreateArgs("title", "/tmp/body.md", identity)).toEqual([
    "pr",
    "create",
    "--repo",
    identity.repository,
    "--title",
    "title",
    "--body-file",
    "/tmp/body.md",
    "--head",
    identity.branch,
    "--base",
    "main",
  ]);
  expect(pullRequestCreateArgs("title", "/tmp/body.md", identity)).not.toContain(
    "--draft",
  );
  expect(() =>
    assertReadyPullRequestHead(
      { ...ready, isDraft: true },
      identity,
    ),
  ).toThrow("ready for review");
  expect(() =>
    assertReadyPullRequestHead(
      { ...ready, headRefOid: "b".repeat(40) },
      identity,
    ),
  ).toThrow("head moved");
  expect(() =>
    assertReadyPullRequestHead(
      { ...ready, baseRefName: "release" },
      identity,
    ),
  ).toThrow("base branch");
  expect(() =>
    assertReadyPullRequestHead(
      { ...ready, headRefName: "other-branch" },
      identity,
    ),
  ).toThrow("head branch");
  expect(() =>
    assertReadyPullRequestHead(
      { ...ready, url: "https://github.com/other/repo/pull/42" },
      identity,
    ),
  ).toThrow("repository");
  expect(
    assertReadyPullRequestHead(ready, identity),
  ).toBeUndefined();
  for (const state of ["OPEN", "CLOSED", "UNKNOWN", "arbitrary-state"]) {
    expect(() =>
      assertMergedPullRequestState({ ...ready, state }, identity),
    ).toThrow(
      `returned ${state}`,
    );
  }
  expect(() =>
    assertMergedPullRequestState(
      { ...ready, state: "MERGED", baseRefName: "release" },
      identity,
    ),
  ).toThrow("base branch");
  expect(() =>
    assertMergedPullRequestState(
      { ...ready, state: "MERGED", headRefOid: "b".repeat(40) },
      identity,
    ),
  ).toThrow("head moved");
  expect(() =>
    assertMergedPullRequestState(
      { ...ready, state: "MERGED", isDraft: true },
      identity,
    ),
  ).toThrow("ready for review");
  expect(
    assertMergedPullRequestState({ ...ready, state: "MERGED" }, identity),
  ).toBeUndefined();
});

test("merge protection requires strict CI enforcement for administrators", () => {
  const assertRequiredMergeProtection = (
    improvementLib as Record<string, unknown>
  ).assertRequiredMergeProtection;
  expect(assertRequiredMergeProtection).toBeFunction();
  if (typeof assertRequiredMergeProtection !== "function") return;

  const protectedMain = {
    required_status_checks: {
      strict: true,
      contexts: ["Verify"],
      checks: [{ context: "Verify", app_id: 15368 }],
    },
    enforce_admins: { enabled: true },
  };
  expect(
    assertRequiredMergeProtection(protectedMain, "Verify", 15368),
  ).toBeUndefined();
  expect(() =>
    assertRequiredMergeProtection(
      { ...protectedMain, enforce_admins: { enabled: false } },
      "Verify",
      15368,
    ),
  ).toThrow("administrators");
  expect(() =>
    assertRequiredMergeProtection(
      {
        ...protectedMain,
        required_status_checks: {
          ...protectedMain.required_status_checks,
          strict: false,
        },
      },
      "Verify",
      15368,
    ),
  ).toThrow("strict");
  expect(() =>
    assertRequiredMergeProtection(
      {
        ...protectedMain,
        required_status_checks: {
          strict: true,
          contexts: ["GitGuardian Security Checks"],
          checks: [{ context: "GitGuardian Security Checks", app_id: 15368 }],
        },
      },
      "Verify",
      15368,
    ),
  ).toThrow("Verify");
  expect(() =>
    assertRequiredMergeProtection(
      {
        ...protectedMain,
        required_status_checks: {
          strict: true,
          contexts: ["Verify"],
          checks: [{ context: "Verify", app_id: 42 }],
        },
      },
      "Verify",
      15368,
    ),
  ).toThrow("15368");
  expect(() =>
    assertRequiredMergeProtection(
      {
        ...protectedMain,
        required_status_checks: {
          strict: true,
          contexts: ["Verify"],
          checks: [],
        },
      },
      "Verify",
      15368,
    ),
  ).toThrow("15368");
});

test("stage budgets count only active work while retaining prior usage", () => {
  const tracker = createActiveStageBudgetTracker<"repairs" | "review">();
  tracker.activate("repairs", 0);
  expect(tracker.remaining("repairs", 65_000, 10_000)).toBe(55_000);
  tracker.activate("review", 10_000);
  expect(tracker.remaining("repairs", 65_000, 50_000)).toBe(55_000);
  expect(tracker.remaining("review", 65_000, 50_000)).toBe(25_000);
  tracker.activate("repairs", 50_000);
  expect(tracker.remaining("repairs", 65_000, 60_000)).toBe(45_000);
  tracker.activate("review", 60_000);
  expect(tracker.remaining("review", 65_000, 70_000)).toBe(15_000);
});

test("stage budget respects global deadline", () => {
  expect(stageBudgetMs(1_000, 600_000, 1_100, 70_000)).toBe(70_000);
  expect(stageBudgetMs(1_000, 100_000, 90_000, 70_000)).toBe(11_000);
  expect(profileLimits.simple.deadlineMs).toBe(1_800_000);
  expect(profileLimits.medium.deadlineMs).toBe(3_600_000);
  expect(profileLimits.challenging.deadlineMs).toBe(7_200_000);
  expect(profileLimits.simple.maxPaths).toBe(3);
  expect(profileLimits.medium.maxPaths).toBe(6);
  expect(profileLimits.challenging.maxPaths).toBe(10);
});

test("profile caps and candidate targets use the active clock", () => {
  expect(profileLimits.simple).toMatchObject({
    minMinutes: 10,
    maxMinutes: 20,
    activeCapMs: 1_800_000,
  });
  expect(profileLimits.medium).toMatchObject({
    minMinutes: 30,
    maxMinutes: 60,
    activeCapMs: 3_600_000,
  });
  expect(profileLimits.challenging).toMatchObject({
    minMinutes: 60,
    maxMinutes: 120,
    activeCapMs: 7_200_000,
  });
});

test("challenging split rejects over-cap active cost and admits the exact cap", () => {
  const atCap: ScoutCandidate = {
    ...candidate,
    expectedMinutes: 120,
    estimatedActiveMs: 7_200_000,
  };
  expect(() =>
    assertCandidateFitsActiveProfile(atCap, "challenging"),
  ).not.toThrow();
  expect(() =>
    assertCandidateFitsActiveProfile(
      { ...atCap, estimatedActiveMs: 7_200_001 },
      "challenging",
    ),
  ).toThrow(CandidateRequiresSplitError);
  try {
    assertCandidateFitsActiveProfile(
      { ...atCap, estimatedActiveMs: 7_200_001 },
      "challenging",
    );
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateRequiresSplitError);
    expect((error as CandidateRequiresSplitError).reason).toContain("split");
  }
});

test("failure normalization always returns a string", () => {
  expect(normalizeFailure(undefined)).toBe("undefined");
});

test("candidate citations require exact leading and trailing token boundaries", () => {
  const packet = renderScoutEvidence(
    [
      { path: "src/a.ts", content: "export const value = 1;\n" },
      { path: "tests/a.test.ts", content: "test(\"a\", () => {});\n" },
    ],
    1_000,
    "",
    [{ sourcePath: "src/a.ts", testPath: "tests/a.test.ts" }],
  );
  const issuesFor = (evidence: readonly string[]) =>
    validateCandidateEvidence(
      {
        ...candidate,
        allowedPaths: ["src/a.ts", "tests/a.test.ts"],
        testPath: "tests/a.test.ts",
        targetedTestArgs: ["test", "tests/a.test.ts"],
        evidence: [...evidence],
      },
      packet,
    );

  expect(issuesFor(["src/a.ts:1 claim", "tests/a.test.ts:1 proof"])).toEqual(
    [],
  );
  expect(
    issuesFor(["`src/a.ts:1` claim", "`tests/a.test.ts:1` proof"]),
  ).toEqual([]);
  expect(
    issuesFor(["(src/a.ts:1) claim", "(tests/a.test.ts:1) proof"]),
  ).toEqual([]);

  for (const evidence of [
    ["notsrc/a.ts:1 claim", "nottests/a.test.ts:1 proof"],
    ["src/nested/src/a.ts:1 claim", "tests/nested/tests/a.test.ts:1 proof"],
    ["src/a.ts:1x claim", "tests/a.test.ts:1x proof"],
    ["src/a.ts:10 claim", "tests/a.test.ts:10 proof"],
    ["src/a.ts:1/next claim", "tests/a.test.ts:1.more proof"],
  ]) {
    expect(issuesFor(evidence)).toContain(
      "candidate evidence must cite an evidence packet path and line",
    );
  }
});

test("launcher branch identity is exact and required", () => {
  const requireImprovementBranch = (
    improvementLib as Record<string, unknown>
  ).requireImprovementBranch;
  expect(requireImprovementBranch).toBeFunction();
  if (typeof requireImprovementBranch !== "function") return;
  expect(requireImprovementBranch("run-1", "  orca/improve-run-1  ")).toBe(
    "orca/improve-run-1",
  );
  expect(() => requireImprovementBranch("run-1", undefined)).toThrow(
    "ORCA_IMPROVEMENT_BRANCH",
  );
  expect(() => requireImprovementBranch("run-1", "orca/improve-other")).toThrow(
    "did not match",
  );
});

test("launcher delivery identity requires immutable repository and remotes", () => {
  const requireLauncherDeliveryIdentity = (
    improvementLib as Record<string, unknown>
  ).requireLauncherDeliveryIdentity;
  expect(requireLauncherDeliveryIdentity).toBeFunction();
  if (typeof requireLauncherDeliveryIdentity !== "function") return;
  const values = {
    branch: " orca/improve-run-1 ",
    repository: " example/repo ",
    originFetchUrl: " git@github.com:example/repo.git ",
    originPushUrl: " git@github.com:example/repo.git ",
  };
  expect(requireLauncherDeliveryIdentity("run-1", values)).toEqual({
    branch: "orca/improve-run-1",
    repository: "example/repo",
    originFetchUrl: "git@github.com:example/repo.git",
    originPushUrl: "git@github.com:example/repo.git",
  });
  for (const key of Object.keys(values) as Array<keyof typeof values>) {
    expect(() =>
      requireLauncherDeliveryIdentity("run-1", {
        ...values,
        [key]: undefined,
      }),
    ).toThrow(
      {
        branch: "ORCA_IMPROVEMENT_BRANCH",
        repository: "ORCA_IMPROVEMENT_REPOSITORY",
        originFetchUrl: "ORCA_IMPROVEMENT_ORIGIN_FETCH_URL",
        originPushUrl: "ORCA_IMPROVEMENT_ORIGIN_PUSH_URL",
      }[key],
    );
  }
  expect(() =>
    requireLauncherDeliveryIdentity("run-1", {
      ...values,
      repository: "not-a-repository",
    }),
  ).toThrow("ORCA_IMPROVEMENT_REPOSITORY");
});

test("seed issue resolution follows latest append-only state", () => {
  const resolveOpenIssueForProvingRun = (
    improvementLib as Record<string, unknown>
  ).resolveOpenIssueForProvingRun;
  expect(resolveOpenIssueForProvingRun).toBeFunction();
  if (typeof resolveOpenIssueForProvingRun !== "function") return;
  const open = {
    id: "seed",
    status: "open",
    evidence: "old",
    runId: "failed-run",
  };
  const context = {
    backend: "codex",
    worktree: "/tmp/proof",
    branch: "orca/improve-proof-run",
    monitorPath: ".orca/monitoring/proof.json",
  };
  expect(
    resolveOpenIssueForProvingRun(
      [open],
      "seed",
      "proof-run",
      "https://github.com/example/repo/pull/1",
      "2026-07-14T00:00:00.000Z",
      context,
    ),
  ).toEqual({
    ...open,
    ...context,
    at: "2026-07-14T00:00:00.000Z",
    evidence:
      "Resolved by merged pull request https://github.com/example/repo/pull/1",
    prUrl: "https://github.com/example/repo/pull/1",
    status: "resolved",
    provingRunId: "proof-run",
  });
  expect(
    resolveOpenIssueForProvingRun(
      [open, { ...open, status: "corrected" }],
      "seed",
      "proof-run",
      "https://github.com/example/repo/pull/1",
      "2026-07-14T00:00:00.000Z",
      context,
    ),
  ).toBeUndefined();
  expect(
    resolveOpenIssueForProvingRun(
      [{ ...open, id: "other" }],
      "seed",
      "proof-run",
      "https://github.com/example/repo/pull/1",
      "2026-07-14T00:00:00.000Z",
      context,
    ),
  ).toBeUndefined();
});

test("proving-run resolution covers every latest-open ledger ID deterministically", () => {
  const resolveLatestOpenIssuesForProvingRun = (
    improvementLib as Record<string, unknown>
  ).resolveLatestOpenIssuesForProvingRun;
  expect(resolveLatestOpenIssuesForProvingRun).toBeFunction();
  if (typeof resolveLatestOpenIssuesForProvingRun !== "function") return;
  const issues = [
    { id: "zeta", status: "open", evidence: "zeta", runId: "run-z" },
    { id: "alpha", status: "open", evidence: "old", runId: "run-old" },
    { id: "closed", status: "open", evidence: "old", runId: "run-c" },
    { id: "alpha", status: "open", evidence: "latest", runId: "run-a" },
    { id: "closed", status: "corrected", evidence: "fixed", runId: "run-c" },
  ];
  const context = {
    backend: "codex",
    worktree: "/tmp/proof",
    branch: "orca/improve-proof-run",
    monitorPath: ".orca/monitoring/proof.json",
  };
  const provingRunId = "proof-run";
  const prUrl = "https://github.com/example/repo/pull/1";
  const at = "2026-07-14T00:00:00.000Z";
  expect(
    resolveLatestOpenIssuesForProvingRun(
      issues,
      provingRunId,
      prUrl,
      at,
      context,
    ),
  ).toEqual([
    {
      ...issues[3],
      ...context,
      at,
      evidence: `Resolved by merged pull request ${prUrl}`,
      prUrl,
      status: "resolved",
      provingRunId,
    },
    {
      ...issues[0],
      ...context,
      at,
      evidence: `Resolved by merged pull request ${prUrl}`,
      prUrl,
      status: "resolved",
      provingRunId,
    },
  ]);
});

test("remote-check evidence exists only for an all-green fixed head", () => {
  const buildPassedRemoteChecksEvidence = (
    improvementLib as Record<string, unknown>
  ).buildPassedRemoteChecksEvidence;
  expect(buildPassedRemoteChecksEvidence).toBeFunction();
  if (typeof buildPassedRemoteChecksEvidence !== "function") return;
  const log = {
    command: "gh pr checks https://example.test/pr/1 --json name,workflow,bucket",
    status: "passed",
    stdout: "[]",
    stderr: "",
  };
  const headSha = "a".repeat(40);
  const checkedAt = "2026-07-14T00:00:00.000Z";
  expect(() =>
    buildPassedRemoteChecksEvidence([], log, headSha, checkedAt),
  ).toThrow("not passed");
  expect(() =>
    buildPassedRemoteChecksEvidence(
      [{ name: "Verify", workflow: "CI", bucket: "pending" }],
      log,
      headSha,
      checkedAt,
    ),
  ).toThrow("not passed");
  const checks = [{ name: "Verify", workflow: "CI", bucket: "pass" }];
  expect(() =>
    buildPassedRemoteChecksEvidence(
      checks,
      { ...log, status: "failed" },
      headSha,
      checkedAt,
    ),
  ).toThrow("command did not pass");
  expect(
    buildPassedRemoteChecksEvidence(checks, log, headSha, checkedAt),
  ).toEqual({
    checkedAt,
    headSha,
    state: "passed",
    command: log,
    checks,
  });
  expect(() =>
    buildPassedRemoteChecksEvidence(checks, log, "not-a-sha", checkedAt),
  ).toThrow("head SHA is invalid");
  expect(() =>
    buildPassedRemoteChecksEvidence(checks, log, headSha, "not-a-time"),
  ).toThrow("timestamp is invalid");
});

test("selected model overlay preserves every stage directive", () => {
  const withSelectedModel = (
    improvementLib as Record<string, unknown>
  ).withSelectedModel;
  expect(withSelectedModel).toBeFunction();
  if (typeof withSelectedModel !== "function") return;
  const directive = stageConfig(
    "implement",
    { skill: "test-driven-development", prompt: "Keep the RED proof." },
    false,
  );
  expect(withSelectedModel(directive, "gpt-5-codex")).toEqual({
    model: "gpt-5-codex",
    ...directive,
  });
  expect(withSelectedModel(directive, undefined)).toEqual(directive);
});

test("current branch proof rejects a branch other than the launcher binding", () => {
  const assertCurrentBranch = (
    improvementLib as Record<string, unknown>
  ).assertCurrentBranch;
  expect(assertCurrentBranch).toBeFunction();
  if (typeof assertCurrentBranch !== "function") return;
  expect(
    assertCurrentBranch("  orca/improve-run-1\n", "orca/improve-run-1"),
  ).toBe("orca/improve-run-1");
  expect(() =>
    assertCurrentBranch("orca/improve-other", "orca/improve-run-1"),
  ).toThrow("did not match launcher branch");
});

test("usage aggregation retains every reported token category", () => {
  const mergeUsage = (
    improvementLib as Record<string, unknown>
  ).mergeUsage;
  expect(mergeUsage).toBeFunction();
  if (typeof mergeUsage !== "function") return;
  expect(mergeUsage(undefined, { input: 2, output: 3 })).toEqual({
    input: 2,
    output: 3,
  });
  expect(
    mergeUsage(
      { input: 2, output: 3, reasoning: 5 },
      { input: 7, output: 11, reasoning: 13 },
    ),
  ).toEqual({ input: 9, output: 14, reasoning: 18 });
  expect(mergeUsage({ input: 2, output: 3 }, undefined)).toEqual({
    input: 2,
    output: 3,
  });
});

test("delivery requires recorded backend usage", () => {
  const requireRecordedUsage = (
    improvementLib as Record<string, unknown>
  ).requireRecordedUsage;
  expect(requireRecordedUsage).toBeFunction();
  if (typeof requireRecordedUsage !== "function") return;
  expect(() => requireRecordedUsage(undefined)).toThrow(
    "backend usage is required before delivery",
  );
  expect(() => requireRecordedUsage({ input: 0, output: 0 })).toThrow(
    /at least one positive counter/,
  );
  for (const invalid of [
    { input: -1, output: 2 },
    { input: Number.NaN, output: 2 },
    { input: Number.POSITIVE_INFINITY, output: 2 },
    { input: 2, output: Number.NEGATIVE_INFINITY },
    { input: 2, output: 3, reasoning: Number.POSITIVE_INFINITY },
  ]) {
    expect(() => requireRecordedUsage(invalid)).toThrow(
      /finite non-negative numbers/,
    );
  }
  expect(requireRecordedUsage({ input: 0, output: 0, reasoning: 1 })).toEqual({
    input: 0,
    output: 0,
    reasoning: 1,
  });
  expect(requireRecordedUsage({ input: 2, output: 3, reasoning: 5 })).toEqual({
    input: 2,
    output: 3,
    reasoning: 5,
  });
});

test("legacy seed resolution overlays the current proving-run context", () => {
  const resolveOpenIssueForProvingRun = (
    improvementLib as Record<string, unknown>
  ).resolveOpenIssueForProvingRun;
  expect(resolveOpenIssueForProvingRun).toBeFunction();
  if (typeof resolveOpenIssueForProvingRun !== "function") return;
  const legacy = {
    id: "seed",
    status: "open",
    evidence: "old",
    runId: "failed-run",
  };
  const context = {
    backend: "codex",
    worktree: "/tmp/proof",
    branch: "orca/improve-proof-run",
    monitorPath: ".orca/monitoring/proof.json",
  };
  expect(
    resolveOpenIssueForProvingRun(
      [legacy],
      "seed",
      "proof-run",
      "https://github.com/example/repo/pull/1",
      "2026-07-14T00:00:00.000Z",
      context,
    ),
  ).toEqual({
    ...legacy,
    ...context,
    at: "2026-07-14T00:00:00.000Z",
    evidence:
      "Resolved by merged pull request https://github.com/example/repo/pull/1",
    prUrl: "https://github.com/example/repo/pull/1",
    status: "resolved",
    provingRunId: "proof-run",
  });
});
