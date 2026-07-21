import { createHash } from "node:crypto";
import { z, type BackendConfig, type Usage } from "@twelvehart/orcats";

const dependencyManifestOrLock =
  /(?:^|\/)(?:[^/]*(?:[-.]lock(?:b|\.[^/]+)?|lockfile)|npm-shrinkwrap\.json|package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.(?:mod|sum)|build\.sbt|Cargo\.toml|Pipfile|Gemfile|composer\.json|deno\.jsonc?|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|mix\.exs|rebar\.config|pubspec\.yaml|Package\.swift)$/i;
const releaseOrPublishPath =
  /^(?:\.github\/workflows(?:\/|$)|docs\/release\.md$|(?:bin|skills|\.changeset)(?:\/|$)|\.npm(?:rc|ignore)$|CHANGELOG\.md$)|(?:^|\/)(?:install|release|publish)\.(?:sh|[cm]?[jt]s)$/i;
const secretKeyOrCertPath =
  /(?:^|\/)(?:\.env[^/]*(?:$|\/)|(?:secrets?|keys?|certs?|credentials?)(?:\/|$)|[^/]+\.(?:pem|key|crt|cer|p12|pfx|jks|keystore)$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$)/i;
const securityPolicyPath =
  /(?:^|\/)(?:SECURITY\.(?:md|txt)|security-policy(?:\.[^/]+)?|CODEOWNERS)$|^\.github\/(?:codeql|dependabot(?:\.ya?ml)?)(?:\/|$)/i;
const genericProtectedTarget =
  /(?:^|\/)(?:release|publish|credential|secret|security|package-artifact)[^/]*(?:\/|$)/i;
const generatedPath = /(?:^|\/)generated(?:\/|$)/i;
const publicApiEntrypoint =
  /(?:^|\/)index\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
function isForbiddenPath(path: string): boolean {
  return (
    path.startsWith(".orca/") ||
    dependencyManifestOrLock.test(path) ||
    releaseOrPublishPath.test(path) ||
    secretKeyOrCertPath.test(path) ||
    securityPolicyPath.test(path) ||
    genericProtectedTarget.test(path) ||
    generatedPath.test(path) ||
    publicApiEntrypoint.test(path)
  );
}

