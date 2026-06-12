import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowRunLog,
  OutcomeLog,
  FailureLog,
  StageLog,
  RegressedReason
} from "../src/index.ts";

const monitoringDir = process.env.ORCA_MONITOR_DIR ?? join(process.cwd(), ".orca", "monitoring");

async function loadLogs(): Promise<WorkflowRunLog[]> {
  let entries: string[];
  try {
    entries = await readdir(monitoringDir);
  } catch {
    console.error(`No monitoring directory found at ${monitoringDir}`);
    console.error("Run with --monitor (or --eval) to generate logs.");
    process.exit(1);
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    console.error(`No .json log files found in ${monitoringDir}`);
    process.exit(1);
  }

  return Promise.all(
    jsonFiles.map(async (f) => {
      const content = await readFile(join(monitoringDir, f), "utf8");
      return JSON.parse(content) as WorkflowRunLog;
    })
  );
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${String(ms)}ms`;
}

/** One row of the cross-backend convergence-cost matrix. `precondition-skip`
 * files are excluded from the `tokensPerFile` / `wallMsPerFile` denominators —
 * they were not the backend's work. A backend that was never run simply does
 * not appear (absent, not a failure). */
export interface BackendMatrixRow {
  readonly backend: string;
  readonly runs: number;
  readonly clean: number;
  readonly repaired: number;
  readonly repairedAvgIterations: number;
  readonly regressedStuck: number;
  readonly regressedTimeout: number;
  readonly regressedCeiling: number;
  readonly guardReject: number;
  readonly declined: number;
  readonly preconditionSkip: number;
  readonly tokensPerFile: number;
  readonly wallMsPerFile: number;
}

export function buildBackendMatrix(logs: readonly WorkflowRunLog[]): BackendMatrixRow[] {
  interface Acc {
    backend: string;
    runs: number;
    clean: number;
    repaired: number;
    repairIterTotal: number;
    regressed: Record<RegressedReason, number>;
    guardReject: number;
    declined: number;
    preconditionSkip: number;
    scored: number;
    tokenTotal: number;
    wallTotal: number;
  }

  const byBackend = new Map<string, Acc>();
  for (const log of logs) {
    const acc = byBackend.get(log.backend) ?? {
      backend: log.backend,
      runs: 0,
      clean: 0,
      repaired: 0,
      repairIterTotal: 0,
      regressed: { stuck: 0, timeout: 0, ceiling: 0 },
      guardReject: 0,
      declined: 0,
      preconditionSkip: 0,
      scored: 0,
      tokenTotal: 0,
      wallTotal: 0
    };
    acc.runs += 1;
    for (const outcome of log.outcomes) {
      switch (outcome.verdict) {
        case "clean":
          acc.clean += 1;
          break;
        case "repaired":
          acc.repaired += 1;
          acc.repairIterTotal += outcome.iterations ?? 0;
          break;
        case "regressed":
          acc.regressed[outcome.regressedReason ?? "stuck"] += 1;
          break;
        case "guard-reject":
          acc.guardReject += 1;
          break;
        case "declined":
          acc.declined += 1;
          break;
        case "precondition-skip":
          acc.preconditionSkip += 1;
          break;
      }
      if (outcome.verdict !== "precondition-skip") {
        acc.scored += 1;
        acc.tokenTotal += outcome.tokens ?? 0;
        acc.wallTotal += outcome.durationMs;
      }
    }
    byBackend.set(log.backend, acc);
  }

  return [...byBackend.values()]
    .map((acc) => ({
      backend: acc.backend,
      runs: acc.runs,
      clean: acc.clean,
      repaired: acc.repaired,
      repairedAvgIterations: acc.repaired === 0 ? 0 : acc.repairIterTotal / acc.repaired,
      regressedStuck: acc.regressed.stuck,
      regressedTimeout: acc.regressed.timeout,
      regressedCeiling: acc.regressed.ceiling,
      guardReject: acc.guardReject,
      declined: acc.declined,
      preconditionSkip: acc.preconditionSkip,
      tokensPerFile: acc.scored === 0 ? 0 : acc.tokenTotal / acc.scored,
      wallMsPerFile: acc.scored === 0 ? 0 : acc.wallTotal / acc.scored
    }))
    .sort((a, b) => a.backend.localeCompare(b.backend));
}

export function summarizeLogs(logs: readonly WorkflowRunLog[]): string {
  const lines: string[] = [];
  const scored = logs.reduce((n, log) => n + log.summary.pass + log.summary.fail + log.summary.skip, 0);
  const totalPass = logs.reduce((n, log) => n + log.summary.pass, 0);
  const totalFail = logs.reduce((n, log) => n + log.summary.fail, 0);
  const totalSkip = logs.reduce((n, log) => n + log.summary.skip, 0);
  const totalPreconditionSkip = logs.reduce((n, log) => n + log.summary.preconditionSkip, 0);
  const totalTokens = logs.reduce(
    (n, log) => n + log.outcomes.reduce((sum, outcome) => sum + (outcome.tokens ?? 0), 0),
    0
  );
  const passRate = scored > 0 ? ((totalPass / scored) * 100).toFixed(1) : "n/a";

  lines.push(`=== Workflow Run Summary (${String(logs.length)} run${logs.length !== 1 ? "s" : ""}) ===`);
  lines.push("");
  lines.push(`Scored files       : ${String(scored)} (excludes ${String(totalPreconditionSkip)} precondition-skip)`);
  lines.push(`Safe (clean+repair): ${String(totalPass)}`);
  lines.push(`Declined           : ${String(totalSkip)}`);
  lines.push(`Regressed/rejected : ${String(totalFail)}`);
  lines.push(`Safe-improve rate  : ${passRate}%`);
  if (totalTokens > 0) {
    lines.push(`Tokens             : ${String(totalTokens)}`);
  }

  appendBackendSummary(lines, logs);
  appendBackendMatrix(lines, logs);
  appendSlowestStages(lines, logs);
  appendSlowestFiles(lines, logs);
  appendRepairSummary(lines, logs);
  appendUsageSummary(lines, logs);
  appendFailures(lines, logs);

  return `${lines.join("\n")}\n`;
}

function appendBackendSummary(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const byBackend = new Map<
    string,
    { pass: number; fail: number; skip: number; preconditionSkip: number; runs: number; tokens: number }
  >();
  for (const log of logs) {
    const stats = byBackend.get(log.backend) ?? {
      pass: 0,
      fail: 0,
      skip: 0,
      preconditionSkip: 0,
      runs: 0,
      tokens: 0
    };
    stats.pass += log.summary.pass;
    stats.fail += log.summary.fail;
    stats.skip += log.summary.skip;
    stats.preconditionSkip += log.summary.preconditionSkip;
    stats.runs += 1;
    stats.tokens += log.outcomes.reduce((sum, outcome) => sum + (outcome.tokens ?? 0), 0);
    byBackend.set(log.backend, stats);
  }

  if (byBackend.size === 0) return;

  lines.push("", "--- Per-backend ---");
  for (const [backend, stats] of byBackend) {
    const files = stats.pass + stats.fail + stats.skip + stats.preconditionSkip;
    const tokenText = stats.tokens > 0 ? `, ${String(stats.tokens)} tokens` : "";
    lines.push(
      `  ${backend}: ${String(stats.runs)} run(s), ${String(files)} files, ${String(stats.pass)} pass, ${String(stats.fail)} fail, ${String(stats.skip)} skip, ${String(stats.preconditionSkip)} precondition${tokenText}`
    );
  }
}

function appendBackendMatrix(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const rows = buildBackendMatrix(logs);
  if (rows.length === 0) return;

  lines.push("", "--- Cross-backend convergence-cost matrix ---");
  lines.push("backend        clean repaired(avgIt) regressed(stuck/to/ceil) declined  tok/file  wall/file");
  for (const row of rows) {
    const regressed = `${String(row.regressedStuck)}/${String(row.regressedTimeout)}/${String(row.regressedCeiling)}`;
    lines.push(
      `${row.backend.padEnd(14)} ${String(row.clean).padStart(5)} ${`${String(row.repaired)}(${row.repairedAvgIterations.toFixed(1)})`.padStart(15)} ${regressed.padStart(24)} ${String(row.declined).padStart(8)} ${String(Math.round(row.tokensPerFile)).padStart(9)} ${formatMs(row.wallMsPerFile).padStart(10)}`
    );
  }
}

function appendSlowestStages(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const allStages: (StageLog & { runId: string })[] = logs.flatMap((log) =>
    log.stages.map((stage) => ({ ...stage, runId: log.runId.slice(0, 8) }))
  );
  if (allStages.length === 0) return;

  lines.push("", "--- Slowest stages ---");
  for (const stage of allStages.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)) {
    lines.push(`  [${stage.runId}] ${stage.name}: ${formatMs(stage.durationMs)} (${stage.status})`);
  }
}

function appendSlowestFiles(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const allOutcomes: (OutcomeLog & { runId: string })[] = logs.flatMap((log) =>
    log.outcomes.map((outcome) => ({ ...outcome, runId: log.runId.slice(0, 8) }))
  );
  if (allOutcomes.length === 0) return;

  lines.push("", "--- Slowest files ---");
  for (const outcome of allOutcomes.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)) {
    const repairText = outcome.iterations === undefined ? "" : `, repairs=${String(outcome.iterations)}`;
    const validationMs = (outcome.validation ?? []).reduce((sum, run) => sum + run.durationMs, 0);
    const validationText = validationMs > 0 ? `, validation=${formatMs(validationMs)}` : "";
    lines.push(
      `  [${outcome.runId}] ${outcome.file}: ${formatMs(outcome.durationMs)} (${outcome.verdict}${repairText}${validationText})`
    );
  }
}

function appendRepairSummary(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const repaired = logs.flatMap((log) => log.outcomes).filter((outcome) => (outcome.iterations ?? 0) > 0);
  if (repaired.length === 0) return;

  const iterations = repaired.reduce((sum, outcome) => sum + (outcome.iterations ?? 0), 0);
  lines.push("", "--- Repairs ---");
  lines.push(`  Files repaired: ${String(repaired.length)}`);
  lines.push(`  Repair iterations: ${String(iterations)}`);
}

function appendUsageSummary(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const outcomes = logs.flatMap((log) => log.outcomes).filter((outcome) => outcome.usage !== undefined);
  if (outcomes.length === 0) return;

  const input = outcomes.reduce((sum, outcome) => sum + (outcome.usage?.input ?? 0), 0);
  const output = outcomes.reduce((sum, outcome) => sum + (outcome.usage?.output ?? 0), 0);
  const reasoning = outcomes.reduce((sum, outcome) => sum + (outcome.usage?.reasoning ?? 0), 0);
  lines.push("", "--- Usage ---");
  lines.push(`  Input: ${String(input)}`);
  lines.push(`  Output: ${String(output)}`);
  if (reasoning > 0) {
    lines.push(`  Reasoning: ${String(reasoning)}`);
  }
}

function appendFailures(lines: string[], logs: readonly WorkflowRunLog[]): void {
  const allFailures: (FailureLog & { runId: string })[] = logs.flatMap((log) =>
    log.failures.map((failure) => ({ ...failure, runId: log.runId.slice(0, 8) }))
  );
  if (allFailures.length === 0) return;

  lines.push("", "--- Failures ---");
  for (const failure of allFailures) {
    const category = failure.category ?? describeError(failure.error);
    lines.push(`  [${failure.runId}] ${failure.file}: ${category} (${formatMs(failure.durationMs)})`);
  }
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { readonly _tag: unknown })._tag);
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "unknown";
}

if (import.meta.main) {
  const logs = await loadLogs();
  process.stdout.write(summarizeLogs(logs));
}
