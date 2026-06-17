import { describe, expect, test } from "bun:test";

import {
  WorkflowMonitor,
  loop,
  measure as manifestMeasure,
  untilManifestComplete,
  type TaskManifest,
  type Usage,
} from "../src/index.ts";

// L10 acceptance (spec execution-observability / tasks §9): a loop emits a per-cycle progress
// stream on the run log. The stream is derived from the same manifest projection (L05 `measure`)
// that drives the termination variant, so reported `measure`/`delta` cannot drift from the stop
// reason; cumulative usage reuses the L02 counter, so a usage-less cycle reports `unknown`, not zero.

const manifest = (passes: readonly boolean[]): TaskManifest => ({
  tasks: passes.map((p, i) => ({ id: `t${String(i)}`, passes: p })),
});

/** Flip the first still-pending task — one unit of manifest progress per cycle. */
const passOne = (state: TaskManifest): TaskManifest => {
  const index = state.tasks.findIndex((task) => !task.passes);
  if (index < 0) return state;
  return { tasks: state.tasks.map((task, i) => (i === index ? { ...task, passes: true } : task)) };
};

const usage = (input: number, output: number): Usage => ({ input, output });

describe("loop progress stream (tasks 9.1-9.3)", () => {
  test("each completed cycle appends a record with iteration, measure, and delta", async () => {
    const monitor = new WorkflowMonitor("codex");
    const start = manifest([false, false, false]); // pending = 3

    const result = await loop<TaskManifest>("manifest")
      .step("pass-one", passOne)
      .until(untilManifestComplete())
      .run(start, {
        onCycle: (cycle) => {
          monitor.recordCycle(cycle);
        },
      });

    const outcome = result._unsafeUnwrap();
    expect(outcome.stopReason).toBe("converged");
    expect(outcome.iterations).toBe(3);

    const { progress } = monitor.toJson();
    expect(progress.map((p) => p.iteration)).toEqual([1, 2, 3]);
    // Measure is the manifest projection's pending count, decreasing toward the floor.
    expect(progress.map((p) => p.measure)).toEqual([2, 1, 0]);
    // delta = change vs the prior cycle; 0 for the first record, then one unit of progress each.
    expect(progress.map((p) => p.delta)).toEqual([0, -1, -1]);
  });

  test("the stream stays consistent with the termination variant", async () => {
    const monitor = new WorkflowMonitor("codex");
    const start = manifest([false, false]);

    const result = await loop<TaskManifest>("manifest")
      .step("pass-one", passOne)
      .until(untilManifestComplete())
      .run(start, {
        onCycle: (cycle) => {
          monitor.recordCycle(cycle);
        },
      });

    const outcome = result._unsafeUnwrap();
    const { progress } = monitor.toJson();
    const last = progress.at(-1);
    if (last === undefined) throw new Error("expected a progress record");

    // The variant converges exactly when the projection hits 0; the stream's last record agrees.
    expect(last.measure).toBe(0);
    expect(last.measure).toBe(manifestMeasure(manifest([true, true])));
    expect(last.stopReasonSoFar).toBe("converged");
    expect(last.stopReasonSoFar).toBe(outcome.stopReason);
    // A still-pending cycle reports `running`, never a terminal reason.
    expect(progress.slice(0, -1).every((p) => p.stopReasonSoFar === "running")).toBe(true);
  });

  test("a fan-out cycle records each branch's id, status, and usage-or-unknown", () => {
    const monitor = new WorkflowMonitor("codex");

    monitor.recordCycle({
      iteration: 1,
      measure: 4,
      branches: [
        { id: "b1", status: "completed", usage: usage(100, 50) },
        { id: "b2", status: "failed", usage: usage(20, 10) },
        { id: "b3", status: "completed" }, // backend reported no usage
      ],
    });

    const record = monitor.toJson().progress[0];
    if (record === undefined) throw new Error("expected a progress record");

    expect(record.branches).toEqual([
      { id: "b1", status: "completed", usage: { input: 100, output: 50 } },
      { id: "b2", status: "failed", usage: { input: 20, output: 10 } },
      { id: "b3", status: "completed", usage: "unknown" },
    ]);

    // A branch with no reported usage makes the cumulative summary `unknown` — not zero — while
    // still carrying the known total (100+50 + 20+10 = 180).
    expect(record.cumulativeUsage).toEqual({ kind: "unknown", knownTotal: 180 });
  });

  test("flat delta with rising token usage surfaces an incipient runaway before a guard fires", () => {
    const monitor = new WorkflowMonitor("codex");

    // Measure is stuck at 5 across four cycles while each cycle burns more tokens.
    for (let iteration = 1; iteration <= 4; iteration++) {
      monitor.recordCycle({ iteration, measure: 5, usage: usage(800, 200) });
    }

    const { progress } = monitor.toJson();

    // Flat delta: no progress after the first record.
    expect(progress.map((p) => p.delta)).toEqual([0, 0, 0, 0]);
    // No guard has fired — every record is still `running`, so the runaway is visible pre-emptively.
    expect(progress.every((p) => p.stopReasonSoFar === "running")).toBe(true);
    // Cumulative reported usage climbs monotonically: 1000, 2000, 3000, 4000.
    expect(progress.map((p) => p.cumulativeUsage)).toEqual([
      { kind: "known", total: 1000 },
      { kind: "known", total: 2000 },
      { kind: "known", total: 3000 },
      { kind: "known", total: 4000 },
    ]);
  });

  test("a cycle with no reported usage reports unknown cumulative, not zero", () => {
    const monitor = new WorkflowMonitor("codex");

    monitor.recordCycle({ iteration: 1, measure: 2, usage: usage(500, 100) });
    monitor.recordCycle({ iteration: 2, measure: 1 }); // backend reported nothing

    const second = monitor.toJson().progress[1];
    if (second === undefined) throw new Error("expected a progress record");
    expect(second.cumulativeUsage).toEqual({ kind: "unknown", knownTotal: 600 });
  });
});
