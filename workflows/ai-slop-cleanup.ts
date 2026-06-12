import { basename, join } from "node:path";
import { ok } from "neverthrow";
import {
  command,
  fixLoop,
  flow,
  fs,
  gh,
  git,
  llm,
  z,
  selectBackend,
  type BackendTag,
  type FixLoopStop,
  type SelectedBackend,
  type OutcomeVerdict,
  type RegressedReason,
  type Usage,
  WorkflowMonitor,
} from "../src/index.ts";

/** High seatbelt on repair iterations — not the binding stop (convergence and
 * the no-progress signature are). */
const RepairCeiling = 10;
/** Wall-clock backstop for the whole per-file repair loop. */
const RepairWallClockMs = 10 * 60_000;

export const PullRequestTitle = "Clean up AI-slop patterns in source and tests";
export const PullRequestBodyPath = ".orca/ai-slop-cleanup-pr.md";
export const DefaultCleanupBranch = "ai-slop-cleanup";

// Backends without native schema enforcement (e.g. pi) emit reasonable but
// off-shape values — capitalized risk, an array of hint commands. Preprocess
// normalizes those before validation; with z.toJSONSchema's default output
// view, native backends still receive the strict inner enum/string schema.
const RiskSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(["low", "medium", "high"])
);

const ValidationHintSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.join("; ") : value),
  z.string()
);

export const CleanupAgentResultSchema = z.object({
  path: z.string(),
  changed: z.boolean(),
  smellsRemoved: z.array(z.string()),
  validationHint: ValidationHintSchema,
  risk: RiskSchema
});

export type CleanupAgentResult = z.infer<typeof CleanupAgentResultSchema>;

export const CleanupGroupOrder = [
  "conversation/model",
  "backends",
  "flow/tools/runner",
  "review/plan",
  "tests",
  "other"
] as const;

export type CleanupGroup = (typeof CleanupGroupOrder)[number];

export interface WorkflowArgs {
  readonly dryRun: boolean;
  readonly base: string;
  readonly branch: string;
  readonly publish: boolean;
  readonly monitor: boolean;
  /** Eval sink: forces monitoring on and skips commit/PR/aggregate-verify so the
   * run yields only a verdict log (the runner discards the worktree). */
  readonly evalMode: boolean;
  readonly startGroup?: CleanupGroup;
  readonly maxFiles?: number;
}

