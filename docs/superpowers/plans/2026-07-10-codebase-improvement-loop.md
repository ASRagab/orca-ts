# Codebase Improvement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and dogfood a staged Orcats workflow that selects one codebase
improvement, proves it red-to-green, reports progress, opens a pull request,
waits for checks, and squash-merges within its 10/30/45-minute profile ceiling.

**Architecture:** A shell launcher creates a fresh worktree from `origin/main`
and starts a self-executing Orcats workflow there. It rebuilds and PATH-pins the
source checkout's compiled binary, recording its HEAD, SHA-256, and version, so
a stale global install cannot change the runtime under proof. A pure TypeScript
module owns
directive validation, bounded scout-evidence selection, ranked candidate
selection, scope checks, deadlines, and remote-check classification. The
workflow owns deterministic evidence gathering, agent turns, gates, review,
monitoring, delivery, and issue evidence.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Orcats 0.2.3, Codex CLI,
GitHub CLI, Bun test.

## Global Constraints

- The proving workflow is Codex-only. An unset or empty `ORCA_BACKEND` defaults
  to `codex`; explicit `codex` is accepted, and every other value is rejected
  before monitor, preflight, filesystem, config, command, or backend side
  effects.
- Complexity defaults to simple; explicit medium/challenging ceilings are
  30/45 minutes and path limits are 6/10.
- Live launcher passes `--baseline=strict` in a fresh `origin/main` worktree.
- Every launcher mode builds and pins `dist/orcats` from a clean archive of the
  committed source HEAD; dirty source-worktree bytes and global Orcats
  installations are not eligible for the proof runtime.
- Stage directive: `{ skill?: string, prompt?: string }`; one field required.
- First run applies `$tdd` to reproduce/implement and an exact review prompt.
- One low-risk fix; simple/medium/challenging allow at most 3/6/10 paths; every
  profile requires one test plus a distinct production path.
- Exclude dependencies, lockfiles, releases, publishing, secrets, security,
  public APIs, workflow artifacts, and destructive Git operations.
- Red proof is valid only after the exact filtered positive control passes and
  the statically identified added RED test fails under its anchored exact-name
  selector with one marker-bound `(fail)` record and canonical Bun summary. One
  unchanged
  reproduce allocation covers all ranks, lazy controls, gates, evidence writes,
  exact restoration, pre/post rejected-artifact budget assertions, and a final
  post-RED-persistence budget assertion.
- The control and added RED assertion must resolve to the same exported
  production entrypoint through lexical symbol identity. Aliases preserve
  export identity; shadowing or untainted reassignment clears an outer origin,
  and a different export from the same allowed production file is invalid.
- Reproduction preserves every baseline test byte and adds exactly one raw
  contiguous top-level-test insertion. Any other byte change or inserted
  disabling directive token is invalid.
- The RED assertion ends in an allowlisted built-in Bun matcher. Only `not`,
  `resolves`, and `rejects` property modifiers may precede it; called modifiers
  and unknown terminal or intermediate properties are invalid.
- Fall back only for a typed invalid proof. Timeout markers, signal-killed
  commands with `exitCode: null`, backend, scope, persistence, budget, and
  restoration failures stop immediately.
- Targeted test and lint repair once; full `bun run verify` once.
- Merge requires `CI / Verify`, every reported check green, and head-SHA match.
- The exact post-creation `no checks reported` GitHub CLI result is pending;
  authentication, API, timeout, malformed-output, and other failures stay fatal.
- Launcher-to-merge ceilings are 600/1800/2700 seconds; simple stage
  allocations total 560 seconds and scale by 3/4.5 for larger profiles.
- A bounded command cannot succeed while any member of its process group
  remains. Residual members receive `TERM`, then `KILL`; a would-be zero status
  becomes `125` before evidence finalization.
- Scout keeps its 100-second allocation: at most 10 seconds gather stable
  evidence from at most four tracked source and four tracked test files, at
  most 80 seconds synthesize and rank without tools, and 10 seconds validate or
  fail closed. Synthesis uses at most two fresh 40-second conversations and
  retries only the first attempt's exact timeout cancellation.
- Scout evidence is capped at 10,000 characters and records paths, character
  count, SHA-256 digest, command logs, latest first-parent commit evidence,
  ranked candidate IDs, rejected attempts, and the accepted control.
- Gather commands are exactly `git status --porcelain=v1`,
  `git ls-files src tests`,
  `git log -40 --format= --name-only -- src tests`,
  `git show` with the latest-commit format, `--name-only`, `--first-parent`, and
  `HEAD`, one
  `rg -n --no-heading -m 8` scan over selected paths, and the repeated status.
- Core Orcats API, global Codex configuration, and model policy stay unchanged.
- `.orca/` stays ignored and never enters implementation commits.
- User-approved subagent adaptation: each ignored-artifact task uses a
  before/after snapshot diff, SHA-256 manifest, implementer report, and task
  review instead of a Git commit/review-package range.
- Main's pre-existing `package-lock.json` remains untouched.
- Launcher never removes worktrees or branches.

## File Map

| File | Responsibility |
|---|---|
| `.orca/workflows/codebase-improvement-lib.ts` | Pure schemas and policies. |
| `.orca/workflows/codebase-improvement-lib.test.ts` | Policy behavior tests. |
| `.orca/workflows/codebase-improvement.ts` | Staged Orcats workflow. |
| `.orca/workflows/codebase-improvement-contract.test.ts` | Flow safety contract. |
| `.orca/workflows/codebase-improvement.config.json` | Default directives. |
| `.orca/workflows/codebase-improvement.sh` | Worktree launcher. |
| `.orca/workflows/codebase-improvement-artifacts.test.ts` | Artifact tests. |
| `.orca/workflows/codebase-improvement.run.md` | Runbook. |
| `.orca/improvement-loop/issues.jsonl` | Issue and correction ledger. |
| `.orca/improvement-loop/runs/$ORCA_IMPROVEMENT_RUN_ID/` | Collected run evidence. |
| `.orca/improvement-loop/latest.json` | Paths and identifiers for latest run. |

The tracked plan/design stay on `meta/codebase-improvement-loop`. The selected
improvement is committed only on generated
`orca/improve-$ORCA_IMPROVEMENT_RUN_ID`.

---

### Task 1: Pure Directive and Candidate Policies

**Files:**

- Create: `.orca/workflows/codebase-improvement-lib.test.ts`
- Create: `.orca/workflows/codebase-improvement-lib.ts`

**Interfaces:**

- Produces: `WorkflowConfigSchema`, `ScoutResultSchema`, `Candidate`,
  `ComplexityProfile`, `profileLimits`, `stageConfig`, `renderDirective`,
  `chooseCandidate`, `hydrateCandidate`, `runRankedCandidateFallback`,
  `validateCandidateForProfile`, `validateChangedPaths`, `controlTestName`,
  `controlTestArgs`, `assertImmutableTestDiff`, `remoteCheckState`,
  `stageBudgetMs`, `withSelectedModel`, `mergeUsage`, `assertCurrentBranch`,
  `resolveOpenIssueForProvingRun`, and `normalizeFailure`.
- Consumes: `z` and `BackendConfig` from `@twelvehart/orcats`.

Correction 3 later extends `ScoutResultSchema` with `rankedCandidateIds`, adds
the evidence helpers, and changes `chooseCandidate` to consume the validated
ranking. Its exact RED/GREEN steps supersede the original selection snippet
below without changing the completed Task 1 baseline evidence.

Correction 7 later introduced a packet-grounded positive control. Correction 8
superseded its all-candidate shape: the scout returns three control-free seeds,
an exact ranking, and one `selectedControl` bound to rank one. Correction 13
adds bounded ranked fallback: rank one is hydrated first, later controls are
generated lazily, and the candidate is selected only after genuine RED. The
Codex scout request alone uses low reasoning effort. The filtered command
remains `test <testPath> --test-name-pattern ^control <candidate.id>$`.

- [ ] **Step 1: Write failing policy tests**

Create tests for these exact behaviors:

```typescript
import { describe, expect, test } from "bun:test";
import {
  CandidateSchema,
  chooseCandidate,
  profileLimits,
  remoteCheckState,
  renderDirective,
  stageConfig,
  stageBudgetMs,
  validateCandidateForProfile,
  validateChangedPaths,
} from "./codebase-improvement-lib.ts";

const candidate = {
  id: "timeout-message",
  title: "fix: preserve timeout diagnostics",
  problem: "Timed-out commands lose their final diagnostic line.",
  evidence: ["src/tools/process.ts drops buffered timeout output"],
  allowedPaths: ["src/tools/process.ts", "tests/tools.test.ts"],
  testPath: "tests/tools.test.ts",
  targetedTestArgs: ["test", "tests/tools.test.ts"],
  expectedFailurePattern: "last diagnostic",
  controlBrief:
    "A normal timed-out command preserves its final diagnostic through the same formatter.",
  implementationBrief: "Preserve buffered stderr when timeout fires.",
  expectedMinutes: 6,
  risk: "low" as const,
};

describe("CandidateSchema", () => {
  test("requires test and production paths", () => {
    expect(CandidateSchema.parse(candidate)).toEqual(candidate);
    expect(
      CandidateSchema.safeParse({
        ...candidate,
        allowedPaths: ["tests/tools.test.ts", "tests/other.test.ts"],
      }).success,
    ).toBe(false);
  });

  test("rejects forbidden paths", () => {
    for (const path of ["bun.lock", ".github/workflows/ci.yml"]) {
      expect(
        CandidateSchema.safeParse({
          ...candidate,
          allowedPaths: [path, "tests/tools.test.ts"],
        }).success,
      ).toBe(false);
    }
  });
});

test("selection is deterministic", () => {
  expect(
    chooseCandidate([
      { ...candidate, id: "b", expectedMinutes: 7 },
      { ...candidate, id: "a", expectedMinutes: 6 },
      {
        ...candidate,
        id: "c",
        expectedMinutes: 6,
        allowedPaths: ["src/tools/process.ts", "src/tools/terminal.ts", "tests/tools.test.ts"],
      },
    ]).id,
  ).toBe("a");
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

test("profiles enforce time and path limits", () => {
  expect(validateCandidateForProfile(candidate, "simple")).toEqual([]);
  const medium = {
    ...candidate,
    expectedMinutes: 25,
    allowedPaths: [
      "src/tools/process.ts",
      "src/tools/terminal.ts",
      "src/tools/fs.ts",
      "tests/tools.test.ts",
    ],
  };
  expect(validateCandidateForProfile(medium, "medium")).toEqual([]);
  expect(validateCandidateForProfile(medium, "simple").length).toBeGreaterThan(0);
});

test("scope rejects missing test and off-target paths", () => {
  expect(validateChangedPaths(candidate, ["src/tools/process.ts", "tests/tools.test.ts"])).toEqual([]);
  expect(validateChangedPaths(candidate, ["src/tools/process.ts"]).join(" ")).toContain("test path");
  expect(validateChangedPaths(candidate, ["src/tools/process.ts", "README.md"]).join(" ")).toContain(
    "off-target",
  );
});

describe("remote checks", () => {
  test("empty and missing expected checks stay pending", () => {
    expect(remoteCheckState([])).toBe("pending");
    expect(remoteCheckState([{ name: "GitGuardian", workflow: "", bucket: "pass" }])).toBe("pending");
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
});

test("stage budget respects global deadline", () => {
  expect(stageBudgetMs(1_000, 600_000, 1_100, 70_000)).toBe(70_000);
  expect(stageBudgetMs(1_000, 100_000, 90_000, 70_000)).toBe(11_000);
  expect(profileLimits.simple.deadlineMs).toBe(600_000);
  expect(profileLimits.medium.deadlineMs).toBe(1_800_000);
  expect(profileLimits.challenging.deadlineMs).toBe(2_700_000);
  expect(profileLimits.simple.maxPaths).toBe(3);
  expect(profileLimits.medium.maxPaths).toBe(6);
  expect(profileLimits.challenging.maxPaths).toBe(10);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts
```

Expected: FAIL because the library does not exist.

- [ ] **Step 3: Implement minimal policies**

Implement Zod schemas with these invariants:

