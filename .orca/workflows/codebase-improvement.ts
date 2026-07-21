import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as ts from "typescript";
import {
  codex,
  command,
  fixLoop,
  flow,
  flowArgs,
  fs,
  llm,
  ok,
  resolveBaselinePolicy,
  runBaselineGate,
  selectBackend,
  WorkflowMonitor,
  z,
  type BackendTag,
  type CommandTool,
  type CommandLog,
  type FixLoopStop,
  type Outcome,
  type RegressedReason,
  type Usage,
  type VerificationCommand,
} from "@twelvehart/orcats";
import {
  assertCurrentBranch,
  assertCandidateFitsActiveProfile,
  assertMergedPullRequestState,
  assertImmutableTestDiff,
  assertRequiredMergeProtection,
  assertReadyPullRequestHead,
  candidateRedMarker,
  CandidateControlSchema,
  CandidateRequiresSplitError,
  ComplexityProfileSchema,
  controlTestArgs,
  controlTestName,
  createActiveStageBudgetTracker,
  DeliveryRecordSchema,
  hydrateCandidate,
  mergeUsage,
  namedTestArgs,
  normalizeFailure,
  parseRemoteChecksCommandResult,
  profileLimits,
  pullRequestCreateArgs,
  renderScoutEvidence,
  renderShellCommand,
  requireLauncherDeliveryIdentity,
  requireRecordedUsage,
  remoteCheckState,
  runRankedCandidateFallback,
  ScopedScoutResultSchema,
  selectScoutEvidence,
  stageBudgetMs,
  stageConfig,
  validateCandidateEvidence,
  validateCandidateForProfile,
  validateScopedScoutResult,
  validateChangedPaths,
  withSelectedModel,
  WorkflowConfigSchema,
  type Candidate,
  type ComplexityProfile,
  type DeliveryRecordV1,
  type PullRequestIdentity,
  type ScoutEvidenceFile,
  type ScoutEvidencePacket,
  type ScoutResult,
  type ScopedScoutResult,
  type WorkflowConfig,
} from "./codebase-improvement-lib.ts";
import {
  assertGitManifestUnchanged,
  assertPositiveControlEvidence,
  assertRedGateEvidence,
  assertSemanticPositiveControl,
  awaitBounded,
  awaitExpectedFileChange,
  awaitToolFreeOutcome,
  awaitWithinDeadline,
  captureFileContentManifest,
  captureGitWorktreeManifest,
  captureExactFileSnapshot,
  ConversationTimeoutError,
  createWorkflowStatusWriter,
  decodeUtf8Source,
  finalizeWorkflowEvidence,
  gateIssuesFromLogs,
  hasConfirmedExpectedFileChange,
  InvalidReproductionProofError,
  matcherProofArgs,
  MATCHER_PROOF_PRELOAD_SOURCE,
  parseGitCommitManifest,
  parseGitIndexManifest,
  parseExactGitPathList,
  publishFinalizationText as publishFinalizationTextSecure,
  remainingTimeout,
  reserveConversationTimeouts,
  restoreExactFileSnapshot,
  runTargetAfterPositiveControl,
  runRequiredCommand,
  finalizeScopedScoutRecords,
  runScopedScoutFanout,
  withGitManifestGuard,
  type BoundedConversation,
  type ExactFileSnapshot,
  type ExactRestorationEvidence,
  type ExactSnapshotOperations,
  type FinalizationCommitDecision,
  type FinalizationContext,
  type GateIssue,
  type GitManifestEntry,
  type SemanticPositiveControlEvidence,
  type TimeoutRetryRecord,
} from "./codebase-improvement-runtime.ts";

const BASELINE_GATE = [
  { command: "bun", args: ["test"], timeoutMs: 30_000 },
  { command: "bun", args: ["run", "lint"], timeoutMs: 30_000 },
] as const;
const FULL_GATE = {
  command: "bun",
  args: ["run", "verify"],
  timeoutMs: 75_000,
} as const;
const CONFIG_PATH = ".orca/workflows/codebase-improvement.config.json";
const PLAN_PATH = ".orca/improvement-loop/plan.json";
const RED_DIFF_PATH = ".orca/improvement-loop/red-test.diff";
const MATCHER_PROOF_PRELOAD_PATH =
  ".orca/improvement-loop/matcher-proof-preload.ts";
const ISSUE_PATH = ".orca/improvement-loop/issues.jsonl";
const REPORT_DIR = ".orca/improvement-loop/runs";
const SIMPLE_STAGE_LIMITS = {
  preflight: 300_000,
  scout: 155_000,
  reproduce: 120_000,
  implement: 300_000,
  repairs: 180_000,
  review: 180_000,
  verify: 180_000,
  delivery: 180_000,
} as const;
const SCOUT_GATHER_LIMIT_MS = 15_000;
const SCOUT_MODEL_LIMIT_MS = 120_000;
const SCOUT_VALIDATION_LIMIT_MS = 20_000;
const CONVERSATION_SETTLEMENT_RESERVE_MS = 5_000;
const SCOUT_EVIDENCE_MAX_FILES = 8;
const SCOUT_EVIDENCE_MAX_CHARS = 10_000;
const FALLBACK_CONTROL_LIMIT_MS = 10_000;
const RUNTIME_FINALIZATION_RESERVE_MS = 60_000;
const DELIVERY_CONTINUATION_DEADLINE_MS = 30 * 60_000;
const DELIVERY_RECORD_LOCK_STALE_MS = 60_000;
const PROFILE_SCALE = {
  simple: 1,
  medium: 2,
  challenging: 4,
} as const;
const BACKEND_READINESS: Record<
  BackendTag,
  { readonly command: string; readonly args: readonly string[] }
> = {
  codex: { command: "codex", args: ["login", "status"] },
  opencode: { command: "opencode", args: ["auth", "list"] },
  claude: { command: "claude", args: ["--version"] },
  pi: { command: "pi", args: ["--version"] },
};
const MONITOR_DIR = ".orca/monitoring";
const IGNORED_ORCA_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const IGNORED_ORCA_MANIFEST_MAX_ENTRIES = 1_024;
const IGNORED_ORCA_MANIFEST_MAX_PATH_BYTES = 256 * 1024;
const ReviewResultSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      evidence: z.string().trim().min(1),
      recommendation: z.string().trim().min(1),
      fixable: z.boolean(),
    }),
  ),
});
const PullRequestHeadSchema = z.object({
  url: z.string().url(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  isDraft: z.boolean(),
});
const PreflightAttestationSchema = z.object({
  runId: z.string().min(1),
  runtimeHead: z.string().min(1),
  runtimeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
  checkedAt: z.string().min(1),
});

type ReviewFinding = z.infer<typeof ReviewResultSchema>["findings"][number];
type StageLimit = keyof typeof SIMPLE_STAGE_LIMITS;
type DeliveryReadyPullRequest = z.infer<typeof PullRequestHeadSchema>;
type DeliveryMergedPullRequest = DeliveryReadyPullRequest & {
  readonly state: string;
};
type SemanticControlEvidence = SemanticPositiveControlEvidence & {
  readonly testAstSha256: string;
};

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
  semanticControl?: SemanticControlEvidence;
  restoration?: ExactRestorationEvidence;
}

type ExactTestSnapshot = ExactFileSnapshot;

interface AcceptedReproduction {
  readonly candidate: Candidate;
  readonly control: ScoutResult["selectedControl"];
  readonly redDiff: string;
  readonly semanticControl: SemanticControlEvidence;
}

interface RunReport {
  runId: string;
  monitorRunId: string;
  profile: ComplexityProfile;
  startedAtMs: number;
  workerDeadlineAtMs: number;
  finishedAtMs?: number;
  elapsedMs?: number;
  backend: string;
  stage: string;
  baseSha: string;
  worktree: string;
  branch: string;
  artifactDigest: string;
  preflightPath: string;
  preflightRunId: string;
  preflightArtifactDigest: string;
  appliedSystemPrompts: Partial<
    Record<
      "scout" | "reproduce" | "implement" | "repair" | "review",
      string
    >
  >;
  candidate?: Candidate;
  scoutEvidence?: {
    paths: string[];
    sourceTestPairs: Array<{
      sourcePath: string;
      testPath: string;
    }>;
    charCount: number;
    sha256: string;
    attempts: TimeoutRetryRecord[];
    candidates?: ScoutResult["candidates"];
    ranking?: string[];
    selectedControl?: ScoutResult["selectedControl"];
    acceptedControl?: ScoutResult["selectedControl"];
    latestCommit?: string;
    commands: CommandLog[];
    scopes?: Array<{
      scopeIndex: number;
      label: string;
      status: string;
      sourcePath: string;
      testPath: string;
      sha256: string;
      reason?: string;
      validationIssues?: readonly string[];
    }>;
    splitReason?: string;
  };
  redDiffPath?: string;
  rejectedCandidates: RejectedCandidateEvidence[];
  validation: CommandLog[];
  prUrl?: string;
  matchedHeadSha?: string;
  deliveryRecordPath?: string;
  activeStatus: "pending" | "ready" | "failed";
  deliveryStatus: "pending" | "blocked" | "delivered";
  semanticControl?: SemanticControlEvidence;
  repository: string;
  originFetchUrl: string;
  originPushUrl: string;
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
  classification:
    | "environment"
    | "baseline"
    | "backend"
    | "gate"
    | "review"
    | "scope"
    | "remote-check"
    | "merge"
    | "sla-overrun";
  stage: string;
  elapsedMs: number;
  evidence: string;
  backend: string;
  worktree: string;
  branch: string;
  monitorPath: string;
  prUrl?: string;
  status: "open" | "corrected" | "resolved";
  provingRunId?: string;
}

async function awaitConversationWithinBudget<T>(
  conversation: BoundedConversation<T>,
  availableMs: number,
  stage: string,
  recordUsage: (usage: Usage | undefined) => void,
): Promise<T> {
  const timeouts = reserveConversationTimeouts(
    availableMs,
    availableMs,
    CONVERSATION_SETTLEMENT_RESERVE_MS,
    stage,
  );
  try {
    return await awaitBounded(
      conversation,
      timeouts.activeTimeoutMs,
      stage,
      timeouts.settlementTimeoutMs,
    );
  } catch (error) {
    if (
      error instanceof ConversationTimeoutError &&
      error.terminal?.status === "fulfilled"
    ) {
      const outcome = error.terminal.value;
      if (
        typeof outcome === "object" &&
        outcome !== null &&
        "type" in outcome &&
        outcome.type === "success" &&
        "result" in outcome &&
        typeof outcome.result === "object" &&
        outcome.result !== null &&
        "usage" in outcome.result
      ) {
        const usage = outcome.result.usage;
        const reasoning =
          typeof usage === "object" &&
          usage !== null &&
          "reasoning" in usage
            ? usage.reasoning
            : undefined;
        if (
          typeof usage === "object" &&
          usage !== null &&
          "input" in usage &&
          typeof usage.input === "number" &&
          Number.isInteger(usage.input) &&
          usage.input >= 0 &&
          "output" in usage &&
          typeof usage.output === "number" &&
          Number.isInteger(usage.output) &&
          usage.output >= 0 &&
          (reasoning === undefined ||
            (typeof reasoning === "number" &&
              Number.isInteger(reasoning) &&
              reasoning >= 0))
        ) {
          recordUsage({
            input: usage.input,
            output: usage.output,
            ...(reasoning === undefined ? {} : { reasoning }),
          });
        }
      }
    }
    throw error;
  }
}

interface DeliveryContinuationDependencies {
  readonly deadlineAtMs?: number;
  readonly now: () => number;
  readonly readProtection: (remainingMs: number) => Promise<{
    readonly valid: boolean;
    readonly log: CommandLog;
  }>;
  readonly readChecks: (remainingMs: number) => Promise<{
    readonly state: "pending" | "passed" | "failed";
    readonly log: CommandLog;
  }>;
  readonly readPullRequest: (
    phase: "ready" | "merged",
    remainingMs: number,
  ) => Promise<{
    readonly pr: DeliveryReadyPullRequest | DeliveryMergedPullRequest;
    readonly log: CommandLog;
  }>;
  readonly merge: (
    lockedHeadSha: string,
    remainingMs: number,
  ) => Promise<CommandLog>;
  readonly requireActiveReadyReport: (record: DeliveryRecordV1) => Promise<void>;
  readonly persist: (
    record: DeliveryRecordV1,
    persistenceDeadlineAtMs?: number,
  ) => Promise<void>;
}

interface DeliveryContinuationResult {
  readonly status: "pending" | "blocked" | "delivered";
  readonly exitCode: 0 | 1 | 75;
  readonly record: DeliveryRecordV1;
}

function parseDeliveryReportEvidence(rawReport: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(rawReport);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("delivery report evidence must be an object");
  }
  return parsed as Record<string, unknown>;
}

