import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import { executeLoop } from "../src/loop/execution.ts";

describe("loop execution stop semantics", () => {
  test("budget exhaustion returns the post-step evaluation state", async () => {
    let count = 0;

    const result = await executeLoop<{ readonly count: number }>({
      evaluate: () => Promise.resolve(ok({ count })),
      converged: () => false,
      nextAction: () => ({ identity: "increment", inputs: null }),
      execute: () => {
        count += 1;
        return Promise.resolve(ok({ usage: { input: 2, output: 0 } }));
      },
      tokenBudget: 1,
      maxIterations: 5,
      fingerprint: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.stop).toBe("budget-exhausted");
      expect(result.value.iterations).toBe(1);
      expect(result.value.lastEvaluation).toEqual({ count: 1 });
    }
  });

  test("step stopReason stops the loop with the post-step evaluation state", async () => {
    let count = 0;

    const result = await executeLoop<{ readonly count: number }>({
      evaluate: () => Promise.resolve(ok({ count })),
      converged: () => false,
      nextAction: () => ({ identity: "increment", inputs: null }),
      execute: () => {
        count += 1;
        return Promise.resolve(ok({ stopReason: "cancelled" }));
      },
      maxIterations: 5,
      fingerprint: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.stop).toBe("cancelled");
      expect(result.value.iterations).toBe(1);
      expect(result.value.lastEvaluation).toEqual({ count: 1 });
    }
  });

  test("default fingerprinting is off for direct executeLoop callers", async () => {
    let count = 3;

    const result = await executeLoop<{ readonly count: number }>({
      evaluate: () => Promise.resolve(ok({ count })),
      converged: (state) => state.count === 0,
      nextAction: () => ({ identity: "decrement", inputs: null }),
      execute: () => {
        count -= 1;
        return Promise.resolve(ok(undefined));
      },
      maxIterations: 5,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.stop).toBe("converged");
      expect(result.value.iterations).toBe(3);
      expect(result.value.lastEvaluation).toEqual({ count: 0 });
    }
  });
});
