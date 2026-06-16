import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { fixLoop, type ReviewIssue } from "../src/index.ts";

const issue = (message: string, fixable = true): ReviewIssue => ({
  reviewer: "test",
  message,
  fixable,
});

describe("fixLoop", () => {
  test("clean on first evaluation - halts immediately, 0 fix operations", async () => {
    let evalCount = 0;
    const result = await fixLoop(
      () => { evalCount++; return Promise.resolve(ok([])); },
      () => Promise.resolve(ok(undefined)),
    );
    expect(result._unsafeUnwrap()).toEqual({
      iterations: 0,
      ignoredIssues: [],
      converged: true,
      stop: "converged",
      events: ["evaluate:started", "evaluate:completed"],
    });
    expect(evalCount).toBe(1);
  });

  test("dirty first, clean after fix - 2 evaluate calls, 1 fix call", async () => {
    let evalCount = 0;
    const result = await fixLoop(
      () => {
        evalCount++;
        return Promise.resolve(ok(evalCount === 1 ? [issue("found")] : []));
      },
      () => Promise.resolve(ok(undefined)),
    );
    const summary = result._unsafeUnwrap();
    expect(summary.iterations).toBe(1);
    expect(summary.ignoredIssues).toEqual([]);
    expect(summary.converged).toBe(true);
    expect(evalCount).toBe(2);
  });

  test("dirty, no fixable issues - halts immediately without fixing", async () => {
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("unfixable", false)])),
      () => Promise.resolve(ok(undefined)),
    );
    const summary = result._unsafeUnwrap();
    expect(summary.iterations).toBe(0);
    expect(summary.converged).toBe(false);
    expect(summary.ignoredIssues).toHaveLength(1);
    expect(summary.ignoredIssues[0]?.message).toBe("unfixable");
  });

  test("dirty, fix never clears - halts at maxIterations", async () => {
    let evalCount = 0;
    let fixCount = 0;
    const result = await fixLoop(
      () => { evalCount++; return Promise.resolve(ok([issue("persistent")])); },
      () => { fixCount++; return Promise.resolve(ok(undefined)); },
      3,
    );
    const summary = result._unsafeUnwrap();
    expect(summary.iterations).toBe(3);
    expect(summary.converged).toBe(false);
    expect(summary.ignoredIssues).toHaveLength(1);
    expect(evalCount).toBe(4);
    expect(fixCount).toBe(3);
  });

  test("event sequence: evaluate/fix per iteration in correct order", async () => {
    let evalCount = 0;
    const result = await fixLoop(
      () => {
        evalCount++;
        return Promise.resolve(ok(evalCount <= 2 ? [issue("x")] : []));
      },
      () => Promise.resolve(ok(undefined)),
    );
    expect(result._unsafeUnwrap().events).toEqual([
      "evaluate:started", "evaluate:completed",
      "fix:started", "fix:completed",
      "evaluate:started", "evaluate:completed",
      "fix:started", "fix:completed",
      "evaluate:started", "evaluate:completed",
    ]);
  });

  test("fix only receives fixable issues, not all issues", async () => {
    const received: ReviewIssue[] = [];
    await fixLoop(
      () => Promise.resolve(ok([issue("fixable", true), issue("unfixable", false)])),
      (issues) => { received.push(...issues); return Promise.resolve(ok(undefined)); },
      1,
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.message).toBe("fixable");
  });

  test("propagates evaluate error", async () => {
    const error = { _tag: "CommandFailed" as const, command: "eval", exitCode: 1, stdout: "", stderr: "boom" };
    const result = await fixLoop(
      () => Promise.resolve(err(error)),
      () => Promise.resolve(ok(undefined)),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()._tag).toBe("CommandFailed");
  });

  test("propagates fix error", async () => {
    const error = { _tag: "CommandFailed" as const, command: "fix", exitCode: 1, stdout: "", stderr: "boom" };
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("x")])),
      () => Promise.resolve(err(error)),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()._tag).toBe("CommandFailed");
  });

  test("maxIterations=0 halts before any fix", async () => {
    let fixCount = 0;
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("x")])),
      () => { fixCount++; return Promise.resolve(ok(undefined)); },
      0,
    );
    const summary = result._unsafeUnwrap();
    expect(summary.iterations).toBe(0);
    expect(summary.converged).toBe(false);
    expect(summary.stop).toBe("ceiling");
    expect(fixCount).toBe(0);
  });

  test("stalled detector stops the loop as stuck", async () => {
    let fixCount = 0;
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("persistent")])),
      () => { fixCount++; return Promise.resolve(ok(undefined)); },
      { maxIterations: 10, stalled: () => true },
    );
    const summary = result._unsafeUnwrap();
    expect(summary.converged).toBe(false);
    expect(summary.stop).toBe("stuck");
    expect(summary.events).toContain("no-progress");
    expect(fixCount).toBe(0);
  });

  test("wall-clock backstop stops the loop as timeout", async () => {
    let clock = 0;
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("slow")])),
      () => { clock += 100; return Promise.resolve(ok(undefined)); },
      { maxIterations: 100, wallClockMs: 250, now: () => clock },
    );
    const summary = result._unsafeUnwrap();
    expect(summary.converged).toBe(false);
    expect(summary.stop).toBe("timeout");
  });

  test("unfixable issues report stop=unfixable", async () => {
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("unfixable", false)])),
      () => Promise.resolve(ok(undefined)),
    );
    expect(result._unsafeUnwrap().stop).toBe("unfixable");
  });

  test("budget-exhausted fires when reported usage exceeds the token budget", async () => {
    let fixCount = 0;
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("expensive")])),
      () => {
        fixCount++;
        return Promise.resolve(ok({ usage: { input: 6, output: 5 } }));
      },
      { maxIterations: 10, tokenBudget: 10 },
    );

    const summary = result._unsafeUnwrap();
    expect(summary.iterations).toBe(1);
    expect(summary.stop).toBe("budget-exhausted");
    expect(summary.tokenUsage).toEqual({ kind: "known", total: 11, budget: 10 });
    expect(fixCount).toBe(1);
  });

  test("missing usage records unknown and does not trip the token budget", async () => {
    let evalCount = 0;
    const result = await fixLoop(
      () => {
        evalCount++;
        return Promise.resolve(ok(evalCount === 1 ? [issue("unknown usage")] : []));
      },
      () => Promise.resolve(ok(undefined)),
      { maxIterations: 10, tokenBudget: 0 },
    );

    const summary = result._unsafeUnwrap();
    expect(summary.converged).toBe(true);
    expect(summary.stop).toBe("converged");
    expect(summary.iterations).toBe(1);
    expect(summary.tokenUsage).toEqual({ kind: "unknown", knownTotal: 0, budget: 0 });
  });

  test("fingerprint projection flags an immediate repeated action as stuck", async () => {
    let fixCount = 0;
    const result = await fixLoop(
      () => Promise.resolve(ok([issue("same failure")])),
      () => {
        fixCount++;
        return Promise.resolve(ok(undefined));
      },
      {
        maxIterations: 10,
        fingerprint: (issues) => ({ identity: "validation", inputs: issues.map((item) => item.message) }),
      },
    );

    const summary = result._unsafeUnwrap();
    expect(summary.stop).toBe("stuck");
    expect(summary.iterations).toBe(1);
    expect(fixCount).toBe(1);
  });

  test("fingerprint projection flags an A→B→A oscillation as stuck", async () => {
    const failures = ["A", "B", "A"];
    let evalCount = 0;
    let fixCount = 0;

    const result = await fixLoop(
      () => Promise.resolve(ok([issue(failures[Math.min(evalCount++, failures.length - 1)] ?? "A")])),
      () => {
        fixCount++;
        return Promise.resolve(ok(undefined));
      },
      {
        maxIterations: 10,
        fingerprint: (issues) => ({ identity: "validation", inputs: issues.map((item) => item.message) }),
      },
    );

    const summary = result._unsafeUnwrap();
    expect(summary.stop).toBe("stuck");
    expect(summary.iterations).toBe(2);
    expect(fixCount).toBe(2);
  });

  test("generic overload converges and records usage across cycles", async () => {
    let state = 0;

    const result = await fixLoop({
      evaluate: () => Promise.resolve(ok(state)),
      converged: (value) => value === 2,
      nextAction: (value) => ({ identity: "increment", inputs: { from: value } }),
      fix: () => {
        state++;
        return Promise.resolve(ok({ usage: { input: 1, output: 1, reasoning: 1 } }));
      },
      maxIterations: 10,
      tokenBudget: 10,
    });

    const summary = result._unsafeUnwrap();
    expect(summary.converged).toBe(true);
    expect(summary.stop).toBe("converged");
    expect(summary.iterations).toBe(2);
    expect(summary.lastEvaluation).toBe(2);
    expect(summary.tokenUsage).toEqual({ kind: "known", total: 6, budget: 10 });
  });

  test("mixed usage records an unknown total without a budget", async () => {
    let state = 0;

    const result = await fixLoop({
      evaluate: () => Promise.resolve(ok(state)),
      converged: (value) => value === 3,
      nextAction: (value) => ({ identity: "increment", inputs: { from: value } }),
      fix: () => {
        state++;
        return Promise.resolve(state === 2 ? ok(undefined) : ok({ usage: { input: 1, output: 1 } }));
      },
      maxIterations: 10,
    });

    const summary = result._unsafeUnwrap();
    expect(summary.converged).toBe(true);
    expect(summary.iterations).toBe(3);
    expect(summary.tokenUsage).toEqual({ kind: "unknown", knownTotal: 4 });
  });
});