function renderDeliveryReportEvidence(
  rawReport: string,
  record: DeliveryRecordV1,
  deliveryRecordPath: string,
): string {
  const report = parseDeliveryReportEvidence(rawReport);
  const expected: ReadonlyArray<readonly [string, unknown, string]> = [
    ["runId", record.runId, "run ID"],
    ["profile", record.active.profile, "profile"],
    ["repository", record.repository, "repository"],
    ["prUrl", record.prUrl, "pull request URL"],
    ["branch", record.branch, "branch"],
    ["matchedHeadSha", record.lockedHeadSha, "locked head SHA"],
    ["activeStatus", "ready", "active status"],
    ["sla", "passed", "SLA status"],
  ];
  for (const [field, value, label] of expected) {
    if (report[field] !== value) {
      throw new Error(`delivery report ${label} does not match record`);
    }
  }
  const relativeDeliveryRecordPath =
    `.orca/improvement-loop/runs/${record.runId}/delivery.json`;
  if (report.deliveryRecordPath !== relativeDeliveryRecordPath) {
    throw new Error("delivery report path does not match record");
  }
  if (!deliveryRecordPath.endsWith(relativeDeliveryRecordPath)) {
    throw new Error("delivery record path does not match report");
  }
  if (
    report.deliveryStatus !== "pending" &&
    report.deliveryStatus !== "blocked" &&
    report.deliveryStatus !== "delivered"
  ) {
    throw new Error("delivery report status is invalid");
  }
  return `${JSON.stringify(
    { ...report, deliveryStatus: record.delivery.status },
    null,
    2,
  )}\n`;
}

function assertActiveReadyDeliveryReport(
  rawReport: string,
  record: DeliveryRecordV1,
  deliveryRecordPath: string,
): void {
  const report = parseDeliveryReportEvidence(rawReport);
  if (report.deliveryStatus !== record.delivery.status) {
    throw new Error("delivery report status does not match record");
  }
  void renderDeliveryReportEvidence(rawReport, record, deliveryRecordPath);
}

function parseDeliveryContinuationArgs(args: readonly string[]): string | undefined {
  const continuation = args.filter((arg) => arg.startsWith("--continue-delivery="));
  if (continuation.length === 0) return undefined;
  const continuationArgument = continuation[0];
  if (
    continuation.length !== 1 ||
    args.length !== 1 ||
    continuationArgument === undefined
  ) {
    throw new Error("--continue-delivery must be used alone");
  }
  const runId = continuationArgument.slice("--continue-delivery=".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("--continue-delivery requires a valid run ID");
  }
  return runId;
}

async function runDeliveryContinuation(
  rawRecord: string,
  dependencies: DeliveryContinuationDependencies,
): Promise<DeliveryContinuationResult> {
  const record = DeliveryRecordSchema.parse(JSON.parse(rawRecord));
  const startedAtMs = dependencies.now();
  const deadlineAtMs =
    dependencies.deadlineAtMs ?? startedAtMs + DELIVERY_CONTINUATION_DEADLINE_MS;
  const identity: PullRequestIdentity = {
    repository: record.repository,
    branch: record.branch,
    headSha: record.lockedHeadSha,
  };
  const checks: CommandLog[] = [];
  let latestPr: DeliveryReadyPullRequest | undefined;

  const remaining = (operation: string): number => {
    const value = deadlineAtMs - dependencies.now();
    if (value <= 0) throw new Error(`delivery continuation exceeded deadline before ${operation}`);
    return value;
  };
  const expired = (): boolean => dependencies.now() >= deadlineAtMs;
  const finish = async (
    status: "pending" | "blocked" | "delivered",
    merge?: CommandLog,
  ): Promise<DeliveryContinuationResult> => {
    const finishedAtMs = Math.max(startedAtMs, dependencies.now());
    const next = DeliveryRecordSchema.parse({
      ...record,
      delivery: {
        status,
        attempts: [
          ...record.delivery.attempts,
          {
            startedAtMs,
            finishedAtMs,
            status,
            ...(latestPr === undefined ? {} : { pr: latestPr }),
            ...(checks.length === 0 ? {} : { checks }),
            ...(merge === undefined ? {} : { merge }),
          },
        ],
      },
    });
    await dependencies.persist(next, deadlineAtMs);
    return {
      status,
      exitCode: status === "delivered" ? 0 : status === "pending" ? 75 : 1,
      record: next,
    };
  };
  const readReady = async (): Promise<"ok" | "pending" | "blocked"> => {
    if (expired()) return "pending";
    try {
      const read = await dependencies.readPullRequest("ready", remaining("PR identity"));
      checks.push(read.log);
      assertReadyPullRequestHead(read.pr, identity);
      latestPr = read.pr;
      return "ok";
    } catch {
      return expired() ? "pending" : "blocked";
    }
  };

  if (record.delivery.status !== "pending") {
    return {
      status: record.delivery.status,
      exitCode: record.delivery.status === "delivered" ? 0 : 1,
      record,
    };
  }
  try {
    await dependencies.requireActiveReadyReport(record);
  } catch {
    return await finish("blocked");
  }
  const initialReady = await readReady();
  if (initialReady !== "ok") return await finish(initialReady);

  let initialChecks: Awaited<ReturnType<DeliveryContinuationDependencies["readChecks"]>>;
  try {
    initialChecks = await dependencies.readChecks(remaining("initial checks"));
  } catch {
    return await finish(expired() ? "pending" : "blocked");
  }
  checks.push(initialChecks.log);
  if (initialChecks.state === "failed") return await finish("blocked");
  if (initialChecks.state === "pending" || expired()) {
    return await finish("pending");
  }

  if (expired()) return await finish("pending");
  let protection: Awaited<ReturnType<DeliveryContinuationDependencies["readProtection"]>>;
  try {
    protection = await dependencies.readProtection(remaining("merge protection"));
  } catch {
    return await finish(expired() ? "pending" : "blocked");
  }
  checks.push(protection.log);
  if (!protection.valid) return await finish("blocked");

  if (expired()) return await finish("pending");
  let freshChecks: Awaited<ReturnType<DeliveryContinuationDependencies["readChecks"]>>;
  try {
    freshChecks = await dependencies.readChecks(remaining("fresh checks"));
  } catch {
    return await finish(expired() ? "pending" : "blocked");
  }
  checks.push(freshChecks.log);
  if (freshChecks.state === "failed") return await finish("blocked");
  if (freshChecks.state === "pending" || expired()) return await finish("pending");
  const freshReady = await readReady();
  if (freshReady !== "ok") return await finish(freshReady);

  if (expired()) return await finish("pending");
  let merge: CommandLog | undefined;
  const confirmMerged = async (): Promise<DeliveryContinuationResult | undefined> => {
    if (expired()) return await finish("pending", merge);
    let confirmation: { readonly pr: DeliveryReadyPullRequest; readonly log: CommandLog };
    try {
      confirmation = await dependencies.readPullRequest(
        "merged",
        remaining("merged confirmation"),
      );
    } catch {
      // A post-merge read can fail after GitHub accepted the merge. The
      // terminal state is unknown, so preserve the record for a retry.
      return await finish("pending", merge);
    }
    try {
      const mergedPr = confirmation.pr as DeliveryMergedPullRequest;
      assertMergedPullRequestState(mergedPr, identity);
      latestPr = {
        url: mergedPr.url,
        baseRefName: mergedPr.baseRefName,
        headRefName: mergedPr.headRefName,
        headRefOid: mergedPr.headRefOid,
        isDraft: mergedPr.isDraft,
      };
      return await finish("delivered", merge);
    } catch {
      // The response was authoritative, but it no longer proves the
      // immutable delivery identity or merged state.
      return await finish("blocked", merge);
    }
  };
  try {
    merge = await dependencies.merge(record.lockedHeadSha, remaining("merge"));
  } catch {
    const confirmed = await confirmMerged();
    if (confirmed !== undefined) return confirmed;
    return await finish(expired() ? "pending" : "blocked");
  }
  const confirmed = await confirmMerged();
  if (confirmed !== undefined) return confirmed;
  return await finish(expired() ? "pending" : "blocked", merge);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function acquireDeliveryRecordLock(
  destination: string,
  deadlineAtMs?: number,
): Promise<string> {
  const lock = `${destination}.lock`;
  let retryingExistingLock = false;
  while (true) {
    if (retryingExistingLock && deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      throw new Error("delivery record lock wait exceeded continuation deadline");
    }
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        await writeDeliveryRecordLockOwner(lock);
        return lock;
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      if (await recoverStaleDeliveryRecordLock(lock)) continue;
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        throw new Error("delivery record lock wait exceeded continuation deadline");
      }
      const delayMs =
        deadlineAtMs === undefined ? 10 : Math.min(10, deadlineAtMs - Date.now());
      if (delayMs <= 0) {
        throw new Error("delivery record lock wait exceeded continuation deadline");
      }
      retryingExistingLock = true;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

interface DeliveryRecordLockOwner {
  readonly pid: number;
  readonly createdAtMs: number;
}

function parseDeliveryRecordLockOwner(raw: string): DeliveryRecordLockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
      !Number.isSafeInteger((parsed as { createdAtMs?: unknown }).createdAtMs)
    ) {
      return undefined;
    }
    const { pid, createdAtMs } = parsed as DeliveryRecordLockOwner;
    return pid > 0 && createdAtMs >= 0 ? { pid, createdAtMs } : undefined;
  } catch {
    return undefined;
  }
}

async function writeDeliveryRecordLockOwner(lock: string): Promise<void> {
  await writeFile(
    `${lock}/owner.json`,
    `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`,
    { mode: 0o600 },
  );
}

function isDeliveryRecordLockOwnerLive(owner: DeliveryRecordLockOwner): boolean {
  if (typeof process.kill !== "function") return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, "ESRCH");
  }
}

async function recoverStaleDeliveryRecordLock(lock: string): Promise<boolean> {
  let owner: DeliveryRecordLockOwner | undefined;
  try {
    owner = parseDeliveryRecordLockOwner(await readFile(`${lock}/owner.json`, "utf8"));
  } catch {
    // A process killed between mkdir and owner publication is reclaimable only
    // after the directory lease expires.
  }
  if (owner !== undefined && isDeliveryRecordLockOwnerLive(owner)) return false;
  try {
    const lockStat = await stat(lock);
    if (Date.now() - lockStat.mtimeMs < DELIVERY_RECORD_LOCK_STALE_MS) {
      return false;
    }
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return true;
    throw error;
  }
  const staleLock = `${lock}.stale-${String(process.pid)}-${String(Date.now())}`;
  try {
    await rename(lock, staleLock);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return true;
    throw error;
  }
  await rm(staleLock, { recursive: true, force: true });
  return true;
}

function mergeDeliveryAttempt(
  current: DeliveryRecordV1,
  next: DeliveryRecordV1,
): DeliveryRecordV1 {
  if (current.runId !== next.runId) {
    throw new Error("delivery record run ID changed during continuation");
  }
  if (current.delivery.status !== "pending") return current;
  if (next.delivery.attempts.length === 0) {
    throw new Error("delivery continuation did not produce an attempt");
  }
  const attempt = next.delivery.attempts[next.delivery.attempts.length - 1];
  return DeliveryRecordSchema.parse({
    ...current,
    delivery: {
      status:
        current.delivery.status === "pending"
          ? next.delivery.status
          : current.delivery.status,
      attempts: [...current.delivery.attempts, attempt],
    },
  });
}

