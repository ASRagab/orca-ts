# Codebase Improvement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and dogfood a staged Orcats workflow that selects one codebase
improvement, proves it red-to-green, reports progress, opens a pull request,
waits for checks, and squash-merges within its 10/30/45-minute profile ceiling.

**Architecture:** A shell launcher creates a fresh worktree from `origin/main`
and starts a self-executing Orcats workflow there. A pure TypeScript module owns
directive validation, candidate selection, scope checks, deadlines, and remote
check classification. The workflow owns agent turns, gates, review, monitoring,
delivery, and issue evidence.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Orcats 0.2.3, Codex CLI,
GitHub CLI, Bun test.

## Global Constraints

- Default backend `codex`; runtime override stays supported.
- Complexity defaults to simple; explicit medium/challenging ceilings are
  30/45 minutes and path limits are 6/10.
- Live launcher passes `--baseline=strict` in a fresh `origin/main` worktree.
- Stage directive: `{ skill?: string, prompt?: string }`; one field required.
- First run applies `$tdd` to reproduce/implement and an exact review prompt.
- One low-risk fix; simple/medium/challenging allow at most 3/6/10 paths; every
  profile requires one test plus a distinct production path.
- Exclude dependencies, lockfiles, releases, publishing, secrets, security,
  public APIs, workflow artifacts, and destructive Git operations.
- Targeted test and lint repair once; full `bun run verify` once.
- Merge requires `CI / Verify`, every reported check green, and head-SHA match.
- Launcher-to-merge ceilings are 600/1800/2700 seconds; simple stage
  allocations total 560 seconds and scale by 3/4.5 for larger profiles.
- `.orca/` stays ignored and never enters implementation commits.
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
  `chooseCandidate`, `validateCandidateForProfile`, `validateChangedPaths`,
  `assertImmutableTestDiff`, `remoteCheckState`, `stageBudgetMs`, and
  `normalizeFailure`.
- Consumes: `z` and `BackendConfig` from `@twelvehart/orcats`.

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
  expect(profileLimits.medium.deadlineMs).toBe(1_800_000);
  expect(profileLimits.challenging.deadlineMs).toBe(2_700_000);
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
    'monitor.stage("select-plan"',
    'monitor.stage("reproduce"',
    'monitor.stage("red-gate"',
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
  preflight: 45_000,
  scout: 70_000,
  reproduce: 50_000,
  implement: 110_000,
  repairs: 70_000,
  review: 50_000,
  verify: 75_000,
  delivery: 90_000,
} as const;
const PROFILE_SCALE = { simple: 1, medium: 3, challenging: 4.5 } as const;

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
  redDiffPath?: string;
  validation: CommandLog[];
  prUrl?: string;
  matchedHeadSha?: string;
  merged: boolean;
  sla: "pending" | "passed" | "failed";
  stopReason?: string;
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

Bound every conversation with:

```typescript
async function awaitBounded<B extends BackendTag>(
  conversation: Conversation<B>,
  timeoutMs: number,
  stage: string,
): Promise<Outcome<B>> {
  if (timeoutMs <= 0) throw new Error(`sla-overrun before ${stage}`);
  const timer = setTimeout(() => {
    void conversation.cancel(`${stage} exceeded ${String(timeoutMs)}ms`);
  }, timeoutMs);
  try {
    return await conversation.awaitResult();
  } finally {
    clearTimeout(timer);
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
async function changedPaths(): Promise<string[]>;
async function pathDiff(path: string): Promise<string>;
async function assertTrackedPaths(paths: readonly string[]): Promise<void>;
function describeOutcome(outcome: Outcome): string;
async function readRemoteChecks(prUrl: string): Promise<RemoteCheck[]>;
async function confirmMerged(prUrl: string): Promise<void>;
```