export interface CommandSpec {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface CommandRunSummary {
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface ChangedFileSummary {
  readonly path: string;
  readonly group: CleanupGroup;
  readonly smellsRemoved: readonly string[];
  readonly risk: "low" | "medium" | "high";
}

export interface SkippedFileSummary {
  readonly path: string;
  readonly reason: string;
}

export interface PullRequestSummaryInput {
  readonly changedFiles: readonly ChangedFileSummary[];
  readonly skippedFiles: readonly SkippedFileSummary[];
  readonly validation: readonly CommandRunSummary[];
}

type DiffGuardResult =
  | { readonly accepted: true; readonly changedFiles: readonly string[] }
  | {
      readonly accepted: false;
      readonly changedFiles: readonly string[];
      readonly reason: string;
    };

export interface CleanupTimings {
  baselineValidationMs?: number;
  agentMs?: number;
  validationMs?: number;
  repairMs?: number;
}

export interface CleanupAgentResultWithUsage extends CleanupAgentResult {
  readonly usage?: Usage;
}

export interface FileCleanupOutcome {
  readonly verdict: OutcomeVerdict;
  readonly changedFiles: readonly ChangedFileSummary[];
  readonly skippedFiles: readonly SkippedFileSummary[];
  readonly changedPaths: readonly string[];
  readonly validation: readonly CommandRunSummary[];
  readonly timings: CleanupTimings;
  readonly reason?: string;
  /** Repair iterations to reach green: 0 for `clean`, K for `repaired`. */
  readonly iterations?: number;
  /** Set only when `verdict === "regressed"`. */
  readonly regressedReason?: RegressedReason;
  /** Total agent tokens spent on this file (initial edit + repairs). */
  readonly tokens?: number;
  readonly usage?: Usage;
}

interface TimedStep<T> {
  readonly value: T;
  readonly durationMs: number;
}

/** A failed-validation signature carried through the repair loop. `message` is
 * the normalized failed-command + failure-line set used for no-progress
 * detection; all validation failures are treated as fixable (we always retry). */
interface ValidationIssue {
  readonly message: string;
  readonly fixable: true;
}

export function parseWorkflowArgs(argv: readonly string[]): WorkflowArgs {
  const startGroup = parseOptionalGroup(readFlag(argv, "--start-group"));
  const maxFiles = parseOptionalMaxFiles(readFlag(argv, "--max-files"));
  return {
    dryRun: argv.includes("--dry-run"),
    base: readFlag(argv, "--base") ?? "main",
    branch: readFlag(argv, "--branch") ?? DefaultCleanupBranch,
    publish: !argv.includes("--no-publish"),
    monitor: argv.includes("--monitor"),
    evalMode: argv.includes("--eval"),
    ...(startGroup ? { startGroup } : {}),
    ...(maxFiles === undefined ? {} : { maxFiles })
  };
}

export function shouldRunWorkflow(metaMain: boolean, argv: readonly string[] = process.argv): boolean {
  const entrypoint = argv[1] ?? "";
  return metaMain || entrypoint.endsWith("/bin/orca") || entrypoint.endsWith("\\bin\\orca");
}

function parseOptionalMaxFiles(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--max-files must be a positive integer: ${value}`);
  }

  return parsed;
}

function parseOptionalGroup(value: string | undefined): CleanupGroup | undefined {
  if (!value) {
    return undefined;
  }

  if ((CleanupGroupOrder as readonly string[]).includes(value)) {
    return value as CleanupGroup;
  }

  throw new Error(`Unknown cleanup group: ${value}`);
}

function groupsFrom(startGroup: CleanupGroup | undefined): readonly CleanupGroup[] {
  if (!startGroup) {
    return CleanupGroupOrder;
  }

  return CleanupGroupOrder.slice(CleanupGroupOrder.indexOf(startGroup));
}

export function selectCleanupFiles(trackedFiles: readonly string[]): string[] {
  return [...new Set(trackedFiles.map(normalizePath))]
    .filter(isCleanupCandidate)
    .sort((left, right) => left.localeCompare(right));
}

export function isCleanupCandidate(path: string): boolean {
  const normalized = normalizePath(path);
  if (!/^(src|tests)\/.+\.ts$/.test(normalized)) {
    return false;
  }

  if (normalized.endsWith(".d.ts")) {
    return false;
  }

  if (normalized.endsWith(".generated.ts") || normalized.endsWith(".gen.ts")) {
    return false;
  }

  const excludedSegments = new Set([
    "build",
    "coverage",
    "dist",
    "fixtures",
    "generated",
    "__generated__"
  ]);

  return !normalized.split("/").some((segment) => excludedSegments.has(segment));
}

export function groupForFile(path: string): CleanupGroup {
  const normalized = normalizePath(path);
  const testName = basename(normalized);

  if (
    normalized.startsWith("src/conversation/") ||
    normalized.startsWith("src/model/") ||
    testName === "conversation.test.ts" ||
    testName === "model.test.ts"
  ) {
    return "conversation/model";
  }

  if (
    normalized.startsWith("src/backends/") ||
    /^(claude|codex|jsonl|opencode).*\.test\.ts$/.test(testName) ||
    normalized.startsWith("tests/integration/")
  ) {
    return "backends";
  }

  if (
    normalized.startsWith("src/cli/") ||
    normalized.startsWith("src/flow/") ||
    normalized.startsWith("src/runner/") ||
    normalized.startsWith("src/tools/") ||
    /^(cli|flow|tools|typecheck)\.test\.ts$/.test(testName)
  ) {
    return "flow/tools/runner";
  }

  if (
    normalized.startsWith("src/plan/") ||
    normalized.startsWith("src/review/") ||
    /^(plan|review|review-loop|tier2)\.test\.ts$/.test(testName)
  ) {
    return "review/plan";
  }

  if (normalized.startsWith("tests/")) {
    return "tests";
  }

  return "other";
}

export function sortFilesByCleanupGroup(files: readonly string[]): string[] {
  return [...files].sort((left, right) => {
    const leftGroup = CleanupGroupOrder.indexOf(groupForFile(left));
    const rightGroup = CleanupGroupOrder.indexOf(groupForFile(right));
    if (leftGroup !== rightGroup) {
      return leftGroup - rightGroup;
    }
    return left.localeCompare(right);
  });
}

export function planValidationCommands(
  filePath: string,
  availableFiles: readonly string[]
): readonly CommandSpec[] {
  const targetedTest = findTargetedTest(filePath, availableFiles);
  const commands: CommandSpec[] = [];
  if (targetedTest) {
    commands.push({ cmd: "bun", args: ["test", targetedTest] });
  }

  commands.push(
    { cmd: "bun", args: ["run", "typecheck"] },
    { cmd: "bun", args: ["run", "lint"] }
  );

  return commands;
}

export function findTargetedTest(
  filePath: string,
  availableFiles: readonly string[]
): string | undefined {
  const normalized = normalizePath(filePath);
  const testFiles = availableFiles
    .map(normalizePath)
    .filter((path) => /^tests\/.+\.test\.ts$/.test(path) && isCleanupCandidate(path))
    .sort((left, right) => left.localeCompare(right));

  if (normalized.startsWith("tests/") && normalized.endsWith(".test.ts")) {
    return normalized;
  }

  if (!normalized.startsWith("src/")) {
    return undefined;
  }

  const [, area = "", ...rest] = normalized.split("/");
  const stem = basename(normalized, ".ts");
  const relativeWithoutExt = [area, ...rest].join("/").replace(/\.ts$/, "");
  const exactCandidates = [
    `tests/${relativeWithoutExt}.test.ts`,
    `tests/${area}.test.ts`,
    `tests/${area}-${stem}.test.ts`,
    `tests/${stem}.test.ts`
  ];

  for (const candidate of exactCandidates) {
    if (testFiles.includes(candidate)) {
      return candidate;
    }
  }

  const usefulStem = stem === "index" ? area : stem;
  return (
    testFiles.find((path) => basename(path).includes(usefulStem)) ??
    testFiles.find((path) => basename(path).includes(area))
  );
}

export function allowedExtraFilesFor(
  filePath: string,
  availableFiles: readonly string[]
): readonly string[] {
  const targetedTest = findTargetedTest(filePath, availableFiles);
  if (!targetedTest || targetedTest === normalizePath(filePath)) {
    return [];
  }

  return [targetedTest];
}

export function evaluateDiffGuard(
  targetPath: string,
  changedFiles: readonly string[],
  allowedExtraFiles: readonly string[] = []
): DiffGuardResult {
  const target = normalizePath(targetPath);
  const changed = [...new Set(changedFiles.map(normalizePath))].sort((left, right) =>
    left.localeCompare(right)
  );

  if (changed.length === 0) {
    return { accepted: true, changedFiles: changed };
  }

  const allowed = new Set([target, ...allowedExtraFiles.map(normalizePath)]);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    return {
      accepted: false,
      changedFiles: changed,
      reason: `Unexpected file changes: ${unexpected.join(", ")}`
    };
  }

  if (!changed.includes(target)) {
    return {
      accepted: false,
      changedFiles: changed,
      reason: `Patch did not touch ${target}`
    };
  }

  return { accepted: true, changedFiles: changed };
}

export function parseStatusPaths(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3);
      const renamedPath = rawPath.split(" -> ").at(-1) ?? rawPath;
      return normalizePath(renamedPath);
    })
    .sort((left, right) => left.localeCompare(right));
}

export function newChangedPaths(
  beforePaths: readonly string[],
  afterPaths: readonly string[]
): string[] {
  const before = new Set(beforePaths.map(normalizePath));
  return [...new Set(afterPaths.map(normalizePath))]
    .filter((path) => !before.has(path))
    .sort((left, right) => left.localeCompare(right));
}

async function modifiedPreexistingPaths(
  beforeDiffs: ReadonlyMap<string, string>,
  afterStatus: readonly string[]
): Promise<string[]> {
  const candidates = afterStatus.filter((p) => beforeDiffs.has(p));
  const results: string[] = [];
  for (const p of candidates) {
    if ((await diffForPath(p)) !== beforeDiffs.get(p)) {
      results.push(p);
    }
  }
  return results;
}

export function buildPullRequestBody(input: PullRequestSummaryInput): string {
  const changedGroups = unique(input.changedFiles.map((file) => file.group));
  const groupedFiles = changedGroups.map((group) => {
    const files = input.changedFiles.filter((file) => file.group === group);
    return [`### ${group}`, ...files.map(formatChangedFile)].join("\n");
  });