export const DirectiveSchema = z
  .object({
    skill: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => value.skill !== undefined || value.prompt !== undefined,
  );

export const WorkflowConfigSchema = z.object({
  stages: z.object({
    scout: DirectiveSchema,
    reproduce: DirectiveSchema,
    implement: DirectiveSchema,
    repair: DirectiveSchema,
    review: DirectiveSchema,
  }),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

export const ComplexityProfileSchema = z.enum([
  "simple",
  "medium",
  "challenging",
]);
export type ComplexityProfile = z.infer<typeof ComplexityProfileSchema>;
export const profileLimits = {
  simple: {
    minMinutes: 10,
    maxMinutes: 20,
    maxPaths: 3,
    activeCapMs: 1_800_000,
    deadlineMs: 1_800_000,
  },
  medium: {
    minMinutes: 30,
    maxMinutes: 60,
    maxPaths: 6,
    activeCapMs: 3_600_000,
    deadlineMs: 3_600_000,
  },
  challenging: {
    minMinutes: 60,
    maxMinutes: 120,
    maxPaths: 10,
    activeCapMs: 7_200_000,
    deadlineMs: 7_200_000,
  },
} as const;

const candidateIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const testScoutPath = /^tests\/.*\.test\.ts$/;
const candidateRedMarkerPattern = /^ORCA_RED:[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function candidateRedMarker(candidateId: string): string {
  return `ORCA_RED:${candidateIdSchema.parse(candidateId)}`;
}

export function isGenericExpectedFailurePattern(value: string): boolean {
  return !candidateRedMarkerPattern.test(value);
}

const ScoutCandidateBaseSchema = z.object({
    id: candidateIdSchema,
    title: z
      .string()
      .trim()
      .regex(
        /^(?:fix|feat|docs|test|refactor|perf|chore)(?:\([^)]+\))?: .+/,
      ),
    problem: z.string().trim().min(1),
    evidence: z.array(z.string().trim().min(1)).min(1),
    allowedPaths: z.array(z.string().trim().min(1)).min(2).max(10),
    testPath: z.string().trim().min(1),
    targetedTestArgs: z.array(z.string()).length(2),
    expectedFailurePattern: z.string().min(1),
    implementationBrief: z.string().trim().min(1),
    expectedMinutes: z.number().int().min(10).max(120),
    estimatedActiveMs: z.number().int().positive().optional(),
    risk: z.literal("low"),
  });

type ScoutCandidateBase = z.infer<typeof ScoutCandidateBaseSchema>;

function candidateContractIssues(value: ScoutCandidateBase): string[] {
  const issues: string[] = [];
  if (value.expectedFailurePattern !== candidateRedMarker(value.id)) {
    issues.push("expected failure pattern must equal candidate RED marker");
  }
  const paths = new Set(value.allowedPaths);
  if (paths.size !== value.allowedPaths.length) {
    issues.push("allowed paths must be unique");
  }
  if (!paths.has(value.testPath)) {
    issues.push("test path must be allowed");
  }
  if (!testScoutPath.test(value.testPath)) {
    issues.push("test path must be a tests tree test file");
  }
  if (
    !value.allowedPaths.some(
      (path) => path !== value.testPath && !path.startsWith("tests/"),
    )
  ) {
    issues.push("production path required");
  }
  if (value.targetedTestArgs[0] !== "test") {
    issues.push("targeted command must be bun test");
  }
  if (value.targetedTestArgs[1] !== value.testPath) {
    issues.push("targeted test path must match testPath");
  }
  for (const path of value.allowedPaths) {
    if (path.startsWith("tests/") && path !== value.testPath) {
      issues.push(`non-target test path is not allowed: ${path}`);
    }
    if (
      path.startsWith("/") ||
      path.includes("..") ||
      isForbiddenPath(path)
    ) {
      issues.push(`forbidden path: ${path}`);
    }
  }
  return issues;
}

export const ScoutCandidateSchema = ScoutCandidateBaseSchema.superRefine(
  (value, context) => {
    for (const message of candidateContractIssues(value)) {
      context.addIssue({
        code: "custom",
        message,
      });
    }
  },
);

export const CandidateSchema = ScoutCandidateBaseSchema.extend({
  controlBrief: z.string().trim().min(1),
  controlTestName: z.string().trim().min(1),
  controlProductionPath: z.string().trim().min(1),
}).superRefine((value, context) => {
    for (const message of candidateContractIssues(value)) {
      context.addIssue({
        code: "custom",
        message,
      });
    }
    if (
      !value.allowedPaths.includes(value.controlProductionPath) ||
      value.controlProductionPath === value.testPath ||
      value.controlProductionPath.startsWith("tests/")
    ) {
      context.addIssue({
        code: "custom",
        message: "control production path must be an allowed production path",
      });
    }
  });

export interface ScoutEvidenceFile {
  readonly path: string;
  readonly content: string;
  readonly matchLines?: readonly number[];
}

export interface ScoutSourceTestPair {
  readonly sourcePath: string;
  readonly testPath: string;
}

export interface ScoutEvidenceSelection {
  readonly paths: readonly string[];
  readonly sourceTestPairs: readonly ScoutSourceTestPair[];
}

export interface ScoutEvidencePacket {
  readonly paths: readonly string[];
  readonly text: string;
  readonly sha256: string;
  readonly charCount: number;
  readonly renderedLineMarkers: readonly string[];
  readonly sourceTestPairs: readonly ScoutSourceTestPair[];
}

const sourceScoutPath = /^src\/(?!.*(?:^|\/)index\.ts$).*\.ts$/;
const scoutPathTokenStopWords = new Set([
  "index",
  "main",
  "src",
  "test",
  "tests",
  "ts",
  "types",
]);
const SCOUT_MATCH_CONTEXT_RADIUS = 16;

function scoutPathTokens(path: string): Set<string> {
  return new Set(
    path
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (token) =>
          token.length > 1 && !scoutPathTokenStopWords.has(token),
      ),
  );
}

function scoutTestRelatedness(
  testPath: string,
  sourcePaths: readonly string[],
): number {
  return sourcePaths.reduce((highest, sourcePath) => {
    const overlap = scoutPathRelatedness(testPath, sourcePath);
    return Math.max(highest, overlap);
  }, 0);
}

function scoutPathRelatedness(
  testPath: string,
  sourcePath: string,
): number {
  const testTokens = scoutPathTokens(testPath);
  return [...scoutPathTokens(sourcePath)].filter((token) =>
    testTokens.has(token),
  ).length;
}

type ScoutTestAssignment = readonly (string | undefined)[];

function compareScoutTestAssignments(
  left: ScoutTestAssignment,
  right: ScoutTestAssignment,
  sourcePaths: readonly string[],
  touches: ReadonlyMap<string, number>,
): number {
  const assignedCount = (assignment: ScoutTestAssignment): number =>
    assignment.filter((path) => path !== undefined).length;
  const totalRelatedness = (assignment: ScoutTestAssignment): number =>
    assignment.reduce((total, testPath, sourceIndex) => {
      if (testPath === undefined) return total;
      const sourcePath = sourcePaths[sourceIndex];
      if (sourcePath === undefined) {
        throw new Error("Scout test assignment has no source path");
      }
      return total + scoutPathRelatedness(testPath, sourcePath);
    }, 0);
  const countDifference = assignedCount(left) - assignedCount(right);
  if (countDifference !== 0) return countDifference;
  const scoreDifference = totalRelatedness(left) - totalRelatedness(right);
  if (scoreDifference !== 0) return scoreDifference;
  for (const [sourceIndex, sourcePath] of sourcePaths.entries()) {
    const leftPath = left[sourceIndex];
    const rightPath = right[sourceIndex];
    if (leftPath === undefined || rightPath === undefined) {
      if (leftPath !== rightPath) return leftPath === undefined ? -1 : 1;
      continue;
    }
    const relatednessDifference =
      scoutPathRelatedness(leftPath, sourcePath) -
      scoutPathRelatedness(rightPath, sourcePath);
    if (relatednessDifference !== 0) return relatednessDifference;
    const touchDifference =
      (touches.get(leftPath) ?? 0) - (touches.get(rightPath) ?? 0);
    if (touchDifference !== 0) return touchDifference;
    const pathDifference = rightPath.localeCompare(leftPath);
    if (pathDifference !== 0) return pathDifference;
  }
  return 0;
}

function assignScoutTests(
  sourcePaths: readonly string[],
  testPaths: readonly string[],
  testLimit: number,
  touches: ReadonlyMap<string, number>,
): ScoutTestAssignment {
  const empty = Array<string | undefined>(sourcePaths.length).fill(undefined);
  let assignments = new Map<number, ScoutTestAssignment>([[0, empty]]);
  for (const testPath of [...testPaths].sort()) {
    const nextAssignments = new Map(assignments);
    for (const [mask, assignment] of assignments) {
      const assignedCount = assignment.filter(
        (path) => path !== undefined,
      ).length;
      if (assignedCount >= testLimit) continue;
      for (const [sourceIndex, sourcePath] of sourcePaths.entries()) {
        const sourceBit = 1 << sourceIndex;
        if (
          (mask & sourceBit) !== 0 ||
          scoutPathRelatedness(testPath, sourcePath) === 0
        ) {
          continue;
        }
        const candidate = [...assignment];
        candidate[sourceIndex] = testPath;
        const candidateMask = mask | sourceBit;
        const existing = nextAssignments.get(candidateMask);
        if (
          existing === undefined ||
          compareScoutTestAssignments(
            candidate,
            existing,
            sourcePaths,
            touches,
          ) > 0
        ) {
          nextAssignments.set(candidateMask, candidate);
        }
      }
    }
    assignments = nextAssignments;
  }
  let best: ScoutTestAssignment = empty;
  for (const assignment of assignments.values()) {
    if (
      compareScoutTestAssignments(
        assignment,
        best,
        sourcePaths,
        touches,
      ) > 0
    ) {
      best = assignment;
    }
  }
  return best;
}

export function selectScoutEvidence(
  trackedPaths: readonly string[],
  recentPaths: readonly string[],
  maxFiles: number,
): ScoutEvidenceSelection {
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
  const sourcePaths = rank(
    trackedPaths.filter((path) => sourceScoutPath.test(path)),
  ).slice(0, sourceLimit);
  const availableTestPaths = [...new Set(
    trackedPaths.filter((path) => testScoutPath.test(path)),
  )]
    .filter((path) => !isForbiddenPath(path));
  const testAssignments = assignScoutTests(
    sourcePaths,
    availableTestPaths,
    testLimit,
    touches,
  );
  const sourceTestPairs = testAssignments.flatMap((testPath, sourceIndex) =>
    testPath === undefined
      ? []
      : [{ sourcePath: sourcePaths[sourceIndex]!, testPath }],
  );
  const testPaths = sourceTestPairs.map((pair) => pair.testPath);
  const remainingTestPaths = new Set(availableTestPaths);
  for (const testPath of testPaths) remainingTestPaths.delete(testPath);
  testPaths.push(
    ...[...remainingTestPaths]
      .sort(
        (left, right) =>
          scoutTestRelatedness(right, sourcePaths) -
            scoutTestRelatedness(left, sourcePaths) ||
          (touches.get(right) ?? 0) - (touches.get(left) ?? 0) ||
          left.localeCompare(right),
      )
      .slice(0, testLimit - testPaths.length),
  );
  return {
    paths: [...sourcePaths, ...testPaths],
    sourceTestPairs,
  };
}

export function selectScoutEvidencePaths(
  trackedPaths: readonly string[],
  recentPaths: readonly string[],
  maxFiles: number,
): string[] {
  return [...selectScoutEvidence(trackedPaths, recentPaths, maxFiles).paths];
}

export function renderScoutEvidence(
  files: readonly ScoutEvidenceFile[],
  maxChars: number,
  prefix = "",
  pairs: readonly ScoutSourceTestPair[] = [],
): ScoutEvidencePacket {
  const paths = [...new Set(files.map((file) => file.path))].sort();
  const pathSet = new Set(paths);
  const sourceTestPairs = [...pairs].sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      left.testPath.localeCompare(right.testPath),
  );
  const pairedSources = new Set<string>();
  const pairedTests = new Set<string>();
  for (const pair of sourceTestPairs) {
    if (
      !pathSet.has(pair.sourcePath) ||
      !pathSet.has(pair.testPath) ||
      !sourceScoutPath.test(pair.sourcePath) ||
      !testScoutPath.test(pair.testPath)
    ) {
      throw new Error(
        `invalid scout source-test pair: ${pair.sourcePath} -> ${pair.testPath}`,
      );
    }
    if (
      pairedSources.has(pair.sourcePath) ||
      pairedTests.has(pair.testPath)
    ) {
      throw new Error(
        `duplicate scout source-test reservation: ${pair.sourcePath} -> ${pair.testPath}`,
      );
    }
    pairedSources.add(pair.sourcePath);
    pairedTests.add(pair.testPath);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const renderStates = paths.map((path) => {
    const file = byPath.get(path)!;
    const lines = file.content.split("\n");
    const hotspotIndexes = [
      ...new Set(
        (file.matchLines ?? [])
          .map((line) => line - 1)
          .filter((index) => index >= 0 && index < lines.length),
      ),
    ].sort((left, right) => left - right);
    const selectedIndexes = new Set(
      hotspotIndexes.length > 0 ? hotspotIndexes : [0],
    );
    const optionalIndexes: number[] = [];
    const queuedIndexes = new Set(hotspotIndexes);
    if (hotspotIndexes.length > 0) {
      for (
        let distance = 1;
        distance <= SCOUT_MATCH_CONTEXT_RADIUS;
        distance += 1
      ) {
        for (const hotspotIndex of hotspotIndexes) {
          for (const index of [
            hotspotIndex - distance,
            hotspotIndex + distance,
          ]) {
            if (
              index < 0 ||
              index >= lines.length ||
              queuedIndexes.has(index)
            ) {
              continue;
            }
            queuedIndexes.add(index);
            optionalIndexes.push(index);
          }
        }
      }
    } else {
      optionalIndexes.push(
        ...lines.map((_, index) => index).slice(1, 40),
      );
    }
    return {
      path,
      lines,
      selectedIndexes,
      optionalIndexes,
      nextOptionalIndex: 0,
    };
  });
  const pairSection =
    sourceTestPairs.length === 0
      ? ""
      : [
          "Reserved source-test pairs:",
          ...sourceTestPairs.map(
            (pair) => `${pair.sourcePath} -> ${pair.testPath}`,
          ),
        ].join("\n");
  const render = (): string => {
    const body = renderStates
      .map((state) => {
        const lines = [...state.selectedIndexes]
          .sort((left, right) => left - right)
          .map(
            (index) =>
              `${String(index + 1)} ${state.lines[index] ?? ""}`,
          );
        return [`File: ${state.path}`, ...lines].join("\n");
      })
      .filter((section) => section.length > 0)
      .join("\n\n");
    return [prefix, pairSection, body]
      .filter((section) => section.length > 0)
      .join("\n");
  };
  let text = render();
  if (text.length > maxChars) {
    throw new Error("scout required evidence exceeds character cap");
  }
  let addedLine = true;
  while (addedLine) {
    addedLine = false;
    for (const state of renderStates) {
      while (state.nextOptionalIndex < state.optionalIndexes.length) {
        const index = state.optionalIndexes[state.nextOptionalIndex]!;
        state.nextOptionalIndex += 1;
        state.selectedIndexes.add(index);
        const candidateText = render();
        if (candidateText.length <= maxChars) {
          text = candidateText;
          addedLine = true;
          break;
        }
        state.selectedIndexes.delete(index);
      }
    }
  }
  const renderedLineMarkers = renderStates.flatMap((state) =>
    [...state.selectedIndexes]
      .sort((left, right) => left - right)
      .map((index) => `${state.path}:${String(index + 1)}`),
  );
  return {
    paths,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    charCount: text.length,
    renderedLineMarkers,
    sourceTestPairs,
  };
}

export const CandidateControlSchema = z.object({
  candidateId: candidateIdSchema,
  brief: z.string().trim().min(1),
  testName: z.string().trim().min(1),
  productionPath: z.string().trim().min(1),
});

const StrictScoutCandidateSchema = ScoutCandidateBaseSchema.strict().superRefine(
  (value, context) => {
    for (const message of candidateContractIssues(value)) {
      context.addIssue({
        code: "custom",
        message,
      });
    }
  },
);
const CodexScopedScoutCandidateTransportSchema = ScoutCandidateBaseSchema.extend({
  estimatedActiveMs: z.number().int().positive(),
})
  .strict()
  .superRefine((value, context) => {
    for (const message of candidateContractIssues(value)) {
      context.addIssue({
        code: "custom",
        message,
      });
    }
  });
const StrictCandidateControlSchema = CandidateControlSchema.strict();
const ScopedScoutCandidateResultSchema = z
  .object({
    status: z.literal("candidate"),
    candidate: StrictScoutCandidateSchema,
    selectedControl: StrictCandidateControlSchema,
  })
  .strict();
const ScopedScoutNoCandidateResultSchema = z
  .object({
    status: z.literal("no_candidate"),
    reason: z.string().trim().min(1),
  })
  .strict();
export const ScopedScoutResultSchema = z
  .discriminatedUnion("status", [
    ScopedScoutCandidateResultSchema,
    ScopedScoutNoCandidateResultSchema,
  ])
  .superRefine((value, context) => {
    if (
      value.status === "candidate" &&
      value.selectedControl.candidateId !== value.candidate.id
    ) {
      context.addIssue({
        code: "custom",
        message: "selected control must target the scoped candidate",
      });
    }
  });

/**
 * Codex requires every object property in `--output-schema` to be required and
 * rejects a top-level JSON Schema `oneOf`. Keep a required nullable envelope
 * on the wire, then validate with {@link ScopedScoutResultSchema} locally.
 */
export const ScopedScoutTransportSchema = z
  .object({
    status: z.enum(["candidate", "no_candidate"]),
    candidate: CodexScopedScoutCandidateTransportSchema.nullable(),
    selectedControl: StrictCandidateControlSchema.nullable(),
    reason: z.string().trim().min(1).nullable(),
  })
  .strict();

export const ScoutResultSchema = z
  .object({
    candidates: z.array(ScoutCandidateSchema).min(1).max(3),
    rankedCandidateIds: z.array(z.string()).min(1).max(3),
    candidateControls: z.array(CandidateControlSchema).min(1).max(3),
    selectedControl: CandidateControlSchema,
  })
  .superRefine((value, context) => {
    const candidateIds = [...value.candidates.map((item) => item.id)].sort();
    const rankedIds = [...new Set(value.rankedCandidateIds)].sort();
    if (
      new Set(candidateIds).size !== value.candidates.length ||
      rankedIds.length !== value.rankedCandidateIds.length ||
      rankedIds.join("\n") !== candidateIds.join("\n")
    ) {
      context.addIssue({
        code: "custom",
        message: "rankedCandidateIds must be the candidate-ID permutation",
      });
    }
    if (value.candidateControls.length !== value.candidates.length) {
      context.addIssue({
        code: "custom",
        message: "candidateControls must have one control per candidate",
      });
    }
    if (
      new Set(value.candidateControls.map((control) => control.candidateId)).size !==
      value.candidateControls.length
    ) {
      context.addIssue({
        code: "custom",
        message: "candidateControls must have unique candidate IDs",
      });
    }
    if (
      value.candidateControls.some(
        (control, index) =>
          control.candidateId !== value.rankedCandidateIds[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "candidateControls must match ranked candidate order",
      });
    }
    if (value.selectedControl.candidateId !== value.rankedCandidateIds[0]) {
      context.addIssue({
        code: "custom",
        message: "selectedControl must target the rank-one candidate",
      });
    }
    const rankOneControl = value.candidateControls[0];
    if (
      rankOneControl !== undefined &&
      (rankOneControl.candidateId !== value.selectedControl.candidateId ||
        rankOneControl.brief !== value.selectedControl.brief ||
        rankOneControl.testName !== value.selectedControl.testName ||
        rankOneControl.productionPath !== value.selectedControl.productionPath)
    ) {
      context.addIssue({
        code: "custom",
        message: "selectedControl must equal the rank-one candidate control",
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
          message:
            "each ranked candidate must have an exclusive production path",
        });
      }
    }
  });
export type ScoutCandidate = z.infer<typeof ScoutCandidateSchema>;
export type ScoutResult = z.infer<typeof ScoutResultSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type CandidateControl = z.infer<typeof CandidateControlSchema>;
export type ScopedScoutResult = z.infer<typeof ScopedScoutResultSchema>;
export type ScopedScoutTransport = z.infer<typeof ScopedScoutTransportSchema>;

export function parseScopedScoutTransport(value: unknown): ScopedScoutResult {
  const parsed = ScopedScoutTransportSchema.parse(value);
  if (parsed.status === "candidate") {
    if (
      parsed.candidate === null ||
      parsed.selectedControl === null ||
      parsed.reason !== null
    ) {
      throw new Error(
        "candidate response requires candidate and selectedControl with null reason",
      );
    }
    return ScopedScoutResultSchema.parse({
      status: "candidate",
      candidate: parsed.candidate,
      selectedControl: parsed.selectedControl,
    });
  }
  if (
    parsed.candidate !== null ||
    parsed.selectedControl !== null ||
    parsed.reason === null
  ) {
    throw new Error(
      "no_candidate response requires null candidate and selectedControl with reason",
    );
  }
  return ScopedScoutResultSchema.parse({
    status: "no_candidate",
    reason: parsed.reason,
  });
}

export class NoSuitableScoutCandidateError extends Error {
  constructor() {
    super("no suitable scoped scout candidates");
    this.name = "NoSuitableScoutCandidateError";
  }
}

export function buildScoutResult(
  results: readonly {
    readonly scopeIndex: number;
    readonly result: Extract<
      ScopedScoutResult,
      { readonly status: "candidate" }
    >;
  }[],
): ScoutResult {
  const ordered = [...results].sort(
    (left, right) =>
      left.scopeIndex - right.scopeIndex ||
      left.result.candidate.id.localeCompare(right.result.candidate.id) ||
      left.result.candidate.testPath.localeCompare(right.result.candidate.testPath),
  );
  const candidateIds = new Set<string>();
  const controls = new Set<string>();
  const testPaths = new Set<string>();
  const accepted: typeof ordered = [];
  for (const record of ordered) {
    const { candidate, selectedControl } = record.result;
    const controlKey = JSON.stringify([
      selectedControl.candidateId,
      selectedControl.brief,
      selectedControl.testName,
      selectedControl.productionPath,
    ]);
    if (
      candidateIds.has(candidate.id) ||
      controls.has(controlKey) ||
      testPaths.has(candidate.testPath)
    ) {
      continue;
    }
    candidateIds.add(candidate.id);
    controls.add(controlKey);
    testPaths.add(candidate.testPath);
    accepted.push(record);
  }
  const ranked = accepted.slice(0, 3);
  if (ranked.length === 0) throw new NoSuitableScoutCandidateError();
  const candidates = ranked.map((record) => record.result.candidate);
  const candidateControls = ranked.map(
    (record) => record.result.selectedControl,
  );
  return ScoutResultSchema.parse({
    candidates,
    rankedCandidateIds: candidates.map((candidate) => candidate.id),
    candidateControls,
    selectedControl: candidateControls[0]!,
  });
}

export type RankedCandidateAttempt<T> =
  | { readonly status: "accepted"; readonly value: T }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly restore: () => Promise<void>;
    };