async function persistDeliveryRecordAtomically(
  destination: string,
  record: DeliveryRecordV1,
  deadlineAtMs?: number,
  heldLock?: string,
): Promise<void> {
  const lock = heldLock ?? (await acquireDeliveryRecordLock(destination, deadlineAtMs));
  try {
    const current = DeliveryRecordSchema.parse(
      JSON.parse(await readFile(destination, "utf8")),
    );
    const merged = mergeDeliveryAttempt(current, record);
    if (merged === current) return;
    const temporary = `${destination}.delivery-${String(process.pid)}-${String(Date.now())}.tmp`;
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, destination);
  } finally {
    if (heldLock === undefined) {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

async function persistDeliveryReportEvidence(
  destination: string,
  value: string,
  deadlineAtMs?: number,
): Promise<void> {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error("delivery report persistence exceeded continuation deadline");
  }
  const temporary = `${destination}.delivery-report-${String(process.pid)}-${String(Date.now())}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    await rm(temporary, { force: true });
    throw new Error("delivery report persistence exceeded continuation deadline");
  }
  await rename(temporary, destination);
}

await flow(flowArgs())(async () => {
  const continuationRunId = parseDeliveryContinuationArgs(flowArgs());
  if (continuationRunId !== undefined) {
    const deliveryRecordPath = requiredEnvironment(
      "ORCA_IMPROVEMENT_DELIVERY_RECORD_PATH",
    );
    const deliveryDeadlineAtMs = parseDeliveryContinuationDeadlineAtMs(
      requiredEnvironment("ORCA_IMPROVEMENT_DELIVERY_DEADLINE_AT_MS"),
      Date.now(),
    );
    const deliveryLock = await acquireDeliveryRecordLock(
      deliveryRecordPath,
      deliveryDeadlineAtMs,
    );
    try {
      const rawRecord = await readFile(deliveryRecordPath, "utf8");
      const launcherValidatedRecord = DeliveryRecordSchema.parse(JSON.parse(rawRecord));
      if (launcherValidatedRecord.runId !== continuationRunId) {
        throw new Error("delivery record run ID does not match continuation");
      }
      if (!deliveryRecordPath.endsWith("delivery.json")) {
        throw new Error("delivery record path must end with delivery.json");
      }
      const deliveryReportPath = `${deliveryRecordPath.slice(
        0,
        -"delivery.json".length,
      )}report.json`;
      let activeReadyReport = await readFile(deliveryReportPath, "utf8");
      const persistDeliveryReportMirror = async (record: DeliveryRecordV1) => {
        const renderedDeliveryReport = renderDeliveryReportEvidence(
          activeReadyReport,
          record,
          deliveryRecordPath,
        );
        await persistDeliveryReportEvidence(
          deliveryReportPath,
          renderedDeliveryReport,
          deliveryDeadlineAtMs,
        );
        return renderedDeliveryReport;
      };
      const renderedDeliveryReport = await persistDeliveryReportMirror(launcherValidatedRecord);
      activeReadyReport = renderedDeliveryReport;
      if (launcherValidatedRecord.delivery.status !== "pending") {
        process.exitCode = launcherValidatedRecord.delivery.status === "delivered" ? 0 : 1;
        return;
      }
      const commandLog = async (
        commandName: string,
        args: readonly string[],
        remainingMs: number,
      ) => {
        const result = await command().run({
          command: commandName,
          args,
          timeoutMs: remainingTimeout(
            30_000,
            remainingMs,
            [commandName, ...args].join(" "),
          ),
        });
        return {
          result,
          log: {
            command: [commandName, ...args].join(" "),
            status: result.type === "success" ? ("passed" as const) : ("failed" as const),
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          },
        };
      };
      const outcome = await runDeliveryContinuation(rawRecord, {
        deadlineAtMs: deliveryDeadlineAtMs,
        now: Date.now,
        requireActiveReadyReport: (record) => {
          assertActiveReadyDeliveryReport(
            activeReadyReport,
            record,
            deliveryRecordPath,
          );
          return Promise.resolve();
        },
        readProtection: async (remainingMs) => {
          const commandResult = await commandLog(
            "gh",
            [
              "api",
              `repos/${launcherValidatedRecord.repository}/branches/main/protection`,
            ],
            remainingMs,
          );
          if (commandResult.result.type !== "success") {
            return { valid: false, log: commandResult.log };
          }
          try {
            assertRequiredMergeProtection(
              JSON.parse(commandResult.result.stdout),
              "Verify",
              15368,
            );
            return { valid: true, log: commandResult.log };
          } catch {
            return { valid: false, log: commandResult.log };
          }
        },
        readChecks: async (remainingMs) => {
          const commandResult = await commandLog(
            "gh",
            [
              "pr",
              "checks",
              launcherValidatedRecord.prUrl,
              "--json",
              "name,workflow,bucket",
            ],
            remainingMs,
          );
          try {
            return {
              state: remoteCheckState(
                parseRemoteChecksCommandResult(
                  commandResult.result,
                  commandResult.log.command,
                ),
              ),
              log: commandResult.log,
            };
          } catch {
            return { state: "failed" as const, log: commandResult.log };
          }
        },
        readPullRequest: async (phase, remainingMs) => {
          const fields =
            phase === "merged"
              ? "url,baseRefName,headRefName,headRefOid,isDraft,state"
              : "url,baseRefName,headRefName,headRefOid,isDraft";
          const commandResult = await commandLog(
            "gh",
            ["pr", "view", launcherValidatedRecord.prUrl, "--json", fields],
            remainingMs,
          );
          if (commandResult.result.type !== "success") {
            throw new Error(`${commandResult.log.command} failed`);
          }
          return {
            pr: JSON.parse(commandResult.result.stdout) as DeliveryReadyPullRequest,
            log: commandResult.log,
          };
        },
        merge: async (lockedHeadSha, remainingMs) =>
          (
            await commandLog(
              "gh",
              [
                "pr",
                "merge",
                launcherValidatedRecord.prUrl,
                "--squash",
                "--match-head-commit",
                lockedHeadSha,
              ],
              remainingMs,
            )
          ).log,
        persist: async (record, persistenceDeadlineAtMs) => {
          const renderedDeliveryReport = await persistDeliveryReportMirror(record);
          activeReadyReport = renderedDeliveryReport;
          await persistDeliveryRecordAtomically(
            deliveryRecordPath,
            record,
            persistenceDeadlineAtMs,
            deliveryLock,
          );
        },
      });
      process.exitCode = outcome.exitCode;
    } finally {
      await rm(deliveryLock, { recursive: true, force: true });
    }
    return;
  }
  const requestedBackend = process.env.ORCA_BACKEND?.trim() || "codex";
  if (requestedBackend !== "codex") {
    throw new Error(
      `proving workflow requires codex backend; received ${requestedBackend}`,
    );
  }
  const activeSelected = selectBackend({ default: "codex" });
  if (activeSelected.tag !== "codex") {
    throw new Error(
      `proving workflow requires codex backend; received ${activeSelected.tag}`,
    );
  }
  const selected = activeSelected;
  const baseline = resolveBaselinePolicy({ args: flowArgs() });
  const profile = parseProfile(baseline.args);
  const limits = profileLimits[profile];
  const startedAtMs = parseStartedAt(
    requiredEnvironment("ORCA_IMPROVEMENT_STARTED_AT_MS"),
  );
  const workerDeadlineAtMs = parseWorkerDeadlineAtMs(
    requiredEnvironment("ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS"),
    startedAtMs,
    limits.deadlineMs,
  );
  let runId =
    process.env.ORCA_IMPROVEMENT_RUN_ID?.trim() ||
    `uninitialized-${String(startedAtMs)}`;
  const monitor = new WorkflowMonitor(requestedBackend, {
    writeStatus: createWorkflowStatusWriter(
      (text) => void process.stderr.write(text),
    ),
  });
  const report: RunReport = {
    runId,
    monitorRunId: monitor.runId,
    profile,
    startedAtMs,
    workerDeadlineAtMs,
    backend: requestedBackend,
    stage: "initialize",
    baseSha: "",
    worktree: process.cwd(),
    branch: process.env.ORCA_IMPROVEMENT_BRANCH?.trim() ?? "",
    artifactDigest: process.env.ORCA_IMPROVEMENT_ARTIFACT_DIGEST?.trim() ?? "",
    preflightPath: process.env.ORCA_IMPROVEMENT_PREFLIGHT_PATH?.trim() ?? "",
    preflightRunId: "",
    preflightArtifactDigest: "",
    repository: process.env.ORCA_IMPROVEMENT_REPOSITORY?.trim() ?? "",
    originFetchUrl:
      process.env.ORCA_IMPROVEMENT_ORIGIN_FETCH_URL?.trim() ?? "",
    originPushUrl:
      process.env.ORCA_IMPROVEMENT_ORIGIN_PUSH_URL?.trim() ?? "",
    appliedSystemPrompts: {},
    rejectedCandidates: [],
    validation: [],
    activeStatus: "pending",
    deliveryStatus: "pending",
    merged: false,
    sla: "pending",
  };
  let candidate: Candidate | undefined;
  let capturedTestDiff = "";
  let reviewFindings: ReviewFinding[] = [];
  let validatedPaths: string[] = [];
  let verifiedContentManifest: readonly GitManifestEntry[] | undefined;
  let bodyFailed = false;
  let pendingIssue: RunIssue | undefined;
  let deliveryRecord: DeliveryRecordV1 | undefined;
  let deliveryRecordPublished = false;
  const activeStageBudgets = createActiveStageBudgetTracker<StageLimit>();

  const stageLimit = (name: StageLimit): number =>
    Math.round(SIMPLE_STAGE_LIMITS[name] * PROFILE_SCALE[profile]);
  const runtimeDeadlineMs = (): number =>
    workerDeadlineAtMs - startedAtMs;
  const workDeadlineMs = (): number =>
    runtimeDeadlineMs() - RUNTIME_FINALIZATION_RESERVE_MS;
  const beginBudget = (name: StageLimit): void =>
    activeStageBudgets.activate(name, Date.now());
  const workRemaining = (): number =>
    stageBudgetMs(
      startedAtMs,
      workDeadlineMs(),
      Date.now(),
      workDeadlineMs(),
    );
  const budget = (name: StageLimit): number => {
    const now = Date.now();
    return Math.min(
      activeStageBudgets.remaining(name, stageLimit(name), now),
      workRemaining(),
    );
  };
  const buildRunIssue = (
    id: string,
    stage: string,
    classification: RunIssue["classification"],
    elapsedMs: number,
    evidence: string,
    at = new Date().toISOString(),
  ): RunIssue => ({
    id,
    runId,
    at,
    classification,
    stage,
    elapsedMs,
    evidence,
    backend: report.backend,
    worktree: report.worktree,
    branch: report.branch,
    monitorPath: `${MONITOR_DIR}/${monitor.runId}.json`,
    ...(report.prUrl === undefined ? {} : { prUrl: report.prUrl }),
    status: "open",
  });
  const enter = (name: string): void => {
    report.stage = name;
    if (Date.now() >= startedAtMs + workDeadlineMs()) {
      throw new Error(`sla-overrun before ${name}`);
    }
  };
  const recordUsage = (usage: Usage | undefined): void => {
    const merged = mergeUsage(report.usage, usage);
    if (merged !== undefined) report.usage = merged;
  };

  try {
    runId = requiredEnvironment("ORCA_IMPROVEMENT_RUN_ID");
    report.runId = runId;
    const launcherIdentity = requireLauncherDeliveryIdentity(runId, {
      branch: report.branch,
      repository: report.repository,
      originFetchUrl: report.originFetchUrl,
      originPushUrl: report.originPushUrl,
    });
    report.branch = launcherIdentity.branch;
    report.repository = launcherIdentity.repository;
    report.originFetchUrl = launcherIdentity.originFetchUrl;
    report.originPushUrl = launcherIdentity.originPushUrl;
    report.artifactDigest = requiredEnvironment(
      "ORCA_IMPROVEMENT_ARTIFACT_DIGEST",
    );
    report.preflightPath = requiredEnvironment(
      "ORCA_IMPROVEMENT_PREFLIGHT_PATH",
    );
    enter("preflight");
    beginBudget("preflight");
    const preflightRead = await awaitWithinDeadline(
      "preflight attestation read",
      () => budget("preflight"),
      async () => await fs().readText(report.preflightPath),
    );
    if (preflightRead.isErr()) {
      throw new Error(
        `${report.preflightPath} read failed: ${normalizeFailure(preflightRead.error)}`,
      );
    }
    const preflight = PreflightAttestationSchema.parse(
      parseJson(preflightRead.value, report.preflightPath),
    );
    report.preflightRunId = preflight.runId;
    report.preflightArtifactDigest = preflight.artifactDigest;
    if (preflight.artifactDigest !== report.artifactDigest) {
      throw new Error(
        `preflight attestation did not match live artifact digest for run ${runId}`,
      );
    }
    const selectedStageBackend = codex({ ignoreUserConfig: true });
    const selectedStageConfig = (
      config: ReturnType<typeof stageConfig>,
    ): ReturnType<typeof stageConfig> =>
      withSelectedModel(config, activeSelected.model);
    report.backend = selected.tag;
    const config = await awaitWithinDeadline(
      "workflow config read",
      () => budget("preflight"),
      async () => await readConfig(),
    );
    const scoutConfig = {
      ...stageConfig("scout", config.stages.scout, true),
      reasoningEffort: "low" as const,
    };
    report.appliedSystemPrompts.scout = scoutConfig.systemPrompt ?? "";
    const repairConfig = stageConfig("repair", config.stages.repair, false);
    report.appliedSystemPrompts.repair = repairConfig.systemPrompt ?? "";

    await monitor.stage("preflight", async () => {
      const baselineResult = await runBaselineGate({
        policy: baseline.policy,
        commands: BASELINE_GATE,
        commandTool: budgetedCommandTool(() => budget("preflight")),
        repair: async (issues) => {
          const outcome = await withStableIgnoredOrcaGuard("baseline-repair", () => budget("preflight"), async () => {
            const conversation = llm().autonomous(selectedStageBackend, {
              prompt: [
                "Repair the failing baseline without weakening any gate.",
                ...issues.map((issue) => issue.message),
              ].join("\n"),
              config: selectedStageConfig(repairConfig),
            });
            return await awaitConversationWithinBudget(
              conversation,
              budget("preflight"),
              "baseline repair",
              recordUsage,
            );
          });
          if (outcome.type !== "success") {
            throw new Error(
              `baseline repair failed: ${describeOutcome(outcome)}`,
            );
          }
          recordUsage(outcome.result.usage);
          return { usage: outcome.result.usage };
        },
      });
      report.validation.push(...baselineResult.validation);

      const readiness = BACKEND_READINESS[selected.tag];
      report.validation.push(
        await runRequired(
          readiness.command,
          readiness.args,
          budget("preflight"),
        ),
      );
      report.validation.push(
        await runRequired("gh", ["auth", "status"], budget("preflight")),
      );
      const worktree = await runRequired(
        "git",
        ["rev-parse", "--show-toplevel"],
        budget("preflight"),
      );
      const head = await runRequired(
        "git",
        ["rev-parse", "HEAD"],
        budget("preflight"),
      );
      const originMain = await runRequired(
        "git",
        ["rev-parse", "origin/main"],
        budget("preflight"),
      );
      report.validation.push(
        worktree,
        head,
        originMain,
      );
      report.worktree = worktree.stdout.trim();
      report.baseSha = originMain.stdout.trim();
      report.validation.push(
        ...(await assertBoundGitContext(
          "initial",
          report.branch,
          report.baseSha,
          report.originFetchUrl,
          report.originPushUrl,
          () => budget("preflight"),
        )),
      );
      if (head.stdout.trim() !== report.baseSha) {
        throw new Error(
          `git rev-parse HEAD did not match origin/main (${head.stdout.trim()} != ${report.baseSha})`,
        );
      }
    });

    enter("scout");
    beginBudget("scout");
    const scoutResult = await monitor.stage("scout", async () => {
      const gatherCommands: CommandLog[] = [];
      report.scoutEvidence = {
        paths: [],
        sourceTestPairs: [],
        charCount: 0,
        sha256: "",
        attempts: [],
        commands: gatherCommands,
      };
      const gatherDeadlineMs = Date.now() + SCOUT_GATHER_LIMIT_MS;
      const gatherRemaining = (): number =>
        remainingTimeout(
          SCOUT_GATHER_LIMIT_MS,
          Math.min(
            gatherDeadlineMs - Date.now(),
            budget("scout") -
              SCOUT_MODEL_LIMIT_MS -
              SCOUT_VALIDATION_LIMIT_MS,
          ),
          "scout evidence gather",
        );
      const recordGather = (log: CommandLog): void => {
        gatherCommands.push(log);
        report.validation.push(log);
      };
      const gatherRequired = async (
        commandName: string,
        args: readonly string[],
      ): Promise<CommandLog> => {
        const log = await awaitWithinDeadline(
          [commandName, ...args].join(" "),
          gatherRemaining,
          () => runLogged(commandName, args, gatherRemaining()),
        );
        recordGather(log);
        if (log.status === "failed") {
          throw new Error(
            `${log.command} failed\n${log.stderr || log.stdout}`,
          );
        }
        return log;
      };

      const statusBefore = await gatherRequired("git", ["status", "--porcelain=v1"]);
      const tracked = await gatherRequired("git", ["ls-files", "src", "tests"]);
      const recent = await gatherRequired("git", ["log", "-40", "--format=", "--name-only", "--", "src", "tests"]);
      const latestCommit = await gatherRequired("git", [
        "show",
        "--format=Latest commit: %H%nSubject: %s",
        "--name-only",
        "--first-parent",
        "HEAD",
      ]);
      const trackedPaths = nonEmptyLines(tracked.stdout);
      const recentPaths = nonEmptyLines(recent.stdout);
      const selection = selectScoutEvidence(
        trackedPaths,
        recentPaths,
        SCOUT_EVIDENCE_MAX_FILES,
      );
      const selectedPaths = [...selection.paths];
      if (selectedPaths.length === 0) {
        throw new Error("scout evidence gather selected no tracked paths");
      }
      const scan = await awaitWithinDeadline(
        "scout rg scan",
        gatherRemaining,
        () =>
          runLogged(
            "rg",
            [
              "-n",
              "--no-heading",
              "-m",
              "8",
              "TODO|FIXME|HACK|XXX|throw new Error|catch",
              "--",
              ...selectedPaths,
            ],
            gatherRemaining(),
          ),
      );
      if (scan.status === "failed" && scan.exitCode !== 1) {
        recordGather(scan);
        throw new Error(
          `${scan.command} failed\n${scan.stderr || scan.stdout}`,
        );
      }
      recordGather(
        scan.exitCode === 1 ? { ...scan, status: "passed" } : scan,
      );
      const matchLines = parseScoutMatchLines(
        scan.exitCode === 1 ? "" : scan.stdout,
        selectedPaths,
      );
      const evidenceFiles: ScoutEvidenceFile[] = [];
      for (const selectedPath of selectedPaths) {
        const read = await awaitWithinDeadline(
          `${selectedPath} read`,
          gatherRemaining,
          () => fs().readText(selectedPath),
        );
        if (read.isErr()) {
          throw new Error(
            `${selectedPath} read failed: ${normalizeFailure(read.error)}`,
          );
        }
        evidenceFiles.push({
          path: selectedPath,
          content: read.value,
          matchLines: matchLines.get(selectedPath) ?? [],
        });
      }
      const evidence = renderScoutEvidence(
        evidenceFiles,
        SCOUT_EVIDENCE_MAX_CHARS,
        latestCommitEvidencePrefix(latestCommit.stdout),
        selection.sourceTestPairs,
      );
      gatherRemaining();
      const evidenceSha256 = createHash("sha256").update(evidence.text).digest("hex");
      gatherRemaining();
      const statusAfter = await gatherRequired("git", ["status", "--porcelain=v1"]);
      if (statusBefore.stdout !== statusAfter.stdout) {
        throw new Error("scout evidence gather changed worktree status");
      }
      report.scoutEvidence.paths = [...evidence.paths];
      report.scoutEvidence.sourceTestPairs = evidence.sourceTestPairs.map(
        (pair) => ({ ...pair }),
      );
      report.scoutEvidence.charCount = evidence.charCount;
      report.scoutEvidence.sha256 = evidenceSha256;
      report.scoutEvidence.latestCommit = latestCommit.stdout;

      const scopedPairs = selection.sourceTestPairs.slice(0, 4);
      if (scopedPairs.length === 0) {
        throw new Error("scout evidence contains no reserved source-test pair");
      }
      const scopedPackets: ScoutEvidencePacket[] = [];
      for (const pair of scopedPairs) {
        gatherRemaining();
        const packet = renderScoutEvidence(
          evidenceFiles.filter(
            (file) =>
              file.path === pair.sourcePath || file.path === pair.testPath,
          ),
          SCOUT_EVIDENCE_MAX_CHARS,
          latestCommitEvidencePrefix(latestCommit.stdout),
          [pair],
        );
        gatherRemaining();
        gatherRemaining();
        if (!/^[0-9a-f]{64}$/.test(packet.sha256)) {
          throw new Error("scout evidence packet SHA-256 is invalid");
        }
        scopedPackets.push(packet);
      }
      const validateScopedCandidate = (
        value: ScopedScoutResult,
        scopeIndex: number,
      ): readonly string[] => {
        const pair = scopedPairs[scopeIndex];
        const packet = scopedPackets[scopeIndex];
        if (pair === undefined || packet === undefined) {
          return [`scout scope ${String(scopeIndex + 1)} is incomplete`];
        }
        const scopedIssues = validateScopedScoutResult(value, pair, packet, profile);
        if (value.status !== "candidate") return scopedIssues;
        return [
          ...scopedIssues,
          ...validateCandidateForProfile(value.candidate, profile),
          ...validateCandidateEvidence(value.candidate, packet),
        ];
      };
      const scopedUsage = new Map<number, Usage | undefined>();
      const fanout = await runScopedScoutFanout<ScopedScoutResult>({
        conversations: scopedPackets.map((packet, scopeIndex) => {
          const pair = scopedPairs[scopeIndex];
          if (pair === undefined) {
            throw new Error(`scout scope ${String(scopeIndex + 1)} has no pair`);
          }
          const label = `scout scope ${String(scopeIndex + 1)}`;
          let conversation:
            | (BoundedConversation<Outcome> & {
                events(): AsyncIterable<
                  import("@twelvehart/orcats").ConversationEvent
                >;
              })
            | undefined;
          return {
            label,
            async run(activeRemaining, settlementRemaining) {
              return await monitor.stage(label, async () => {
                const activeConversation = llm().autonomous(selectedStageBackend, {
                  prompt: scopedScoutPrompt(profile, profileLimits[profile], packet.text, pair),
                  schema: ScopedScoutResultSchema,
                  config: selectedStageConfig(scoutConfig),
                });
                conversation = activeConversation;
                const outcome = await awaitToolFreeOutcome(activeConversation, async () =>
                  awaitBounded(
                    activeConversation,
                    activeRemaining(),
                    label,
                    settlementRemaining(),
                  ),
                );
                if (outcome.type !== "success") {
                  throw new Error(`${label} failed: ${describeOutcome(outcome)}`);
                }
                scopedUsage.set(scopeIndex, outcome.result.usage);
                const structured = ScopedScoutResultSchema.safeParse(
                  outcome.result.structured,
                );
                if (!structured.success) {
                  throw new Error(
                    `${label} structured output invalid: ${structured.error.message}`,
                  );
                }
                return structured.data;
              });
            },
            async cancel(reason) {
              await conversation?.cancel(reason);
            },
          };
        }),
        modelAllocationMs: SCOUT_MODEL_LIMIT_MS,
        settlementReserveMs: CONVERSATION_SETTLEMENT_RESERVE_MS,
        quorum: 3,
        accept: (value) => value.status === "candidate",
        validateAccepted: validateScopedCandidate,
      });
      const validationDeadlineMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;
      const validationRemaining = (): number =>
        remainingTimeout(
          SCOUT_VALIDATION_LIMIT_MS,
          Math.min(
            validationDeadlineMs - Date.now(),
            budget("scout"),
          ),
          "scout validation",
        );
      const withinScoutValidation = async <T>(
        label: string,
        operation: () => T | Promise<T>,
      ): Promise<T> =>
        await awaitWithinDeadline(label, validationRemaining, async () => {
          return await operation();
        });
      const scopedResult = await finalizeScopedScoutRecords({
        records: fanout.records,
        remainingMs: validationRemaining,
        validate: (value, record) =>
          validateScopedCandidate(value, record.scopeIndex),
        persistScopeRecord: async (record) => {
          const pair = scopedPairs[record.scopeIndex];
          const packet = scopedPackets[record.scopeIndex];
          if (pair === undefined || packet === undefined) {
            throw new Error(`scout scope ${String(record.scopeIndex + 1)} is incomplete`);
          }
          await withinScoutValidation(
            `scout scope ${String(record.scopeIndex + 1)} evidence`,
            async () => {
              await writeJson(
                `${REPORT_DIR}/${runId}/scout-scope-${String(record.scopeIndex + 1)}.json`,
                {
                  ...record,
                  sourcePath: pair.sourcePath,
                  testPath: pair.testPath,
                  packetSha256: packet.sha256,
                },
              );
            },
          );
        },
        recordTerminalUsage: (record) => {
          recordUsage(scopedUsage.get(record.scopeIndex));
        },
        recordReportSummary: (summary) =>
          withinScoutValidation("scout report evidence", () => {
            const scoutEvidence = report.scoutEvidence;
            if (scoutEvidence === undefined) {
              throw new Error("scout evidence is missing before scoped summary");
            }
            scoutEvidence.scopes = summary.records.map((record) => {
              const pair = scopedPairs[record.scopeIndex];
              const packet = scopedPackets[record.scopeIndex];
              if (pair === undefined || packet === undefined) {
                throw new Error(`scout scope ${String(record.scopeIndex + 1)} is incomplete`);
              }
              return {
                scopeIndex: record.scopeIndex,
                label: record.label,
                status: record.status,
                sourcePath: pair.sourcePath,
                testPath: pair.testPath,
                sha256: packet.sha256,
                ...(record.reason === undefined ? {} : { reason: record.reason }),
                ...(record.validationIssues === undefined
                  ? {}
                  : { validationIssues: record.validationIssues }),
              };
            });
          }),
        recordLedgerSummary: async (summary) => {
          await withinScoutValidation(
            "scout ledger evidence",
            async () => {
              await writeJson(`${REPORT_DIR}/${runId}/scout-ledger.json`, summary);
            },
          );
        },
      });
      report.scoutEvidence.attempts = [];
      for (const proposed of scopedResult.candidates) {
        await awaitWithinDeadline(
          `candidate ${proposed.id} tracked paths`,
          validationRemaining,
          () =>
            assertTrackedPaths(
              proposed.allowedPaths,
              validationRemaining(),
            ),
        );
      }
      validationRemaining();
      return scopedResult;
    });

    if (report.scoutEvidence === undefined) {
      throw new Error("scout evidence report is missing");
    }
    report.scoutEvidence.candidates = [...scoutResult.candidates];
    report.scoutEvidence.ranking = [...scoutResult.rankedCandidateIds];
    report.scoutEvidence.selectedControl = {
      ...scoutResult.selectedControl,
    };
    const reproduceConfig = stageConfig(
      "reproduce",
      config.stages.reproduce,
      false,
    );
    report.appliedSystemPrompts.reproduce =
      reproduceConfig.systemPrompt ?? "";

    enter("reproduce");
    beginBudget("reproduce");
    await writeMatcherProofPreload(() => budget("reproduce"));
    const resolveFallbackControl = async (
      candidateId: string,
    ): Promise<ScoutResult["selectedControl"]> => {
      const proposed = scoutResult.candidates.find(
        (item) => item.id === candidateId,
      );
      if (proposed === undefined) {
        throw new Error(`ranked candidate ${candidateId} is missing`);
      }
      const label = `fallback control ${candidateId}`;
      return await monitor.stage(label, async () => {
        const controlConversation = llm().autonomous(selectedStageBackend, {
          prompt: fallbackControlPrompt(proposed),
          schema: CandidateControlSchema,
          config: selectedStageConfig(scoutConfig),
        });
        const outcome = await awaitToolFreeOutcome(
          controlConversation,
          () =>
            awaitConversationWithinBudget(
              controlConversation,
              remainingTimeout(
                FALLBACK_CONTROL_LIMIT_MS,
                budget("reproduce"),
                label,
              ),
              label,
              recordUsage,
            ),
        );
        if (outcome.type !== "success") {
          throw new Error(`${label} failed: ${describeOutcome(outcome)}`);
        }
        recordUsage(outcome.result.usage);
        const structured = CandidateControlSchema.safeParse(
          outcome.result.structured,
        );
        if (!structured.success) {
          throw new Error(
            `${label} structured output invalid: ${structured.error.message}`,
          );
        }
        if (structured.data.candidateId !== candidateId) {
          throw new Error(
            `${label} returned control for ${structured.data.candidateId}`,
          );
        }
        return structured.data;
      });
    };
    const reproduction = await monitor.stage("reproduce", async () =>
      runRankedCandidateFallback(
        scoutResult.rankedCandidateIds,
        async (candidateId, rank) => {
          report.stage = `reproduce-rank-${String(rank + 1)}`;
          const control =
            candidateId === scoutResult.selectedControl.candidateId
              ? scoutResult.selectedControl
              : await resolveFallbackControl(candidateId);
          const attempted = hydrateCandidate(scoutResult, control);
          const chosen = attempted;
          try {
            assertCandidateFitsActiveProfile(chosen, profile);
          } catch (error) {
            if (
              error instanceof CandidateRequiresSplitError &&
              report.scoutEvidence !== undefined
            ) {
              report.scoutEvidence.splitReason = error.reason;
            }
            throw error;
          }
          const snapshot = await captureExactTestSnapshot(
            chosen.testPath,
            () => budget("reproduce"),
          );
          const snapshotSha256 = snapshot.sha256;
          const validationStart = report.validation.length;
          let capturedAttemptDiff = "";
          let semanticControlEvidence: SemanticControlEvidence | undefined;
          try {
            const baselineTestSource = decodeUtf8Source(snapshot.bytes, chosen.testPath);
            const baselineSemanticControl = semanticPositiveControlEvidence(
              chosen,
              baselineTestSource,
            );
            const baselineControl = await runLogged(
              "bun",
              matcherProofArgs(
                controlTestArgs(chosen),
                MATCHER_PROOF_PRELOAD_PATH,
              ),
              budget("reproduce"),
            );
            report.validation.push(baselineControl);
            assertPositiveControlEvidence(
              baselineControl,
              controlTestName(chosen),
            );
            const guardedReproduction = await withStableIgnoredOrcaGuard("reproduce", () => budget("reproduce"), async () => {
              const reproduceConversation = llm().autonomous(selectedStageBackend, {
                  prompt: reproducePrompt(chosen),
                  config: selectedStageConfig(reproduceConfig),
              });
              const reproduceResult = await awaitExpectedFileChange(
                reproduceConversation,
                chosen.testPath,
                () =>
                  awaitConversationWithinBudget(
                    reproduceConversation,
                    budget("reproduce"),
                    "reproduce",
                    recordUsage,
                  ),
              );
              const outcome = reproduceResult.outcome;
              if (outcome.type !== "success") {
                throw new Error(`reproduce failed: ${describeOutcome(outcome)}`);
              }
              recordUsage(outcome.result.usage);
              return reproduceResult;
            });
            const reproduceResult = guardedReproduction;
            const paths = await changedPaths(() => budget("reproduce"));
            if (
              paths.length > 1 ||
              (paths.length === 1 && paths[0] !== chosen.testPath)
            ) {
              throw new Error(
                `reproduce may change only ${chosen.testPath}; changed: ${paths.join(", ")}`,
              );
            }
            if (
              !hasConfirmedExpectedFileChange(
                reproduceResult.expectedFileChangeState,
                paths,
                chosen.testPath,
              )
            ) {
              throw new InvalidReproductionProofError(
                "no-change",
                `reproduce did not provide confirmed change evidence for ${chosen.testPath}`,
              );
            }
            capturedAttemptDiff = await pathDiff(
              chosen.testPath,
              () => budget("reproduce"),
            );
            if (capturedAttemptDiff.trim() === "") {
              throw new InvalidReproductionProofError(
                "empty-diff",
                `${chosen.testPath} has no regression-test diff`,
              );
            }
            const capturedTestDiff = capturedAttemptDiff;
            const controlSource = decodeUtf8Source(
              await awaitWithinDeadline(
                "reproduced test read",
                () => budget("reproduce"),
                async () => await readFile(chosen.testPath),
              ),
              chosen.testPath,
            );
            semanticControlEvidence = semanticPositiveControlEvidence(
              chosen,
              controlSource,
              baselineTestSource,
            );
            const candidateRedTestName =
              semanticControlEvidence.candidateRedTestName;
            if (candidateRedTestName === undefined) {
              throw new InvalidReproductionProofError(
                "target-wrong-pattern",
                `semantic reproduction proof did not identify the added RED test for ${chosen.id}`,
              );
            }
            if (
              semanticControlEvidence.testAstSha256 !==
              baselineSemanticControl.testAstSha256
            ) {
              throw new InvalidReproductionProofError(
                "control-failed",
                `reproduce changed pre-existing control ${controlTestName(chosen)}`,
              );
            }
            report.stage = "red-gate";
            await monitor.stage("red-gate", async () => {
              const control = await runLogged(
                "bun",
                matcherProofArgs(
                  controlTestArgs(chosen),
                  MATCHER_PROOF_PRELOAD_PATH,
                ),
                budget("reproduce"),
              );
              report.validation.push(control);
              const red = await runTargetAfterPositiveControl(
                control,
                controlTestName(chosen),
                () =>
                  runLogged(
                    "bun",
                    matcherProofArgs(
                      namedTestArgs(chosen.testPath, candidateRedTestName),
                      MATCHER_PROOF_PRELOAD_PATH,
                    ),
                    budget("reproduce"),
                  ),
              );
              report.validation.push(red);
              assertRedGateEvidence(
                control,
                controlTestName(chosen),
                red,
                candidateRedTestName,
                candidateRedMarker(chosen.id),
              );
              await awaitWithinDeadline(
                "RED diff write",
                () => budget("reproduce"),
                async () => await writeText(RED_DIFF_PATH, capturedTestDiff),
              );
            });
            return {
              status: "accepted",
              value: {
                candidate: attempted,
                control: control,
                redDiff: capturedAttemptDiff,
                semanticControl: semanticControlEvidence,
              } satisfies AcceptedReproduction,
            } as const;
          } catch (error) {
            if (!isInvalidReproductionProof(error)) throw error;
            report.stage = `reproduce-rank-${String(rank + 1)}-rejected`;
            const reason = normalizeFailure(error);
            const artifactPath = `${REPORT_DIR}/${runId}/rejected/${String(rank + 1)}-${attempted.id}.json`;
            report.rejectedCandidates.push({
              candidate: attempted,
              control: control,
              reason: reason,
              redDiff: capturedAttemptDiff,
              validation: [...report.validation.slice(validationStart)],
              snapshotSha256: snapshotSha256,
              rank: rank + 1,
              artifactPath,
              baselineStatus: snapshot.baselineStatus,
              baselineDiff: snapshot.baselineDiff,
              ...(semanticControlEvidence === undefined
                ? {}
                : { semanticControl: semanticControlEvidence }),
            });
            const rejected = report.rejectedCandidates.at(-1)!;
            await awaitWithinDeadline(
              "rejected candidate artifact write",
              () => budget("reproduce"),
              async () => await writeJson(artifactPath, rejected),
            );
            return {
              status: "rejected",
              reason,
              restore: async () => {
                const restoration = await restoreExactTestSnapshot(
                  attempted.testPath,
                  snapshot,
                  () => budget("reproduce"),
                );
                rejected.restoration = restoration;
                await awaitWithinDeadline(
                  "rejected restoration artifact write",
                  () => budget("reproduce"),
                  async () => await writeJson(artifactPath, rejected),
                );
              },
            } as const;
          }
        },
      ),
    );

    candidate = reproduction.value.candidate;
    capturedTestDiff = reproduction.value.redDiff;
    report.candidate = candidate;
    report.scoutEvidence.acceptedControl = {
      ...reproduction.value.control,
    };
    report.redDiffPath = RED_DIFF_PATH;
    report.semanticControl = reproduction.value.semanticControl;

    enter("select-plan");
    await monitor.stage("select-plan", async () => {
      const chosen = requireCandidate(candidate);
      await awaitWithinDeadline(
        "accepted plan write",
        workRemaining,
        async () =>
          await writeJson(PLAN_PATH, {
            runId,
            profile,
            baseSha: report.baseSha,
            candidates: scoutResult.candidates,
            rankedCandidateIds: scoutResult.rankedCandidateIds,
            selectedControl: scoutResult.selectedControl,
            acceptedControl: reproduction.value.control,
            rejectedCandidates: report.rejectedCandidates,
            candidate: chosen,
          }),
      );
    });

    const chosen = requireCandidate(candidate);

    const implementConfig = stageConfig(
      "implement",
      config.stages.implement,
      false,
    );
    report.appliedSystemPrompts.implement =
      implementConfig.systemPrompt ?? "";

    enter("implement");
    beginBudget("implement");
    await monitor.stage("implement", async () => {
      const outcome = await withStableIgnoredOrcaGuard("implement", () => budget("implement"), async () => {
        const implementConversation = llm().autonomous(selectedStageBackend, {
          prompt: implementPrompt(chosen, capturedTestDiff),
          config: selectedStageConfig(implementConfig),
        });
        return await awaitConversationWithinBudget(
          implementConversation,
          budget("implement"),
          "implement",
          recordUsage,
        );
      });
      if (outcome.type !== "success") {
        throw new Error(`implement failed: ${describeOutcome(outcome)}`);
      }
      recordUsage(outcome.result.usage);
      assertImmutableTestDiff(
        capturedTestDiff,
        await pathDiff(chosen.testPath, () => budget("implement")),
      );
      assertCandidateScope(
        chosen,
        await changedPaths(() => budget("implement")),
      );
    });

    enter("targeted-repair");
    beginBudget("repairs");
    await monitor.stage("targeted-repair", async () => {
      const seenGateIssues = new Set<string>();
      const loop = await fixLoop<GateIssue>(
        async () => {
          const logs = await runTargetedGate(chosen, budget("repairs"));
          report.validation.push(...logs);
          return ok(gateIssuesFromLogs(logs));
        },
        async (issues) => {
          const outcome = await withStableIgnoredOrcaGuard("targeted-repair", () => budget("repairs"), async () => {
            const repairConversation = llm().autonomous(selectedStageBackend, {
                prompt: repairPrompt(
                  chosen,
                  issues.map((issue) => issue.message),
                ),
                config: selectedStageConfig(repairConfig),
            });
            return await awaitConversationWithinBudget(
              repairConversation,
              budget("repairs"),
              "targeted repair",
              recordUsage,
            );
          });
          if (outcome.type !== "success") {
            throw new Error(
              `targeted repair failed: ${describeOutcome(outcome)}`,
            );
          }
          recordUsage(outcome.result.usage);
          assertImmutableTestDiff(
            capturedTestDiff,
            await pathDiff(chosen.testPath, () => budget("repairs")),
          );
          assertCandidateScope(
            chosen,
            await changedPaths(() => budget("repairs")),
          );
          return ok({ usage: outcome.result.usage });
        },
        {
          maxIterations: 1,
          wallClockMs: budget("repairs"),
          stalled: (issues) => {
            const signature = issues
              .map((issue) => issue.message.replace(/\d+/g, "#"))
              .sort()
              .join("\n");
            if (seenGateIssues.has(signature)) return true;
            seenGateIssues.add(signature);
            return false;
          },
        },
      );
      if (loop.isErr()) {
        throw new Error(`targeted repair loop failed: ${normalizeFailure(loop.error)}`);
      }
      if (!loop.value.converged) {
        const reason = regressedReason(loop.value.stop);
        throw new Error(
          `targeted repair did not converge: ${loop.value.stop} (${reason})`,
        );
      }
    });

    const reviewConfig = stageConfig("review", config.stages.review, true);
    report.appliedSystemPrompts.review = reviewConfig.systemPrompt ?? "";
    const performReview = async (label: string): Promise<ReviewFinding[]> => {
      const reviewConversation = llm().autonomous(selectedStageBackend, {
        prompt: reviewPrompt(chosen),
        schema: ReviewResultSchema,
        config: selectedStageConfig(reviewConfig),
      });
      const outcome = await awaitConversationWithinBudget(
        reviewConversation,
        budget("review"),
        label,
        recordUsage,
      );
      if (outcome.type !== "success") {
        throw new Error(`${label} failed: ${describeOutcome(outcome)}`);
      }
      recordUsage(outcome.result.usage);
      const structured = ReviewResultSchema.safeParse(
        outcome.result.structured,
      );
      if (!structured.success) {
        throw new Error(
          `review structured output invalid: ${structured.error.message}`,
        );
      }
      return structured.data.findings;
    };

    enter("review");
    beginBudget("review");
    await monitor.stage("review", async () => {
      reviewFindings = await performReview("review");
      report.initialReviewFindings = [...reviewFindings];
    });

    enter("review-repair");
    await monitor.stage("review-repair", async () => {
      const blockers = blockingFindings(reviewFindings);
      if (blockers.length === 0) {
        report.finalReviewFindings = [...reviewFindings];
        report.finalReviewBlockerCount = 0;
        return;
      }
      if (blockers.some((finding) => !finding.fixable)) {
        throw new Error(
          `review returned unfixable blockers: ${JSON.stringify(blockers)}`,
        );
      }
      beginBudget("repairs");
      const outcome = await withStableIgnoredOrcaGuard("review-repair", () => budget("repairs"), async () => {
        const repairConversation = llm().autonomous(selectedStageBackend, {
          prompt: repairPrompt(
            chosen,
            blockers.map(
              (finding) =>
                `${finding.severity}: ${finding.evidence}\n${finding.recommendation}`,
            ),
          ),
          config: selectedStageConfig(repairConfig),
        });
        return await awaitConversationWithinBudget(
          repairConversation,
          budget("repairs"),
          "review repair",
          recordUsage,
        );
      });
      if (outcome.type !== "success") {
        throw new Error(`review repair failed: ${describeOutcome(outcome)}`);
      }
      recordUsage(outcome.result.usage);
      assertImmutableTestDiff(
        capturedTestDiff,
        await pathDiff(chosen.testPath, () => budget("repairs")),
      );
      assertCandidateScope(
        chosen,
        await changedPaths(() => budget("repairs")),
      );
      const logs = await runTargetedGate(chosen, budget("repairs"));
      report.validation.push(...logs);
      const failed = logs.find((log) => log.status === "failed");
      if (failed !== undefined) {
        throw new Error(
          `${failed.command} failed after review repair\n${failed.stderr || failed.stdout}`,
        );
      }
      beginBudget("review");
      reviewFindings = await performReview("repeated review");
      const remaining = blockingFindings(reviewFindings);
      report.finalReviewFindings = [...reviewFindings];
      report.finalReviewBlockerCount = remaining.length;
      if (remaining.length > 0) {
        throw new Error(
          `review blockers remain after one repair: ${JSON.stringify(remaining)}`,
        );
      }
    });
    if (report.finalReviewBlockerCount !== 0) {
      throw new Error("review completion did not record zero blockers");
    }

    enter("verify");
    beginBudget("verify");
    await monitor.stage("verify", async () => {
      report.validation.push(
        ...(await assertBoundGitContext(
          "post-agent",
          report.branch,
          report.baseSha,
          report.originFetchUrl,
          report.originPushUrl,
          () => budget("verify"),
        )),
      );
      const full = await runRequired(
        FULL_GATE.command,
        FULL_GATE.args,
        Math.min(
          FULL_GATE.timeoutMs * PROFILE_SCALE[profile],
          budget("verify"),
        ),
      );
      report.validation.push(full);
      assertImmutableTestDiff(
        capturedTestDiff,
        await pathDiff(chosen.testPath, () => budget("verify")),
      );
      const paths = await changedPaths(() => budget("verify"));
      assertCandidateScope(chosen, paths);
      validatedPaths = paths;
      const profileIssues = validateCandidateForProfile(chosen, profile);
      if (profileIssues.length > 0 || paths.length > limits.maxPaths) {
        throw new Error(
          `verify scope violates ${profile}: ${[
            ...profileIssues,
            ...(paths.length > limits.maxPaths
              ? [`changed path count exceeds ${String(limits.maxPaths)}`]
              : []),
          ].join("; ")}`,
        );
      }
      verifiedContentManifest = await captureCandidateWorktreeManifest(
        paths,
        () => budget("verify"),
      );
    });
    report.usage = requireRecordedUsage(report.usage);

    enter("commit-push");
    beginBudget("delivery");
    const capturedOriginPushUrl = report.originPushUrl;
    const pushedHeadSha = await monitor.stage("commit-push", async () => {
      if (verifiedContentManifest === undefined) {
        throw new Error("verified candidate content manifest is missing");
      }
      assertImmutableTestDiff(
        capturedTestDiff,
        await pathDiff(chosen.testPath, () => budget("delivery")),
      );
      const paths = await changedPaths(() => budget("delivery"));
      assertCandidateScope(chosen, paths);
      validatedPaths = paths;
      const preStageManifest = await captureCandidateWorktreeManifest(
        paths,
        () => budget("delivery"),
      );
      assertGitManifestUnchanged(verifiedContentManifest, preStageManifest, "pre-stage candidate content");
      report.validation.push(
        await runRequired(
          "git",
          ["add", "--", ...paths],
          budget("delivery"),
        ),
      );
      const staged = await runRequired(
        "git",
        ["diff", "--cached", "--name-only", "-z"],
        budget("delivery"),
      );
      report.validation.push(staged);
      parseExactGitPathList(staged.stdout, paths, "staged candidate");
      const stagedManifest = await captureCandidateIndexManifest(
        paths,
        () => budget("delivery"),
      );
      assertGitManifestUnchanged(verifiedContentManifest, stagedManifest, "staged candidate content");
      const preCommitHead = await runRequired(
        "git",
        ["rev-parse", "HEAD"],
        budget("delivery"),
      );
      report.validation.push(preCommitHead);
      const preCommitHeadSha = preCommitHead.stdout.trim();
      if (
        !/^[0-9a-f]{40}$/.test(preCommitHeadSha) ||
        preCommitHeadSha !== report.baseSha
      ) {
        throw new Error(
          `pre-commit HEAD ${preCommitHeadSha} did not match base ${report.baseSha}`,
        );
      }
      report.validation.push(
        await runRequired(
          "git",
          ["commit", "-m", chosen.title],
          budget("delivery"),
        ),
      );
      const validatedHead = await runRequired(
        "git",
        ["rev-parse", "HEAD"],
        budget("delivery"),
      );
      report.validation.push(validatedHead);
      const validatedHeadSha = validatedHead.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(validatedHeadSha)) {
        throw new Error(
          `git rev-parse HEAD returned invalid commit SHA: ${JSON.stringify(validatedHeadSha)}`,
        );
      }
      const committedAncestry = await runRequired(
        "git",
        ["rev-list", "--parents", "-n", "1", validatedHeadSha],
        budget("delivery"),
      );
      report.validation.push(committedAncestry);
      const ancestryParts = committedAncestry.stdout.trim().split(/\s+/);
      if (
        ancestryParts.length !== 2 ||
        ancestryParts[0] !== validatedHeadSha ||
        ancestryParts[1] !== preCommitHeadSha
      ) {
        throw new Error(
          `committed candidate must be exactly one child of ${preCommitHeadSha}`,
        );
      }
      const committedPaths = await runRequired(
        "git",
        [
          "diff",
          "--name-only",
          "-z",
          preCommitHeadSha,
          validatedHeadSha,
          "--",
        ],
        budget("delivery"),
      );
      report.validation.push(committedPaths);
      parseExactGitPathList(
        committedPaths.stdout,
        paths,
        "committed candidate range",
      );
      const committedManifest = await captureCandidateCommitManifest(
        paths,
        () => budget("delivery"),
      );
      assertGitManifestUnchanged(verifiedContentManifest, committedManifest, "committed candidate content");
      const prePushWorktreeManifest = await captureCandidateWorktreeManifest(
        paths,
        () => budget("delivery"),
      );
      assertGitManifestUnchanged(
        verifiedContentManifest,
        prePushWorktreeManifest,
        "pre-push candidate worktree content",
      );
      report.validation.push(
        ...(await assertBoundGitContext(
          "pre-push",
          report.branch,
          report.baseSha,
          report.originFetchUrl,
          report.originPushUrl,
          () => budget("delivery"),
        )),
      );
      report.validation.push(
        await runRequired(
          "git",
          [
            "push",
            capturedOriginPushUrl,
            `${validatedHeadSha}:refs/heads/${report.branch}`,
          ],
          budget("delivery"),
        ),
      );
      report.validation.push(
        ...(await assertBoundGitContext(
          "post-push",
          report.branch,
          report.baseSha,
          report.originFetchUrl,
          report.originPushUrl,
          () => budget("delivery"),
        )),
      );
      const remoteBranch = await runRequired(
        "git",
        [
          "ls-remote",
          "--refs",
          capturedOriginPushUrl,
          `refs/heads/${report.branch}`,
        ],
        budget("delivery"),
      );
      report.validation.push(remoteBranch);
      if (
        remoteBranch.stdout.trim() !==
        `${validatedHeadSha}\trefs/heads/${report.branch}`
      ) {
        throw new Error(
          `remote branch ${report.branch} did not resolve to ${validatedHeadSha}`,
        );
      }
      return validatedHeadSha;
    });

    const pullRequestIdentity: PullRequestIdentity = {
      repository: report.repository,
      branch: report.branch,
      headSha: pushedHeadSha,
    };

    enter("pull-request");
    await monitor.stage("pull-request", async () => {
      const bodyPath = `${REPORT_DIR}/${runId}/pr-body.md`;
      await awaitWithinDeadline(
        "PR body write",
        () => budget("delivery"),
        async () => await writeText(bodyPath, pullRequestBody(chosen, report)),
      );
      const created = await createPullRequestBounded(
        chosen.title,
        bodyPath,
        pullRequestIdentity,
        budget("delivery"),
      );
      report.validation.push(created.log);
      report.prUrl = created.url;
    });

    const prUrl = requirePullRequestUrl(report.prUrl);
    const assertPullRequestHead = (
      url: string,
      identity: PullRequestIdentity,
    ): Promise<void> =>
      assertPullRequestHeadBounded(
        url,
        identity,
        budget("delivery"),
      );
    await assertPullRequestHead(prUrl, pullRequestIdentity);
    report.matchedHeadSha = pullRequestIdentity.headSha;
    const readyAtMs = Date.now();
    deliveryRecord = DeliveryRecordSchema.parse({
      version: 1,
      runId,
      repository: report.repository,
      prUrl,
      branch: report.branch,
      baseRefName: "main",
      lockedHeadSha: pullRequestIdentity.headSha,
      active: {
        profile,
        startedAtMs,
        readyAtMs,
        elapsedMs: readyAtMs - startedAtMs,
        activeDeadlineAtMs: workerDeadlineAtMs,
        verification: [...report.validation],
      },
      delivery: {
        status: "pending",
        attempts: [],
      },
    });
    report.deliveryRecordPath = `${REPORT_DIR}/${runId}/delivery.json`;
    report.deliveryStatus = deliveryRecord.delivery.status;
  } catch (error) {
    bodyFailed = true;
    report.stopReason = normalizeFailure(error);
    report.activeStatus = "failed";
    report.sla = "failed";
    monitor.recordFailure({
      file: candidate?.title ?? "codebase-improvement",
      error,
      durationMs: Date.now() - startedAtMs,
      category: classifyIssue(report.stage, error),
    });
    pendingIssue = buildRunIssue(
      `${runId}-${report.stage}-${String(Date.now())}`,
      report.stage,
      classifyIssue(report.stage, error),
      Date.now() - startedAtMs,
      normalizeFailure(error),
    );
    throw error;
  } finally {
    let persistedIssue: RunIssue | undefined;
    const finalizerErrors = await finalizeWorkflowEvidence({
      bodyFailed,
      remainingMs: () =>
        stageBudgetMs(
          startedAtMs,
          runtimeDeadlineMs(),
          Date.now(),
          runtimeDeadlineMs(),
        ),
      shutdown: {
        label: "shutdown",
        run: async () => {
          await selected.shutdown?.();
        },
      },
      artifacts: [
        {
          label: "issue ledger",
          run: async (context) => {
            if (
              pendingIssue !== undefined &&
              pendingIssue !== persistedIssue
            ) {
              const issue = pendingIssue;
              const commit = await appendIssue(issue, runId, context);
              persistedIssue = issue;
              return commit;
            }
          },
        },
        {
          label: "delivery record",
          run: async (context) => {
            if (deliveryRecord === undefined) return;
            return await publishActiveReadyDeliveryRecord(
              `${REPORT_DIR}/${runId}/delivery.json`,
              `${JSON.stringify(deliveryRecord, null, 2)}\n`,
              runId,
              context,
              () => {
                deliveryRecordPublished = true;
                if (report.activeStatus !== "pending") return;
                const readyCandidate = requireCandidate(candidate);
                report.activeStatus = "ready";
                report.stopReason = "active-ready";
                monitor.recordOutcome({
                  reason: "active-ready",
                  file: readyCandidate.title,
                  verdict: "clean",
                  durationMs: Date.now() - startedAtMs,
                  smellsRemoved: [readyCandidate.problem],
                  changedPaths: validatedPaths,
                  validation: report.validation,
                  usage: requireRecordedUsage(report.usage),
                });
              },
            );
          },
        },
        {
          label: "monitor",
          run: async (context) => {
            return await publishFinalizationText(
              `${MONITOR_DIR}/${monitor.runId}.json`,
              `${JSON.stringify(monitor.toJson(), null, 2)}\n`,
              runId,
              context,
            );
          },
        },
      ],
      failureArtifactReserveMs: 2_000,
      report: {
        label: "report",
        run: async (context) => {
          const finishedAtMs = Date.now();
          const remainingAtReport = context.remainingMs();
          report.finishedAtMs = finishedAtMs;
          report.elapsedMs = finishedAtMs - startedAtMs;
          report.sla =
            !bodyFailed &&
            report.stage !== "finalize" &&
            deliveryRecordPublished &&
            report.activeStatus === "ready" &&
            report.elapsedMs <= runtimeDeadlineMs() &&
            remainingAtReport > 0
              ? "passed"
              : "failed";
          return await publishFinalizationText(
            `${REPORT_DIR}/${runId}/report.json`,
            `${JSON.stringify(report, null, 2)}\n`,
            runId,
            context,
          );
        },
      },
      enterFailureState: (errors) => {
        const finishedAtMs = Date.now();
        const stopReason = `workflow finalization failed: ${errors
          .map((error) => error.message)
          .join("; ")}`;
        const finalizationError = new AggregateError(errors, stopReason);
        report.finishedAtMs = finishedAtMs;
        report.elapsedMs = finishedAtMs - startedAtMs;
        report.stage = "finalize";
        report.activeStatus = "failed";
        report.sla = "failed";
        report.stopReason = stopReason;
        pendingIssue = buildRunIssue(
          `${runId}-finalize`,
          "finalize",
          "environment",
          report.elapsedMs,
          stopReason,
          new Date(finishedAtMs).toISOString(),
        );
        monitor.recordFailure({
          file: candidate?.title ?? "codebase-improvement",
          error: finalizationError,
          durationMs: report.elapsedMs,
          category: "environment",
        });
      },
    });
    console.log(`monitor=${MONITOR_DIR}/${monitor.runId}.json`);
    console.log(`report=${REPORT_DIR}/${runId}/report.json`);
    console.log(`ledger=${ISSUE_PATH}`);
    if (report.prUrl !== undefined) console.log(`pr_url=${report.prUrl}`);
    if (!bodyFailed && finalizerErrors.length > 0) {
      throw new AggregateError(finalizerErrors, "workflow finalization failed");
    }
    for (const error of finalizerErrors) {
      console.error(error.message);
    }
  }
});

async function runRequired(
  commandName: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandLog> {
  return await runRequiredCommand(command(), commandName, args, timeoutMs);
}

async function assertBoundGitContext(
  label: string,
  expectedBranch: string,
  expectedBaseSha: string,
  expectedFetchUrl: string,
  expectedPushUrl: string,
  remaining: () => number,
): Promise<CommandLog[]> {
  const branch = await runRequired(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    remainingTimeout(5_000, remaining(), `${label} branch`),
  );
  const originMain = await runRequired(
    "git",
    ["rev-parse", "origin/main"],
    remainingTimeout(5_000, remaining(), `${label} origin/main`),
  );
  const originFetchUrl = await runRequired(
    "git",
    ["remote", "get-url", "origin"],
    remainingTimeout(5_000, remaining(), `${label} origin fetch URL`),
  );
  const originPushUrl = await runRequired(
    "git",
    ["remote", "get-url", "--push", "origin"],
    remainingTimeout(5_000, remaining(), `${label} origin push URL`),
  );
  assertCurrentBranch(branch.stdout, expectedBranch);
  if (originMain.stdout.trim() !== expectedBaseSha) {
    throw new Error(
      `${label} origin/main ${originMain.stdout.trim()} did not match ${expectedBaseSha}`,
    );
  }
  if (originFetchUrl.stdout.trim() !== expectedFetchUrl) {
    throw new Error(`${label} origin fetch URL changed`);
  }
  if (originPushUrl.stdout.trim() !== expectedPushUrl) {
    throw new Error(`${label} origin push URL changed`);
  }
  return [branch, originMain, originFetchUrl, originPushUrl];
}

function budgetedCommandTool(remaining: () => number): CommandTool {
  return {
    async run(spec: VerificationCommand) {
      const remainingMs = remaining();
      const rendered = [spec.command, ...(spec.args ?? [])].join(" ");
      const timeoutMs = remainingTimeout(
        spec.timeoutMs ?? remainingMs,
        remainingMs,
        rendered,
      );
      return await command().run({ ...spec, timeoutMs });
    },
  };
}

async function readConfig(): Promise<WorkflowConfig> {
  const result = await fs().readText(CONFIG_PATH);
  if (result.isErr()) {
    throw new Error(`${CONFIG_PATH} read failed: ${normalizeFailure(result.error)}`);
  }
  return WorkflowConfigSchema.parse(parseJson(result.value, CONFIG_PATH));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function publishActiveReadyDeliveryRecord(
  destination: string,
  value: string,
  runId: string,
  context: FinalizationContext,
  onPublished: () => void,
): Promise<FinalizationCommitDecision> {
  const decision = await publishFinalizationText(
    destination,
    value,
    runId,
    context,
  );
  onPublished();
  return decision;
}

async function publishFinalizationText(
  path: string,
  value: string,
  _runId: string,
  context: FinalizationContext,
): Promise<FinalizationCommitDecision> {
  return await publishFinalizationTextSecure(path, value, context);
}

async function appendIssue(
  issue: RunIssue,
  runId: string,
  context: FinalizationContext,
): Promise<FinalizationCommitDecision> {
  let existing = "";
  if (await fs().exists(ISSUE_PATH)) {
    const read = await fs().readText(ISSUE_PATH);
    if (read.isErr()) {
      throw new Error(
        `${ISSUE_PATH} read failed: ${normalizeFailure(read.error)}`,
      );
    }
    existing = read.value;
  }
  const prefix = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  return await publishFinalizationText(
    ISSUE_PATH,
    `${prefix}${JSON.stringify(issue)}\n`,
    runId,
    context,
  );
}

function latestCommitEvidencePrefix(
  latestCommit: string,
): string {
  return [
    "Latest commit subject and changed paths:",
    latestCommit.trim(),
    "Current source and test evidence:",
  ].join("\n");
}

async function captureExactTestSnapshot(
  path: string,
  remaining: () => number,
): Promise<ExactTestSnapshot> {
  return await captureExactFileSnapshot(
    path,
    exactSnapshotOperations(remaining),
  );
}

async function restoreExactTestSnapshot(
  path: string,
  snapshot: ExactTestSnapshot,
  remaining: () => number,
): Promise<ExactRestorationEvidence> {
  return await restoreExactFileSnapshot(
    path,
    snapshot,
    exactSnapshotOperations(remaining),
  );
}

function exactSnapshotOperations(
  remaining: () => number,
): ExactSnapshotOperations {
  return {
    readBytes: async (path) => {
      const file = Bun.file(path);
      const exists = await awaitWithinDeadline(
        "test snapshot existence check",
        remaining,
        async () => await file.exists(),
      );
      if (!exists) {
        throw new Error(`test snapshot path does not exist: ${path}`);
      }
      return new Uint8Array(
        await awaitWithinDeadline(
          "test snapshot read",
          remaining,
          async () => await file.arrayBuffer(),
        ),
      );
    },
    writeBytes: async (path, bytes) => {
      await awaitWithinDeadline(
        "test snapshot write",
        remaining,
        async () => await Bun.write(path, bytes),
      );
    },
    readStatus: async () =>
      (
        await runRequired(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all"],
          remainingTimeout(5_000, remaining(), "snapshot git status"),
        )
      ).stdout,
    readDiff: async () =>
      (
        await runRequired(
          "git",
          ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
          remainingTimeout(5_000, remaining(), "snapshot git diff"),
        )
      ).stdout,
  };
}

async function captureIgnoredOrcaContentManifest(
  remaining: () => number,
): Promise<GitManifestEntry[]> {
  const ignored = await runRequired(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ".orca",
    ],
    remainingTimeout(10_000, remaining(), "ignored .orca manifest paths"),
  );
  if (
    Buffer.byteLength(ignored.stdout) >
    IGNORED_ORCA_MANIFEST_MAX_PATH_BYTES
  ) {
    throw new Error("ignored .orca manifest exceeds path byte limit");
  }
  const paths = ignored.stdout
    .split("\0")
    .filter((path) => path !== "");
  return await captureFileContentManifest(paths, {
    maxTotalBytes: IGNORED_ORCA_MANIFEST_MAX_BYTES,
    maxEntries: IGNORED_ORCA_MANIFEST_MAX_ENTRIES,
    maxTotalPathBytes: IGNORED_ORCA_MANIFEST_MAX_PATH_BYTES,
    remainingMs: remaining,
  });
}

function assertIgnoredOrcaContentManifest(
  expected: readonly GitManifestEntry[],
  actual: readonly GitManifestEntry[],
  label: string,
): void {
  assertGitManifestUnchanged(
    expected,
    actual,
    `${label} ignored .orca content`,
  );
}

async function withStableIgnoredOrcaGuard<T>(
  label: string,
  remaining: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  let expected: readonly GitManifestEntry[] | undefined;
  return await withGitManifestGuard(
    async () => {
      const actual = await captureIgnoredOrcaContentManifest(remaining);
      if (expected === undefined) {
        expected = actual;
      } else {
        assertIgnoredOrcaContentManifest(expected, actual, label);
      }
      return actual;
    },
    operation,
  );
}

async function captureCandidateWorktreeManifest(
  paths: readonly string[],
  remaining: () => number,
): Promise<GitManifestEntry[]> {
  const format = await runRequired(
    "git",
    ["rev-parse", "--show-object-format"],
    remainingTimeout(5_000, remaining(), "read Git object format"),
  );
  const objectFormat = format.stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(
      `git rev-parse returned unsupported object format: ${JSON.stringify(objectFormat)}`,
    );
  }
  return await captureGitWorktreeManifest(paths, {
    root: process.cwd(),
    objectFormat,
    remainingMs: remaining,
    hashFile: async (path) => {
      const hashed = await runRequired(
        "git",
        ["hash-object", `--path=${path}`, "--", path],
        remainingTimeout(5_000, remaining(), `hash candidate path ${path}`),
      );
      return hashed.stdout.trim();
    },
  });
}

async function captureCandidateIndexManifest(
  paths: readonly string[],
  remaining: () => number,
): Promise<GitManifestEntry[]> {
  const staged = await runRequired(
    "git",
    ["ls-files", "--stage", "-z", "--", ...paths],
    remainingTimeout(10_000, remaining(), "staged candidate manifest"),
  );
  return parseGitIndexManifest(staged.stdout, paths);
}

async function captureCandidateCommitManifest(
  paths: readonly string[],
  remaining: () => number,
): Promise<GitManifestEntry[]> {
  const committed = await runRequired(
    "git",
    ["ls-tree", "-rz", "--full-tree", "HEAD", "--", ...paths],
    remainingTimeout(10_000, remaining(), "committed candidate manifest"),
  );
  return parseGitCommitManifest(committed.stdout, paths);
}

async function changedPaths(
  remaining: () => number,
): Promise<string[]> {
  const tracked = await runRequired(
    "git",
    ["diff", "--name-only", "-z", "HEAD"],
    remainingTimeout(30_000, remaining(), "git diff changed paths"),
  );
  const untracked = await runRequired(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    remainingTimeout(30_000, remaining(), "git untracked paths"),
  );
  return [
    ...new Set(
      `${tracked.stdout}${untracked.stdout}`
        .split("\0")
        .map((path) => path.trim())
        .filter((path) => path !== ""),
    ),
  ].sort();
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter((line) => line !== "");
}

function parseScoutMatchLines(
  value: string,
  selectedPaths: readonly string[],
): Map<string, number[]> {
  const matchLines = new Map<string, number[]>();
  const paths = [...selectedPaths].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  for (const record of nonEmptyLines(value)) {
    const path = paths.find((item) => record.startsWith(`${item}:`));
    if (path === undefined) {
      throw new Error(`rg returned match outside selected paths: ${record}`);
    }
    const match = /^([1-9]\d*):/.exec(record.slice(path.length + 1));
    if (match === null) {
      throw new Error(`rg returned invalid match record: ${record}`);
    }
    const lines = matchLines.get(path) ?? [];
    lines.push(Number(match[1]));
    matchLines.set(path, lines);
  }
  for (const [path, lines] of matchLines) {
    matchLines.set(path, [...new Set(lines)].sort((left, right) => left - right));
  }
  return matchLines;
}

async function pathDiff(
  path: string,
  remaining: () => number,
): Promise<string> {
  const result = await runRequired(
    "git",
    ["diff", "--no-ext-diff", "--binary", "HEAD", "--", path],
    remainingTimeout(30_000, remaining(), `git diff ${path}`),
  );
  return result.stdout;
}

async function assertTrackedPaths(
  paths: readonly string[],
  timeoutMs: number,
): Promise<void> {
  if (paths.length === 0) throw new Error("git ls-files requires paths");
  await runRequired(
    "git",
    ["ls-files", "--error-unmatch", "--", ...paths],
    timeoutMs,
  );
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.type === "failed") {
    return `backend error: ${normalizeFailure(outcome.error)}`;
  }
  if (outcome.type === "cancelled") {
    return `cancelled: ${outcome.reason ?? "no reason"}`;
  }
  return `success: ${outcome.result.output}`;
}

async function createPullRequestBounded(
  title: string,
  bodyFile: string,
  identity: PullRequestIdentity,
  timeoutMs: number,
): Promise<{ readonly url: string; readonly log: CommandLog }> {
  const log = await runRequired(
    "gh",
    pullRequestCreateArgs(title, bodyFile, identity),
    timeoutMs,
  );
  const url = log.stdout.match(
    /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
  )?.[0];
  if (url === undefined) {
    throw new Error(`gh pr create --body-file ${bodyFile} returned no PR URL`);
  }
  return { url, log };
}

async function readPullRequestHeadBounded(
  prUrl: string,
  timeoutMs: number,
): Promise<z.infer<typeof PullRequestHeadSchema>> {
  const result = await runRequired(
    "gh",
    [
      "pr",
      "view",
      prUrl,
      "--json",
      "url,baseRefName,headRefName,headRefOid,isDraft",
    ],
    timeoutMs,
  );
  return PullRequestHeadSchema.parse(
    parseJson(
      result.stdout,
      `gh pr view ${prUrl} --json url,baseRefName,headRefName,headRefOid,isDraft`,
    ),
  );
}

async function assertPullRequestHeadBounded(
  prUrl: string,
  identity: PullRequestIdentity,
  timeoutMs: number,
): Promise<void> {
  const actual = await readPullRequestHeadBounded(prUrl, timeoutMs);
  assertReadyPullRequestHead(actual, identity);
}

async function runLogged(
  commandName: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandLog> {
  if (timeoutMs <= 0) {
    throw new Error(
      `sla-overrun before ${[commandName, ...args].join(" ")}`,
    );
  }
  const result = await command().run({
    command: commandName,
    args,
    timeoutMs,
  });
  return {
    command: [commandName, ...args].join(" "),
    status: result.type === "success" ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

async function runTargetedGate(
  candidate: Candidate,
  timeoutMs: number,
): Promise<CommandLog[]> {
  return await Promise.all([
    runLogged(
      "bun",
      matcherProofArgs(
        candidate.targetedTestArgs,
        MATCHER_PROOF_PRELOAD_PATH,
      ),
      timeoutMs,
    ),
    runLogged("bun", ["run", "lint"], timeoutMs),
  ]);
}

async function writeText(path: string, value: string): Promise<void> {
  const result = await fs().writeText(path, value);
  if (result.isErr()) {
    throw new Error(`${path} write failed: ${normalizeFailure(result.error)}`);
  }
}

async function writeMatcherProofPreload(
  remainingMs: () => number,
): Promise<void> {
  await awaitWithinDeadline(
    "matcher proof preload write",
    remainingMs,
    async () => {
      await writeText(MATCHER_PROOF_PRELOAD_PATH, MATCHER_PROOF_PRELOAD_SOURCE);
    },
  );
  const written = await awaitWithinDeadline(
    "matcher proof preload verification",
    remainingMs,
    async () => await readFile(MATCHER_PROOF_PRELOAD_PATH),
  );
  if (!written.equals(Buffer.from(MATCHER_PROOF_PRELOAD_SOURCE, "utf8"))) {
    throw new Error(`${MATCHER_PROOF_PRELOAD_PATH} byte verification failed`);
  }
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${source} returned invalid JSON: ${normalizeFailure(error)}`);
  }
}