  const skipped =
    input.skippedFiles.length === 0
      ? ["- None"]
      : input.skippedFiles.map((file) => `- ${file.path}: ${file.reason}`);

  const validation =
    input.validation.length === 0
      ? ["- Not run"]
      : input.validation.map((run) => {
          const status = run.status === "passed" ? "PASS" : "FAIL";
          return `- ${status} \`${run.command}\` (${String(run.durationMs)}ms)`;
        });

  const verificationOutput =
    input.validation.length === 0
      ? ["No validation output captured."]
      : input.validation.map((run) =>
          [
            `### ${run.command}`,
            "```text",
            truncateOutput([run.stdout, run.stderr].filter(Boolean).join("\n")) || "(no output)",
            "```"
          ].join("\n")
        );

  return [
    "## Summary",
    "- Removed AI-slop cleanup patterns from tracked TypeScript source and tests.",
    `- Changed groups: ${changedGroups.length === 0 ? "None" : changedGroups.join(", ")}.`,
    "",
    "## Changed Files",
    groupedFiles.length === 0 ? "- None" : groupedFiles.join("\n\n"),
    "",
    "## Skipped/Reverted Files",
    skipped.join("\n"),
    "",
    "## Validation",
    validation.join("\n"),
    "",
    "## Verification Output",
    verificationOutput.join("\n\n")
  ].join("\n");
}

async function timed<T>(fn: () => Promise<T>): Promise<TimedStep<T>> {
  const startedAt = Date.now();
  const value = await fn();
  return { value, durationMs: Date.now() - startedAt };
}

async function monitored<T>(
  monitor: WorkflowMonitor | undefined,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  if (monitor) {
    return await monitor.stage(name, fn);
  }

  return await fn();
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await flow(argv)(async () => {
    await runCleanupWorkflow(parseWorkflowArgs(argv));
  });
}

async function runCleanupWorkflow(args: WorkflowArgs): Promise<void> {
  const selected = selectBackend({
    default: "codex",
    perBackend: {
      codex: { approvalPolicy: "never" },
      opencode: { model: "openai/gpt-5.5" }
    }
  });
  console.log(`Cleanup backend: ${selected.tag}${selected.model ? ` (${selected.model})` : ""}`);
  // Eval mode always records a verdict log — it is the run's only deliverable.
  const monitor = args.monitor || args.evalMode ? new WorkflowMonitor(selected.tag) : undefined;
  try {
    await runCleanupWithBackend(args, selected, monitor);
  } finally {
    await selected.shutdown?.();
    if (monitor) {
      const logDir = process.env.ORCA_MONITOR_DIR ?? join(process.cwd(), ".orca", "monitoring");
      await monitor.writeLog(logDir);
      console.log(`Monitor log written to ${logDir}/${monitor.runId}.json`);
    }
  }
}