```typescript
import { z, type BackendConfig } from "@twelvehart/orcats";

const forbiddenPath = /^(?:\.env(?:\.|$)|\.github\/workflows\/|package\.json$|bun\.lock$|package-lock\.json$|skills\/|docs\/release\.md$|\.orca\/)/;

export const DirectiveSchema = z
  .object({
    skill: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.skill !== undefined || value.prompt !== undefined);

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

export const ComplexityProfileSchema = z.enum(["simple", "medium", "challenging"]);
export type ComplexityProfile = z.infer<typeof ComplexityProfileSchema>;
export const profileLimits = {
  simple: { minMinutes: 5, maxMinutes: 10, maxPaths: 3, deadlineMs: 600_000 },
  medium: { minMinutes: 20, maxMinutes: 30, maxPaths: 6, deadlineMs: 1_800_000 },
  challenging: { minMinutes: 30, maxMinutes: 45, maxPaths: 10, deadlineMs: 2_700_000 },
} as const;

export const CandidateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().trim().regex(/^(?:fix|feat|docs|test|refactor|perf|chore)(?:\([^)]+\))?: .+/),
    problem: z.string().trim().min(1),
    evidence: z.array(z.string().trim().min(1)).min(1),
    allowedPaths: z.array(z.string().trim().min(1)).min(2).max(10),
    testPath: z.string().trim().min(1),
    targetedTestArgs: z.array(z.string()).min(2),
    expectedFailurePattern: z.string().trim().min(1),
    controlBrief: z.string().trim().min(1),
    implementationBrief: z.string().trim().min(1),
    expectedMinutes: z.number().int().min(5).max(45),
    risk: z.literal("low"),
  })
  .superRefine((value, context) => {
    const paths = new Set(value.allowedPaths);
    if (!paths.has(value.testPath)) context.addIssue({ code: "custom", message: "test path must be allowed" });
    if (!value.allowedPaths.some((path) => path !== value.testPath && !path.startsWith("tests/"))) {
      context.addIssue({ code: "custom", message: "production path required" });
    }
    if (value.targetedTestArgs[0] !== "test") {
      context.addIssue({ code: "custom", message: "targeted command must be bun test" });
    }
    for (const path of value.allowedPaths) {
      if (path.startsWith("/") || path.includes("..") || forbiddenPath.test(path)) {
        context.addIssue({ code: "custom", message: `forbidden path: ${path}` });
      }
    }
  });

export const ScoutResultSchema = z.object({
  candidates: z.array(CandidateSchema).length(3),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export function controlTestName(candidate: Candidate): string {
  return `control ${candidate.id}`;
}

export function controlTestArgs(candidate: Candidate): string[] {
  return [
    "test",
    candidate.testPath,
    "--test-name-pattern",
    `^${controlTestName(candidate)}$`,
  ];
}

export function renderDirective(stage: string, directive: z.infer<typeof DirectiveSchema>): string {
  return [
    `Orcats stage: ${stage}.`,
    directive.skill === undefined ? undefined : `You MUST invoke $${directive.skill} before stage work.`,
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
    selfManagedGit: false,
    systemPrompt: renderDirective(stage, directive),
  };
}

export function validateCandidateForProfile(
  candidate: Candidate,
  profile: ComplexityProfile,
): string[] {
  const limits = profileLimits[profile];
  const issues: string[] = [];
  if (candidate.expectedMinutes < limits.minMinutes || candidate.expectedMinutes > limits.maxMinutes) {
    issues.push(`expected minutes outside ${profile} profile`);
  }
  if (candidate.allowedPaths.length > limits.maxPaths) {
    issues.push(`path count exceeds ${profile} profile`);
  }
  return issues;
}

export function chooseCandidate(candidates: readonly Candidate[]): Candidate {
  const parsed = z.array(CandidateSchema).min(1).parse(candidates);
  return [...parsed].sort(
    (left, right) =>
      left.expectedMinutes - right.expectedMinutes ||
      left.allowedPaths.length - right.allowedPaths.length ||
      left.id.localeCompare(right.id),
  )[0]!;
}

export function validateChangedPaths(candidate: Candidate, changedPaths: readonly string[]): string[] {
  const issues: string[] = [];
  const changed = new Set(changedPaths);
  const allowed = new Set(candidate.allowedPaths);
  if (changed.size < 2 || changed.size > allowed.size) issues.push("changed path count violates candidate scope");
  if (!changed.has(candidate.testPath)) issues.push(`test path did not change: ${candidate.testPath}`);
  for (const path of changed) {
    if (!allowed.has(path)) issues.push(`off-target path changed: ${path}`);
    if (forbiddenPath.test(path)) issues.push(`forbidden path changed: ${path}`);
  }
  return issues;
}

export function assertImmutableTestDiff(before: string, after: string): void {
  if (before !== after) throw new Error("saved regression-test diff changed after red-state capture");
}

export interface RemoteCheck {
  readonly name: string;
  readonly workflow: string;
  readonly bucket: string;
}

export function remoteCheckState(checks: readonly RemoteCheck[]): "pending" | "passed" | "failed" {
  if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) return "failed";
  const expected = checks.find((check) => check.name === "Verify" && check.workflow === "CI");
  if (expected === undefined || expected.bucket !== "pass") return "pending";
  return checks.every((check) => check.bucket === "pass" || check.bucket === "skipping")
    ? "passed"
    : "pending";
}

export function stageBudgetMs(
  startedAtMs: number,
  deadlineMs: number,
  nowMs: number,
  stageLimitMs: number,
): number {
  return Math.max(0, Math.min(stageLimitMs, startedAtMs + deadlineMs - nowMs));
}

export function normalizeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
```

- [ ] **Step 4: Verify GREEN**

Run the focused test again. Expected: all tests PASS.

- [ ] **Step 5: Record hashes, not commits**

Run `shasum -a 256` on both Task 1 files. Do not stage ignored artifacts.

---

### Task 2: Staged Workflow

**Files:**

- Create: `.orca/workflows/codebase-improvement-contract.test.ts`
- Create: `.orca/workflows/codebase-improvement.ts`

**Interfaces:**

- Consumes Task 1 plus Orcats `flow`, `flowArgs`, `llm`, `command`, `fs`,
  `gh`, `fixLoop`, `runBaselineGate`, `selectBackend`, `WorkflowMonitor`, `ok`.
- Imports Orcats types `BackendTag`, `Conversation`, `Outcome`, `CommandLog`,
  `FixLoopStop`, `RegressedReason`, and `Usage` from the package root.
- Produces plan, red diff, monitor, run report, ledger entries, commit, PR, merge.

- [ ] **Step 1: Write failing flow contract test**

Create `.orca/workflows/codebase-improvement-contract.test.ts`:

```typescript
import { expect, test } from "bun:test";

const path = ".orca/workflows/codebase-improvement.ts";

test("workflow carries required lifecycle and safety controls", async () => {
  expect(await Bun.file(path).exists()).toBe(true);
  const source = await Bun.file(path).text();
  expect(source.match(/await flow\(flowArgs\(\)\)/g)?.length).toBe(1);
  for (const required of [
    'from "@twelvehart/orcats"',
    "resolveBaselinePolicy",
    "runBaselineGate",
    "WorkflowMonitor",
    "selected.shutdown?.()",
    "stageConfig(",
    "appliedSystemPrompts",
    'monitor.stage("preflight"',
    'monitor.stage("scout"',
    'monitor.stage("reproduce"',
    'monitor.stage("red-gate"',
    'monitor.stage("select-plan"',
    'monitor.stage("implement"',
    'monitor.stage("targeted-repair"',
    'monitor.stage("review"',
    'monitor.stage("review-repair"',
    'monitor.stage("verify"',
    'monitor.stage("commit-push"',
    'monitor.stage("pull-request"',
    'monitor.stage("remote-checks"',
    'monitor.stage("merge"',
  ]) {
    expect(source).toContain(required);
  }
  for (const forbidden of [
    'from "neverthrow"',
    "process.argv",
    "implementTaskLoop",
    "runReviewAndFixLoop",
    "executeLoop",
    "reset --hard",
    "clean -fd",
    "force-push",
  ]) {
    expect(source).not.toContain(forbidden);
  }
});
```

- [ ] **Step 2: Verify RED**

Run `bun test .orca/workflows/codebase-improvement-contract.test.ts`.
Expected: FAIL because workflow file does not exist.

- [ ] **Step 3: Implement constants and bounded helpers**

Start from the compiling issue-to-PR template rather than a blank file:

```bash
cp skills/orcats-author/assets/templates/issue-to-pr.ts \
  .orca/workflows/codebase-improvement.ts
```

Replace every template slot and the top-level body; retain its baseline,
outcome-detail, explicit-staging, PR-body-file, and `finally` shutdown patterns.
Use exact gates and paths:

```typescript
const BASELINE_GATE = [
  { command: "bun", args: ["test"], timeoutMs: 30_000 },
  { command: "bun", args: ["run", "lint"], timeoutMs: 30_000 },
] as const;
const FULL_GATE = { command: "bun", args: ["run", "verify"], timeoutMs: 75_000 } as const;
const CONFIG_PATH = ".orca/workflows/codebase-improvement.config.json";
const PLAN_PATH = ".orca/improvement-loop/plan.json";
const RED_DIFF_PATH = ".orca/improvement-loop/red-test.diff";
const ISSUE_PATH = ".orca/improvement-loop/issues.jsonl";
const REPORT_DIR = ".orca/improvement-loop/runs";
const SIMPLE_STAGE_LIMITS = {
  preflight: 35_000,
  scout: 100_000,
  reproduce: 65_000,
  implement: 100_000,
  repairs: 65_000,
  review: 65_000,
  verify: 40_000,
  delivery: 90_000,
} as const;
const SCOUT_GATHER_LIMIT_MS = 10_000;
const SCOUT_MODEL_LIMIT_MS = 80_000;
const SCOUT_ATTEMPT_LIMIT_MS = 40_000;
const SCOUT_VALIDATION_LIMIT_MS = 10_000;
const SCOUT_EVIDENCE_MAX_FILES = 8;
const SCOUT_EVIDENCE_MAX_CHARS = 10_000;
const PROFILE_SCALE = { simple: 1, medium: 3, challenging: 4.5 } as const;

interface RejectedCandidateEvidence {
  candidate: Candidate;
  control: ScoutResult["selectedControl"];
  reason: string;
  redDiff: string;
  validation: CommandLog[];
  snapshotSha256: string;
  rank: number;
  artifactPath: string;
  baselineStatus: string;
  baselineDiff: string;
  restoration?: ExactRestorationEvidence;
}

interface RunReport {
  runId: string;
  profile: ComplexityProfile;
  startedAtMs: number;
  finishedAtMs?: number;
  elapsedMs?: number;
  backend: string;
  stage: string;
  baseSha: string;
  worktree: string;
  branch: string;
  appliedSystemPrompts: Partial<Record<"scout" | "reproduce" | "implement" | "repair" | "review", string>>;
  candidate?: Candidate;
  scoutEvidence?: {
    paths: string[];
    charCount: number;
    sha256: string;
    attempts: TimeoutRetryRecord[];
    candidates?: ScoutResult["candidates"];
    ranking?: string[];
    selectedControl?: ScoutResult["selectedControl"];
    acceptedControl?: ScoutResult["selectedControl"];
    latestCommit?: string;
    commands: CommandLog[];
  };
  redDiffPath?: string;
  rejectedCandidates: RejectedCandidateEvidence[];
  validation: CommandLog[];
  prUrl?: string;
  matchedHeadSha?: string;
  merged: boolean;
  sla: "pending" | "passed" | "failed";
  stopReason?: string;
  initialReviewFindings?: ReviewFinding[];
  finalReviewFindings?: ReviewFinding[];
  finalReviewBlockerCount?: number;
  usage?: Usage;
}

interface RunIssue {
  id: string;
  runId: string;
  at: string;
  classification: "environment" | "baseline" | "backend" | "gate" | "review" | "scope" | "remote-check" | "merge" | "sla-overrun";
  stage: string;
  elapsedMs: number;
  evidence: string;
  status: "open" | "corrected" | "resolved";
  provingRunId?: string;
}
```

The following original helper sketch is historical. Correction 18's
absolute-completion contract below supersedes its callback-timing behavior.

Bound every conversation with the tested runtime helper:

```typescript
interface BoundedConversation<T> {
  awaitResult(): Promise<T>;
  cancel(reason?: string): Promise<void>;
}

async function awaitBounded<T>(
  conversation: BoundedConversation<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`sla-overrun before ${stage}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellationFailure = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void conversation
        .cancel(`${stage} exceeded ${String(timeoutMs)}ms`)
        .catch(reject);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      conversation.awaitResult(),
      cancellationFailure,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runRequired(
  commandName: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandLog> {
  const result = await command().run({ command: commandName, args, timeoutMs });
  const log: CommandLog = {
    command: [commandName, ...args].join(" "),
    status: result.type === "success" ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
  if (result.type !== "success") {
    throw new Error(`${log.command} failed\n${result.stderr || result.stdout}`);
  }
  return log;
}
```

Implement these signatures unchanged:

```typescript
async function readConfig(): Promise<WorkflowConfig>;
async function writeJson(path: string, value: unknown): Promise<void>;
async function appendIssue(issue: RunIssue): Promise<void>;
async function changedPaths(remaining: () => number): Promise<string[]>;
async function pathDiff(path: string, remaining: () => number): Promise<string>;
async function assertTrackedPaths(paths: readonly string[], timeoutMs: number): Promise<void>;
function describeOutcome(outcome: Outcome): string;
async function readRemoteChecks(prUrl: string): Promise<{ readonly checks: RemoteCheck[]; readonly log: CommandLog }>;
async function confirmMerged(prUrl: string): Promise<void>;
```

`readConfig` parses `WorkflowConfigSchema`. `writeJson` and `appendIssue` use
`fs()` results and preserve existing JSONL. Git helpers use argument arrays.
`readRemoteChecks` parses `gh pr checks --json name,workflow,bucket`. The exact
exit-1 `no checks reported` startup result becomes an empty pending rollup;
other failures still throw.
`confirmMerged` requires `gh pr view --json state` to equal `MERGED`. Every
failure message contains its command or file path; `describeOutcome` includes
backend error or reason.

- [ ] **Step 4: Implement exact lifecycle**

Inside exactly one `await flow(flowArgs())(async () => {})`:

```typescript
const scoutConfig = {
  ...stageConfig("scout", config.stages.scout, true),
  reasoningEffort: "low" as const,
};
report.appliedSystemPrompts.scout = scoutConfig.systemPrompt ?? "";

const reproduceConfig = stageConfig("reproduce", config.stages.reproduce, false);
report.appliedSystemPrompts.reproduce = reproduceConfig.systemPrompt ?? "";

const implementConfig = stageConfig("implement", config.stages.implement, false);
report.appliedSystemPrompts.implement = implementConfig.systemPrompt ?? "";

const reviewConfig = stageConfig("review", config.stages.review, true);
report.appliedSystemPrompts.review = reviewConfig.systemPrompt ?? "";
```

Pass each named config to its matching `llm().autonomous` call. Record before
awaiting so a timeout still proves which request configuration was applied.

1. Reject a non-empty `ORCA_BACKEND` other than `codex` before creating the
   monitor or performing any config, filesystem, command, or backend work. Then
   resolve baseline and `--complexity=$profile` args, select default Codex, read
   launcher run ID/time, select `profileLimits[profile]`, multiply each simple
   stage limit by `PROFILE_SCALE[profile]`, and start the monitor.
2. `preflight`: baseline gate, Codex/GitHub auth, HEAD equals `origin/main`.
3. `scout`: run the exact global-constraint commands, deterministically choose
   at most four source and four test files, render a stable 10,000-character
   evidence packet including the latest first-parent commit subject and paths,
   record paths/count/SHA-256/command logs, and verify the worktree did not
   change. Give only that packet to a tool-free structured
   synthesis phase with at most 80 seconds total and at most two fresh
   40-second conversations. Retry only when the first attempt ends in its exact
   timeout cancellation. Persist every attempt record. Reject tool events as a
   no-tool failure, invalid or incomplete `rankedCandidateIds`, uncited
   evidence, off-packet paths, and profile/path violations. Require one
   `selectedControl` whose ID equals rank one. Persist all three seeds, ranking,
   and selected control in report provenance.
4. `reproduce`: attempt IDs in rank order under one shared budget. Rank one
   uses `selectedControl`; resolve later controls lazily in a tool-free turn
   bounded by 10 seconds and remaining reproduce time. Before each attempt,
   capture raw test bytes, SHA-256, exact Git status, and complete binary diff.
   Apply `$tdd`, permit only the test path, and mark an edit applied only after
   its successful matching normalized file-change result. Continue draining
   events and always await terminal outcome so later backend failure and usage
   remain visible. Off-target changes request cancellation and fail only after
   terminal settlement; started, failed, or unmatched results never prove an
   applied edit. Classify normalized evidence as none, unconfirmed, or applied.
   The reusable event guard retains terminal-only behavior: none plus exactly
   one expected Git path and a non-empty diff proves the edit; unconfirmed
   evidence rejects the attempt. This does not make a non-Codex backend
   selectable for the proving workflow.
5. For each attempted rank, add a top-level passing test named exactly
   `control <candidate.id>` plus the target regression. The child and parent
   both run the exact control then target commands. Fall back only for a typed
   invalid proof: failed, skipped, or miscounted control; passing target; wrong
   pattern; no net change; or empty diff. A timeout marker or null exit code is
   operational and stops the run.
6. On typed rejection, persist candidate-local proof and baseline evidence,
   restore raw bytes, then require snapshot SHA-256, exact status, and complete
   binary diff equality before the next rank. Every operation remains on the
   shared budget. Assert a positive remainder immediately before and after each
   rejected-artifact write. On valid RED, save the immutable diff and recheck
   the budget after persistence before accepting.
7. `select-plan`: only after acceptance, persist seeds, ranking, original and
   accepted controls, rejected attempts, and the hydrated selected candidate.
8. `implement`: apply `$tdd`, permit production paths, freeze test diff.
9. `targeted-repair`: targeted test plus lint through one-fix `fixLoop`.
10. `review`: exact review prompt and structured blockers.
11. `review-repair`: one repair and repeated review when blockers exist.
12. `verify`: require persisted zero final blockers, full gate, immutable test,
    and profile path scope.
13. `commit-push`: stage only validated paths, commit, capture local HEAD, push.
14. `pull-request`: write body file, create ready PR, require its head to match
    the immutable locally captured SHA, and store the URL.
15. `remote-checks`: poll five seconds; require `CI / Verify`; treat the exact
    post-creation `no checks reported` result as pending, never as an empty pass.
16. `merge`: squash with the same local SHA and confirm `MERGED`.
17. Resolve prior timeout issue only after merge and SLA success.

Catch appends classified issue and rethrows. Finally writes monitor/report,
prints evidence paths, and calls `selected.shutdown?.()`.

- [ ] **Step 5: Verify GREEN and typecheck**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
```

Expected: tests PASS and typecheck reports `OK`.

- [ ] **Step 6: Record hashes, not commits**

Hash workflow and contract test. Confirm `git status` omits `.orca/`.

---

### Task 3: Config, Launcher, Runbook, and Seed Issue

**Files:**

- Create: `.orca/workflows/codebase-improvement-artifacts.test.ts`
- Create: `.orca/workflows/codebase-improvement.config.json`
- Create: `.orca/workflows/codebase-improvement.sh`
- Create: `.orca/workflows/codebase-improvement.run.md`
- Create: `.orca/improvement-loop/issues.jsonl`

**Interfaces:**

- Consumes Task 1 config schema and Task 2 workflow.
- Produces preflight-only mode, live runner, centralized evidence, default
  directives, exact runbook, and prior timeout issue.

- [ ] **Step 1: Write failing artifact tests**

Create `.orca/workflows/codebase-improvement-artifacts.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { WorkflowConfigSchema } from "./codebase-improvement-lib.ts";

test("default config proves skill and prompt directives", async () => {
  const config = WorkflowConfigSchema.parse(
    await Bun.file(".orca/workflows/codebase-improvement.config.json").json(),
  );
  expect(config.stages.reproduce.skill).toBe("tdd");
  expect(config.stages.implement.skill).toBe("tdd");
  expect(config.stages.review.prompt).toContain("concrete correctness");
});

test("launcher exposes isolated strict-baseline modes", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  for (const required of [
    "--preflight-only",
    "--complexity=simple",
    "worktree add",
    "origin/main",
    "--baseline=strict",
  ]) {
    expect(source).toContain(required);
  }
  for (const forbidden of ["worktree remove", "branch -D", "reset --hard", "clean -fd"]) {
    expect(source).not.toContain(forbidden);
  }
});

test("runbook names exact gates and merge proof", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.run.md").text();
  for (const required of [
    "bun test",
    "bun run lint",
    "bun run verify",
    "CI / Verify",
    "10 minutes",
    "30 minutes",
    "45 minutes",
  ]) {
    expect(source).toContain(required);
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-artifacts.test.ts
```

Expected: FAIL because config, launcher, and runbook do not exist.

- [ ] **Step 3: Write default directives**

Create exact config:

```json
{
  "stages": {
    "scout": {
      "prompt": "Prefer a low-risk behavioral defect with a focused regression test and direct source evidence."
    },
    "reproduce": {
      "skill": "tdd",
      "prompt": "Add only the failing regression test. Do not change production code."
    },
    "implement": {
      "skill": "tdd",
      "prompt": "Fix the root cause without changing or weakening the captured regression test."
    },
    "repair": {
      "skill": "debug-like-expert",
      "prompt": "Diagnose the observed failure before editing and keep the regression test immutable."
    },
    "review": {
      "prompt": "Report only concrete correctness, regression, safety, or test-quality blockers with direct diff evidence."
    }
  }
}
```

- [ ] **Step 4: Implement launcher**

Create `.orca/workflows/codebase-improvement.sh` from this implementation:

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source_root=$(git -C "$script_dir/../.." rev-parse --show-toplevel)
mode=live
complexity=simple

for arg in "$@"; do
  case "$arg" in
    --preflight-only) mode=preflight ;;
    --complexity=simple) complexity=simple ;;
    --complexity=medium) complexity=medium ;;
    --complexity=challenging) complexity=challenging ;;
    *) echo "unsupported argument: $arg" >&2; exit 64 ;;
  esac
done

now_ms() {
  bun -e 'process.stdout.write(String(Date.now()))'
}

started_at_ms=$(now_ms)
run_id="$(date -u +%Y%m%d%H%M%S)-$$"
branch="orca/improve-$run_id"
worktree="${TMPDIR:-/tmp}/orcats-improvement-$run_id"
run_dir="$source_root/.orca/improvement-loop/runs/$run_id"
latest="$source_root/.orca/improvement-loop/latest.json"
mkdir -p "$run_dir"
launcher_log="$run_dir/launcher.log"
exec > >(tee "$launcher_log") 2>&1

git -C "$source_root" fetch origin main
git -C "$source_root" worktree add "$worktree" -b "$branch" origin/main
mkdir -p "$worktree/.orca/workflows" "$worktree/.orca/improvement-loop"

for name in codebase-improvement.ts codebase-improvement-lib.ts \
  codebase-improvement-lib.test.ts codebase-improvement-contract.test.ts \
  codebase-improvement-artifacts.test.ts codebase-improvement.config.json \
  codebase-improvement.run.md
do
  cp "$script_dir/$name" "$worktree/.orca/workflows/$name"
done

ledger="$source_root/.orca/improvement-loop/issues.jsonl"
if [[ -f "$ledger" ]]; then
  cp "$ledger" "$worktree/.orca/improvement-loop/issues.jsonl"
fi

cd "$worktree"
bun install --frozen-lockfile

if [[ "$mode" == preflight ]]; then
  bun test .orca/workflows/codebase-improvement-lib.test.ts \
    .orca/workflows/codebase-improvement-contract.test.ts \
    .orca/workflows/codebase-improvement-artifacts.test.ts
  bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
    .orca/workflows/codebase-improvement.ts
  bun test
  bun run lint
  jq -n --arg runId "$run_id" --arg branch "$branch" \
    --arg worktree "$worktree" --arg profile "$complexity" \
    '{runId:$runId,branch:$branch,worktree:$worktree,profile:$profile,mode:"preflight",exitCode:0}' \
    > "$latest"
  echo "run_id=$run_id"
  echo "branch=$branch"
  echo "worktree=$worktree"
  echo "latest=$latest"
  exit 0
fi

set +e
ORCA_IMPROVEMENT_RUN_ID="$run_id" \
ORCA_IMPROVEMENT_STARTED_AT_MS="$started_at_ms" \
bash skills/orcats-flow/scripts/orca-run.sh \
  .orca/workflows/codebase-improvement.ts --backend codex -- \
  --baseline=strict "--complexity=$complexity"
exit_code=$?
set -e

if [[ -d "$worktree/.orca/monitoring" ]]; then
  cp -R "$worktree/.orca/monitoring" "$run_dir/monitoring"
