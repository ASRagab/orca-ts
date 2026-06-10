import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type StageStatus = "completed" | "failed";
export type OutcomeVerdict = "changed" | "skipped" | "no-op";

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
}

export interface FailureLog {
  readonly file: string;
  readonly error: unknown;
  readonly durationMs: number;
}

export interface WorkflowRunSummary {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
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
    const pass = this.#outcomes.filter((o) => o.verdict === "changed").length;
    const skip = this.#outcomes.filter((o) => o.verdict === "skipped" || o.verdict === "no-op").length;
    const fail = this.#failures.length;
    return {
      runId: this.#runId,
      startedAt: this.#startedAt.toISOString(),
      backend: this.#backend,
      stages: [...this.#stages],
      outcomes: [...this.#outcomes],
      failures: [...this.#failures],
      summary: { pass, fail, skip, durationMs: Date.now() - this.#startedAt.getTime() },
    };
  }

  async writeLog(logDir: string): Promise<void> {
    const path = join(logDir, `${this.#runId}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.toJson(), null, 2));
  }
}