async function runCleanupWithBackend(
  args: WorkflowArgs,
  selected: SelectedBackend,
  monitor?: WorkflowMonitor,
): Promise<void> {
  const branch = await monitored(monitor, "setup", async () => {
    await assertCleanWorktree();
    return await ensureCleanupBranch(args.branch);
  });
  const baselineValidation = await monitored(monitor, "baseline validation", () =>
    runCommandPlan([
      { cmd: "bun", args: ["run", "lint"] },
      { cmd: "bun", args: ["run", "typecheck"] },
      { cmd: "bun", args: ["test"] }
    ])
  );

  if (!baselineValidation.passed) {
    throw new Error(
      `Baseline validation failed: ${firstFailure(baselineValidation.runs)?.command ?? "unknown"}`
    );
  }

  const trackedFiles = await monitored(monitor, "list tracked files", listTrackedTypeScriptFiles);
  const groups = groupsFrom(args.startGroup);
  const files = sortFilesByCleanupGroup(selectCleanupFiles(trackedFiles)).filter((file) =>
    groups.includes(groupForFile(file))
  );

  if (args.dryRun) {
    await monitored(monitor, "dry run", () => {
      printDryRun(files, baselineValidation.runs);
      return Promise.resolve();
    });
    return;
  }

  const changedFiles: ChangedFileSummary[] = [];
  const skippedFiles: SkippedFileSummary[] = [];
  const validation: CommandRunSummary[] = [...baselineValidation.runs];
  const acceptedPaths = new Set<string>();
  let processed = 0;

  for (const group of groups) {
    const groupFiles = files.filter((file) => groupForFile(file) === group);

    for (const file of groupFiles) {
      if (acceptedPaths.has(file)) {
        continue;
      }

      if (args.maxFiles !== undefined && processed >= args.maxFiles) {
        console.log(`Reached --max-files=${String(args.maxFiles)}; stopping after a clean group boundary.`);
        break;
      }

      processed += 1;
      const startedAt = Date.now();
      console.log(`Cleaning ${file} (${String(processed)}${args.maxFiles ? `/${String(args.maxFiles)}` : ""})`);
      let outcome: FileCleanupOutcome;
      try {
        outcome = await monitored(monitor, `file:${file}`, () =>
          cleanupFile(file, trackedFiles, acceptedPaths, selected, askAgentForCleanup, monitor)
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        monitor?.recordFailure({ file, error: errorMessage(error), durationMs, category: "file" });
        throw error;
      }
      const durationMs = Date.now() - startedAt;
      const elapsedSeconds = (durationMs / 1000).toFixed(1);
      const skipReason = outcome.skippedFiles[0]?.reason ?? outcome.reason;
      const detail = outcome.verdict === "regressed" && outcome.regressedReason
        ? `${outcome.verdict}:${outcome.regressedReason}`
        : outcome.verdict;
      console.log(`  ${file}: ${detail} in ${elapsedSeconds}s${skipReason ? ` (${skipReason})` : ""}`);
      monitor?.recordOutcome({
        file,
        verdict: outcome.verdict,
        durationMs,
        smellsRemoved: outcome.changedFiles.flatMap((f) => f.smellsRemoved),
        changedPaths: outcome.changedPaths,
        validation: outcome.validation,
        ...(skipReason ? { reason: skipReason } : {}),
        ...(outcome.iterations === undefined ? {} : { iterations: outcome.iterations }),
        ...(outcome.regressedReason === undefined ? {} : { regressedReason: outcome.regressedReason }),
        ...(outcome.tokens === undefined ? {} : { tokens: outcome.tokens }),
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage })
      });
      validation.push(...outcome.validation);
      skippedFiles.push(...outcome.skippedFiles);

      for (const changed of outcome.changedFiles) {
        changedFiles.push(changed);
        acceptedPaths.add(changed.path);
      }
    }

    const dirtyGroupPaths = await dirtyPathsForGroup(group);
    if (dirtyGroupPaths.length > 0) {
      await monitored(monitor, `commit:${group}`, () => commitGroupChanges(group, dirtyGroupPaths));
    }

    if (args.maxFiles !== undefined && processed >= args.maxFiles) {
      break;
    }
  }

  if (args.evalMode) {
    // Eval sink: per-file verdicts are recorded; skip the aggregate verify, the
    // PR, and the publish gate. The runner discards this worktree.
    console.log(`Eval run complete: ${String(changedFiles.length)} changed, ${String(skippedFiles.length)} skipped.`);
    return;
  }

  const finalValidation = await monitored(monitor, "final verify", () =>
    runCommandPlan([{ cmd: "bun", args: ["run", "verify"] }])
  );
  validation.push(...finalValidation.runs);
  const body = buildPullRequestBody({ changedFiles, skippedFiles, validation });
  await monitored(monitor, "write PR body", () => writeText(PullRequestBodyPath, body));

  if (!finalValidation.passed) {
    throw new Error(
      `Final verification failed: ${firstFailure(finalValidation.runs)?.command ?? "unknown"}`
    );
  }

  if (changedFiles.length === 0) {
    throw new Error("No cleanup changes were accepted; PR not created.");
  }

  if (!args.publish) {
    await monitored(monitor, "publish skipped", () => {
      console.log(`Publication skipped by --no-publish. PR body written to ${PullRequestBodyPath}.`);
      return Promise.resolve();
    });
    return;
  }

  await monitored(monitor, "push branch", () => pushBranch(branch));
  await monitored(monitor, "create pull request", () => createPullRequest(args.base));
}