export interface RankedCandidateRejection {
  readonly candidateId: string;
  readonly reason: string;
}

export interface RankedCandidateFallbackResult<T> {
  readonly value: T;
  readonly rejections: readonly RankedCandidateRejection[];
}

export async function runRankedCandidateFallback<T>(
  candidateIds: readonly string[],
  attempt: (
    candidateId: string,
    rank: number,
  ) => Promise<RankedCandidateAttempt<T>>,
): Promise<RankedCandidateFallbackResult<T>> {
  const rejections: RankedCandidateRejection[] = [];
  for (const [rank, candidateId] of candidateIds.entries()) {
    const result = await attempt(candidateId, rank);
    if (result.status === "accepted") {
      return { value: result.value, rejections };
    }
    rejections.push({ candidateId, reason: result.reason });
    await result.restore();
  }
  throw new Error(
    `ranked candidates exhausted: ${rejections
      .map(({ candidateId, reason }) => `${candidateId}: ${reason}`)
      .join("; ")}`,
  );
}

export function hydrateCandidate(
  result: ScoutResult,
  control: CandidateControl,
): Candidate {
  const parsed = ScoutResultSchema.parse(result);
  const parsedControl = CandidateControlSchema.parse(control);
  if (!parsed.rankedCandidateIds.includes(parsedControl.candidateId)) {
    throw new Error(
      `control candidate ${parsedControl.candidateId} is not ranked`,
    );
  }
  const selected = parsed.candidates.find(
    (candidate) => candidate.id === parsedControl.candidateId,
  )!;
  const allowedProductionPaths = selected.allowedPaths.filter(
    (path) => path !== selected.testPath && !path.startsWith("tests/"),
  );
  if (!allowedProductionPaths.includes(parsedControl.productionPath)) {
    throw new Error(
      `control production path ${parsedControl.productionPath} is not an allowed production path for ${selected.id}`,
    );
  }
  return CandidateSchema.parse({
    ...selected,
    controlBrief: parsedControl.brief,
    controlTestName: parsedControl.testName,
    controlProductionPath: parsedControl.productionPath,
  });
}