fi
if [[ -d "$worktree/.orca/improvement-loop/runs/$run_id" ]]; then
  cp -R "$worktree/.orca/improvement-loop/runs/$run_id" "$run_dir/workflow"
fi
if [[ -f "$worktree/.orca/improvement-loop/issues.jsonl" ]]; then
  cp "$worktree/.orca/improvement-loop/issues.jsonl" "$ledger"
  cp "$worktree/.orca/improvement-loop/issues.jsonl" "$run_dir/issues.jsonl"
fi

monitor_path=""
if [[ -d "$run_dir/monitoring" ]]; then
  monitor_path=$(find "$run_dir/monitoring" -type f -name '*.json' -print -quit)
fi
report_path="$run_dir/workflow/report.json"
pr_url=""
if [[ -f "$report_path" ]]; then
  pr_url=$(jq -r '.prUrl // ""' "$report_path")
fi
ended_at_ms=$(now_ms)
elapsed_ms=$(( ended_at_ms - started_at_ms ))

jq -n --arg runId "$run_id" --arg branch "$branch" \
  --arg worktree "$worktree" --arg profile "$complexity" \
  --arg monitor "$monitor_path" --arg report "$report_path" \
  --arg ledger "$ledger" --arg prUrl "$pr_url" \
  --argjson elapsedMs "$elapsed_ms" --argjson exitCode "$exit_code" \
  '{runId:$runId,branch:$branch,worktree:$worktree,profile:$profile,monitor:$monitor,report:$report,ledger:$ledger,prUrl:$prUrl,elapsedMs:$elapsedMs,exitCode:$exitCode}' \
  > "$latest"