export async function cleanupFile(
  filePath: string,
  trackedFiles: readonly string[],
  acceptedPaths: ReadonlySet<string>,
  selected: SelectedBackend,
  _askAgent: typeof askAgentForCleanup = askAgentForCleanup,
  monitor?: WorkflowMonitor
): Promise<FileCleanupOutcome> {
  const normalizedPath = normalizePath(filePath);
  const timings: CleanupTimings = {};
  const beforeStatus = parseStatusPaths(await statusShort());
  // Snapshot diff content for already-dirty paths so further agent modifications
  // to pre-existing dirty files are detected (path-only comparison misses them).
  const beforeDiffs = new Map<string, string>();
  for (const p of beforeStatus) {
    beforeDiffs.set(p, await diffForPath(p));
  }
  const baselineDiff = await diffForPath(filePath);
  const validationPlan = planValidationCommands(filePath, trackedFiles);
  const fileBaseline = await timed(() =>
    monitored(monitor, `file:${normalizedPath}:baseline validation`, () =>
      runCommandPlan(targetedTestCommands(validationPlan))
    )
  );
  timings.baselineValidationMs = fileBaseline.durationMs;
  if (!fileBaseline.value.passed) {
    return skipped(
      filePath,
      `Targeted baseline failed: ${firstFailure(fileBaseline.value.runs)?.command ?? "unknown"}`,
      "precondition-skip",
      { validation: fileBaseline.value.runs, timings }
    );
  }

  const allowedExtras = allowedExtraFilesFor(filePath, trackedFiles).filter(
    (path) => !acceptedPaths.has(path)
  );

  let tokens = 0;
  const onUsage = (used: number): void => {
    tokens += used;
  };

  let agentResult: CleanupAgentResultWithUsage;
  try {
    const agent = await timed(() =>
      monitored(monitor, `file:${normalizedPath}:agent turn`, () =>
        _askAgent(selected, {
          filePath,
          trackedFiles,
          baselineDiff,
          validationPlan,
          allowedExtras,
          onUsage
        })
      )
    );
    timings.agentMs = agent.durationMs;
    agentResult = agent.value;
  } catch (error) {
    const attemptPaths = await attemptPathsSince(beforeStatus, beforeDiffs);
    await restoreAttempt(attemptPaths);
    // A crashed initial edit is a backend-quality failure, not a neutral skip.
    return skipped(filePath, errorMessage(error), "regressed", { changedPaths: attemptPaths, timings, tokens });
  }

  const attempt = await attemptPathsSince(beforeStatus, beforeDiffs);
  const guard = evaluateDiffGuard(filePath, attempt, allowedExtras);

  if (agentResult.path !== normalizePath(filePath)) {
    await restoreAttempt(attempt);
    return skipped(filePath, `Structured result path mismatch: ${agentResult.path}`, "guard-reject", {
      changedPaths: attempt,
      timings,
      tokens
    });
  }

  if (!agentResult.changed && attempt.length === 0) {
    return declined(tokens, timings, agentResult.usage);
  }

  if (!guard.accepted) {
    await restoreAttempt(attempt);
    return skipped(filePath, guard.reason, "guard-reject", { changedPaths: attempt, timings, tokens });
  }

  // Convergence-guarded repair: re-run the gate and let the agent iterate until
  // green or a guard fires (no-progress signature / wall-clock / ceiling).
  // Depth is NOT capped by a stingy count — we burn tokens to converge.
  const stalled = makeStallDetector();
  let lastValidation: readonly CommandRunSummary[] = [];

  const loop = await fixLoop<ValidationIssue>(
    async () => {
      const validation = await timed(() =>
        monitored(monitor, `file:${normalizedPath}:validation`, () => runCommandPlan(validationPlan))
      );
      timings.validationMs = (timings.validationMs ?? 0) + validation.durationMs;
      lastValidation = validation.value.runs;
      return ok(validation.value.passed ? [] : [validationIssue(validation.value.runs)]);
    },
    async () => {
      const beforeRepair = parseStatusPaths(await statusShort());
      const repairStart = Date.now();
      try {
        await monitored(monitor, `file:${normalizedPath}:repair`, async () =>
          _askAgent(selected, {
            filePath,
            trackedFiles,
            baselineDiff: await diffForPath(filePath),
            validationPlan,
            allowedExtras,
            repairFailure: lastValidation,
            onUsage
          })
        );
      } catch {
        // A crashed repair makes no progress: revert this round and let the
        // no-progress guard settle the verdict on the next evaluation.
        await restoreAttempt(newChangedPaths(beforeRepair, parseStatusPaths(await statusShort())));
        return ok(undefined);
      } finally {
        timings.repairMs = (timings.repairMs ?? 0) + Date.now() - repairStart;
      }
      // Keep the repair in scope: undo any out-of-scope edits it introduced.
      if (!evaluateDiffGuard(filePath, await attemptPathsSince(beforeStatus, beforeDiffs), allowedExtras).accepted) {
        await restoreAttempt(newChangedPaths(beforeRepair, parseStatusPaths(await statusShort())));
      }
      return ok(undefined);
    },
    { maxIterations: RepairCeiling, wallClockMs: RepairWallClockMs, stalled }
  );

  const finalPaths = await attemptPathsSince(beforeStatus, beforeDiffs);

  if (loop.isErr()) {
    await restoreAttempt(finalPaths);
    return skipped(filePath, errorMessage(loop.error), "regressed", {
      validation: lastValidation,
      changedPaths: finalPaths,
      timings,
      tokens
    });
  }

  const summary = loop.value;
  if (summary.converged) {
    const finalGuard = evaluateDiffGuard(filePath, finalPaths, allowedExtras);
    if (!finalGuard.accepted) {
      await restoreAttempt(finalPaths);
      return skipped(filePath, finalGuard.reason, "guard-reject", { changedPaths: finalPaths, timings, tokens });
    }
    const verdict = summary.iterations === 0 ? "clean" : "repaired";
    return changed(finalGuard.changedFiles, agentResult, lastValidation, timings, verdict, summary.iterations, tokens);
  }

  await restoreAttempt(finalPaths);
  return skipped(
    filePath,
    `Could not converge: ${firstFailure(lastValidation)?.command ?? "unknown"}`,
    "regressed",
    { validation: lastValidation, changedPaths: finalPaths, timings, regressedReason: regressedReasonFor(summary.stop), tokens }
  );
}