export function controlTestName(candidate: Candidate): string {
  return candidate.controlTestName;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function namedTestArgs(testPath: string, testName: string): string[] {
  return [
    "test",
    testPath,
    "--test-name-pattern",
    `^${escapeRegularExpression(testName)}$`,
  ];
}

export function controlTestArgs(candidate: Candidate): string[] {
  return namedTestArgs(candidate.testPath, controlTestName(candidate));
}

const plainShellArgument = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function renderShellCommand(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args]
    .map((argument) =>
      plainShellArgument.test(argument)
        ? argument
        : `'${argument.replaceAll("'", "'\"'\"'")}'`,
    )
    .join(" ");
}

export function renderDirective(
  stage: string,
  directive: z.infer<typeof DirectiveSchema>,
): string {
  return [
    `Orcats stage: ${stage}.`,
    directive.skill === undefined
      ? undefined
      : `You MUST invoke $${directive.skill} before stage work.`,
    directive.prompt,
    "Work autonomously. Do not ask the operator questions.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

export function stageConfig(
  stage: string,
  directive: z.infer<typeof DirectiveSchema>,
  readOnly: boolean,
): BackendConfig {
  return {
    readOnly,
    sandbox: readOnly ? "read-only" : "workspace-write",
    selfManagedGit: false,
    systemPrompt: renderDirective(stage, directive),
  };
}

export function withSelectedModel(
  config: BackendConfig,
  model: string | undefined,
): BackendConfig {
  return {
    ...(model === undefined ? {} : { model }),
    ...config,
  };
}

export function validateCandidateForProfile(
  candidate: ScoutCandidate,
  profile: ComplexityProfile,
): string[] {
  const limits = profileLimits[profile];
  const issues: string[] = [];
  if (
    candidate.expectedMinutes < limits.minMinutes ||
    candidate.expectedMinutes > limits.maxMinutes
  ) {
    issues.push(`expected minutes outside ${profile} profile`);
  }
  if (candidate.allowedPaths.length > limits.maxPaths) {
    issues.push(`path count exceeds ${profile} profile`);
  }
  return issues;
}

export class CandidateRequiresSplitError extends Error {
  readonly reason: string;

  constructor(
    readonly candidateId: string,
    readonly estimatedActiveMs: number,
    readonly activeCapMs: number,
  ) {
    super(
      `candidate ${candidateId} requires split: estimated active cost ${String(estimatedActiveMs)}ms exceeds ${String(activeCapMs)}ms`,
    );
    this.name = "CandidateRequiresSplitError";
    this.reason = "candidate requires split before implementation";
  }
}

export function assertCandidateFitsActiveProfile(
  candidate: ScoutCandidate,
  profile: ComplexityProfile,
): void {
  const estimatedActiveMs =
    candidate.estimatedActiveMs ?? candidate.expectedMinutes * 60_000;
  const activeCapMs = profileLimits[profile].activeCapMs;
  if (estimatedActiveMs > activeCapMs) {
    throw new CandidateRequiresSplitError(
      candidate.id,
      estimatedActiveMs,
      activeCapMs,
    );
  }
}

export function chooseCandidate(
  result: ScoutResult,
): Candidate {
  const parsed = ScoutResultSchema.parse(result);
  return hydrateCandidate(parsed, parsed.selectedControl);
}

const citationTokenCharacter = /[\w./\\-]/;

function containsRenderedCitation(value: string, marker: string): boolean {
  for (
    let index = value.indexOf(marker);
    index >= 0;
    index = value.indexOf(marker, index + marker.length)
  ) {
    const previousCharacter = value[index - 1];
    const nextCharacter = value[index + marker.length];
    if (
      (previousCharacter === undefined ||
        !citationTokenCharacter.test(previousCharacter)) &&
      (nextCharacter === undefined || !citationTokenCharacter.test(nextCharacter))
    ) {
      return true;
    }
  }
  return false;
}

function citesRenderedMarker(
  citations: readonly string[],
  markers: readonly string[],
): boolean {
  return citations.some((citation) =>
    markers.some((marker) => containsRenderedCitation(citation, marker)),
  );
}

export function validateScopedScoutResult(
  result: ScopedScoutResult,
  pair: ScoutSourceTestPair,
  packet: ScoutEvidencePacket,
  profile: ComplexityProfile,
): string[] {
  const parsed = ScopedScoutResultSchema.safeParse(result);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `scoped scout result invalid: ${issue.message}`,
    );
  }

  const issues: string[] = [];
  const pairIsReserved = packet.sourceTestPairs.some(
    (reserved) =>
      reserved.sourcePath === pair.sourcePath &&
      reserved.testPath === pair.testPath,
  );
  if (!pairIsReserved) {
    issues.push("scoped scout pair must be reserved in the evidence packet");
  }

  if (parsed.data.status === "no_candidate") {
    const sourceMarkers = packet.renderedLineMarkers.filter((marker) =>
      marker.startsWith(`${pair.sourcePath}:`),
    );
    if (!citesRenderedMarker([parsed.data.reason], sourceMarkers)) {
      issues.push("no_candidate reason must cite a rendered source path line");
    }
    const testMarkers = packet.renderedLineMarkers.filter((marker) =>
      marker.startsWith(`${pair.testPath}:`),
    );
    if (!citesRenderedMarker([parsed.data.reason], testMarkers)) {
      issues.push("no_candidate reason must cite a rendered test path line");
    }
    return issues;
  }

  const { candidate, selectedControl } = parsed.data;
  const allowedPaths = new Set(candidate.allowedPaths);
  if (
    candidate.allowedPaths.length !== 2 ||
    allowedPaths.size !== 2 ||
    !allowedPaths.has(pair.sourcePath) ||
    !allowedPaths.has(pair.testPath)
  ) {
    issues.push("candidate allowed paths must equal the reserved source-test pair");
  }
  if (candidate.testPath !== pair.testPath) {
    issues.push("candidate test path must equal the reserved test path");
  }
  if (selectedControl.productionPath !== pair.sourcePath) {
    issues.push("control production path must equal the reserved source path");
  }
  issues.push(...validateCandidateEvidence(candidate, packet));
  issues.push(...validateCandidateForProfile(candidate, profile));
  return issues;
}