function parseProfile(args: readonly string[]): ComplexityProfile {
  const values = args
    .filter((arg) => arg.startsWith("--complexity="))
    .map((arg) => arg.slice("--complexity=".length));
  const unsupported = args.filter((arg) => !arg.startsWith("--complexity="));
  if (values.length === 0 && unsupported.length === 0) return "simple";
  if (values.length !== 1 || unsupported.length > 0) {
    throw new Error(
      `expected exactly one --complexity=simple|medium|challenging argument; received ${args.join(" ")}`,
    );
  }
  return ComplexityProfileSchema.parse(values[0]);
}

function parseStartedAt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `ORCA_IMPROVEMENT_STARTED_AT_MS must be a positive integer, got ${value}`,
    );
  }
  return parsed;
}

function parseWorkerDeadlineAtMs(
  value: string,
  startedAtMs: number,
  deadlineMs: number,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= startedAtMs ||
    parsed > startedAtMs + deadlineMs
  ) {
    throw new Error(
      `ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS must be a safe integer greater than ${String(startedAtMs)} and no later than ${String(startedAtMs + deadlineMs)}, got ${value}`,
    );
  }
  return parsed;
}

function parseDeliveryContinuationDeadlineAtMs(
  value: string,
  startedAtMs: number,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > startedAtMs + DELIVERY_CONTINUATION_DEADLINE_MS
  ) {
    throw new Error(
      `ORCA_IMPROVEMENT_DELIVERY_DEADLINE_AT_MS must be a positive safe integer no later than ${String(startedAtMs + DELIVERY_CONTINUATION_DEADLINE_MS)}, got ${value}`,
    );
  }
  return parsed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireCandidate(candidate: Candidate | undefined): Candidate {
  if (candidate === undefined) throw new Error(`${PLAN_PATH} has no candidate`);
  return candidate;
}