/** Unique set of paths the agent touched since the pre-attempt snapshot —
 * newly-changed paths plus pre-existing dirty files whose diff changed. */
async function attemptPathsSince(
  beforeStatus: readonly string[],
  beforeDiffs: ReadonlyMap<string, string>
): Promise<readonly string[]> {
  const afterStatus = parseStatusPaths(await statusShort());
  return [
    ...new Set([
      ...newChangedPaths(beforeStatus, afterStatus),
      ...(await modifiedPreexistingPaths(beforeDiffs, afterStatus))
    ])
  ];
}

/** Normalized failure signature for no-progress detection: the set of failed
 * commands plus failure lines with volatile bits (numbers, paths) stripped. */
export function validationSignature(runs: readonly CommandRunSummary[]): string {
  const parts = new Set<string>();
  for (const run of runs) {
    if (run.status !== "failed") continue;
    parts.add(`cmd:${run.command}`);
    for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) {
      if (/\b(fail|error|expected)\b/i.test(line) || /[✗✘]/.test(line)) {
        parts.add(line.replace(/\d+/g, "#").replace(/\/[^\s:]+/g, "/PATH").replace(/\s+/g, " ").trim());
      }
    }
  }
  return [...parts].sort().join("\n");
}

function validationIssue(runs: readonly CommandRunSummary[]): ValidationIssue {
  return { message: validationSignature(runs), fixable: true };
}

/** Stateful no-progress detector: returns true when the current round's
 * signature was already seen — catching both an immediate repeat (stuck) and an
 * A→B→A cycle (oscillation). */
export function makeStallDetector(): (issues: readonly ValidationIssue[]) => boolean {
  const seen = new Set<string>();
  return (issues) => {
    const signature = issues.map((issue) => issue.message).join("\n");
    if (seen.has(signature)) return true;
    seen.add(signature);
    return false;
  };
}

function regressedReasonFor(stop: FixLoopStop): RegressedReason {
  switch (stop) {
    case "timeout":
      return "timeout";
    case "ceiling":
      return "ceiling";
    default:
      return "stuck";
  }
}

async function askAgentForCleanup(
  selected: SelectedBackend,
  args: {
    readonly filePath: string;
    readonly trackedFiles: readonly string[];
    readonly baselineDiff: string;
    readonly validationPlan: readonly CommandSpec[];
    readonly allowedExtras: readonly string[];
    readonly repairFailure?: readonly CommandRunSummary[];
    /** Reports agent token spend (input + output) for convergence-cost scoring. */
    readonly onUsage?: (tokens: number) => void;
  }
): Promise<CleanupAgentResultWithUsage> {
  const conversation = llm().autonomous(selected.backend, {
    prompt: buildCleanupPrompt(args),
    // opencode 1.16.2 hangs when a structured-output (`format`) turn follows tool
    // use, so we skip the native schema request for it and parse the JSON the
    // prompt asks for out of the assistant text instead. Backends whose
    // structured output is reliable keep the native schema path.
    ...(supportsStructuredFormat(selected.tag) ? { schema: CleanupAgentResultSchema } : {}),
    ...(selected.model === undefined ? {} : { config: { model: selected.model } })
  });
  const outcome = await conversation.awaitResult();

  if (outcome.type !== "success") {
    throw new Error(`${selected.tag} cleanup failed for ${args.filePath}: ${JSON.stringify(outcome)}`);
  }

  const usage = outcome.result.usage;
  if (usage !== undefined) {
    args.onUsage?.(usage.input + usage.output);
  }

  const candidate = outcome.result.structured ?? extractJsonObject(outcome.result.output);
  const parsed = CleanupAgentResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`${selected.tag} returned invalid cleanup JSON for ${args.filePath}`);
  }

  return {
    ...parsed.data,
    path: normalizePath(parsed.data.path),
    ...(outcome.result.usage === undefined ? {} : { usage: outcome.result.usage })
  };
}

/** Backends whose native structured-output (`format`/`--output-schema`) is
 * reliable for tool-using turns. opencode 1.16.2 is excluded — see
 * {@link askAgentForCleanup}. */
function supportsStructuredFormat(tag: BackendTag): boolean {
  return tag !== "opencode";
}

/** Best-effort JSON object extraction from assistant text for backends that
 * don't return a native structured payload: try the whole string, then a fenced
 * ```json block, then the last balanced `{...}` span. */
export function extractJsonObject(text: string): unknown {
  const direct = tryParseJson(text.trim());
  if (direct !== undefined) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed !== undefined) {
      return parsed;
    }
  }

  // Scan right-to-left for the last balanced {…} block so earlier braces
  // (code snippets, other JSON objects) don't corrupt the span.
  let searchEnd = text.lastIndexOf("}");
  while (searchEnd !== -1) {
    let depth = 0;
    let matchStart = -1;
    for (let i = searchEnd; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        depth--;
        if (depth === 0) {
          matchStart = i;
          break;
        }
      }
    }
    if (matchStart !== -1) {
      const parsed = tryParseJson(text.slice(matchStart, searchEnd + 1));
      if (parsed !== undefined) {
        return parsed;
      }
    }
    searchEnd = text.lastIndexOf("}", searchEnd - 1);
  }

  return undefined;
}

