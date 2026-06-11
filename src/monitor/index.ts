import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

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

export interface OutcomeLog {
  readonly file: string;
  readonly verdict: OutcomeVerdict;
  readonly durationMs: number;
  readonly smellsRemoved: readonly string[];
  readonly reason?: string;
  /** Repair iterations to reach green: 0 for `clean`, K for `repaired`. */
  readonly iterations?: number;
  /** Set only when `verdict === "regressed"`. */
  readonly regressedReason?: RegressedReason;
  /** Total agent tokens spent on this file (initial edit + repairs). */
  readonly tokens?: number;
}

export interface FailureLog {
  readonly file: string;
  readonly error: unknown;
  readonly durationMs: number;
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

export interface WorkflowRunLog {
  readonly runId: string;
  readonly startedAt: string;
  readonly backend: string;
  readonly stages: readonly StageLog[];
  readonly outcomes: readonly OutcomeLog[];
  readonly failures: readonly FailureLog[];
  readonly summary: WorkflowRunSummary;
}

export class WorkflowMonitor {
  readonly #runId: string;
  readonly #startedAt: Date;
  readonly #backend: string;
  readonly #stages: StageLog[] = [];
  readonly #outcomes: OutcomeLog[] = [];
  readonly #failures: FailureLog[] = [];

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

  toJson(): WorkflowRunLog {
    const count = (verdict: OutcomeVerdict): number =>
      this.#outcomes.filter((o) => o.verdict === verdict).length;
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
    };
  }

  async writeLog(logDir: string): Promise<void> {
    const path = join(logDir, `${this.#runId}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.toJson(), null, 2));
  }
}