function requirePullRequestUrl(value: string | undefined): string {
  if (value === undefined) throw new Error("pull request URL is missing");
  return value;
}

function assertCandidateScope(
  candidate: Candidate,
  paths: readonly string[],
): void {
  const issues = validateChangedPaths(candidate, paths);
  if (issues.length > 0) {
    throw new Error(`candidate scope failed: ${issues.join("; ")}`);
  }
}

function semanticPositiveControlEvidence(
  candidate: Candidate,
  source: string,
  baselineSource?: string,
): SemanticControlEvidence {
  try {
    const semantic = assertSemanticPositiveControl(source, {
      expectedTestName: controlTestName(candidate),
      testPath: candidate.testPath,
      allowedProductionPaths: [candidate.controlProductionPath],
      candidateRedMarker: candidateRedMarker(candidate.id),
      baselineSource,
    });
    if (semantic.productionPath !== candidate.controlProductionPath) {
      throw new Error(
        `positive control observed ${semantic.productionPath}, expected ${candidate.controlProductionPath}`,
      );
    }
    const sourceFile = ts.createSourceFile(
      candidate.testPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const namedTests = sourceFile.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement)) return [];
      const expression = statement.expression;
      if (
        !ts.isCallExpression(expression) ||
        !ts.isIdentifier(expression.expression) ||
        expression.expression.text !== "test" ||
        expression.arguments[0] === undefined ||
        !ts.isStringLiteralLike(expression.arguments[0]) ||
        expression.arguments[0].text !== controlTestName(candidate)
      ) {
        return [];
      }
      return [expression];
    });
    if (namedTests.length !== 1) {
      throw new Error(
        `positive control ${controlTestName(candidate)} must have one top-level AST`,
      );
    }
    return {
      ...semantic,
      testAstSha256: createHash("sha256")
        .update(namedTests[0]!.getText(sourceFile))
        .digest("hex"),
    };
  } catch (error) {
    throw new InvalidReproductionProofError(
      "control-failed",
      `semantic positive control failed: ${normalizeFailure(error)}`,
    );
  }
}

