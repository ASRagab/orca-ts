import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Usage } from "../model/index.ts";
import { TokenBudgetCounter, type TokenUsageSummary } from "../loop/termination.ts";
import type { LoopStopReason } from "../loop/builder/types.ts";
import type { LoopContextPressure } from "../loop/execution.ts";

export type StageStatus = "completed" | "failed";
/** Discriminated cleanup verdict. `clean`/`repaired` are safe improvements
 * (pass); `regressed`/`guard-reject` are reverted changes (fail); `declined`
 * is a neutral no-op; `precondition-skip` is excluded from the backend's
 * denominator because the file's gate was already red before the agent ran. */
export type OutcomeVerdict =
  | "clean"
  | "repaired"
  | "regressed"
  | "guard-reject"
  | "declined"
  | "precondition-skip";

/** Why a `regressed` change could not be made to pass the gate. */
export type RegressedReason = "stuck" | "timeout" | "ceiling";

export interface StageLog {
  readonly name: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: StageStatus;
}

export interface CommandLog {
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface OutcomeLog {
  readonly file: string;
  readonly verdict: OutcomeVerdict;
  readonly durationMs: number;
  readonly smellsRemoved: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly validation?: readonly CommandLog[];
  readonly reason?: string;
  /** Repair iterations to reach green: 0 for `clean`, K for `repaired`. */
  readonly iterations?: number;
  /** Set only when `verdict === "regressed"`. */
  readonly regressedReason?: RegressedReason;
  /** Total agent tokens spent on this file (initial edit + repairs). */
  readonly tokens?: number;
  readonly usage?: Usage;
}

export interface FailureLog {
  readonly file: string;
  readonly error: unknown;
  readonly durationMs: number;
  readonly category?: string;
}

export interface WorkflowRunSummary {
  /** Safe improvements: `clean` + `repaired`. */
  readonly pass: number;
  /** Reverted changes (`regressed` + `guard-reject`) plus thrown failures. */
  readonly fail: number;
  /** Neutral no-ops: `declined`. */
  readonly skip: number;
  /** Files whose gate was already red before the agent — excluded from the
   * pass-rate denominator (`pass + fail + skip`). */
  readonly preconditionSkip: number;
  readonly durationMs: number;
}

// Per-cycle progress stream (spec execution-observability / tasks §9). The stream is derived from
// the same manifest projection (L05 `measure`) that drives the termination variant, so the reported
// `measure`/`delta` cannot drift from the stop reason. Cumulative usage reuses the L02
// `TokenBudgetCounter`, so a cycle with no backend usage surfaces as `unknown`, never zero.

/** Stop status known at a cycle. `running` = no terminal reason yet — the incipient-runaway
 * window where a flat `delta` with rising `cumulativeUsage` is visible before a guard fires. */
export type CycleStopStatus = LoopStopReason | "running";

/** One branch of a fan-out cycle. Missing backend usage is `unknown`, not zero. */
export interface BranchProgress {
  readonly id: string;
  readonly status: StageStatus;
  readonly usage: Usage | "unknown";
}

/** A completed cycle's progress record, appended to the run log. */
export interface CycleProgress {
  readonly iteration: number;
  readonly measure: number;
  /** Change in `measure` vs the prior recorded cycle (`0` for the first). */
  readonly delta: number;
  readonly stopReasonSoFar: CycleStopStatus;
  /** Present only for a fan-out cycle. */
  readonly branches?: readonly BranchProgress[];
  /** Cumulative reported usage across cycles; `unknown` (not zero) once any cycle reports none. */
  readonly cumulativeUsage: TokenUsageSummary;
  /** Context pressure evidence from loop execution when offload or compaction ran. */
  readonly contextPressure?: LoopContextPressure;
}

/** A single branch of a fan-out cycle as observed by the caller; `usage` omitted ⇒ `unknown`. */
export interface BranchObservation {
  readonly id: string;
  readonly status: StageStatus;
  readonly usage?: Usage;
}

/** Caller input for {@link WorkflowMonitor.recordCycle}; `delta` and `cumulativeUsage` are derived. */
export interface CycleObservation {
  readonly iteration: number;
  /** Current measure from the manifest projection / loop variant. */
  readonly measure: number;
  /** Total backend usage reported this cycle (non-fanout); omit ⇒ cumulative becomes `unknown`. */
  readonly usage?: Usage;
  /** Per-branch records for a fan-out cycle; when present, cumulative usage folds each branch. */
  readonly branches?: readonly BranchObservation[];
  /** Terminal stop reason for the loop-ending cycle. Defaults to a value derived from the variant:
   * `converged` when `measure <= floor`, else `running`. */
  readonly stopReason?: LoopStopReason;
  /** Convergence floor for the derived stop status; default `0` (the loop builder's floor). */
  readonly floor?: number;
  /** Context pressure evidence emitted by loop execution for this cycle. */
  readonly contextPressure?: LoopContextPressure;
}

export interface WorkflowRunLog {
  readonly runId: string;
  readonly startedAt: string;
  readonly backend: string;
  readonly stages: readonly StageLog[];
  readonly outcomes: readonly OutcomeLog[];
  readonly failures: readonly FailureLog[];
  readonly summary: WorkflowRunSummary;
  /** Per-cycle progress stream; empty for a non-loop run. */
  readonly progress: readonly CycleProgress[];
}

export class WorkflowMonitor {
  readonly #runId: string;
  readonly #startedAt: Date;
  readonly #backend: string;
  readonly #stages: StageLog[] = [];
  readonly #outcomes: OutcomeLog[] = [];
  readonly #failures: FailureLog[] = [];
  readonly #progress: CycleProgress[] = [];
  readonly #cumulativeUsage = new TokenBudgetCounter();
  #lastMeasure: number | undefined;

