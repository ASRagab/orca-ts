import { describe, expect, test } from "bun:test";
import { WorkflowMonitor, type WorkflowRunLog } from "../src/index.ts";
import { summarizeLogs } from "../scripts/summarize-run.ts";

describe("workflow monitor", () => {
  test("records stages, outcomes, failures, summary counts, and optional usage", async () => {
    const monitor = new WorkflowMonitor("codex");

    await monitor.stage("baseline validation", () => Promise.resolve("ok"));
    try {
      await monitor.stage("agent turn", () => Promise.reject(new Error("boom")));
      throw new Error("expected agent turn to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("boom");
    }
    monitor.recordOutcome({
      file: "src/a.ts",
      verdict: "repaired",
      durationMs: 42,
      smellsRemoved: ["dead code"],
      changedPaths: ["src/a.ts"],
      validation: [
        {
          command: "bun test tests/a.test.ts",
          status: "passed",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          durationMs: 10
        }
      ],
      iterations: 1,
      usage: { input: 3, output: 4, reasoning: 5 },
      tokens: 12
    });
    monitor.recordOutcome({
      file: "src/b.ts",
      verdict: "precondition-skip",
      durationMs: 5,
      smellsRemoved: [],
      reason: "targeted baseline failed"
    });
    monitor.recordFailure({
      file: "src/c.ts",
      error: { _tag: "BackendFailed", backend: "codex", message: "stalled" },
      durationMs: 7,
      category: "agent"
    });

    const log = monitor.toJson();

    expect(log.backend).toBe("codex");
    expect(log.stages).toEqual([
      expect.objectContaining({ name: "baseline validation", status: "completed" }),
      expect.objectContaining({ name: "agent turn", status: "failed" })
    ]);
    const firstOutcome = log.outcomes[0];
    const firstFailure = log.failures[0];
    if (!firstOutcome || !firstFailure) {
      throw new Error("expected monitor log entries");
    }
    expect(firstOutcome.file).toBe("src/a.ts");
    expect(firstOutcome.verdict).toBe("repaired");
    expect(firstOutcome.changedPaths).toEqual(["src/a.ts"]);
    expect(firstOutcome.iterations).toBe(1);
    expect(firstOutcome.tokens).toBe(12);
    expect(firstOutcome.usage).toEqual({ input: 3, output: 4, reasoning: 5 });
    expect(firstFailure.file).toBe("src/c.ts");
    expect(firstFailure.category).toBe("agent");
    expect(typeof firstFailure.durationMs).toBe("number");
    expect(log.summary.pass).toBe(1);
    expect(log.summary.fail).toBe(1);
    expect(log.summary.skip).toBe(0);
    expect(log.summary.preconditionSkip).toBe(1);
  });

  test("summarizer reports backend totals, slow stages, slow files, failures, repairs, and usage", () => {
    const log: WorkflowRunLog = {
      runId: "12345678-run",
      startedAt: "2026-06-12T00:00:00.000Z",
      backend: "codex",
      stages: [
        { name: "baseline validation", startedAt: "2026-06-12T00:00:00.000Z", durationMs: 20, status: "completed" }
      ],
      outcomes: [
        {
          file: "src/a.ts",
          verdict: "repaired",
          durationMs: 50,
          smellsRemoved: ["dead code"],
          changedPaths: ["src/a.ts"],
          validation: [
            {
              command: "bun test tests/a.test.ts",
              status: "passed",
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              durationMs: 15
            }
          ],
          iterations: 1,
          usage: { input: 3, output: 4, reasoning: 5 },
          tokens: 12
        }
      ],
      failures: [{ file: "src/c.ts", error: { _tag: "BackendFailed" }, durationMs: 7, category: "agent" }],
      summary: { pass: 1, fail: 1, skip: 0, preconditionSkip: 0, durationMs: 100 }
    };

    const summary = summarizeLogs([log]);

    expect(summary).toContain("codex: 1 run(s), 2 files, 1 pass, 1 fail");
    expect(summary).toContain("baseline validation: 20ms (completed)");
    expect(summary).toContain("src/a.ts: 50ms (repaired, repairs=1, validation=15ms)");
    expect(summary).toContain("Files repaired: 1");
    expect(summary).toContain("Input: 3");
    expect(summary).toContain("[12345678] src/c.ts: agent (7ms)");
  });
});