export function validateCandidateEvidence(
  candidate: ScoutCandidate,
  packet: ScoutEvidencePacket,
): string[] {
  const issues: string[] = [];
  const packetPaths = new Set(packet.paths);
  for (const path of candidate.allowedPaths) {
    if (!packetPaths.has(path)) {
      issues.push(`candidate path absent from evidence packet: ${path}`);
    }
  }
  const productionPaths = candidate.allowedPaths.filter(
    (path) => path !== candidate.testPath && !path.startsWith("tests/"),
  );
  if (
    !packet.sourceTestPairs.some(
      (pair) =>
        pair.testPath === candidate.testPath &&
        productionPaths.includes(pair.sourcePath),
    )
  ) {
    issues.push(
      `candidate target test must be reserved for an allowed production path: ${candidate.testPath}`,
    );
  }
  const renderedCitationMarkers = packet.renderedLineMarkers;
  const hasCitation = citesRenderedMarker(
    candidate.evidence,
    renderedCitationMarkers,
  );
  if (!hasCitation) {
    issues.push("candidate evidence must cite an evidence packet path and line");
  } else {
    const citedPaths = new Set(
      packet.paths.filter((path) =>
        citesRenderedMarker(
          candidate.evidence,
          renderedCitationMarkers.filter((marker) =>
            marker.startsWith(`${path}:`),
          ),
        ),
      ),
    );
    if (!citedPaths.has(candidate.testPath)) {
      issues.push(
        `candidate evidence must cite a rendered test path line: ${candidate.testPath}`,
      );
    }
    for (const path of productionPaths) {
      if (!citedPaths.has(path)) {
        issues.push(
          `candidate evidence must cite a rendered production path line: ${path}`,
        );
      }
    }
  }
  return issues;
}

