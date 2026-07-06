import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ok } from "neverthrow";
import { command as flowCommand } from "../flow/accessors.ts";
import type { Usage } from "../model/index.ts";
import type { CommandLog, RegressedReason, WorkflowMonitor } from "../monitor/index.ts";
import { fixLoop, type FixLoopStop } from "../review/index.ts";
import type { CommandTool, VerificationCommand, VerificationCommandResult } from "../tools/index.ts";

export const BaselinePolicies = ["repair", "strict", "accept-dirty"] as const;
export type BaselinePolicy = (typeof BaselinePolicies)[number];

export interface BaselinePolicyResolution {
  readonly policy: BaselinePolicy;
  readonly args: readonly string[];
  readonly source: "args" | "env" | "default";
}

export interface BaselinePolicyParseOptions {
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly defaultPolicy?: BaselinePolicy;
}

export interface BaselineGateIssue {
  readonly message: string;
  readonly fixable: true;
}

export interface BaselineRepairResult {
  readonly usage?: Usage | undefined;
}

export interface BaselineGateResult {
  readonly policy: BaselinePolicy;
  readonly status: "clean" | "repaired";
  readonly validation: readonly CommandLog[];
  readonly iterations: number;
  readonly snapshotPath?: string;
  readonly usage?: Usage;
}

export interface RunBaselineGateOptions {
  readonly commands: readonly VerificationCommand[];
  readonly policy?: BaselinePolicy;
  readonly commandTool?: CommandTool;
  readonly repair?: (issues: readonly BaselineGateIssue[]) => Promise<BaselineRepairResult | void>;
  readonly monitor?: Pick<WorkflowMonitor, "stage" | "recordOutcome" | "recordFailure">;
  readonly snapshotDir?: string;
  readonly maxIterations?: number;
  readonly wallClockMs?: number;
  readonly tokenBudget?: number;
  readonly stalled?: (issues: readonly BaselineGateIssue[]) => boolean;
  readonly now?: () => number;
}

export interface DirtyBaselineSnapshotOptions {
  readonly commands: readonly VerificationCommand[];
  readonly commandTool?: CommandTool;
  readonly snapshotDir?: string;
  readonly now?: () => number;
}

interface GateRun {
  readonly passed: boolean;
  readonly logs: readonly CommandLog[];
}

interface DirtyBaselineSnapshot {
  readonly status: string;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly untrackedFiles: string;
}

const DefaultBaselinePolicy: BaselinePolicy = "repair";
const DefaultSnapshotDir = ".orca/baselines";

export function resolveBaselinePolicy(options: BaselinePolicyParseOptions = {}): BaselinePolicyResolution {
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  const remaining: string[] = [];
  let argPolicy: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--baseline") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --baseline");
      }
      argPolicy = value;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--baseline=")) {
      argPolicy = arg.slice("--baseline=".length);
      continue;
    }

    if (arg !== undefined) {
      remaining.push(arg);
    }
  }

  if (argPolicy !== undefined) {
    return { policy: parseBaselinePolicyValue(argPolicy), args: remaining, source: "args" };
  }

  const envPolicy = env.ORCA_BASELINE_POLICY;
  if (envPolicy !== undefined && envPolicy.trim() !== "") {
    return { policy: parseBaselinePolicyValue(envPolicy), args: remaining, source: "env" };
  }

  return { policy: options.defaultPolicy ?? DefaultBaselinePolicy, args: remaining, source: "default" };
}

export function parseBaselinePolicy(value: string | undefined): BaselinePolicy {
  return parseBaselinePolicyValue(value ?? DefaultBaselinePolicy);
}

export async function runBaselineGate(options: RunBaselineGateOptions): Promise<BaselineGateResult> {
  const run = async () => runBaselineGateInner(options);
  return options.monitor === undefined ? run() : options.monitor.stage("baseline gate", run);
}

export async function captureDirtyBaselineSnapshot(
  options: DirtyBaselineSnapshotOptions,
): Promise<string | undefined> {
  const commandTool = options.commandTool ?? flowCommand();
  const status = await readWorktreeStatus(commandTool);
  if (status.trim() === "") {
    return undefined;
  }

  const snapshot = await captureDirtyBaseline(commandTool, status);
  const initialGate = await runGate(commandTool, options.commands);
  return writeBaselineSnapshot(snapshot, initialGate.logs, options);
}