function tryParseJson(candidate: string): unknown {
  if (candidate === "") {
    return undefined;
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function buildCleanupPrompt(args: {
  readonly filePath: string;
  readonly trackedFiles: readonly string[];
  readonly baselineDiff: string;
  readonly validationPlan: readonly CommandSpec[];
  readonly allowedExtras: readonly string[];
  readonly repairFailure?: readonly CommandRunSummary[];
}): string {
  const target = normalizePath(args.filePath);
  const group = groupForFile(target);
  const allowedExtras =
    args.allowedExtras.length === 0 ? "none" : args.allowedExtras.map((path) => `- ${path}`).join("\n");
  const validation = args.validationPlan.map(renderCommand).join("\n");
  const repairContext = args.repairFailure
    ? [
        "Repair the validation failure from the previous cleanup attempt.",
        "Failure output:",
        ...args.repairFailure.map((run) => `${run.command}\n${truncateOutput(run.stderr || run.stdout)}`)
      ].join("\n")
    : "This is the first cleanup attempt for the file.";

  return [
    "Clean up exactly one tracked TypeScript file for AI-slop smells.",
    `Target file: ${target}`,
    `Subsystem group: ${group}`,
    "",
    repairContext,
    "",
    "Allowed smells to remove:",
    "- unnecessary abstraction",
    "- redundant comments",
    "- duplicated logic",
    "- dead code",
    "- avoidable bespoke code where a local or library helper already exists",
    "- inefficient local patterns",
    "",
    "Constraints:",
    "- Preserve public behavior and public API.",
    "- Avoid broad rewrites, dependency additions, generated output edits, and unrelated cleanup.",
    `- Directly edit ${target}.`,
    `- Extra file edits allowed only for the matching test counterpart: ${allowedExtras}.`,
    "- Do not stage, commit, push, or create a PR.",
    "- Return structured JSON with path, changed, smellsRemoved, validationHint, and risk.",
    "",
    "Relevant validation commands:",
    validation,
    "",
    "Tracked cleanup scope:",
    args.trackedFiles.filter(isCleanupCandidate).join("\n"),
    "",
    "Baseline diff for the target before this attempt:",
    args.baselineDiff.trim() || "(none)"
  ].join("\n");
}

async function listTrackedTypeScriptFiles(): Promise<string[]> {
  const result = await runRequired({
    cmd: "git",
    args: ["ls-files", "src/**/*.ts", "tests/**/*.ts"]
  });
  return result.stdout.split("\n").map(normalizePath).filter(Boolean);
}

async function assertCleanWorktree(): Promise<void> {
  const status = await statusShort();
  if (status.trim() !== "") {
    throw new Error(`AI-slop cleanup requires a clean worktree.\n${status}`);
  }
}

async function ensureCleanupBranch(branchName: string): Promise<string> {
  const current = (await runRequired({ cmd: "git", args: ["branch", "--show-current"] })).stdout.trim();
  if (current === "") {
    throw new Error("AI-slop cleanup requires a named branch, not detached HEAD.");
  }

  if (current !== "main" && current !== "master") {
    return current;
  }

  const branchExists = await command().run({
    command: "git",
    args: ["rev-parse", "--verify", branchName]
  });

  await runRequired({
    cmd: "git",
    args: branchExists.type === "success" ? ["switch", branchName] : ["switch", "-c", branchName]
  });

  return branchName;
}

async function statusShort(): Promise<string> {
  const status = await git().status();
  if (status.isErr()) {
    throw new Error(`git status failed: ${JSON.stringify(status.error)}`);
  }

  return status.value;
}

async function dirtyPathsForGroup(group: CleanupGroup): Promise<readonly string[]> {
  return parseStatusPaths(await statusShort())
    .filter((path) => groupForFile(path) === group)
    .sort((left, right) => left.localeCompare(right));
}

async function diffForPath(filePath: string): Promise<string> {
  return (
    await runRequired({
      cmd: "git",
      args: ["diff", "--", normalizePath(filePath)]
    })
  ).stdout;
}

async function runCommandPlan(commands: readonly CommandSpec[]): Promise<{
  readonly passed: boolean;
  readonly runs: readonly CommandRunSummary[];
}> {
  const runs: CommandRunSummary[] = [];
  for (const spec of commands) {
    const run = await runCommand(spec);
    runs.push(run);
    if (run.status === "failed") {
      return { passed: false, runs };
    }
  }

  return { passed: true, runs };
}

function targetedTestCommands(commands: readonly CommandSpec[]): readonly CommandSpec[] {
  return commands.filter((spec) => spec.cmd === "bun" && spec.args[0] === "test");
}

async function runCommand(spec: CommandSpec): Promise<CommandRunSummary> {
  const result = await command().run({
    command: spec.cmd,
    args: spec.args,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs })
  });
  return {
    command: renderCommand(spec),
    status: result.type === "success" ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs
  };
}

async function runRequired(spec: CommandSpec): Promise<CommandRunSummary> {
  const result = await runCommand(spec);
  if (result.status === "failed") {
    throw new Error(`Command failed: ${result.command}\n${result.stderr || result.stdout}`);
  }

  return result;
}

