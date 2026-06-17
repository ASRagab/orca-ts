import { describe, expect, spyOn, test } from "bun:test";
import { err, ok } from "neverthrow";
import {
  implementTaskLoop,
  reviewAndFixStrategy,
  runReviewAndFixLoop,
  sequentialTaskStrategy,
  type ReviewerPrompt,
} from "../src/index.ts";

const prompts: ReviewerPrompt[] = [
  { id: "code-functionality", prompt: "functionality" },
  { id: "readability", prompt: "readability" },
  { id: "test", prompt: "test" },
];

describe("reviewAndFixStrategy", () => {
  test("reproduces the single-pass review/fix summary (sequential)", async () => {
    const fixed: string[] = [];
    const result = await reviewAndFixStrategy({
      loadPrompts: () => Promise.resolve(prompts),
      review: (reviewer) =>
        Promise.resolve(
          ok([{ reviewer: reviewer.id, message: `${reviewer.id} finding`, fixable: reviewer.id === "test" }])
        ),
      fix: (issues) => {
        fixed.push(...issues.map((issue) => issue.message));
        return Promise.resolve(ok(undefined));
      },
    });

    expect(result._unsafeUnwrap()).toEqual({
      selected: ["code-functionality", "readability", "test"],
      issues: [
        { reviewer: "code-functionality", message: "code-functionality finding", fixable: false },
        { reviewer: "readability", message: "readability finding", fixable: false },
        { reviewer: "test", message: "test finding", fixable: true },
      ],
      fixed: true,
      events: [
        "review:code-functionality:started",
        "review:code-functionality:completed",
        "review:readability:started",
        "review:readability:completed",
        "review:test:started",
        "review:test:completed",
        "fix:started",
        "fix:completed",
      ],
    });
    expect(fixed).toEqual(["test finding"]);
  });

  test("runs each reviewer exactly once and fixes once — no re-review loop", async () => {
    const reviewCounts = new Map<string, number>();
    let fixCount = 0;
    await reviewAndFixStrategy({
      loadPrompts: () => Promise.resolve(prompts),
      review: (reviewer) => {
        reviewCounts.set(reviewer.id, (reviewCounts.get(reviewer.id) ?? 0) + 1);
        // Every reviewer reports a fixable issue: a naive convergence loop would
        // re-review forever; the single-pass strategy must stop after one fix.
        return Promise.resolve(ok([{ reviewer: reviewer.id, message: "x", fixable: true }]));
      },
      fix: () => {
        fixCount += 1;
        return Promise.resolve(ok(undefined));
      },
    });

    expect([...reviewCounts.values()]).toEqual([1, 1, 1]);
    expect(fixCount).toBe(1);
  });

  test("no fixable issues: no fix, parallel events only", async () => {
    const result = await reviewAndFixStrategy({
      loadPrompts: () => Promise.resolve(prompts),
      parallel: true,
      review: () => Promise.resolve(ok([])),
      fix: () => Promise.resolve(ok(undefined)),
    });
    const summary = result._unsafeUnwrap();
    expect(summary.fixed).toBe(false);
    expect(summary.events).toEqual(["review:parallel:started", "review:parallel:completed"]);
  });

  test("propagates a review error", async () => {
    const error = { _tag: "CommandFailed" as const, command: "review", exitCode: 1, stdout: "", stderr: "x" };
    const result = await reviewAndFixStrategy({
      loadPrompts: () => Promise.resolve(prompts),
      review: (reviewer) =>
        Promise.resolve(reviewer.id === "readability" ? err(error) : ok([])),
      fix: () => Promise.resolve(ok(undefined)),
    });
    expect(result.isErr()).toBe(true);
  });
});

describe("sequentialTaskStrategy", () => {
  test("implements every task and reports completion in order", async () => {
    const result = await sequentialTaskStrategy(
      [
        { id: "1", description: "one" },
        { id: "2", description: "two" },
        { id: "3", description: "three" },
      ],
      () => Promise.resolve(ok(undefined))
    );
    expect(result._unsafeUnwrap()).toEqual({ completed: ["1", "2", "3"] });
  });

  test("stops at the first typed failure", async () => {
    let attempts = 0;
    const result = await sequentialTaskStrategy(
      [
        { id: "1", description: "one" },
        { id: "2", description: "two" },
        { id: "3", description: "three" },
      ],
      (task) => {
        attempts += 1;
        return Promise.resolve(task.id === "2" ? err({ _tag: "NothingToCommit" as const }) : ok(undefined));
      }
    );
    expect(result.isErr()).toBe(true);
    // task 1 + task 2 attempted; task 3 never reached
    expect(attempts).toBe(2);
  });

  test("empty task list converges immediately", async () => {
    const result = await sequentialTaskStrategy([], () => Promise.resolve(ok(undefined)));
    expect(result._unsafeUnwrap()).toEqual({ completed: [] });
  });
});

describe("deprecated wrappers", () => {
  test("runReviewAndFixLoop emits a deprecation warning and delegates", async () => {
    const spy = spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const result = await runReviewAndFixLoop({
        loadPrompts: () => Promise.resolve(prompts),
        review: () => Promise.resolve(ok([])),
        fix: () => Promise.resolve(ok(undefined)),
      });
      expect(result.isOk()).toBe(true);
      expect(spy).toHaveBeenCalled();
      const [message, options] = spy.mock.calls[0] ?? [];
      expect(String(message)).toContain("runReviewAndFixLoop");
      expect((options as { code?: string } | undefined)?.code).toBe("ORCA_DEP_LOOP_COLLAPSE");
    } finally {
      spy.mockRestore();
    }
  });

  test("implementTaskLoop emits a deprecation warning and delegates", async () => {
    const spy = spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const result = await implementTaskLoop([{ id: "1", description: "one" }], () =>
        Promise.resolve(ok(undefined))
      );
      expect(result._unsafeUnwrap()).toEqual({ completed: ["1"] });
      expect(spy).toHaveBeenCalled();
      const [message, options] = spy.mock.calls[0] ?? [];
      expect(String(message)).toContain("implementTaskLoop");
      expect((options as { code?: string } | undefined)?.code).toBe("ORCA_DEP_LOOP_COLLAPSE");
    } finally {
      spy.mockRestore();
    }
  });
});