echo "run_id=$run_id"
echo "branch=$branch"
echo "worktree=$worktree"
echo "elapsed_ms=$elapsed_ms"
echo "monitor=$monitor_path"
echo "report=$report_path"
echo "ledger=$ledger"
echo "pr_url=$pr_url"
echo "exit=$exit_code"
exit "$exit_code"
```

Never use `eval`, force, hard reset, broad clean, worktree removal, or branch
deletion. Make the launcher executable.

- [ ] **Step 5: Write runbook and issue seed**

Runbook triggers:

```bash
bash .orca/workflows/codebase-improvement.sh --preflight-only
bash .orca/workflows/codebase-improvement.sh --complexity=simple
```

Document Codex/GitHub auth, Orcats 0.2.3, Bun setup, strict live baseline,
targeted gates, final verify, `CI / Verify`, simple/medium/challenging ceilings
of 10/30/45 minutes, evidence paths, retained worktree/branch, and bounded
reruns.

Seed one JSONL entry: run
`b22d31ec-f985-49d0-92b9-c3bd03c612e8`, classification `backend`, issue
`feature-implementation-timeout`, elapsed 600008, status `open`, and corrective
design path.

- [ ] **Step 6: Verify GREEN**

Run artifact test. Expected: PASS. Hash all Task 3 artifacts and confirm none
appears in `git status`.

---

### Task 4: Author Validation and Worktree Preflight

**Files:**

- Modify only failing local `.orca/` artifacts.
- Create evidence under the run ID path recorded in `latest.json`.

**Interfaces:**

- Consumes Tasks 1-3.
- Produces green local tests, typecheck, self-audit, one fresh preflight
  worktree, and backend/CLI readiness evidence.

- [ ] **Step 1: Run all local artifact tests**

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run author typecheck**

```bash
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
```

Expected: `OK`.

- [ ] **Step 3: Run cookbook self-audit**

Require current package imports, one flow envelope, `flowArgs`, outcome
narrowing, error/reason detail, monitor, finally shutdown, test+lint, full
verify, fixable issues, and stage directives. Reject bare `neverthrow`,
`process.argv`, deprecated wrappers, internal `executeLoop`, and destructive Git
text.

- [ ] **Step 4: Verify external readiness**

```bash
bash skills/orcats-flow/scripts/orca-doctor.sh --backend codex
gh auth status
orcats --version
```

Expected: Codex ready/logged in, GitHub account `ASRagab`, Orcats 0.2.3.

- [ ] **Step 5: Run launcher preflight without model turn**

```bash
bash .orca/workflows/codebase-improvement.sh --preflight-only
```

Expected: fresh worktree, frozen install, tests/typecheck green, no model turn,
worktree retained.

- [ ] **Step 6: Inspect isolation**

Run:

```bash
latest=.orca/improvement-loop/latest.json
worktree=$(jq -r .worktree "$latest")
git -C "$worktree" status --short --branch
git status --short --branch
```

Expected: preflight worktree has no tracked changes; root still has only
pre-existing `package-lock.json`.

---

### Task 5: Timed Live Dogfood Run

**Files:**

- Runtime writes generated worktree plus central ignored run directory.

**Interfaces:**

- Consumes validated launcher/workflow and current `origin/main`.
- Produces progress, red/green proof, ready PR, green checks, squash merge,
  monitor/report/ledger, and elapsed-time proof.

- [ ] **Step 1: Start through orcats-flow**

Run in managed background terminal:

```bash
bash .orca/workflows/codebase-improvement.sh --complexity=simple
```

Poll output below 60-second intervals. Do not classify ordinary backend work as
stalled.

- [ ] **Step 2: Report significant progress live**

Report: worktree created; baseline green; candidate selected; regression red;
implementation green; review clear/repaired; full verify green; PR opened;
`CI / Verify` green; PR merged.

- [ ] **Step 3: Heal only bounded failures**

Classify environment, baseline, backend, gate, review, scope, remote-check,
merge, or SLA overrun. Permit only the workflow's targeted and review repairs.
Preserve worktree and ledger on failure. Never accept dirty state or merge red
checks.

- [ ] **Step 4: Inspect final evidence**

```bash
latest=.orca/improvement-loop/latest.json
monitor=$(jq -r .monitor "$latest")
report=$(jq -r .report "$latest")
ledger=$(jq -r .ledger "$latest")
pr_url=$(jq -r .prUrl "$latest")
bun run scripts/summarize-run.ts "$monitor"
jq . "$report"
tail -n 20 "$ledger"
gh pr view "$pr_url" --json number,state,mergedAt,mergeCommit,headRefOid,url
git status --short --branch
```

Expected for the simple live proof: exit zero; PR `MERGED`; expected check green;
SLA at most 600000 ms; timeout issue resolved; root `package-lock.json`
untouched. Unit tests separately prove 1800000/2700000 ms medium/challenging
ceilings and 6/10-path limits.

---

### Task 6: Issue-Driven Corrections and Completion Audit

**Files:**

- Modify only implicated ignored artifact for workflow defects.
- Append `.orca/improvement-loop/issues.jsonl`.
- Let workflow alone modify generated improvement branch.

**Interfaces:**

- Consumes failed or successful run evidence.
- Produces correction plus later proving run per new issue and final audit.

Correction 3 historically followed the detailed test-first plan in
`docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md`.
It replaced monolithic repository scouting with bounded deterministic evidence.
Its earlier timing and single-turn shape are superseded by the current contract
above: at most two fresh 40-second attempts, with retry only for the first exact
timeout cancellation. Every later gate remains unchanged.

Correction 12 bound delivery to the immutable locally captured post-commit SHA,
made shutdown and artifact finalization truthful under partial failure, and
persisted initial and final review evidence plus a literal final blocker count.
Its three independently reviewed tasks preserved remote startup polling and all
existing delivery gates.

Correction 13 supersedes rank-one-only reproduction after run
`20260713195408-86998` produced a valid control but a target that passed. It
adds bounded ranked fallback, lazy later-rank controls, one shared reproduce
budget, retained rejection artifacts, and exact restoration before another
rank. Follow-up review required signal-killed gates to remain operational
errors, a final budget check after RED persistence, and real temporary-Git tests
for byte/status/complete-binary-diff restoration. Final review also required an
enforcing non-positive-budget assertion, pre/post rejected-artifact checks, and
independent status-only and corrupt-byte restoration tests. A second audit
required a diff-only restoration test and scoped pre/write/post AST contracts
for both rejected artifacts. Final re-review then found terminal-only backends
were rejected despite exact Git proof; the correction adds three-state event
evidence and mutation-protected terminal-only acceptance. Follow-up review
bound the failed-proof guard to its typed rejection body and corrected its
diagnostic. No later live proof may start until those contracts,
documentation, evidence, and re-review are clean.

Correction 14 follows failed proving run `20260713224535-26481`. The run used
the complete 65-second reproduce budget, but all three ranks repeated a false
empty-package-name premise from fragmented source snippets and an unrelated
test path. The reproduce agent correctly refused to manufacture RED and timed
out while tracing the real embedded-resolution path. Keep the 65/560/600-second
timing contract unchanged. Pair selected sources with related tests, render
every hotspot plus fair context through exact 16-line boundaries, retain up to
40 leading lines for files without hotspots, and fail closed above the
20,000-character packet cap. Require unique target tests, one exclusive
production path per candidate, citations for every allowed production path,
and no auxiliary test paths; shared production support paths remain allowed.
Preserve source-test reservations in the packet and report, require each target
test to match one of its allowed production paths, and validate citations only
against structured rendered source/test markers so commit-prefix text cannot
spoof evidence.
Require immediate unchanged exit when allowed paths disprove a candidate.

Correction 15 follows the final independent reliability audit. Repair and
review allocations now count active work rather than consuming each other's
inactive time. Pull-request head reads prove both ready state and the immutable
SHA; remote-check parsing has one dominant startup/failure path; merge state is
behavior-tested. Launcher evidence finalization changes a prior success to exit
`74` on collection or publication failure while preserving earlier failures.
New issue rows bind backend, worktree, branch, monitor path, and PR URL when
known. Contract mutations protect preflight test arguments, progress output,
unconditional monitor/report writes, effective timing, ready PR creation, head
validation, startup polling, merge confirmation, and final SLA evaluation.
Another live run requires a fresh explicit authorization.

Correction 16 follows three fresh locked-digest audits. Post-turn Git probes now
require the active stage remainder, so helper defaults cannot reset stage or
launcher time. The launcher binds and the workflow validates the retained
branch before config, backend, or baseline work. The final all-green check rows,
command log, timestamp, and unchanged head SHA are persisted before merge.
Baseline repair usage is counted once. Pure behavior tests protect exact
citation boundaries and latest-open seed resolution; AST mutations protect all
node directives, targeted test/lint, the single full verify gate, issue/report
writes, branch/CI bindings, and every timed Git probe. A successor live run
still requires fresh explicit authorization after clean re-audit and preflight.

Correction 17 follows the next locked-digest audits. Tested helpers now own
directive-preserving model overlay, required-command failure handling, timeout
clamping, targeted-gate issue projection, branch matching, and usage merging.
The workflow delegates to those helpers and mutation contracts protect every
callsite, usage turn, remainder consumer, branch log, and seed append. A
successful seed transition overlays current backend, worktree, branch, monitor,
and pull-request context even when its historical open row predates those
fields. The parent helper signatures now match executable code. No live run may
start until a new digest receives three zero-finding audits and preflight passes.

Correction 18 follows the fresh quality and resilience audits of that locked
state. Model-supplied failure markers must be specific and are matched as
literal text, so a generic error word or regular-expression metacharacter
cannot manufacture RED proof. The launcher validates the append-only source
ledger, its immutable seed row, and every one-object JSON line before build,
fetch, worktree, or backend work; invalid input exits `65` without rewriting the
ledger. Every workspace-writing agent node compares a before/after content
manifest of ignored `.orca` controls and evidence, including failure paths.
After full verification, the workflow binds the candidate's exact path, mode,
and object IDs to the pre-stage worktree, staged index, and committed tree, and
pushes only after all three comparisons pass. Direct mutation contracts also
protect implementation budget ownership, CI and usage reachability,
finalization, complete failed-gate evidence, reproduction prompt evidence, full
verification, merged-state checking, count-free ledger closure, and restoration
failure propagation. The original fourteen audit findings are appended as open
ledger rows and require the same later proving run as every earlier open finding.

Follow-up hardening makes the integrity checks behavioral rather than
token-shaped. Ignored manifests have entry, path-byte, content-byte, and
absolute I/O deadlines; symbolic links hash their link text. Candidate
worktree symlinks use Git blob hashing for the repository object format. One
binary comparator and strict index/commit parsers reject malformed framing,
wrong modes, ambiguous object IDs, and duplicate or missing paths. Every
manifest is normalized with deterministic bytewise path ordering independent
of input order or letter case. A full post-commit path query catches hook-added files before
the committed manifest comparison and push. Temporary repositories and direct
mutants prove successful, failed, and synchronous guard paths plus every
delivery mismatch.

The final locked-quality audit adds eleven ledger findings and binds the
successor proof end to end. The exact fourteen-artifact digest now includes the
ledger and links preflight bytes to live bytes. Candidate RED markers derive
from candidate IDs; positive controls bind a pre-existing named test, baseline
run, unchanged semantic fingerprint, the same exported entrypoint as the RED
assertion, and a canonical Bun summary. Every conversation settlement and
finalization action shares the
absolute deadline. Delivery revalidates branch and origin URLs after agents,
binds the exact single-parent commit range, requires typed all-pass CI evidence
with no skips, retains PR base `main`, and proves the unchanged SHA after merge.
Every typed ledger row is validated. The launcher alone resolves latest-open
IDs by atomically committing a zero-open canonical ledger after the workflow's
report and monitor are final. The primary checkout's `package-lock.json` hash
remains unchanged.

The finalization follow-up separates retryable evidence from the terminal
report. Shutdown runs once, then the issue ledger and fresh monitor snapshot run
as retryable artifacts, and exactly one non-retryable report runs last. Each
action receives the fresh shared absolute remainder, an abort signal, its
attempt number, and a generation-current predicate. Timeout aborts and
invalidates the attempt; non-publication actions recheck the absolute remainder
after completion so synchronous work that blocked the timer still fails. A late
settlement may finish privately but cannot publish over its retry.

Publication uses one explicit commit point instead of a generic post-action
clock read. After writing a run-and-attempt-unique temporary file, and
immediately before atomic rename, the publisher requests one authentic positive
commit decision from the action context. The issue, monitor, or report action
returns that exact decision through the wrapper, which treats it as terminal
and never reclassifies the committed publication from a later clock read. The
contract rejects commit calls before the temporary write, moved away from the
immediate pre-rename position, after rename, forged return objects, and duplicate
commit attempts. On pre-publication failure, cleanup removes only the action's
own temporary file, preserves the original publication error as primary, and
attaches any cleanup failure as secondary. After rename, the publisher returns
immediately with no cleanup or other fallible work and no later clock read. The
terminal report recomputes finish time, elapsed time, and SLA before this commit
point, so a deadline failure cannot persist `sla: "passed"`.

The proving backend is now pinned to default Codex. A non-empty
`ORCA_BACKEND` other than `codex` fails before side effects, and the launcher
passes Codex explicitly. Managed OpenCode terminal shutdown remains separate
source-runtime work; it is neither selected nor claimed proven here. That
deferral adds no artifact: the locked set remains the issue ledger, the same ten
`.orca/workflows/` files, and these same three tracked plan/spec documents.

A later audit invalidated the 300-test focused checkpoint and the successor
digest beginning `3eb`. Timer callback scheduling was not proof that work
completed before its deadline. Every timer-based helper now records an absolute
completion time and treats equality as late. `awaitBounded` records terminal
settlement time: an outcome already settled after the active deadline becomes
an owned timeout without redundant cancellation, while a still-pending timeout
cancels once and awaits bounded settlement. Timeout records retain terminal
usage and normalized evidence in JSON-safe form.

The one-time scout retry takes one total-remainder snapshot, reserves terminal
settlement inside it, and retries only the first exact owned timeout while that
snapshot still has positive retry time. It never retries after total expiry.
`awaitWithinDeadline` and each manifest operation reject late success, late
rejection, and exact-deadline equality before evidence can be committed. The
non-Codex guard also moved ahead of monitor construction and every preflight,
filesystem, config, command, and backend operation.

The frozen fourteen-artifact checkpoint
`e28a8885678089f1009b75829fa470ca03ba05f7fb4df0e18d901824d7b78530`
is retained only as invalidated historical evidence. Its local GREEN was 319
focused tests and 1,775 assertions, but the frozen audit found that the ledger
proof covered only the immutable seed and the package-lock proof lacked a
behavioral finalization matrix.

The coverage correction exercises mutation, deletion, and reordering of the
complete captured ledger prefix against both source and candidate ledgers. All
six cases exit `65`, leave the source bytes unchanged, release the ledger lock,
and leave no merge temporary file. Structural mutants also prove that a
seed-only comparison and removal of either source or candidate prefix guard are
rejected. The package-lock finalizer now has a six-case final existence and
SHA-256 matrix: unchanged existing bytes succeed; changed, deleted, newly
appeared, and different-byte recreation fail; identical-byte recreation
succeeds. The scout deadline mutation diagnostic now names the shared
10-second absolute deadline and rejects the stale 15-second wording.

Ledger locking now uses `mkdir` plus one unique
`owner.<pid>.<nonce>` marker. Acquisition verifies that marker is the lock
directory's sole entry, belongs to the current live process, and still matches
the exact acquired path. Each acquisition or recovery iteration starts with a
bounded launcher-deadline check. Recovery removes only one exact inspected dead
owner marker and then uses `rmdir`; empty locks use `rmdir` directly. A
symbolic-link lock directory or marker, live owner, malformed state, and
multiple-marker state remain untouched and fail closed at the deadline. The
main lock path is never renamed or recursively deleted. Normal
release and `TERM`, `INT`, or `HUP` cleanup remove only the caller's exact marker
and merge temporaries. Replacement-race tests prove stale recovery and release
cannot steal or delete a successor owner's marker.

Package-lock protection stages preflight success privately, then performs its
terminal commit-point recheck before stable success publication. After the
source ledger validates, the full finalizer trap precedes ledger snapshot and
prior-evidence invalidation. Preflight mode atomically moves prior preflight and
latest success into run-unique same-directory quarantines; signal and failure
paths repeat the same idempotent invalidation and attempt both paths after one
rename fails. Live validation requires the claimed preflight to match its
quarantined successful latest document.
Changed, disappeared, or newly appeared package-lock state changes final status
to `74`, clears a missing after-hash, discards staging, and leaves only
failure-shaped latest evidence.

Diagnostics print while successful latest and preflight evidence remains
private. Atomic latest publication receives an immediate positive deadline
decision. Claimable preflight receives a second fresh positive decision
immediately before its rename. Signals are recorded while publication owns a
commit boundary. Preflight authority transfers only after the final rename
returns and no pending signal requires retraction. A live signal after latest
publication and before canonical ledger rename exits with the signal status. A
failed preflight decision or rename atomically moves latest
back to private staging before failure rendering. If that move fails after
deadline expiry, an atomic failure tombstone replaces the success-shaped latest
document. If a signal arrives before ownership transfers while canonical
quarantines and reused private fallbacks are occupied, cleanup clears or
reallocates fresh current-run private paths, retries retraction, and verifies
canonical preflight and latest success absent. After preflight authority
transfers, finalization exits immediately with no later
fallible cleanup. The parent post-run hash comparison supplies the final
after-process check.

Correction 19 follows the final bounded proving audits. Merge no longer consumes
only the earlier remote-check snapshot: it polls GitHub again, requires the
current complete check set to pass, persists that fresh typed evidence, and then
reasserts the unchanged ready head before computing the merge timeout. Runtime
archive creation disables Git replacement objects, binding built bytes to the
literal captured commit even when local `refs/replace` exist. Ledger merge now
preserves conventional `TERM`, `INT`, and `HUP` exits as `143`, `130`, and `129`.
Terminal closure behavior seeds two independent open IDs and proves both latest
states resolve. The existing failed-finalizer harness already executed the real
failure merge and required exact source-ledger bytes; explicit latest-state
assertions now make that evidence unmistakable.

Correction 20 follows the resumed bounded proving audits. A signal could arrive
after child-exit observation and still be overwritten by the final wait result;
terminal finalization hashed the first monitor JSON returned by filesystem
order; and fresh client-side CI evidence could not make an unprotected GitHub
merge atomic. The bounded wrapper now reaps the child, restores caller traps,
and then gives any recorded signal precedence. Terminal success requires one
monitor whose filename stem matches its internal run ID and whose Codex summary
contains one clean completed outcome with no failures. Merge now requires
strict `Verify` protection from workflow `CI` on `main`, with administrator
enforcement, before the final poll, unchanged-head check, and SHA-locked command.

Correction 21 follows the terminal-binding audit. The terminal commit now
rehashes the candidate ledger, staged canonical ledger, report, monitor, and a
cycle-free `latest.json` projection while holding the ledger lock. The
projection excludes `ledgerSha256`, `latestProjectionSha256`, and
`terminalProof`; those claims are checked separately. Stable run-local issue
evidence remains the candidate ledger until canonical rename. Post-rename
recovery requires the exact terminal record, projection, embedded claims, and
final-ledger hash.

Correction 22 follows the final protection and terminal-worker audit. GitHub's
required check context is `Verify`; `CI` is workflow metadata, not part of the
context name. Preflight validates strict administrator-enforced protection as
its first gate, and live mode revalidates it before claiming the attestation.
The terminal ledger worker refuses a previously recorded signal, and failed
terminal publication removes its success-shaped staging ledger.

Correction 23 follows the source-identity audit. A context-only `Verify` rule
could be satisfied by another producer. The launcher and workflow now require
the protected check entry to bind `Verify` to GitHub Actions app ID `15368`, and
reject a missing check entry, an unrestricted context, or a different app.

Correction 24 follows loaded-host verification. Two process-heavy launcher
harnesses passed in isolation but exceeded test-only 300-millisecond and
five-second caps during exact-suite runs. Their test timeouts now allow loaded
process startup while retaining every production deadline and assertion.

Correction 25 follows the terminal-worker and protection-test audit. A child
could execute after a signal landed between the final pre-spawn check and PID
capture. A two-phase start and acknowledgement gate now keeps the child inert
until the parent tracks it and rechecks signals. The preflight ordering test
requires both calls to exist and proves the protection-call deletion mutant.
Its final-wait signal harness targets the actual terminal wait after the new
acknowledgement wait was added.

Correction 26 follows the bounded-capture, terminal-stage, and latent-merge
audit. Shell behavioral RED produced six expected failures plus one unrelated
loaded-host timeout. It proved that command substitution could defer the parent
signal trap and that signal or deadline paths after terminal staging could
leave success-shaped evidence. `capture_before_deadline` now performs all 24
bounded output captures from the main shell, and signal, timeout, and finalizer
cleanup remove terminal staging before prior-evidence invalidation.

The merge behavioral RED was 0/1: `Expected []`; `Received ["merge must persist
its command result and confirm exact merged state even after a failed
response"]`. Merge now persists its exact SHA-locked `CommandLog` regardless of
result and always runs bounded authoritative confirmation. Recovery requires
the exact pull request URL and repository, base `main`, head ref, head SHA,
non-draft state, and `MERGED`. A passed command with failed confirmation
surfaces the confirmation failure; dual failure preserves both errors in an
`AggregateError`.

Correction 27 follows the frozen terminal audit. Active-child deadline polling
still invoked `bun` through command substitution, so a stalled clock deferred
TERM for 2,174 milliseconds against a 1,500-millisecond bound. Another RED sent
TERM immediately before the first preflight publication and received exit `0`
instead of `143` because terminal ownership had been asserted before either
rename.

Launcher remainder checks now assign from Bash's built-in `SECONDS` counter in
the main shell, and both finalizer timestamp reads use bounded main-shell
capture. Signals retain direct cleanup authority through latest publication.
Live transfers ownership only before canonical ledger commit; preflight
transfers only after its final rename returns.

- [x] **Step 1: Write failing test for each new artifact defect (historical checkpoint)**

The earlier correction recorded its smallest behavior failures before editing
implementation. The later finalization/backend-pin follow-up is tracked by the
current pending verification step below and the detailed correction plan.

- [x] **Step 2: Implement minimal correction and verify (historical checkpoint)**

The pre-follow-up artifact state passed its focused tests and Task 4 gates. The
later finalization and backend-pin changes invalidate that checkpoint for the
current bytes.

- [x] **Step 2a: Preserve the invalidated focused checkpoint**

The earlier 300-test focused GREEN and digest beginning `3eb`, plus frozen
digest
`e28a8885678089f1009b75829fa470ca03ba05f7fb4df0e18d901824d7b78530`
at 319 tests and 1,775 assertions, are retained only as historical evidence.
Their respective audits invalidated them.

- [x] **Step 2b: Verify the latest frozen-audit correction locally**

The four focused workflow suites reached 327 tests and 1,963 assertions.

- [x] **Step 2c: Run the definitive focused checkpoint**

All four focused suites pass at 328 tests and 1,984 assertions after the
terminal-publication and symlink-lock corrections.

- [x] **Step 2d: Verify every remaining deterministic gate (historical checkpoint)**

Flow typecheck, shell syntax, exact launcher ledger validation, documentation
checks, diff checks, and `bun run verify` passed before the post-checkpoint
finalization audit. That audit invalidated the checkpoint.

- [x] **Step 2e: Close terminal-publication and stale-invalidation races
  (historical checkpoint)**

Behavior tests now cover expiry immediately before claimable preflight commit,
signals after latest and preflight publication, same-directory quarantine that
continues after one rename failure, matching latest-to-preflight claim evidence,
failure tombstone replacement, and direct filesystem ordering behind the
non-Codex guard. This result reached 331 focused tests and 2,016 assertions, but
the later terminal-ledger protocol audit invalidated it.

- [x] **Step 2f: Preserve the invalidated full-gate checkpoint**

Flow typecheck, exact launcher ledger validation, lint, documentation link,
symbol, signature, shell, diff, and full verification passed before the
terminal-ledger protocol correction. Full verification then recorded 461
passing tests, one gated skip, and 1,317 assertions. That evidence is historical
for the current bytes.

- [x] **Step 2g: Commit success only through the canonical ledger**

The workflow now leaves candidate resolutions provisional. Failed-run merge
keeps only each candidate ID's latest-open row. Live success rejects any
concurrent source suffix, publishes `latest.json` as non-authoritative evidence,
and commits only when the zero-open canonical ledger is atomically renamed with
one terminal record binding the candidate ledger, report, monitor, and
cycle-free latest-projection hashes. Stable run-local evidence remains the
candidate ledger until that rename. The terminal lock protects fresh rehashing
of every bound artifact and validation of latest's ledger, projection, and proof
claims.
Pre-rename TERM and SIGKILL cannot authorize success; post-rename recovery
requires that exact record and final ledger hash. Terminal report timeout
reserves time to republish failure artifacts. All four focused suites pass at
340 tests and 2,061 assertions.

- [x] **Step 2h: Preserve the terminal-protocol deterministic checkpoint**

Flow typecheck, exact launcher ledger validation, lint, documentation link,
symbol, signature, shell, diff, and full verification checks passed at the
terminal-protocol checkpoint. Full verification recorded 461 passes, one gated
skip, and 1,317 assertions. The final pre-lock audit invalidated those exact
artifact bytes.

- [x] **Step 2i: Close the final pre-lock audit findings**

Terminal staging now keeps only each candidate ID whose latest candidate row is
open, so a candidate-authored resolution cannot displace the launcher's
authoritative resolution of a base-open issue. Runtime HEAD is captured before
build; the launcher archives that immutable commit into a private directory,
builds there, and copies only the executable into run evidence. A real
failure-swallow mutant now converts a rejected required command into a synthetic
zero-exit log and is rejected by the contract. Behavioral RED preceded both
launcher repairs. The corrected focused checkpoint passes 342 tests with 2,086
assertions.

- [x] **Step 2j: Preserve the final pre-lock deterministic checkpoint**

Flow typecheck, exact launcher ledger validation, lint, documentation link,
symbol, signature, shell, diff, and full verification checks passed before the
Correction 19 audit. Full verification recorded 461 passes, one gated skip, and
1,317 assertions; that result is historical for current bytes.

- [x] **Step 2k: Close the final bounded proving-audit findings**

Behavioral RED proved replace-ref runtime substitution and signal-status loss.
The CI contract rejected cached-only merge evidence. Terminal closure now proves
two independent open IDs, and failed-run resolution filtering retains exact
behavior assertions.

- [x] **Step 2l: Preserve the Correction 19 deterministic checkpoint**

All four focused suites pass at 342 tests and 2,103 assertions. Flow typecheck,
exact ledger validation, lint, documentation link, symbol, signature, shell,
diff, and full verification pass. Full verification records 461 passes, one
gated skip, and 1,317 assertions. The resumed bounded audit invalidated those
bytes.

- [x] **Step 2m: Close resumed bounded-audit findings**

Behavioral RED proved final-wait signal loss and stale or invalid monitor
acceptance. A pure policy test rejected missing strict admin-enforced CI
protection, and the merge contract rejected the old client-only sequence. The
three new audit rows remain append-only and open until the successor live run's
canonical ledger commit.

- [x] **Step 2n: Close terminal cross-file binding findings**

Behavioral RED proved report, monitor, latest metadata, and embedded-claim
mutation could evade the staged proof, and proved interruption could leave
success-shaped run-local issue evidence. Terminal commit now revalidates every
bound artifact under the lock, binds the cycle-free latest projection, and
keeps run-local issues candidate-only until canonical commit. Three audit rows
remain append-only and open for the successor proving run.

- [x] **Step 2o: Re-run every deterministic gate on Correction 21 bytes**

All four focused workflow suites pass at 348 tests and 2,176 assertions. Flow
typecheck, exact ledger validation, lint, documentation link, symbol, signature,
shell, diff, and full verification pass. Full verification records 461 passes,
one gated skip, and 1,317 assertions.

- [x] **Step 2p: Re-run every deterministic gate on Correction 22 bytes**

All four focused workflow suites pass at 352 tests and 2,208 assertions. Flow
typecheck, exact ledger validation, shell syntax, diff checks, and full
verification pass. Full verification records 461 passes, one gated skip, and
1,317 assertions.

- [x] **Step 2q: Re-run every deterministic gate on Corrections 23 and 24**

All four focused workflow suites pass at 352 tests and 2,215 assertions. Flow
typecheck, exact 80-row ledger validation, shell syntax, diff checks, and full
verification pass. Full verification records 461 passes, one gated skip, and
1,317 assertions.

- [x] **Step 2r: Verify the Correction 25 runtime and test bytes**

All four focused workflow suites pass at 353 tests and 2,227 assertions. The
append-only ledger retains its exact 80-row prefix and adds two Correction 25
rows for 82 total. Final deterministic gates run on these recorded bytes before
the replacement fourteen-artifact digest is frozen.

- [x] **Step 2s: Verify the Correction 26 recovery and cleanup bytes**

All four focused workflow suites pass at 363 tests and 2,353 assertions. The
ledger preserves the exact 82-row prefix with SHA-256
`ed4306a940db3275dec36e3bd91e61e7a942bdecd1f57d46f351aa7f934f91ec`.
Three append-only open Correction 26 rows bring it to 85 unique rows. The
Correction 25 checkpoint remains historical at 353 tests, 2,227 assertions,
and 82 rows. Full deterministic verification passes 461 tests with one gated
skip, zero failures, and 1,317 assertions.

The historical fourteen-artifact digest was recorded only as abbreviated
`d603...4e60`. It is invalid and non-reconstructable; missing hexadecimal
characters must not be invented. Final deterministic gates run on the
Correction 26 bytes before the successor digest is computed.

- [x] **Step 2t: Verify the Correction 27 polling and publication bytes**

All four focused workflow suites pass at 365 tests and 2,367 assertions. The
ledger preserves the exact 85-row prefix with SHA-256
`6478fc33be4155396e3cd2aaa3355016b5c3107706580f4bcb90a3da8a4c0418`.
Two append-only open Correction 27 rows bring it to 87 unique rows. Full
deterministic verification passes 461 tests with one gated skip, zero failures,
and 1,317 assertions.

The frozen fourteen-artifact digest
`b039dd863b146132233239d1003bb3f41f48f336b5160b2bc270169bbe7afc77`
is invalid. Final deterministic gates run on the Correction 27 bytes before a
new successor digest is computed.

- [x] **Step 2u: Verify the Correction 28 semantic binding and harness bytes**

All four focused workflow suites pass at 366 tests and 2,377 assertions.
Semantic production taint retains the exported entrypoint through named,
aliased, default, and namespace imports, and the RED assertion must match the
control entrypoint. The concurrent same-ID ledger harness uses a bounded file
handshake instead of a fixed delay and passes five consecutive focused runs.

The ledger preserves the exact 87-row prefix with SHA-256
`d1580b5f595fbbbf4325d08aee3afcce15f2a4a9fb19c4c1714673c3e06587ad`.
Two append-only open Correction 28 rows bring it to 89 unique rows. Full
deterministic verification passes 461 tests with one gated skip, zero failures,
and 1,317 assertions. The frozen fourteen-artifact digest
`89a9381f4734052151a3329d56fce2c96d2a0b6518123e9ae303e4a05890e0d8`
is invalid.

- [x] **Step 2v: Close the three Correction 29 proof gaps**

Bind production taint to lexical symbol identity so shadowing declarations and
untainted reassignments clear an outer origin. Require candidate source to be
the exact baseline raw bytes plus one contiguous top-level-test insertion, and
reject inserted disabling directive tokens. When both canonical quarantines and
reused private fallbacks are occupied, preflight signal cleanup must clear or
reallocate fresh current-run private paths, retry retraction, and verify
canonical preflight and latest success absent.

The fourteen-artifact digest
`9c3824b40178183c2af42ea068063412d896f6f4ec5caa78faf07cc23da3dc24`
is invalidated by these three findings. The ledger preserves its exact 89-row
prefix with SHA-256
`e897a979014f817046b766f9063e7021dceab6181e335cb9339aca3b466f3a32`;
three append-only open Correction 29 rows bring it to 92 unique rows. A new
digest, three zero-finding audits, preflight, and live run remain pending.

- [x] **Step 2w: Close the two Correction 30 proof gaps**

Require the additive RED assertion to invoke one allowlisted terminal Bun
matcher after only recognized property modifiers. After every bounded command
leader exits, require its process group to be empty; terminate residual members
and convert a would-be success to exit `125` before finalization can continue.

The fourteen-artifact digest
`be08eb2843d4163f22d76edfa0617e7f7a98b34063f86afaa507f1c70ffe179a`
is invalidated by these two findings. The ledger preserves its exact 92-row
prefix with SHA-256
`3c2e9579ff986a29c35a5038548b28e635a94f57606d17c28bcfcbf5a8daa013`;
two append-only open Correction 30 rows bring it to 94 unique rows. A successor
digest, three zero-finding audits, preflight, and live run remain pending.

- [x] **Step 2x: Close the four Correction 31 proof gaps**

Require the positive control's production result to reach an allowlisted
terminal Bun matcher. Require the literal RED marker on the target's own
`(fail)` record. Decode source as fatal UTF-8 while retaining any BOM. Assign
every bounded command an inherited owner token, inspect for token-owning
descendants across process groups and sessions, terminate them, and fail closed
on residual ownership or inspection failure.

The fourteen-artifact digest
`c6749dcf831c1070755e602a57baf97e8f628e11284abda53cd0359f54e4d2d4`
is invalidated by these four findings. The ledger preserves its exact 94-row
prefix with SHA-256
`6ba0aaa3319134b5f8b1261806adb68b2f782ac17c433e6221d7496660fc4b4d`;
four append-only open Correction 31 rows bring it to 98 unique rows with
SHA-256
`89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`.
No successor digest was frozen before the next audit.

- [x] **Step 2y: Close the four Correction 32 proof gaps**

Reject a production matcher after unconditional `return` or `throw`, and fail
closed on ambiguous control flow before the causal matcher. Match the RED
marker as one exact token so a longer candidate marker cannot authorize the
target. Isolate host owner enumeration from unrelated finalizer harnesses while
retaining dedicated real descendant tests. Stream full process output through
a pipefail-protected filter so only matched PID lines reach temporary storage.

The ledger preserves its exact 98-row prefix with SHA-256
`89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`;
four append-only open Correction 32 rows bring it to 102 unique rows with
SHA-256
`021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`.
All four focused suites pass at 384 tests and 2,496 assertions. A new digest,
three zero-finding audits, preflight, and the authorized live run remain
pending.

- [x] **Step 2z: Close the eleven Correction 33 semantic proof gaps**

Propagate label-scoped exits and fail closed on optional calls or indexes.
Apply the same causal matcher, production-origin, reachability, and side-effect
rules to the positive control and RED test. Invalidate exact provenance after
evaluated nested writes, invoked local effects, or later production calls whose
arguments are not recursively proven primitives. Require passive matcher
arguments independent of the received value, reject `toSatisfy`, and preserve
named and namespace production origins through non-optional `await`.

Require the candidate marker to be absent from baseline source. Return the
exact single added RED test's nonempty static name, run only its anchored and
escaped exact-name selector, and require exactly one matching `(fail)` record
plus one canonical Bun summary with zero passes, one failure, nonzero
expectation calls, one test, and one file. Duplicate or contradictory summary
fields fail closed. Control-name character hardening is adjacent but remains
out of scope.

The ledger preserves its exact 102-row prefix with SHA-256
`021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`;
eleven append-only open Correction 33 rows bring it to 113 unique rows with
SHA-256
`d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`.
Fresh local evidence covers all four focused suites at 406 tests and 2,663
assertions: 84 library, 157 runtime, 82 contract, and 83 artifact tests. Flow
typecheck also passes. Full deterministic verification passes 461 tests with
one gated skip, zero failures, and 1,317 assertions. A new digest, three
zero-finding audits, preflight, and the authorized live run remain pending.

- [x] **Step 2aa: Close the two Correction 34 matcher and prompt gaps**

Require every matcher-argument const binding to resolve recursively to a
primitive before it can support semantic proof. Effectful or aggregate-backed
bindings fail closed. Align the reproduction prompt with the authoritative
parent gates: the agent runs the filtered control and exact named RED command,
not the whole test file.

The ledger preserves its exact 113-row prefix with SHA-256
`d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`;
two append-only open Correction 34 rows bring it to 115 unique rows with
SHA-256
`20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`.

- [x] **Step 2ab: Close the three Correction 35 matcher-passivity gaps**

Reject matcher expectations backed by mutable const arrays or objects, and
remove prototype-dependent `toBeOneOf` from causal proof. Preserve safe inline
object literals by validating property values rather than identifier keys, and
accept only the unshadowed global `undefined` primitive.

The ledger preserves its exact 115-row prefix with SHA-256
`20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`;
three append-only open Correction 35 rows bring it to 118 unique rows with
SHA-256
`aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`.

- [x] **Step 2ac: Close the Correction 36 global matcher-state gap**

Write and byte-verify a deadline-bound Bun preload immediately after the
reproduce budget starts. The preload disables `expect.extend`, freezes
`expect.prototype` and `expect`, and prefixes both control commands, the exact
named RED command, and post-fix targeted GREEN. Static analysis performs causal
matcher validation before expect-integrity classification, then rejects
aliases, extensions, escaped assertion objects, and `expect.prototype` writes.
The preload contract rejects any pre-install proof-wrapper invocation.

The ledger preserves its exact 118-row prefix with SHA-256
`aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`;
one append-only open Correction 36 row brings it to 119 unique rows with
SHA-256
`bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`.
All four focused suites pass at 417 tests and 2,715 assertions: 84 library with
323 assertions, 167 runtime with 682, 83 contract with 704, and 83 artifact
with 1,006. Flow typecheck passes. Full deterministic verification, a new
digest, three zero-finding audits, preflight, and the authorized live run remain
pending.

- [x] **Step 2ad: Close the Correction 37 pre-install wrapper gap**

Trace transitive named proof wrappers from `matcherProofArgs` to runtime call
sites. Reject direct, aliased, and hoisted pre-install execution plus indirect
wrapper references, while accepting a safely hoisted wrapper invoked only after
installation.

The ledger preserves its exact 119-row prefix with SHA-256
`bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`;
one append-only open Correction 37 row brings it to 120 unique rows with
SHA-256
`625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`.

- [x] **Step 2ae: Close the two Correction 38 wrapper-analysis false positives**

Resolve proof-wrapper calls and references by TypeScript binding identity, not
identifier text. Compare preload installation with reachable named-wrapper
invocations rather than declaration position. Preserve direct, alias, and
transitive pre-install rejection while accepting shadowed same-name bindings
and safely hoisted declarations.

The ledger preserves its exact 120-row prefix with SHA-256
`625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`;
two append-only open Correction 38 rows bring it to 122 unique rows with
SHA-256
`189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`.
Focused matcher tests and flow typecheck pass. The full artifact suite exposed
the Correction 39 harness-timeout gap.

- [x] **Step 2af: Close the Correction 39 artifact-harness timeout gap**

Give the five-case fresh-preflight integration harness a 15-second test timeout
instead of Bun's five-second default. Keep every launcher, preflight, stage,
and 600-second live deadline unchanged.

The ledger preserves its exact 122-row prefix with SHA-256
`189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`;
one append-only open Correction 39 row brings it to 123 unique rows with
SHA-256
`71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`.
All four focused suites pass at 419 tests and 2,727 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 83 artifact
with 1,006. Flow typecheck passes. Full deterministic verification, a new
digest, three zero-finding audits, preflight, and the authorized live run remain
pending.

- [x] **Step 2ag: Close the Correction 40 compiled-loader package gap**

The frozen fourteen-artifact digest
`65f7e553e851d657cdc220ec72660dfc5dba1b356fa31a461dd54ed5077b816b`,
three zero-finding audits, and preflight `20260716182959-15561` were valid.
Authorized live run `20260716183318-48343` exited 1 after 17,815ms before
backend startup because the compiled Bun runtime could not resolve the copied
workflow's installed `typescript` package.

Enable Bun runtime package metadata loading in local and release compiled
binary builds. The host-native release smoke replaces release source-syntax
validation: it invokes the real release-builder entrypoint, then executes its
unarchived artifact against a repository flow with a third-party package import.
Its autoload-removal mutation proof failed with the retained resolution error
and passed after the flag was restored. The local-binary smoke, strict
release-option tests, typecheck, touched-file lint, release validation,
embedded-loader tests, and retained inert runtime import pass.

The ledger preserves its exact 123-row prefix with SHA-256
`71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`;
one append-only open Correction 40 row brings it to 124 unique rows with
SHA-256
`fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`.
All four focused suites pass at 419 tests and 2,727 assertions, and full
deterministic verification passes 466 tests with one gated skip, zero failures, and 1,336
assertions. A successor digest, three audits, and preflight remain pending. The
consumed live run cannot be retried without fresh explicit authorization.

- [x] **Step 2ah: Close the Correction 41 sub-second publication gap**

The first successor digest
`16e2c3824553866e404fccd4eaf7e8b3930db28f81894a7e9e68c9c7ff866748`
is invalid. A frozen runtime audit found that the launcher calculated an exact
millisecond deadline but `remaining_launcher_ms` ignored it and used
whole-second `SECONDS`. Live canonical-ledger or preflight success could
therefore publish up to 999 milliseconds late.

Default remainder decisions now validate a fresh `now_ms` value and subtract
it from `launcher_deadline_at_ms`. Active-child polling stays shell-native to
preserve prompt TERM, INT, and HUP handling, starts from one exact remainder,
and performs an exact post-success check. Remove the obsolete launcher-wide
started-seconds state. Deterministic live and preflight finalizer harnesses with
`now_ms=100` and deadline `99` failed RED with exit 0, pass GREEN by failing
closed, leave the canonical ledger unchanged, and preserve the Correction 27
stalled-clock signal guard.

The exact 124-row prefix retains SHA-256
`fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`;
one open Correction 41 row brings the ledger to 125 unique rows with SHA-256
`952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`.
All four focused suites pass at 421 tests and 2,737 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 85 artifact
with 1,016. Full verification passes 466 tests with one gated skip, zero
failures, and 1,336 assertions. A new digest, three audits, and preflight remain
pending. The consumed live run still requires fresh explicit authorization.

- [x] **Step 2ai: Bind the exact deadline inside terminal-ledger commit**

Correction 41's live regression expired before first publication and therefore
did not exercise the interval between latest publication and canonical-ledger
rename. The ledger worker could rename after its last binding validation, the
wrapper could detect expiry only afterward, and the caller could recover that
timeout as success from the matching committed hash.

The terminal-commit action now reads exact time immediately before its
canonical rename and refuses equality or expiry. A deterministic harness keeps
4.9 seconds of shell-native polling budget, advances only the exact clock after
terminal-ledger hash binding, and expires before rename. RED expected exit 74
but received 0 with a committed ledger. GREEN exits 74, retracts success-shaped
latest evidence, preserves the canonical ledger, and keeps post-rename recovery
plus the stalled-clock signal guard green.

The exact 125-row prefix retains SHA-256
`952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`;
one open Correction 42 row brings the ledger to 126 unique rows with SHA-256
`9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`.
All four focused suites pass at 422 tests and 2,743 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 86 artifact
with 1,022. Full verification passes 466 tests with one gated skip, zero
failures, and 1,336 assertions. Fresh reviews, a new 14-artifact digest, three
audits, and preflight remain pending. The consumed live run still requires
fresh explicit authorization.

- [x] **Step 2aj: Make terminal deadline proof mutation-sensitive**

The first frozen Correction 42 successor digest
`14b684dc4829740debc908b96b1ce00cd47d605ff5958deca10aed485d87590f`
is invalid. Its expiry harness advanced exact time after only the staged-ledger
hash, so moving the deadline decision there remained green while later evidence
bindings retained a rename window. The harness also used `now_ms=6000` against
deadline `5000`, so a strict-before `-lt` decision remained green and did not
prove equality rejection.

The harness now advances exact time after the final hash-binding decision and
sets `now_ms=5000`. Mutation proofs relocate the decision after the staged
ledger hash and change `-le` to `-lt`. RED expected each weakened launcher to
escape with exit 0 but received 74. GREEN makes both mutants exit 0 while the
unmodified launcher exits 74, retracts success-shaped latest evidence, and
preserves the canonical ledger. Post-rename recovery and the stalled-clock
signal guard remain green.

The exact 126-row prefix retains SHA-256
`9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`;
two open Correction 43 rows bring the ledger to 128 unique rows with SHA-256
`2476a42e688b8d125a8d5765bd366f514a38ac99c81e711e1415d2b48d935ec9`.
All four focused suites pass at 424 tests and 2,756 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 88 artifact
with 1,035. Full verification passes 466 tests with one gated skip, zero
failures, and 1,336 assertions. A new digest, three audits, and preflight remain
pending. The consumed live run still requires fresh explicit authorization.

- [x] **Step 2ak: Record Correction 44 compact-scout evidence**

Authorized run `20260717000416-46151` failed in scout before edits, push, PR,
CI, or merge. Its first scout attempt saw 73,245 model-visible input
characters, establishing prompt-size correlation; reasoning-effort causality
remains unproven.

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

- [x] **Step 2al: Record Correction 45 frozen-audit fixes**

The frozen-byte audits found
`audit-scout-validation-reserve-deadline`,
`audit-candidate-citation-token-boundary`, and
`audit-current-scout-plan-evidence-cap`. Early synthesis left validation able
to consume the whole scout remainder, forged prefix, nested-path, and line
suffix text satisfied rendered markers, and the current imperative Task 2
snippet still prescribed `20_000`.

Scout validation now starts one absolute 10-second validation deadline
immediately after synthesis, bounds every tracked-path operation by its shared
remainder, and performs a final remainder check. Candidate citations now
require exact citation-token boundaries. The current Task 2 snippet uses the
normative 10,000-character cap and names the validation-limit constant.

Three append-only open audit rows bring the ledger to 132 rows and 132 unique
IDs with SHA-256
`1ebfb5e0bec4d7f3fd4db71c8550ab7193e181e52c733ae8850bbcd7a0f261f1`.
Focused library, contract, and artifact regressions pass. Prompt-size correlation
and the unproven reasoning-effort causality conclusion are unchanged. Full
verification, a new manifest, three fresh audits, preflight, and any live run
remain pending. Another live run requires fresh explicit authorization.

- [x] **Step 2am: Record Correction 46 harness-timeout fix**

The aggregate library, contract, and artifact gate exposed
`terminal package-lock drift blocks success publication` as a behavioral RED.
The test runs three subprocess harnesses under Bun's default 5-second timeout;
it timed out in the aggregate gate and took 4.98 seconds isolated. Only this
existing three-scenario artifact test now has an explicit 15-second timeout,
matching its neighboring harness.

Append-only open row `review-terminal-package-lock-harness-timeout` brings the
ledger to 133 rows and 133 unique IDs with SHA-256
`07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347`.
The focused target and artifact proof pass 1/1 each, the isolated artifact
suite passes 91/91, and the aggregate gate passes 262/262. Full verification,
a new manifest, three
fresh audits, preflight, and any live run remain pending. Another live run
requires fresh explicit authorization.

- [x] **Step 2an: Enforce the Correction 47 finalizer-harness timeout policy**

The complete four-suite gate exposed a second default-timeout failure:
`successful terminal publication validates monitor identity and outcome`
timed out after 5003.72 milliseconds. It expected launcher exit 74 but received
the timeout signal status 143.

A deterministic AST inventory found 31 finalizer-harness tests, 33 static calls,
and 52 loop-expanded subprocess runs. The 24 default-timeout tests
relied on Bun's five-second default, six already declared 15 seconds, and the
named six-scenario mutation test declared 30 seconds. Every ordinary
finalizer-harness test now declares a 15-second timeout; the six-scenario
mutation test retains its 30-second timeout. An AST policy guard locks the
31-test, 33-call, and 52-run expansion. It rejects indirect harness references
and duplicate exception titles.
It permits exactly one six-scenario 30-second exception.
It rejects reduced scenario sets.

Append-only open row `review-finalizer-harness-timeout-policy` preserves the
exact 133-row prefix with SHA-256
`07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347`
and brings the ledger to 134 rows and 134 unique IDs with SHA-256
`24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f`.
The isolated artifact suite passes 93/93 with 1,317 assertions, and the
four-suite aggregate passes 431/431 with 3,064 assertions. Full verification
records 466 passes, one gated skip, zero failures, and 1,336 assertions. A new
manifest, three fresh audits, preflight, and any live run remain pending.
Another live run requires fresh explicit authorization.

- [x] **Step 2ao: Enforce the Correction 48 unconditional scenario policy**

The frozen-byte policy audit found
`audit-finalizer-harness-conditional-skip`. The first AST guard counted six
declared loop elements, but a conditional `continue` could skip one at runtime
while preserving 31 tests, 33 calls, 52 expanded runs, and an empty issue list.

The sole 30-second exception must now use one top-level `for...of` loop whose
first body statement is an unconditional top-level harness call awaited into
one variable. Conditional, early-exit, alternate-loop, nested, and labeled
control flow are rejected. A mutation regression proves all six scenarios must
execute. The loop must enumerate the exact six unique mutation literals;
duplicate literals and spread elements are rejected.

Append-only open row `audit-finalizer-harness-conditional-skip` preserves the
exact 134-row prefix with SHA-256
`24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f`
and brings the ledger to 135 rows and 135 unique IDs with SHA-256
`f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3`.
Focused policy and proof verification passes. The isolated artifact suite
passes 94/94 with 1,405 assertions, and the four-suite aggregate passes 432/432
with 3,152 assertions. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions. A new manifest, three fresh audits,
preflight, and any live run remain pending.
Another live run requires fresh explicit authorization.

- [x] **Step 2ap: Enforce the Correction 49 exact harness scenario policy**

The Correction 48 frozen-byte audits found five remaining root-cause classes:

- `audit-finalizer-harness-scenario-binding`:
- `audit-finalizer-harness-global-loop-control`:
- `audit-finalizer-harness-option-integrity`:
- `audit-finalizer-harness-scenario-identity`:
- `audit-finalizer-harness-callable-identity`:

Static loop cardinality alone did not prove which scenarios executed, which
harness option each scenario selected, or which callable produced the result.
All seven harness loops require exact scenario-array digests.
They require exact scenario-to-option selector paths.
They use inline non-spread scenario literals.
They use const loop bindings and a first awaited harness call with fixed
launcher and zero-status arguments. Remaining values are pure harness options
with unique static keys.

Pre-loop and post-call returns, breaks, catching try blocks, conditional skips,
spreads, computed overrides, assignments, calls, and irrelevant bindings fail
closed.
The file retains one top-level `runFinalizerHarness`.
It retains one top-level `terminalMonitorFixture`.
Both are used only through direct calls.

The exact 135-row ledger prefix retains SHA-256
`f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3`.
Five append-only open rows bring the ledger to 140 rows and 140 unique IDs with
SHA-256
`401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
Deterministic verification also exposed that the four-scenario terminal-stage
boundary test consumed 14.0-14.9 seconds under its 15-second limit. The harness
now tightens only its test-local `run_before_deadline` polling from 50ms to 10ms
for `afterTerminalStage` scenarios; production launcher polling and the
15-second test limit are unchanged. The focused boundary test passes 1/1 with
32 assertions in 11.5 seconds.

Focused policy verification passes 18/18 with 88 assertions. The isolated
artifact suite passes 112/112 with 1,584 assertions, and the four-suite
aggregate passes 450/450 with 3,331 assertions. Flow typecheck, exact ledger
validation, Bash syntax, documentation link, symbol, and signature checks pass.
Full verification records 466 passes, one gated skip, zero failures, and 1,336
assertions. A new manifest, three fresh audits, preflight, and any live run
remain pending.
Another live run requires fresh explicit authorization.

- [x] **Step 2aq: Close Correction 50 audit findings and proof**

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

- [x] **Step 2ar: Record Correction 51 composed finalization reserves**

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

- [x] **Step 2as: Bind Correction 52 historical proof boundaries and ledger semantics**

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

- [x] **Step 2at: Unify Correction 53 exact historical boundaries**

Three historical-proof boundary root causes remained after Correction 52:

- `audit-correction50-proof-heading-start`: The Correction 50 proof located its
  start with plain-text `lastIndexOf`, so a plain non-heading Correction 50
  label could satisfy the historical proof. The shared parser now requires an
  exact supported Markdown heading before the Correction 50 row anchor.
- `audit-correction51-heading-word-boundary`: The Correction 51 and Correction
  52 heading matchers lacked numeric word boundaries, so Correction 510 or
  Correction 520 could satisfy an exact historical heading. The shared matcher
  now requires the complete requested correction number.
- `audit-correction51-proof-section-end-boundary`: The Correction 51 proof
  ended at reusable authorization text instead of its next correction heading,
  so its required authorization could be borrowed from Correction 52. The
  shared extractor now ends the section at the exact next-number heading.

One shared exact Markdown heading matcher accepts `##`, `###`, and checked-list
headings with optional bold markers and requires `\bCorrection <number>\b`. One
shared historical extractor requires an exact current heading before its row
anchor, an exact next-number heading after that row anchor, and
`current < row < next`; it returns only `source.slice(current, next)`.
Corrections 49, 50, 51, and 52 now use that extractor.

The unchanged first 152 rows retain SHA-256
`24328b018809a39e2659dcc62e94c7600d106e63cebb2d4cfc00af83ee24bdcb`.
Three append-only open rows bring the ledger to 155 rows and 155 unique IDs with
SHA-256
`5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65`.

Final measured gates: focused Correction 53 proof and mutation policy pass 2/2
with 171 assertions. The isolated artifact suite passes 124/124 with 2,397
assertions, and the four-suite aggregate passes 469/469 with 4,165 assertions.
Flow typecheck and exact extracted launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest for the ordered 14-file set, three fresh audits, preflight, and a
live run remain pending. No manifest generation, audit, preflight, live
execution, push, PR, CI wait, or merge ran in Correction 53. Any live run or
GitHub write requires fresh explicit authorization.

- [x] **Step 3: Append every terminal and final proving audit entry**

Record each terminal-protocol, final pre-lock, or proving-audit gap as one
append-only open row, including the three Correction 20, three Correction 21,
four Correction 22, one Correction 23, one Correction 24, two Correction 25,
three Correction 26 rows, two Correction 27 rows, two Correction 28 rows,
three Correction 29 rows, two Correction 30 rows, four Correction 31 rows,
four Correction 32 rows, eleven Correction 33 rows, two Correction 34 rows,
three Correction 35 rows, one Correction 36 row, one Correction 37 row, two
Correction 38 rows, one Correction 39 row, one Correction 40 row, one
Correction 41 row, one Correction 42 row, two Correction 43 rows, one
Correction 44 row, three Correction 45 rows, one Correction 46 row, one
Correction 47 row, one Correction 48 row, five Correction 49 rows, and nine
Correction 50 rows, one Correction 51 row, two Correction 52 rows, three
Correction 53 rows, and nine Correction 54 rows.
The launcher, not the workflow, will resolve every latest-open ID at the
terminal canonical-ledger commit.

- [ ] **Step 4: Rerun complete live workflow**

Start from a new current `origin/main` worktree. Do not reuse partial branch.
Do not invoke another live run until fresh explicit authorization. Once
authorized, continue until one run passes and each new issue points to a later
proving run.

- [ ] **Step 5: Audit every objective requirement**

```text
fresh worktree -> worktree list + report base SHA
skill directive -> config + report directive evidence
prompt directive -> config + report directive evidence
deterministic evidence/ranked plan -> scout stage + plan JSON
latest-commit evidence -> scout packet + report gather command
ranked fallback -> pure ordering tests + typed rejection artifacts + exact restore
test-first -> lexical binding + exact raw insert + reachable causal matcher + frozen matcher state + exact named RED failure and canonical one-test summary + control/RED/GREEN proof
operational gate failures -> timeout/null-exit tests prove no candidate fallback
absolute timing -> completion timestamps + owned settled timeout + one-snapshot retry
backend -> Codex default/pin + non-Codex rejection before side effects
implementation -> validated paths + commit
verification -> targeted logs + full verify exit zero
review -> initial/final findings + persisted literal zero blocker count
PR/merge -> strict admin CI app 15368 + ready PR + fresh rollup + SHA lock + logged attempt + bounded exact confirmation after every response
progress -> live output + monitor JSON
timing -> elapsed time <= selected profile deadline (live proof: 600000 ms)
profiles -> unit evidence for 600000/1800000/2700000 ms and 3/6/10 paths
iteration -> timeout correction plus every new issue/later run
finalization -> bounded shutdown-once + retryable artifacts + one terminal report + canonical ledger renamed last + exact terminal record/hash recovery
preflight signal cleanup -> fresh private retraction when quarantine/fallback paths are occupied
process isolation -> no surviving bounded-command group or detached token owner after leader exit; temporary scan state is PID-only
integrity -> literal specific RED marker + ignored .orca manifests + verified/index/commit equality
preservation -> root package-lock.json unchanged
```

- [ ] **Step 6: Complete goal only after every row is proven**

If any row lacks direct evidence, continue the relevant task. Do not redefine
success around the passing subset.

---

## Execution Choice

1. **Subagent-Driven:** fresh implementer per task with specification and quality
   review between tasks.
2. **Inline Execution:** execute tasks in this session with plan checkpoints.

The live Orcats workflow remains the authoritative worker for the selected
codebase improvement in either mode.

## Correction 54

Nine successor-audit root causes remained after Correction 53:

- `audit-runtime-filesystem-deadline-coverage`: Active filesystem operations
  now share the exact 580-second work remainder and reject completion at or
  after cutoff.
- `audit-ci-poll-deadline-reserve`: Every pending CI sleep is deadline-bound
  and preserves the 5,000 ms merge-confirmation plus 5,000 ms issue-closure
  reserves.
- `audit-launcher-publication-deadline-coverage`: Every canonical launcher
  publication uses the supervised atomic rename protocol with a 1,000 ms
  read-only recovery reserve.
- `audit-merge-response-authoritative-confirmation`: Every exact SHA-locked
  squash response is persisted before authoritative state confirmation,
  including failed responses and ordered dual-cause failure.
- `audit-correction-heading-horizontal-whitespace`: Correction headings accept
  horizontal space or tab only; a newline after the Markdown marker is
  rejected.
- `audit-correction-row-anchor-exact-line`: Escaped row IDs match only exact
  Markdown anchor lines; suffixed and prose-only IDs are rejected.
- `audit-correction-heading-uniqueness`: Each current and supplied next-number
  correction heading must occur exactly once.
- `audit-correction53-section-end-boundary`: Correction 53 is bounded by the
  exact Correction 54 heading rather than reusable authorization prose or EOF.
- `audit-proof-semantic-execution-binding`: Exact section bytes and SHA-256
  values bind historical wording, semantic polarity, and measured-count prose
  without claiming that static text executed a command.

The unchanged first 155 ledger rows retain SHA-256
`5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65`.
Nine append-only open rows bring the ledger to 164 rows and 164 unique IDs
with SHA-256 `1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c`.

Static hashes bind wording and history only. Executed focused and aggregate
gate outputs plus a fresh preflight prove execution. Historical measured-count
prose remains locked documentation, not evidence that those commands ran.

Final measured Task 4 gate: focused proof document policy and Correction 54
verification passes 5/5 with
68 assertions.
The Task 5 aggregate gate and fresh preflight remain pending and must execute;
their later outputs, not this static section, will prove those actions.

No manifest generation, audit, preflight, live execution, push, PR, CI wait,
or merge ran in Correction 54. Any live run or GitHub write requires fresh
explicit authorization.
