import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import {
  createRunPresenter,
  createRunReporter,
  defineLoop,
  flow,
  loop,
  reporter,
  stdout,
  terminal,
  WorkflowMonitor,
  type RunEvent,
} from "../src/index.ts";
import { fakeSource } from "../src/test-utils/fakes.ts";
import { runQuiet } from "../src/tools/process.ts";

function captureReporter(events: RunEvent[] = []) {
  return createRunReporter({ sinks: [{ handle: (event) => { events.push(event); } }] });
}

describe("run output integration", () => {
  test("WorkflowMonitor emits shared run events while preserving its JSON log shape", async () => {
    const events: RunEvent[] = [];
    const root = await mkdtemp(join(tmpdir(), "orca-monitor-output-"));
    try {
      const monitor = new WorkflowMonitor("codex", { reporter: captureReporter(events), statusIntervalMs: 0 });

      await monitor.stage("inspect", () => Promise.resolve());
      monitor.recordCycle({ iteration: 1, measure: 2, usage: { input: 1, output: 2 } });
      await monitor.writeLog(root);

      const log = monitor.toJson();
      expect(log.backend).toBe("codex");
      expect(log.stages).toHaveLength(1);
      expect(log.stages[0]?.name).toBe("inspect");
      expect(log.stages[0]?.status).toBe("completed");
      expect(log.progress).toHaveLength(1);
      expect(log.progress[0]?.iteration).toBe(1);
      expect(log.progress[0]?.measure).toBe(2);
      expect(log.progress[0]?.delta).toBe(0);
      expect(log.progress[0]?.stopReasonSoFar).toBe("running");
      expect(events.map((event) => event.type)).toEqual([
        "run_started",
        "stage",
        "stage",
        "cycle_progress",
        "artifact",
      ]);
      const finalEvent = events.at(-1);
      expect(finalEvent?.type).toBe("artifact");
      if (finalEvent?.type !== "artifact") {
        throw new Error("Expected final monitor event to be an artifact");
      }
      expect(finalEvent.artifact).toBe("monitor-log");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("flow context exposes an overridable reporter and terminal delegates compatible events", async () => {
    const events: RunEvent[] = [];
    await flow([], { reporter: captureReporter(events) })(() => {
      reporter().emit({ type: "stage", name: "setup", status: "started" });
      terminal().emit({ type: "step", name: "patch", status: "completed" });
      terminal().emit({ type: "assistant_message", text: "ready" });
      expect(terminal().lines()).toEqual(["step: patch completed", "ready"]);
    });

    expect(events).toEqual([
      { type: "stage", name: "setup", status: "started" },
      { type: "stage", name: "patch", status: "completed" },
      { type: "agent_activity", activity: "assistant_summary", summary: "ready" },
    ]);
  });

  test("loop builder and loop firing report progress without polluting stdout sinks", async () => {
    const events: RunEvent[] = [];
    const result = await loop<number>("countdown")
      .step("decrement", (state) => state - 1)
      .measure((state) => state)
      .run(2, { overrides: { reporter: captureReporter(events) } });

    expect(result._unsafeUnwrap().stopReason).toBe("converged");
    expect(
      events.some(
        (event) =>
          event.type === "cycle_progress" && event.iteration === 1 && event.measure === 1,
      ),
    ).toBe(true);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const firingReporter = createRunReporter({
      sinks: [
        createRunPresenter({
          env: {},
          isTTY: false,
          writeDiagnostic: (text) => stderrChunks.push(text),
          writeOutput: (text) => stdoutChunks.push(text),
        }),
      ],
    });
    const definition = defineLoop<undefined, string, string>({
      name: "stdout-loop",
      source: fakeSource<undefined>(),
      sink: stdout({ write: (text) => stdoutChunks.push(text) }),
      onTrigger: () =>
        Promise.resolve(
          ok({
            outcome: { state: "done", stopReason: "converged", iterations: 1 },
            output: "payload",
          }),
        ),
    });

    await import("../src/loop/firing.ts").then(({ runLoopFiring }) =>
      runLoopFiring(definition, undefined, { reporter: firingReporter }),
    );

    expect(stdoutChunks).toEqual(["payload\n"]);
    expect(stderrChunks.join("")).toContain("orcats | run started: stdout-loop\n");
    expect(stderrChunks.join("")).toContain(
      "orcats | done: stdout-loop stopped (converged) after 1 iteration(s)\n",
    );
  });

  test("loop firing supplies its reporter to loop builder progress", async () => {
    const events: RunEvent[] = [];
    const firingReporter = captureReporter(events);
    const definition = defineLoop<undefined, string, number>({
      name: "ambient-countdown",
      source: fakeSource<undefined>(),
      sink: stdout({ write: () => undefined }),
      async onTrigger() {
        const result = await loop<number>("ambient-countdown")
          .step("decrement", (state) => state - 1)
          .measure((state) => state)
          .run(1);
        return result.map((outcome) => ({ outcome, output: "done" }));
      },
    });

    await import("../src/loop/firing.ts").then(({ runLoopFiring }) =>
      runLoopFiring(definition, undefined, { reporter: firingReporter }),
    );

    expect(
      events.some(
        (event) =>
          event.type === "cycle_progress" && event.iteration === 1 && event.measure === 0,
      ),
    ).toBe(true);
  });

  test("flow CLI reports preflight, stages, and failures on stderr while preserving stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-flow-output-"));
    const apiPath = join(process.cwd(), "src", "index.ts");
    const okFlow = join(root, "ok-flow.ts");
    const failingFlow = join(root, "failing-flow.ts");
    await writeFile(
      okFlow,
      `import { flow, terminal } from ${JSON.stringify(apiPath)};

await flow()(() => {
  console.log("payload");
  terminal().emit({ type: "step", name: "inspect", status: "started" });
});
`,
    );
    await writeFile(
      failingFlow,
      `import { flow, terminal } from ${JSON.stringify(apiPath)};

await flow()(() => {
  terminal().emit({ type: "step", name: "explode", status: "started" });
  throw new Error("flow boom");
});
`,
    );

    try {
      const okResult = await runQuiet("bun", ["./bin/orcats", "--no-typecheck", okFlow], {
        cwd: process.cwd(),
      });
      const okProc = okResult._unsafeUnwrap();
      expect(okProc.stdout).toBe("payload\n");
      expect(okProc.stderr).toContain("orcats | preflight typecheck skipped: flag\n");
      expect(okProc.stderr).toContain("orcats | stage inspect started\n");
      expect(okProc.stderr).toContain(`orcats | done: ${okFlow} completed\n`);

      const failedResult = await runQuiet("bun", ["./bin/orcats", "--no-typecheck", failingFlow], {
        cwd: process.cwd(),
      });
      const failed = failedResult._unsafeUnwrapErr();
      expect(failed._tag).toBe("CommandFailed");
      if (failed._tag === "CommandFailed") {
        expect(failed.stdout).toBe("");
        expect(failed.stderr).toContain("orcats | stage explode started\n");
        expect(failed.stderr).toContain(`orcats | failed: ${failingFlow}: flow boom\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loop CLI reports cycle progress and final summary while preserving stdout sink output", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-loop-output-"));
    const apiPath = join(process.cwd(), "src", "index.ts");
    const loopPath = join(root, "loop.ts");
    await writeFile(
      loopPath,
      `import { defineLoop, loop, manual, stdout } from ${JSON.stringify(apiPath)};

export default defineLoop({
  name: "cli-countdown",
  source: manual(),
  sink: stdout(),
  async onTrigger() {
    const result = await loop("cli-countdown")
      .step("decrement", (state) => state - 1)
      .measure((state) => state)
      .run(1);
    return result.map((outcome) => ({ outcome, output: "done" }));
  },
});
`,
    );

    try {
      const result = await runQuiet("bun", ["./bin/orcats", "run", "--no-typecheck", loopPath], {
        cwd: process.cwd(),
      });
      const proc = result._unsafeUnwrap();
      expect(proc.stdout).toBe("done\n");
      expect(proc.stderr).toContain("orcats | cycle 1 measure=0\n");
      expect(proc.stderr).toContain("orcats | done: cli-countdown stopped (converged) after 1 iteration(s)\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
