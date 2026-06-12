import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Usage } from "../model/index.ts";

export type StageStatus = "completed" | "failed";
export type OutcomeVerdict =
  | "changed"
  | "repaired"
  | "regressed"
  | "guard-reject"
  | "skipped"
  | "no-op"
  | "precondition-skip";

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
  readonly iterations?: number;
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
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
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
      this.#outcomes.filter((outcome) => outcome.verdict === verdict).length;
    const pass = count("changed") + count("repaired");
    const fail = count("regressed") + count("guard-reject") + this.#failures.length;
    const skip = count("skipped") + count("no-op");
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