  constructor(backend: string) {
    this.#runId = randomUUID();
    this.#startedAt = new Date();
    this.#backend = backend;
  }

  get runId(): string {
    return this.#runId;
  }

  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const result = await fn();
      this.#stages.push({ name, startedAt, durationMs: Date.now() - start, status: "completed" });
      return result;
    } catch (error) {
      this.#stages.push({ name, startedAt, durationMs: Date.now() - start, status: "failed" });
      throw error;
    }
  }

  recordOutcome(log: OutcomeLog): void {
    this.#outcomes.push(log);
  }

  recordFailure(log: FailureLog): void {
    this.#failures.push(log);
  }

  /** Append a per-cycle progress record. `delta` is derived against the prior cycle's `measure`
   * and `cumulativeUsage` is folded with the L02 token counter, so both stay consistent with the
   * termination variant and a usage-less cycle reports `unknown` rather than zero. */
  recordCycle(observation: CycleObservation): void {
    if (observation.branches !== undefined) {
      for (const branch of observation.branches) {
        this.#cumulativeUsage.record(branch.usage);
      }
    } else {
      this.#cumulativeUsage.record(observation.usage);
    }

    const delta = this.#lastMeasure === undefined ? 0 : observation.measure - this.#lastMeasure;
    this.#lastMeasure = observation.measure;

    const floor = observation.floor ?? 0;
    const stopReasonSoFar: CycleStopStatus =
      observation.stopReason ?? (observation.measure <= floor ? "converged" : "running");

    this.#progress.push({
      iteration: observation.iteration,
      measure: observation.measure,
      delta,
      stopReasonSoFar,
      ...(observation.branches === undefined
        ? {}
        : { branches: observation.branches.map(toBranchProgress) }),
      cumulativeUsage: this.#cumulativeUsage.summary(),
      ...(observation.contextPressure === undefined ? {} : { contextPressure: observation.contextPressure }),
    });
  }

  toJson(): WorkflowRunLog {
    const count = (verdict: OutcomeVerdict): number =>
      this.#outcomes.filter((outcome) => outcome.verdict === verdict).length;
    const pass = count("clean") + count("repaired");
    const fail = count("regressed") + count("guard-reject") + this.#failures.length;
    const skip = count("declined");
    const preconditionSkip = count("precondition-skip");
    return {
      runId: this.#runId,
      startedAt: this.#startedAt.toISOString(),
      backend: this.#backend,
      stages: [...this.#stages],
      outcomes: [...this.#outcomes],
      failures: [...this.#failures],
      summary: { pass, fail, skip, preconditionSkip, durationMs: Date.now() - this.#startedAt.getTime() },
      progress: [...this.#progress],
    };
  }

  async writeLog(logDir: string): Promise<void> {
    const path = join(logDir, `${this.#runId}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.toJson(), null, 2));
  }
}

function toBranchProgress(branch: BranchObservation): BranchProgress {
  return { id: branch.id, status: branch.status, usage: branch.usage ?? "unknown" };
}