async function commitGroupChanges(group: CleanupGroup, paths: readonly string[]): Promise<void> {
  const add = await git().add(paths);
  if (add.isErr()) {
    throw new Error(`git add failed for ${group}: ${JSON.stringify(add.error)}`);
  }

  const commit = await git().commit(commitMessageForGroup(group));
  if (commit.isErr()) {
    throw new Error(`git commit failed for ${group}: ${JSON.stringify(commit.error)}`);
  }
}

function commitMessageForGroup(group: CleanupGroup): string {
  return group === "other"
    ? "Clean up miscellaneous implementation noise"
    : `Clean up ${group} implementation noise`;
}

async function restoreAttempt(paths: readonly string[]): Promise<void> {
  const normalized = [...new Set(paths.map(normalizePath))].filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  await command().run({ command: "git", args: ["restore", "--staged", "--worktree", "--", ...normalized] });
  await command().run({ command: "git", args: ["clean", "-fd", "--", ...normalized] });
}

async function writeText(path: string, content: string): Promise<void> {
  const result = await fs().writeText(path, content);
  if (result.isErr()) {
    throw new Error(`Failed to write ${path}: ${JSON.stringify(result.error)}`);
  }
}

async function pushBranch(branch: string): Promise<void> {
  await runRequired({ cmd: "git", args: ["push", "-u", "origin", branch] });
}

async function createPullRequest(base: string): Promise<void> {
  const result = await gh().createPullRequest({
    title: PullRequestTitle,
    bodyFile: PullRequestBodyPath,
    base
  });

  if (result.isErr()) {
    throw new Error(`gh pr create failed: ${JSON.stringify(result.error)}`);
  }
}

function changed(
  changedPaths: readonly string[],
  agentResult: CleanupAgentResultWithUsage,
  validation: readonly CommandRunSummary[],
  timings: CleanupTimings,
  verdict: "clean" | "repaired",
  iterations: number,
  tokens: number
): FileCleanupOutcome {
  return {
    verdict,
    changedFiles: changedPaths.map((path) => ({
      path,
      group: groupForFile(path),
      smellsRemoved: agentResult.smellsRemoved,
      risk: agentResult.risk
    })),
    skippedFiles: [],
    changedPaths,
    validation,
    timings,
    iterations,
    tokens,
    ...(agentResult.usage === undefined ? {} : { usage: agentResult.usage })
  };
}

/** Build a skip/revert outcome with an explicit verdict. Defaults to `guard-reject`
 * but callers pass `precondition-skip`, `guard-reject`, or `regressed`. */
function skipped(
  filePath: string,
  reason: string,
  verdict: Exclude<OutcomeVerdict, "clean" | "repaired" | "declined"> = "guard-reject",
  extra: {
    readonly validation?: readonly CommandRunSummary[];
    readonly changedPaths?: readonly string[];
    readonly timings?: CleanupTimings;
    readonly regressedReason?: RegressedReason;
    readonly tokens?: number;
  } = {}
): FileCleanupOutcome {
  return {
    verdict,
    changedFiles: [],
    skippedFiles: [{ path: normalizePath(filePath), reason }],
    changedPaths: extra.changedPaths ?? [],
    validation: extra.validation ?? [],
    timings: extra.timings ?? {},
    reason,
    ...(extra.regressedReason === undefined ? {} : { regressedReason: extra.regressedReason }),
    ...(extra.tokens === undefined ? {} : { tokens: extra.tokens })
  };
}

/** Neutral no-op: the agent made no edits and there was nothing to clean. */
function declined(tokens: number, timings: CleanupTimings = {}, usage?: Usage): FileCleanupOutcome {
  return {
    verdict: "declined",
    changedFiles: [],
    skippedFiles: [],
    changedPaths: [],
    validation: [],
    timings,
    ...(tokens === 0 ? {} : { tokens }),
    ...(usage === undefined ? {} : { usage })
  };
}

function firstFailure(runs: readonly CommandRunSummary[]): CommandRunSummary | undefined {
  return runs.find((run) => run.status === "failed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function printDryRun(files: readonly string[], validation: readonly CommandRunSummary[]): void {
  console.log(`AI-slop cleanup dry run: ${String(files.length)} files`);
  for (const group of CleanupGroupOrder) {
    const groupFiles = files.filter((file) => groupForFile(file) === group);
    if (groupFiles.length > 0) {
      console.log(`${group}:`);
      for (const file of groupFiles) {
        console.log(`  ${file}`);
      }
    }
  }

  console.log("Baseline validation:");
  for (const run of validation) {
    console.log(`  ${run.status.toUpperCase()} ${run.command}`);
  }
}


function readFlag(argv: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg?.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }

    if (arg === flag) {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        return value;
      }
    }
  }

  return undefined;
}

function renderCommand(spec: CommandSpec): string {
  return [spec.cmd, ...spec.args].join(" ");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function formatChangedFile(file: ChangedFileSummary): string {
  const smells = file.smellsRemoved.length === 0 ? "reported cleanup" : file.smellsRemoved.join(", ");
  return `- ${file.path}: ${smells} (risk: ${file.risk})`;
}

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= 1200) {
    return trimmed;
  }

  return `${trimmed.slice(0, 1200)}\n... truncated ...`;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

if (shouldRunWorkflow(import.meta.main)) {
  await main(process.argv.slice(2));
}
