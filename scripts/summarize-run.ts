import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRunLog, OutcomeLog, FailureLog, StageLog } from "../src/index.ts";

const monitoringDir = join(process.cwd(), ".orca", "monitoring");

async function loadLogs(): Promise<WorkflowRunLog[]> {
  let entries: string[];
  try {
    entries = await readdir(monitoringDir);
  } catch {
    console.error(`No monitoring directory found at ${monitoringDir}`);
    console.error("Run with --monitor to generate logs.");
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

function printSummary(logs: WorkflowRunLog[]): void {
  const totalFiles = logs.reduce((n, l) => n + l.outcomes.length, 0);
  const totalPass = logs.reduce((n, l) => n + l.summary.pass, 0);
  const totalFail = logs.reduce((n, l) => n + l.summary.fail, 0);
  const totalSkip = logs.reduce((n, l) => n + l.summary.skip, 0);
  const passRate = totalFiles > 0 ? ((totalPass / totalFiles) * 100).toFixed(1) : "n/a";

  console.log(`\n=== Workflow Run Summary (${String(logs.length)} run${logs.length !== 1 ? "s" : ""}) ===\n`);
  console.log(`Files processed : ${String(totalFiles)}`);
  console.log(`Changed (pass)  : ${String(totalPass)}`);
  console.log(`Skipped/no-op   : ${String(totalSkip)}`);
  console.log(`Failures        : ${String(totalFail)}`);
  console.log(`Pass rate       : ${passRate}%`);

  // Per-backend breakdown
  const byBackend = new Map<string, { pass: number; fail: number; skip: number; runs: number }>();
  for (const log of logs) {
    const b = byBackend.get(log.backend) ?? { pass: 0, fail: 0, skip: 0, runs: 0 };
    b.pass += log.summary.pass;
    b.fail += log.summary.fail;
    b.skip += log.summary.skip;
    b.runs += 1;
    byBackend.set(log.backend, b);
  }
  if (byBackend.size > 1) {
    console.log("\n--- Per-backend ---");
    for (const [backend, stats] of byBackend) {
      const files = stats.pass + stats.fail + stats.skip;
      console.log(`  ${backend}: ${String(stats.runs)} run(s), ${String(files)} files, ${String(stats.pass)} changed, ${String(stats.fail)} failed`);
    }
  }

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

const logs = await loadLogs();
printSummary(logs);