export function validateChangedPaths(
  candidate: Candidate,
  changedPaths: readonly string[],
): string[] {
  const issues: string[] = [];
  const changed = new Set(changedPaths);
  const allowed = new Set(candidate.allowedPaths);
  if (changed.size < 2 || changed.size > allowed.size) {
    issues.push("changed path count violates candidate scope");
  }
  if (!changed.has(candidate.testPath)) {
    issues.push(`test path did not change: ${candidate.testPath}`);
  }
  if (
    ![...changed].some(
      (path) =>
        allowed.has(path) &&
        path !== candidate.testPath &&
        !path.startsWith("tests/"),
    )
  ) {
    issues.push("production path did not change");
  }
  for (const path of changed) {
    if (!allowed.has(path)) issues.push(`off-target path changed: ${path}`);
    if (isForbiddenPath(path)) {
      issues.push(`forbidden path changed: ${path}`);
    }
  }
  return issues;
}

export function assertImmutableTestDiff(
  before: string,
  after: string,
): void {
  if (before !== after) {
    throw new Error(
      "saved regression-test diff changed after red-state capture",
    );
  }
}

export interface RemoteCheck {
  readonly name: string;
  readonly workflow: string;
  readonly bucket: string;
}

export interface RemoteChecksCommandResult {
  readonly type: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const RemoteChecksSchema = z.array(
  z.object({
    name: z.string(),
    workflow: z.string(),
    bucket: z.string(),
  }),
);

const MergeProtectionSchema = z.object({
  required_status_checks: z.object({
    strict: z.literal(true),
    contexts: z.array(z.string()),
    checks: z
      .array(
        z.object({
          context: z.string(),
          app_id: z.number().int().nullable().optional(),
        }),
      )
      .optional(),
  }),
  enforce_admins: z.object({ enabled: z.literal(true) }),
});

export function assertRequiredMergeProtection(
  value: unknown,
  requiredCheck: string,
  requiredAppId: number,
): void {
  let protection: z.infer<typeof MergeProtectionSchema>;
  try {
    protection = MergeProtectionSchema.parse(value);
  } catch (error) {
    throw new Error(
      `merge protection must enforce strict status checks for administrators: ${normalizeFailure(error)}`,
    );
  }
  const requiredCheckIsPinned = (
    protection.required_status_checks.checks ?? []
  ).some(
    (check) =>
      check.context === requiredCheck && check.app_id === requiredAppId,
  );
  if (!requiredCheckIsPinned) {
    throw new Error(
      `merge protection must require ${requiredCheck} from GitHub Actions app ${String(requiredAppId)}`,
    );
  }
}

export function isRemoteChecksStartupPending(
  result: RemoteChecksCommandResult,
): boolean {
  const output = `${result.stderr}\n${result.stdout}`.trim();
  return (
    result.type !== "success" &&
    result.exitCode === 1 &&
    /^no checks reported on the '.+' branch$/u.test(output)
  );
}

export function parseRemoteChecksCommandResult(
  result: RemoteChecksCommandResult,
  rendered: string,
): RemoteCheck[] {
  if (isRemoteChecksStartupPending(result)) return [];
  if (result.type !== "success" && result.exitCode !== 8) {
    throw new Error(`${rendered} failed\n${result.stderr || result.stdout}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${rendered} returned invalid JSON: ${normalizeFailure(error)}`);
  }
  return RemoteChecksSchema.parse(parsed);
}

export function pullRequestCreateArgs(
  title: string,
  bodyFile: string,
  identity: PullRequestIdentity,
): string[] {
  return [
    "pr",
    "create",
    "--repo",
    identity.repository,
    "--title",
    title,
    "--body-file",
    bodyFile,
    "--head",
    identity.branch,
    "--base",
    "main",
  ];
}

export interface PullRequestIdentity {
  readonly repository: string;
  readonly branch: string;
  readonly headSha: string;
}

const DeliveryCommandLogSchema = z
  .object({
    command: z.string(),
    status: z.enum(["passed", "failed"]),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number(),
  })
  .strict();

export const ActiveDeliveryEvidenceSchema = z
  .object({
    profile: ComplexityProfileSchema,
    startedAtMs: z.number().int().nonnegative(),
    readyAtMs: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    activeDeadlineAtMs: z.number().int().positive(),
    verification: z.array(DeliveryCommandLogSchema),
  })
  .strict();

export const DeliveryAttemptSchema = z
  .object({
    startedAtMs: z.number().int().nonnegative(),
    finishedAtMs: z.number().int().nonnegative(),
    status: z.enum(["pending", "blocked", "delivered"]),
    pr: z
      .object({
        url: z.url(),
        baseRefName: z.literal("main"),
        headRefName: z.string().min(1),
        headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
        isDraft: z.boolean(),
      })
      .strict()
      .optional(),
    checks: z.array(DeliveryCommandLogSchema).optional(),
    merge: DeliveryCommandLogSchema.optional(),
  })
  .strict();

export const DeliveryStatusEvidenceSchema = z
  .object({
    status: z.enum(["pending", "blocked", "delivered"]),
    attempts: z.array(DeliveryAttemptSchema),
  })
  .strict();

export const DeliveryRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    prUrl: z.url(),
    branch: z.string().min(1),
    baseRefName: z.literal("main"),
    lockedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    active: ActiveDeliveryEvidenceSchema,
    delivery: DeliveryStatusEvidenceSchema,
  })
  .strict();