async function runBaselineGateInner(options: RunBaselineGateOptions): Promise<BaselineGateResult> {
  const commandTool = options.commandTool ?? flowCommand();
  const policy = options.policy ?? DefaultBaselinePolicy;
  const startedAt = currentTime(options);
  const status = await readWorktreeStatus(commandTool);

  if ((policy === "repair" || policy === "strict") && status.trim() !== "") {
    const error = new Error(
      `baseline policy "${policy}" requires a clean worktree; use --baseline=accept-dirty to opt into snapshot-backed dirty baseline repair.\n${status}`,
    );
    options.monitor?.recordFailure({
      file: "baseline",
      error: error.message,
      durationMs: currentTime(options) - startedAt,
      category: "baseline",
    });
    throw error;
  }

  const dirtySnapshot =
    policy === "accept-dirty" && status.trim() !== ""
      ? await captureDirtyBaseline(commandTool, status)
      : undefined;
  let latest = await runGate(commandTool, options.commands);
  const snapshotPath =
    dirtySnapshot === undefined ? undefined : await writeBaselineSnapshot(dirtySnapshot, latest.logs, options);

  if (latest.passed) {
    recordBaselineOutcome(options, {
      startedAt,
      verdict: "clean",
      validation: latest.logs,
      iterations: 0,
      snapshotPath,
    });
    return buildResult(policy, "clean", latest.logs, 0, snapshotPath);
  }

  if (policy === "strict") {
    const reason = "strict baseline policy";
    recordBaselineOutcome(options, {
      startedAt,
      verdict: "regressed",
      validation: latest.logs,
      iterations: 0,
      reason,
      snapshotPath,
    });
    throw new Error(`baseline gate failed under strict policy:\n${renderValidationFailure(latest.logs)}`);
  }

  if (options.repair === undefined) {
    const reason = "missing baseline repair callback";
    recordBaselineOutcome(options, {
      startedAt,
      verdict: "regressed",
      validation: latest.logs,
      iterations: 0,
      reason,
      snapshotPath,
    });
    throw new Error(`baseline gate failed and no repair callback was provided:\n${renderValidationFailure(latest.logs)}`);
  }

  let usage: Usage | undefined;
  const loop = await fixLoop<BaselineGateIssue>(
    async () => ok(latest.passed ? [] : [{ message: renderValidationFailure(latest.logs), fixable: true as const }]),
    async (issues) => {
      const repaired = await options.repair?.(issues);
      usage = addUsage(usage, repaired?.usage);
      latest = await runGate(commandTool, options.commands);
      return ok(repaired?.usage === undefined ? {} : { usage: repaired.usage });
    },
    {
      maxIterations: options.maxIterations ?? 3,
      wallClockMs: options.wallClockMs ?? 10 * 60_000,
      ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
      ...(options.stalled === undefined ? {} : { stalled: options.stalled }),
    },
  );

  if (loop.isErr() || !loop.value.converged) {
    const reason = loop.isErr() ? JSON.stringify(loop.error) : loop.value.stop;
    recordBaselineOutcome(options, {
      startedAt,
      verdict: "regressed",
      validation: latest.logs,
      iterations: loop.isOk() ? loop.value.iterations : 0,
      reason,
      regressedReason: loop.isOk() ? regressedReasonFor(loop.value.stop) : "stuck",
      usage,
      snapshotPath,
    });
    throw new Error(`baseline repair did not converge (${reason}):\n${renderValidationFailure(latest.logs)}`);
  }

  recordBaselineOutcome(options, {
    startedAt,
    verdict: "repaired",
    validation: latest.logs,
    iterations: loop.value.iterations,
    usage,
    snapshotPath,
  });
  return buildResult(policy, "repaired", latest.logs, loop.value.iterations, snapshotPath, usage);
}

function parseBaselinePolicyValue(value: string): BaselinePolicy {
  const normalized = value.trim();
  if (BaselinePolicies.includes(normalized as BaselinePolicy)) {
    return normalized as BaselinePolicy;
  }
  throw new Error(`Invalid baseline policy "${value}"; expected repair, strict, or accept-dirty`);
}

