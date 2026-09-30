import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendFailed, describeRuntimeError, WorkflowMonitor, type WorkflowRunLog } from "../src/index.ts";
import { summarizeLogs } from "../scripts/summarize-run.ts";

describe("workflow monitor", () => {
  test("atomically finalizes success once without losing outcomes or usage", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "orcats-monitor-"));
    try {
      const monitor = new WorkflowMonitor("claude", { transport: "stream-json", statusIntervalMs: 0 });
      await monitor.stage("implement", () => Promise.resolve());
      monitor.recordOutcome({
        file: "src/a.ts", verdict: "repaired", durationMs: 1, smellsRemoved: [],
        usage: { input: 3, output: 4 },
      });
      monitor.recordCycle({ iteration: 1, measure: 0, usage: { input: 3, output: 4 } });

      const finalization = monitor.finalize(logDir, { status: "succeeded" });
      expect(monitor.finalize(logDir, { status: "failed", error: new Error("late failure") })).toBe(finalization);
      await finalization;

      const path = join(logDir, `${monitor.runId}.json`);
      const log = JSON.parse(await readFile(path, "utf8")) as WorkflowRunLog;
      expect(log).toMatchObject({
        status: "succeeded", backend: "claude", transport: "stream-json",
        currentStage: "implement", finalStage: "implement",
      });
      expect(Date.parse(log.endedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(log.startedAt));
      expect(log.terminalError).toBeUndefined();
      expect(log.failedStage).toBeUndefined();
      expect(log.outcomes[0]?.usage).toEqual({ input: 3, output: 4 });
      expect(log.progress[0]?.cumulativeUsage).toEqual({ kind: "known", total: 7 });
      expect(await readdir(logDir)).toEqual([`${monitor.runId}.json`]);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("persists typed stage failure before it propagates", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "orcats-monitor-"));
    const error = backendFailed("claude", "turn stalled", {
      transport: "acp", phase: "turn", artifactPath: ".orca/workflows/example.ts",
      recovery: "ORCA_CLAUDE_TRANSPORT=acp orcats doctor claude --smoke",
    });
    const monitor = new WorkflowMonitor("claude", { transport: "acp", statusIntervalMs: 0 });
    const run = async (): Promise<void> => {
      try {
        // RuntimeError is a tagged object, not an Error instance.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        await monitor.stage("agent turn", () => Promise.reject(error));
      } catch (failure) {
        await monitor.finalize(logDir, { status: "failed", error: failure });
        throw failure;
      }
    };
    try {
      let propagated: unknown;
      try {
        await run();
      } catch (failure) {
        propagated = failure;
      }
      expect(propagated).toBe(error);
      const log = JSON.parse(await readFile(join(logDir, `${monitor.runId}.json`), "utf8")) as WorkflowRunLog;
      expect(log).toMatchObject({ status: "failed", currentStage: "agent turn", failedStage: "agent turn" });
      expect(log.terminalError).toMatchObject({
        _tag: "BackendFailed", backend: "claude", transport: "acp", phase: "turn",
        artifactPath: ".orca/workflows/example.ts", recovery: "ORCA_CLAUDE_TRANSPORT=acp orcats doctor claude --smoke",
      });
      expect(log.terminalError?.message).toBe(describeRuntimeError(error));
      expect(log.endedAt).toBeDefined();
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("records initialization failures and arbitrary thrown values", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "orcats-monitor-"));
    const circular: { self?: unknown } = {};
    circular.self = circular;
    try {
      for (const error of [undefined, null, false, 0, 1n, "failed", new Error("initialize failed"), circular]) {
        const monitor = new WorkflowMonitor("codex", { transport: "subprocess", statusIntervalMs: 0 });
        monitor.recordFailure({ file: "initialize", error, durationMs: 0 });
        await monitor.finalize(logDir, { status: "failed", error });
        const log = JSON.parse(await readFile(join(logDir, `${monitor.runId}.json`), "utf8")) as WorkflowRunLog;
        expect(log).toMatchObject({
          status: "failed", currentStage: "initialize", failedStage: "initialize",
          backend: "codex", transport: "subprocess",
        });
        expect(typeof log.terminalError?.message).toBe("string");
        expect(log.terminalError?.message.length).toBeGreaterThan(0);
        expect(log.failures).toHaveLength(1);
      }
      expect((await readdir(logDir)).every((name) => name.endsWith(".json"))).toBe(true);
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  test("emits human-readable status updates when a writer is configured", async () => {
    const lines: string[] = [];
    const monitor = new WorkflowMonitor("codex", {
      writeStatus: (line) => lines.push(line),
      statusIntervalMs: 0
    });

    await monitor.stage("setup", () => Promise.resolve("ok"));
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
      smellsRemoved: [],
      reason: "fixed",
      iterations: 1
    });
    monitor.recordFailure({
      file: "src/b.ts",
      error: { _tag: "BackendFailed", backend: "codex", message: "stalled" },
      durationMs: 7,
      category: "agent"
    });
    monitor.recordCycle({ iteration: 2, measure: 1, usage: { input: 1, output: 2 } });

    expect(lines[0]).toMatch(/^orcats \| run started: [0-9a-f-]+ \(backend=codex\)$/);
    expect(lines).toContain("orcats | stage setup started");
    expect(lines).toContain("orcats | stage agent turn started");
    expect(lines.some((line) => line.startsWith("orcats | stage setup completed ("))).toBe(true);
    expect(lines.some((line) => line.startsWith("orcats | stage agent turn failed (") && line.endsWith(": boom"))).toBe(true);
    expect(lines).toContain("orcats | outcome src/a.ts repaired (42ms): fixed");
    expect(lines).toContain(
      "orcats | failure src/b.ts agent (7ms): codex backend failed: stalled."
    );
    expect(lines).toContain("orcats | cycle 2 measure=1 delta=0 stop=running usage=input=1 output=2");
  });

  test("emits stage heartbeats while a stage is still running", async () => {
    const lines: string[] = [];
    const monitor = new WorkflowMonitor("codex", {
      writeStatus: (line) => lines.push(line),
      statusIntervalMs: 1
    });

    await monitor.stage("slow", () => new Promise((resolve) => setTimeout(resolve, 10)));

    expect(lines.some((line) => line.startsWith("orcats | stage slow running ("))).toBe(true);
  });

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
      summary: { pass: 1, fail: 1, skip: 0, preconditionSkip: 0, durationMs: 100 },
      progress: []
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