export type ActiveDeliveryEvidence = z.infer<typeof ActiveDeliveryEvidenceSchema>;
export type DeliveryStatusEvidence = z.infer<typeof DeliveryStatusEvidenceSchema>;
export type DeliveryRecordV1 = z.infer<typeof DeliveryRecordSchema>;

export interface PullRequestHeadState {
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly isDraft: boolean;
}

export function assertReadyPullRequestHead(
  actual: PullRequestHeadState,
  identity: PullRequestIdentity,
): void {
  const repository = identity.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^https://github\\.com/${repository}/pull/[1-9]\\d*$`).test(actual.url)) {
    throw new Error(
      `pull request URL ${actual.url} did not match repository ${identity.repository}`,
    );
  }
  if (actual.baseRefName !== "main") {
    throw new Error(
      `pull request base branch must be main, got ${actual.baseRefName}`,
    );
  }
  if (actual.isDraft) {
    throw new Error("pull request must be ready for review");
  }
  if (actual.headRefName !== identity.branch) {
    throw new Error(
      `pull request head branch must be ${identity.branch}, got ${actual.headRefName}`,
    );
  }
  if (actual.headRefOid !== identity.headSha) {
    throw new Error(
      `pull request head moved during checks: expected ${identity.headSha}, got ${actual.headRefOid}`,
    );
  }
}

export interface MergedPullRequestState extends PullRequestHeadState {
  readonly state: string;
}

export function assertMergedPullRequestState(
  actual: MergedPullRequestState,
  identity: PullRequestIdentity,
): void {
  assertReadyPullRequestHead(actual, identity);
  if (actual.state !== "MERGED") {
    throw new Error(`gh pr view state returned ${actual.state}`);
  }
}

export function remoteCheckState(
  checks: readonly RemoteCheck[],
): "pending" | "passed" | "failed" {
  if (
    checks.some(
      (check) =>
        check.bucket === "fail" ||
        check.bucket === "cancel" ||
        check.bucket === "skipping",
    )
  ) {
    return "failed";
  }
  const expected = checks.find(
    (check) => check.name === "Verify" && check.workflow === "CI",
  );
  if (expected === undefined || expected.bucket !== "pass") {
    return "pending";
  }
  return checks.every((check) => check.bucket === "pass")
    ? "passed"
    : "pending";
}

export interface PassedRemoteChecksEvidence<Log> {
  readonly checkedAt: string;
  readonly headSha: string;
  readonly state: "passed";
  readonly command: Log;
  readonly checks: RemoteCheck[];
}

export function buildPassedRemoteChecksEvidence<
  Log extends { readonly status: string },
>(
  checks: readonly RemoteCheck[],
  command: Log,
  headSha: string,
  checkedAt: string,
): PassedRemoteChecksEvidence<Log> {
  if (remoteCheckState(checks) !== "passed") {
    throw new Error("remote checks are not passed");
  }
  if (command.status !== "passed") {
    throw new Error("remote-check command did not pass");
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`remote-check head SHA is invalid: ${headSha}`);
  }
  if (Number.isNaN(Date.parse(checkedAt))) {
    throw new Error(`remote-check timestamp is invalid: ${checkedAt}`);
  }
  return {
    checkedAt,
    headSha,
    state: "passed",
    command,
    checks: checks.map((check) => ({ ...check })),
  };
}