function regressedReason(stop: FixLoopStop): RegressedReason {
  if (stop === "timeout") return "timeout";
  if (stop === "ceiling" || stop === "budget-exhausted") return "ceiling";
  return "stuck";
}

function blockingFindings(
  findings: readonly ReviewFinding[],
): ReviewFinding[] {
  return findings.filter(
    (finding) =>
      finding.severity === "high" || finding.severity === "critical",
  );
}

function isInvalidReproductionProof(
  error: unknown,
): error is InvalidReproductionProofError {
  return error instanceof InvalidReproductionProofError;
}

function scopedScoutPrompt(
  profile: ComplexityProfile,
  limits: (typeof profileLimits)[ComplexityProfile],
  evidence: string,
  pair: { readonly sourcePath: string; readonly testPath: string },
): string {
  return [
    "Use only the evidence packet below.",
    "Do not inspect the repository or call tools.",
    `This scope owns exactly ${pair.sourcePath} and ${pair.testPath}.`,
    "Return one strict candidate tied to that pair, or a cited no_candidate result.",
    "A candidate must use the reserved test path and source path, direct path:line evidence, and an exact ORCA_RED marker.",
    `The candidate must fit the ${profile} target of ${String(limits.minMinutes)}-${String(limits.maxMinutes)} minutes and ${String(limits.activeCapMs)}ms active cap.`,
    "Exclude dependency, release, publish, security, secret, public-API entrypoint, generated, and .orca paths.",
    "Evidence packet:",
    evidence,
  ].join("\n");
}

