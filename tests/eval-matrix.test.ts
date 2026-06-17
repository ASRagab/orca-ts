import { describe, expect, test } from "bun:test";
import type { OutcomeLog, WorkflowRunLog } from "../src/index.ts";
import { buildBackendMatrix } from "../scripts/summarize-run.ts";

function outcome(partial: Partial<OutcomeLog> & Pick<OutcomeLog, "verdict">): OutcomeLog {
  return { file: "f.ts", durationMs: 1000, smellsRemoved: [], ...partial };
}

function log(backend: string, outcomes: readonly OutcomeLog[]): WorkflowRunLog {
  return {
    runId: `${backend}-run`,
    startedAt: new Date().toISOString(),
    backend,
    stages: [],
    outcomes: [...outcomes],
    failures: [],
    summary: { pass: 0, fail: 0, skip: 0, preconditionSkip: 0, durationMs: 0 },
    progress: []
  };
}

describe("buildBackendMatrix", () => {
  test("aggregates per-backend convergence-cost columns", () => {
    const logs = [
      log("codex", [
        outcome({ verdict: "clean", iterations: 0, tokens: 40_000, durationMs: 40_000 }),
        outcome({ verdict: "repaired", iterations: 2, tokens: 80_000, durationMs: 60_000 }),
        outcome({ verdict: "regressed", regressedReason: "stuck", tokens: 120_000, durationMs: 90_000 })
      ]),
      log("pi", [
        outcome({ verdict: "regressed", regressedReason: "timeout", tokens: 300_000, durationMs: 180_000 }),
        outcome({ verdict: "declined", tokens: 0, durationMs: 5_000 })
      ])
    ];

    const matrix = buildBackendMatrix(logs);
    const codex = matrix.find((r) => r.backend === "codex");
    const pi = matrix.find((r) => r.backend === "pi");

    expect(codex).toBeDefined();
    expect(codex?.clean).toBe(1);
    expect(codex?.repaired).toBe(1);
    expect(codex?.repairedAvgIterations).toBe(2);
    expect(codex?.regressedStuck).toBe(1);
    expect(codex?.tokensPerFile).toBe((40_000 + 80_000 + 120_000) / 3);

    expect(pi?.regressedTimeout).toBe(1);
    expect(pi?.declined).toBe(1);
  });

  test("excludes precondition-skip from the per-file denominators", () => {
    const logs = [
      log("codex", [
        outcome({ verdict: "clean", iterations: 0, tokens: 30_000, durationMs: 30_000 }),
        outcome({ verdict: "precondition-skip", tokens: 0, durationMs: 9_999 })
      ])
    ];
    const [row] = buildBackendMatrix(logs);
    // Only the clean file counts toward tokens/wall — the skipped precondition does not.
    expect(row?.preconditionSkip).toBe(1);
    expect(row?.tokensPerFile).toBe(30_000);
    expect(row?.wallMsPerFile).toBe(30_000);
  });

  test("a backend that was never run is absent, not a failure", () => {
    const matrix = buildBackendMatrix([log("codex", [outcome({ verdict: "clean", iterations: 0 })])]);
    expect(matrix.map((r) => r.backend)).toEqual(["codex"]);
    expect(matrix.find((r) => r.backend === "opencode")).toBeUndefined();
  });
});