export interface ActiveStageBudgetTracker<Name extends string> {
  activate(name: Name, nowMs: number): void;
  remaining(name: Name, limitMs: number, nowMs: number): number;
}

export function createActiveStageBudgetTracker<
  Name extends string,
>(): ActiveStageBudgetTracker<Name> {
  const elapsed = new Map<Name, number>();
  let activeName: Name | undefined;
  let activeSinceMs = 0;

  const settle = (nowMs: number): void => {
    if (activeName === undefined) return;
    elapsed.set(
      activeName,
      (elapsed.get(activeName) ?? 0) + Math.max(0, nowMs - activeSinceMs),
    );
  };

  return {
    activate(name, nowMs) {
      if (activeName === name) return;
      settle(nowMs);
      activeName = name;
      activeSinceMs = nowMs;
    },
    remaining(name, limitMs, nowMs) {
      const activeElapsed =
        activeName === name ? Math.max(0, nowMs - activeSinceMs) : 0;
      return Math.max(
        0,
        limitMs - (elapsed.get(name) ?? 0) - activeElapsed,
      );
    },
  };
}

export function stageBudgetMs(
  startedAtMs: number,
  deadlineMs: number,
  nowMs: number,
  stageLimitMs: number,
): number {
  return Math.max(
    0,
    Math.min(stageLimitMs, startedAtMs + deadlineMs - nowMs),
  );
}

export function normalizeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function mergeUsage(
  current: Usage | undefined,
  next: Usage | undefined,
): Usage | undefined {
  if (next === undefined) return current;
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    ...((current?.reasoning ?? next.reasoning) === undefined
      ? {}
      : {
          reasoning: (current?.reasoning ?? 0) + (next.reasoning ?? 0),
        }),
  };
}

export function requireRecordedUsage(usage: Usage | undefined): Usage {
  if (usage === undefined) {
    throw new Error("backend usage is required before delivery");
  }
  const counters = [
    usage.input,
    usage.output,
    ...(usage.reasoning === undefined ? [] : [usage.reasoning]),
  ];
  if (counters.some((counter) => !Number.isFinite(counter) || counter < 0)) {
    throw new Error(
      "backend usage counters must be finite non-negative numbers",
    );
  }
  if (!counters.some((counter) => counter > 0)) {
    throw new Error("backend usage must include at least one positive counter");
  }
  return usage;
}

export function requireImprovementBranch(
  runId: string,
  value: string | undefined,
): string {
  const branch = value?.trim() ?? "";
  if (branch === "") {
    throw new Error("ORCA_IMPROVEMENT_BRANCH is required");
  }
  const expected = `orca/improve-${runId}`;
  if (branch !== expected) {
    throw new Error(
      `ORCA_IMPROVEMENT_BRANCH ${branch} did not match ${expected}`,
    );
  }
  return branch;
}

export interface LauncherDeliveryIdentity {
  readonly branch: string;
  readonly repository: string;
  readonly originFetchUrl: string;
  readonly originPushUrl: string;
}

export function requireLauncherDeliveryIdentity(
  runId: string,
  values: {
    readonly branch?: string | undefined;
    readonly repository?: string | undefined;
    readonly originFetchUrl?: string | undefined;
    readonly originPushUrl?: string | undefined;
  },
): LauncherDeliveryIdentity {
  const branch = requireImprovementBranch(runId, values.branch);
  const required = (
    name: string,
    value: string | undefined,
  ): string => {
    const normalized = value?.trim() ?? "";
    if (normalized === "") throw new Error(`${name} is required`);
    return normalized;
  };
  const repository = required(
    "ORCA_IMPROVEMENT_REPOSITORY",
    values.repository,
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(
      `ORCA_IMPROVEMENT_REPOSITORY must be owner/name, got ${repository}`,
    );
  }
  return {
    branch,
    repository,
    originFetchUrl: required(
      "ORCA_IMPROVEMENT_ORIGIN_FETCH_URL",
      values.originFetchUrl,
    ),
    originPushUrl: required(
      "ORCA_IMPROVEMENT_ORIGIN_PUSH_URL",
      values.originPushUrl,
    ),
  };
}

export function assertCurrentBranch(
  value: string,
  expected: string,
): string {
  const actual = value.trim();
  if (actual !== expected) {
    throw new Error(
      `git branch ${actual} did not match launcher branch ${expected}`,
    );
  }
  return actual;
}

export interface ProvingRunIssueContext {
  readonly backend: string;
  readonly worktree: string;
  readonly branch: string;
  readonly monitorPath: string;
}

export type ResolvedIssueRecord<T> = Omit<
  T,
  | "at"
  | "evidence"
  | "status"
  | "provingRunId"
  | "prUrl"
  | keyof ProvingRunIssueContext
> & ProvingRunIssueContext & {
  readonly at: string;
  readonly evidence: string;
  readonly prUrl: string;
  readonly status: "resolved";
  readonly provingRunId: string;
};

export function resolveLatestOpenIssuesForProvingRun<
  T extends { readonly id: string; readonly status: string },
>(
  issues: readonly T[],
  provingRunId: string,
  mergedPrUrl: string,
  at: string,
  context: ProvingRunIssueContext,
): ResolvedIssueRecord<T>[] {
  const latestById = new Map<string, T>();
  for (const issue of issues) latestById.set(issue.id, issue);
  return [...latestById.values()]
    .filter((issue) => issue.status === "open")
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((prior) => ({
      ...prior,
      ...context,
      at,
      evidence: `Resolved by merged pull request ${mergedPrUrl}`,
      prUrl: mergedPrUrl,
      status: "resolved" as const,
      provingRunId,
    }));
}

export function resolveOpenIssueForProvingRun<
  T extends { readonly id: string; readonly status: string },
>(
  issues: readonly T[],
  issueId: string,
  provingRunId: string,
  mergedPrUrl: string,
  at: string,
  context: ProvingRunIssueContext,
): ResolvedIssueRecord<T> | undefined {
  return resolveLatestOpenIssuesForProvingRun(
    issues,
    provingRunId,
    mergedPrUrl,
    at,
    context,
  ).find((issue) => issue.id === issueId);
}