async function readWorktreeStatus(commandTool: CommandTool): Promise<string> {
  const result = await commandTool.run({ command: "git", args: ["status", "--porcelain=v1"] });
  if (result.type !== "success") {
    throw new Error(`git status failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function runGate(
  commandTool: CommandTool,
  commands: readonly VerificationCommand[],
): Promise<GateRun> {
  const logs: CommandLog[] = [];
  for (const command of commands) {
    const result = await commandTool.run(command);
    logs.push(toCommandLog(result));
    if (result.type !== "success") {
      return { passed: false, logs };
    }
  }
  return { passed: true, logs };
}

function toCommandLog(result: VerificationCommandResult): CommandLog {
  return {
    command: result.command,
    status: result.type === "success" ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

async function captureDirtyBaseline(
  commandTool: CommandTool,
  status: string,
): Promise<DirtyBaselineSnapshot> {
  const [stagedDiff, unstagedDiff, untrackedFiles] = await Promise.all([
    capture(commandTool, { command: "git", args: ["diff", "--staged"] }),
    capture(commandTool, { command: "git", args: ["diff"] }),
    capture(commandTool, { command: "git", args: ["ls-files", "--others", "--exclude-standard"] }),
  ]);
  return { status, stagedDiff, unstagedDiff, untrackedFiles };
}

async function writeBaselineSnapshot(
  snapshot: DirtyBaselineSnapshot,
  validation: readonly CommandLog[],
  options: Pick<DirtyBaselineSnapshotOptions, "snapshotDir" | "now">,
): Promise<string> {
  const snapshotDir = options.snapshotDir ?? DefaultSnapshotDir;
  const snapshotPath = join(snapshotDir, `baseline-${new Date(currentTime(options)).toISOString().replace(/[:.]/g, "-")}.md`);
  const body = [
    "# Orca Baseline Snapshot",
    "",
    `Policy: accept-dirty`,
    `Captured at: ${new Date(currentTime(options)).toISOString()}`,
    "",
    "## Git Status",
    "",
    fence(snapshot.status),
    "",
    "## Staged Diff",
    "",
    fence(snapshot.stagedDiff),
    "",
    "## Unstaged Diff",
    "",
    fence(snapshot.unstagedDiff),
    "",
    "## Untracked Files",
    "",
    fence(snapshot.untrackedFiles),
    "",
    "## Initial Gate Output",
    "",
    ...validation.flatMap((log) => [
      `### ${log.command}`,
      "",
      `Status: ${log.status}`,
      `Exit code: ${String(log.exitCode)}`,
      "",
      "stdout:",
      fence(log.stdout),
      "",
      "stderr:",
      fence(log.stderr),
      "",
    ]),
  ].join("\n");

  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, body);
  return snapshotPath;
}

async function capture(commandTool: CommandTool, command: VerificationCommand): Promise<string> {
  const result = await commandTool.run(command);
  return result.type === "success" ? result.stdout : result.stderr || result.stdout;
}

function recordBaselineOutcome(
  options: RunBaselineGateOptions,
  log: {
    readonly startedAt: number;
    readonly verdict: "clean" | "repaired" | "regressed";
    readonly validation: readonly CommandLog[];
    readonly iterations: number;
    readonly reason?: string | undefined;
    readonly regressedReason?: RegressedReason | undefined;
    readonly usage?: Usage | undefined;
    readonly snapshotPath?: string | undefined;
  },
): void {
  options.monitor?.recordOutcome({
    file: "baseline",
    verdict: log.verdict,
    durationMs: currentTime(options) - log.startedAt,
    smellsRemoved: [],
    validation: log.validation,
    iterations: log.iterations,
    ...(log.reason === undefined ? {} : { reason: log.reason }),
    ...(log.regressedReason === undefined ? {} : { regressedReason: log.regressedReason }),
    ...(log.usage === undefined ? {} : { usage: log.usage, tokens: log.usage.input + log.usage.output }),
    ...(log.snapshotPath === undefined ? {} : { snapshotPath: log.snapshotPath }),
  });
}

function buildResult(
  policy: BaselinePolicy,
  status: "clean" | "repaired",
  validation: readonly CommandLog[],
  iterations: number,
  snapshotPath?: string,
  usage?: Usage,
): BaselineGateResult {
  return {
    policy,
    status,
    validation,
    iterations,
    ...(snapshotPath === undefined ? {} : { snapshotPath }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function renderValidationFailure(logs: readonly CommandLog[]): string {
  const failed = logs.find((log) => log.status === "failed") ?? logs.at(-1);
  if (failed === undefined) {
    return "No validation commands ran.";
  }
  return `${failed.command}\n${failed.stderr || failed.stdout}`;
}

function regressedReasonFor(stop: FixLoopStop): RegressedReason {
  if (stop === "timeout") return "timeout";
  if (stop === "ceiling" || stop === "budget-exhausted") return "ceiling";
  return "stuck";
}

function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const reasoning = (left.reasoning ?? 0) + (right.reasoning ?? 0);
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    ...(reasoning === 0 ? {} : { reasoning }),
  };
}

function fence(value: string): string {
  return `\`\`\`\n${value.trimEnd()}\n\`\`\``;
}

function currentTime(options: Pick<RunBaselineGateOptions, "now">): number {
  return options.now?.() ?? Date.now();
}
