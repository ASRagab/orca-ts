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

function printBackendMatrix(logs: readonly WorkflowRunLog[]): void {
  const rows = buildBackendMatrix(logs);
  if (rows.length === 0) return;
  console.log("\n--- Cross-backend convergence-cost matrix ---");
  console.log("backend        clean repaired(avgIt) regressed(stuck/to/ceil) declined  tok/file  wall/file");
  for (const r of rows) {
    const regressed = `${String(r.regressedStuck)}/${String(r.regressedTimeout)}/${String(r.regressedCeiling)}`;
    console.log(
      `${r.backend.padEnd(14)} ${String(r.clean).padStart(5)} ${`${String(r.repaired)}(${r.repairedAvgIterations.toFixed(1)})`.padStart(15)} ${regressed.padStart(24)} ${String(r.declined).padStart(8)} ${String(Math.round(r.tokensPerFile)).padStart(9)} ${formatMs(r.wallMsPerFile).padStart(10)}`
    );
  }
}

function printSummary(logs: WorkflowRunLog[]): void {
  const scored = logs.reduce((n, l) => n + l.summary.pass + l.summary.fail + l.summary.skip, 0);
  const totalPass = logs.reduce((n, l) => n + l.summary.pass, 0);
  const totalFail = logs.reduce((n, l) => n + l.summary.fail, 0);
  const totalSkip = logs.reduce((n, l) => n + l.summary.skip, 0);
  const totalPrecondition = logs.reduce((n, l) => n + l.summary.preconditionSkip, 0);
  const passRate = scored > 0 ? ((totalPass / scored) * 100).toFixed(1) : "n/a";

  console.log(`\n=== Workflow Run Summary (${String(logs.length)} run${logs.length !== 1 ? "s" : ""}) ===\n`);
  console.log(`Scored files       : ${String(scored)} (excludes ${String(totalPrecondition)} precondition-skip)`);
  console.log(`Safe (clean+repair): ${String(totalPass)}`);
  console.log(`Declined           : ${String(totalSkip)}`);
  console.log(`Regressed/rejected : ${String(totalFail)}`);
  console.log(`Safe-improve rate  : ${passRate}%`);

  printBackendMatrix(logs);

  // Slowest stages across all runs
  const allStages: (StageLog & { runId: string })[] = logs.flatMap((l) =>
    l.stages.map((s) => ({ ...s, runId: l.runId.slice(0, 8) }))
  );
  if (allStages.length > 0) {
    const slowest = allStages.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    console.log("\n--- Slowest stages ---");
    for (const s of slowest) {
      console.log(`  [${s.runId}] ${s.name}: ${formatMs(s.durationMs)} (${s.status})`);
    }
  }

  // Failure categories
  const allFailures: (FailureLog & { runId: string })[] = logs.flatMap((l) =>
    l.failures.map((f) => ({ ...f, runId: l.runId.slice(0, 8) }))
  );
  if (allFailures.length > 0) {
    console.log("\n--- Failures ---");
    for (const f of allFailures) {
      const tag = (f.error as { _tag?: string })._tag ?? "unknown";
      console.log(`  [${f.runId}] ${f.file}: ${tag} (${formatMs(f.durationMs)})`);
    }
  }

  // Slowest files
  const allOutcomes: (OutcomeLog & { runId: string })[] = logs.flatMap((l) =>
    l.outcomes.map((o) => ({ ...o, runId: l.runId.slice(0, 8) }))
  );
  if (allOutcomes.length > 0) {
    const slowestFiles = allOutcomes.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    console.log("\n--- Slowest files ---");
    for (const o of slowestFiles) {
      console.log(`  [${o.runId}] ${o.file}: ${formatMs(o.durationMs)} (${o.verdict})`);
    }
  }

  console.log();
}

if (import.meta.main) {
  const logs = await loadLogs();
  printSummary(logs);
}
