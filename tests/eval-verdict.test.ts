import { describe, expect, test } from "bun:test";
import { WorkflowMonitor } from "../src/index.ts";
import {
  makeStallDetector,
  validationSignature,
  type CommandRunSummary
} from "../workflows/ai-slop-cleanup.ts";

function failed(command: string, stderr: string): CommandRunSummary {
  return { command, status: "failed", stdout: "", stderr, exitCode: 1 };
}

function passed(command: string): CommandRunSummary {
  return { command, status: "passed", stdout: "", stderr: "", exitCode: 0 };
}

const issue = (runs: readonly CommandRunSummary[]) => ({
  message: validationSignature(runs),
  fixable: true as const
});

describe("validationSignature", () => {
  test("is stable across volatile line numbers and paths", () => {
    const a = validationSignature([failed("bun test", "(fail) at /repo/src/a.ts:42 expected 1")]);
    const b = validationSignature([failed("bun test", "(fail) at /other/src/a.ts:99 expected 1")]);
    expect(a).toBe(b);
  });

  test("differs when the failing command set differs", () => {
    const a = validationSignature([failed("bun test", "expected x")]);
    const b = validationSignature([failed("bun run lint", "expected x")]);
    expect(a).not.toBe(b);
  });

  test("ignores passed runs", () => {
    const a = validationSignature([passed("bun run lint"), failed("bun test", "error here")]);
    const b = validationSignature([failed("bun test", "error here")]);
    expect(a).toBe(b);
  });
});

describe("makeStallDetector", () => {
  test("flags an immediate repeat as stalled", () => {
    const stalled = makeStallDetector();
    const same = [issue([failed("bun test", "expected 1 got 2")])];
    expect(stalled(same)).toBe(false);
    expect(stalled(same)).toBe(true);
  });

  test("flags an A→B→A oscillation as stalled", () => {
    const stalled = makeStallDetector();
    const a = [issue([failed("bun test", "expected A")])];
    const b = [issue([failed("bun test", "expected B")])];
    expect(stalled(a)).toBe(false);
    expect(stalled(b)).toBe(false);
    expect(stalled(a)).toBe(true);
  });

  test("does not flag genuine progress", () => {
    const stalled = makeStallDetector();
    expect(stalled([issue([failed("bun test", "error one")])])).toBe(false);
    expect(stalled([issue([failed("bun test", "error two")])])).toBe(false);
    expect(stalled([issue([failed("bun test", "error three")])])).toBe(false);
  });
});

describe("WorkflowMonitor verdict counting", () => {
  test("pass = clean + repaired; precondition-skip excluded from denominator", () => {
    const monitor = new WorkflowMonitor("codex");
    const base = { durationMs: 1, smellsRemoved: [] as string[] };
    monitor.recordOutcome({ file: "a.ts", verdict: "clean", iterations: 0, ...base });
    monitor.recordOutcome({ file: "b.ts", verdict: "repaired", iterations: 2, ...base });
    monitor.recordOutcome({ file: "c.ts", verdict: "regressed", regressedReason: "stuck", ...base });
    monitor.recordOutcome({ file: "d.ts", verdict: "guard-reject", ...base });
    monitor.recordOutcome({ file: "e.ts", verdict: "declined", ...base });
    monitor.recordOutcome({ file: "f.ts", verdict: "precondition-skip", ...base });

    const { summary } = monitor.toJson();
    expect(summary.pass).toBe(2);
    expect(summary.fail).toBe(2);
    expect(summary.skip).toBe(1);
    expect(summary.preconditionSkip).toBe(1);
  });
});