function reproducePrompt(candidate: Candidate): string {
  return [
    `Create the failing regression test for ${candidate.title}.`,
    candidate.problem,
    ...candidate.evidence.map((evidence) => `Evidence: ${evidence}`),
    `Allowed repository paths: ${candidate.allowedPaths.join(", ")}.`,
    `Edit only ${candidate.testPath}.`,
    `The targeted command is ${renderShellCommand("bun", candidate.targetedTestArgs)}.`,
    `The failure must include this exact marker: ${candidateRedMarker(candidate.id)}.`,
    `Name the new regression test with ${candidateRedMarker(candidate.id)} as an exact standalone token.`,
    `Preserve the pre-existing top-level passing control test named exactly "${controlTestName(candidate)}" byte-for-byte in AST.`,
    `That control must continue to prove ${candidate.controlBrief} by importing and observing ${candidate.controlProductionPath}. Do not add, rewrite, rename, repurpose, delete, weaken, skip, or mock the control.`,
    "Make the new RED assertion observe the same exported production entrypoint as the control; only the defect input may differ.",
    `Before stopping, run ${renderShellCommand("bun", controlTestArgs(candidate))} and require exactly one passing control.`,
    `Then run only the new regression test with --test-name-pattern anchored to its escaped exact static name and require it to fail with ${candidateRedMarker(candidate.id)}. Do not run the whole test file as RED proof. If it passes, strengthen only the target assertion; incidental runner, stack, or source text must not satisfy it. Rerun the control and exact-name RED commands.`,
    "The parent independently repeats both gates and saves the test diff only after they pass.",
    "Never rename, repurpose, delete, or weaken an existing test; add only the new regression case.",
    "For this reproduction, treat current implementation and existing tests as stronger evidence than speculative defect claims.",
    "If no legitimate RED exists, leave the baseline unchanged and report the candidate non-reproducible; never manufacture a failure.",
    "After required skill and context setup, inspect only the candidate allowed repository paths before editing. If they disprove the causal claim, stop immediately, leave the baseline unchanged, and report the candidate non-reproducible; do not search for a replacement.",
    "Do not edit production code, weaken existing assertions, or perform git operations.",
  ].join("\n");
}