`readConfig` parses `WorkflowConfigSchema`. `writeJson` and `appendIssue` use
`fs()` results and preserve existing JSONL. Git helpers use argument arrays.
`readRemoteChecks` parses `gh pr checks --json name,workflow,bucket`.
`confirmMerged` requires `gh pr view --json state` to equal `MERGED`. Every
failure message contains its command or file path; `describeOutcome` includes
backend error or reason.

- [ ] **Step 4: Implement exact lifecycle**

Inside exactly one `await flow(flowArgs())(async () => {})`:

```typescript
const scoutConfig = stageConfig("scout", config.stages.scout, true);
report.appliedSystemPrompts.scout = scoutConfig.systemPrompt ?? "";
const scoutConversation = llm().autonomous(selected.backend, {
  prompt: scoutPrompt(profile, profileLimits[profile]),
  schema: ScoutResultSchema,
  config: scoutConfig,
});

const reproduceConfig = stageConfig("reproduce", config.stages.reproduce, false);
report.appliedSystemPrompts.reproduce = reproduceConfig.systemPrompt ?? "";

const implementConfig = stageConfig("implement", config.stages.implement, false);
report.appliedSystemPrompts.implement = implementConfig.systemPrompt ?? "";

const reviewConfig = stageConfig("review", config.stages.review, true);
report.appliedSystemPrompts.review = reviewConfig.systemPrompt ?? "";
```

Pass each named config to its matching `llm().autonomous` call. Record before
awaiting so a timeout still proves which request configuration was applied.

1. Resolve baseline and `--complexity=$profile` args, select Codex, read
   launcher run ID/time, select `profileLimits[profile]`, multiply each simple
   stage limit by `PROFILE_SCALE[profile]`, and start monitor.
2. `preflight`: baseline gate, Codex/GitHub auth, HEAD equals `origin/main`.
3. `scout`: read-only structured turn returning exactly three candidates for
   the selected profile's time and path limits.
4. `select-plan`: validate profile/tracked paths, choose, persist plan.
5. `reproduce`: apply `$tdd`, permit only test path.
6. `red-gate`: targeted test must fail with expected pattern; save diff.
7. `implement`: apply `$tdd`, permit production paths, freeze test diff.
8. `targeted-repair`: targeted test plus lint through one-fix `fixLoop`.
9. `review`: exact review prompt and structured blockers.
10. `review-repair`: one repair and repeated review when blockers exist.
11. `verify`: full gate, immutable test, profile path scope.
12. `commit-push`: stage only validated paths, commit, push.
13. `pull-request`: write body file, create ready PR, store URL.
14. `remote-checks`: poll five seconds; require `CI / Verify`; no empty pass.
15. `merge`: resolve HEAD, squash with matching SHA, confirm `MERGED`.
16. Resolve prior timeout issue.

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

- [ ] **Step 1: Write failing test for each new artifact defect**

Add smallest real behavior test. Run it and observe expected failure before
editing implementation.

- [ ] **Step 2: Implement minimal correction and verify**

Change only implicated artifact. Run focused test green, then all Task 4 gates.

- [ ] **Step 3: Append linked correction entry**

Record issue ID, failing run, class, evidence, correction, status `corrected`,
and next proving run ID as one JSON object line.

- [ ] **Step 4: Rerun complete live workflow**

Start from a new current `origin/main` worktree. Do not reuse partial branch.
Repeat until one run passes and each new issue points to later proving run.

- [ ] **Step 5: Audit every objective requirement**

```text
fresh worktree -> worktree list + report base SHA
skill directive -> config + report directive evidence
prompt directive -> config + report directive evidence
exploration/plan -> scout stage + plan JSON
test-first -> red output + immutable diff + green output
implementation -> validated paths + commit
verification -> targeted logs + full verify exit zero
review -> findings + final zero-blocker result
PR/merge -> PR state + merge commit + matched SHA
progress -> live output + monitor JSON
timing -> elapsed time <= selected profile deadline (live proof: 600000 ms)
profiles -> unit evidence for 600000/1800000/2700000 ms and 3/6/10 paths
iteration -> timeout correction plus every new issue/later run
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