function fallbackControlPrompt(
  candidate: ScoutResult["candidates"][number],
): string {
  return [
    "Use only the packet-grounded candidate below.",
    "Do not inspect the repository or call tools.",
    `Return candidateId exactly as ${candidate.id}.`,
    "Return one pre-existing top-level testName from the packet and its directly imported allowed productionPath.",
    "Return a known-good control brief describing how that exact test uses the same production entrypoint, setup, and observation path as the target, differing only in defect input.",
    "Treat current implementation and existing tests as stronger evidence than speculative defect claims.",
    JSON.stringify(candidate),
  ].join("\n");
}

function implementPrompt(candidate: Candidate, redDiff: string): string {
  const productionPaths = candidate.allowedPaths.filter(
    (path) => path !== candidate.testPath,
  );
  return [
    `Implement ${candidate.title}.`,
    candidate.implementationBrief,
    ...candidate.evidence.map((evidence) => `Evidence: ${evidence}`),
    `Edit only these production paths: ${productionPaths.join(", ")}.`,
    `Do not change ${candidate.testPath}; its captured diff is immutable.`,
    "Captured failing regression-test diff:",
    redDiff,
    gateVerificationDirective(candidate),
    "Fix the root cause and do not perform git operations.",
  ].join("\n");
}

function repairPrompt(
  candidate: Candidate,
  failures: readonly string[],
): string {
  return [
    `Repair ${candidate.title} within these paths: ${candidate.allowedPaths.join(", ")}.`,
    `Do not change ${candidate.testPath}; its captured diff is immutable.`,
    "Diagnose the observed evidence before editing:",
    ...failures,
    "The parent already ran these gates; do not rerun them before editing.",
    gateVerificationDirective(candidate),
    "Do not weaken tests or gates and do not perform git operations.",
  ].join("\n");
}

function gateVerificationDirective(candidate: Candidate): string {
  const targetedCommand = ["bun", ...candidate.targetedTestArgs].join(" ");
  return `Before stopping, run ${targetedCommand} and bun run lint; fix in-scope failures until both pass.`;
}

function reviewPrompt(candidate: Candidate): string {
  return [
    `Review the current diff for ${candidate.title}.`,
    "Report only concrete correctness, regression, safety, or test-quality blockers with direct diff evidence.",
    "Use high or critical severity only for delivery-blocking findings.",
    "Do not edit files or perform git operations.",
  ].join("\n");
}

function pullRequestBody(candidate: Candidate, report: RunReport): string {
  return [
    "## Summary",
    "",
    candidate.problem,
    "",
    "## Evidence",
    "",
    ...candidate.evidence.map((evidence) => `- ${evidence}`),
    "",
    "## Verification",
    "",
    ...report.validation
      .filter((log) => log.status === "passed")
      .map((log) => `- \`${log.command}\``),
    "",
    `Regression test diff: \`${RED_DIFF_PATH}\``,
    "",
  ].join("\n");
}

function classifyIssue(
  stage: string,
  error: unknown,
): RunIssue["classification"] {
  const evidence = normalizeFailure(error).toLowerCase();
  if (evidence.includes("sla-overrun") || evidence.includes("exceeded")) {
    return "sla-overrun";
  }
  if (stage === "preflight") {
    return evidence.includes("baseline") ? "baseline" : "environment";
  }
  if (stage === "remote-checks") return "remote-check";
  if (stage === "merge") return "merge";
  if (
    evidence.includes("scope") ||
    evidence.includes("off-target") ||
    evidence.includes("forbidden path") ||
    evidence.includes("immutable") ||
    evidence.includes("only ") ||
    evidence.includes("tracked path") ||
    evidence.includes("test diff")
  ) {
    return "scope";
  }
  if (
    evidence.includes("backend error") ||
    evidence.includes("structured output")
  ) {
    return "backend";
  }
  if (
    stage === "review" ||
    stage === "review-repair" ||
    evidence.includes("review blocker")
  ) {
    return "review";
  }
  if (
    stage === "scout" ||
    stage === "reproduce" ||
    stage === "implement"
  ) {
    return "backend";
  }
  if (
    stage === "initialize" ||
    stage === "commit-push" ||
    stage === "pull-request" ||
    stage === "resolve-open-issues"
  ) {
    return "environment";
  }
  if (stage === "select-plan") return "scope";
  return "gate";
}
